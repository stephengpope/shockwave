# Cron / Scheduled Runs — Design & Build Plan

Status: **design locked, not built.** Build spec agreed with the user.
Reference studied: `../knack` (web app; `lib/cron/*`, `app/api/cron/*`).
This ports knack's next-run model to Electron + Shockwave's local-first,
active-workspace model. Reviewed twice (code fact-check + adversarial design pass);
findings folded in — see the appendix.

---

## 1. Goal

An in-app scheduler that runs the pi coding agent on a schedule, per workspace,
exactly the way an interactive chat runs — it mints a chat, does real work in the
workspace, and its transcript is saved and browsable like any other chat.

A desktop machine can be off and the app can be closed, so scheduling is **next-run /
catch-up**, not tick-every-minute: each job stores its next fire time; on any tick we
fire what's due, collapsing missed occurrences into one, bounded by a catch-up window.

---

## 2. Locked decisions (with the why)

| Decision | Choice | Why |
|---|---|---|
| Scope | **Active workspace only.** Cron follows the active workspace; switching retargets it. | Simplest; avoids a sync-engine multi-workspace refactor. Non-active workspaces' jobs pause and catch up (within the window) when that workspace becomes active. |
| Where the agent edits | **Live folder** — `cwd = workspace path`, same as interactive. | It's "run exactly like real time." Reuses the existing watcher + sync; no tmp-clone. |
| Commit-back | **Existing active-workspace sync** handles it. No cron-specific git. | Live-folder edits are committed by the sync engine like any agent edit. |
| Timezone | **Local machine time** (resolve IANA tz per tick, pass to `cron-parser`). | Single-user desktop — "0 8 * * *" means 8am *your* time. (knack used UTC because it's a server.) Re-resolving per tick handles travel/tz changes without restart. |
| Master on/off | **One global, machine-local** setting `cron.enabled`. Gates **firing only** (not watching/validation/UI). | "On is on," follows the active workspace. Machine-local so a cloned repo's `cron.json` doesn't auto-run agents everywhere. |
| Per-job on/off | `enabled` flag in `cron.json`. | File is source of truth; agent- and hand-editable. Master × per-job both gate a run. |
| Model override | **Dropped.** Uses the selected coding-agent model. | Simpler. |
| Run state | `cron_state` table in `shockwave.db`, machine-local. | "When did *this machine* last run it / when's it next due." Must not sync. |
| Concurrency | **One agent at a time per workspace, no queue.** Cron defers if **any** agent is running in that workspace — including the user's own chat. When several jobs are due, fire the **single longest-overdue** one (tie-break by job name); the rest wait for a later tick. | Two agents editing one live folder stomp each other. The user always wins; cron waits. |
| Run watchdog | A run that exceeds **`cron.maxRunMinutes`** (default **30**, configurable) is aborted, flagged `lastError`, and the workspace lock released. | A hung provider call must never wedge the scheduler forever. |
| Next-run writer | **The scheduler is the sole writer of `nextRunAt`**, and only for scheduled runs. `runJob` records only `lastRunAt`/`lastError`/`lastSessionId`. Manual runs never move `nextRunAt`. | One writer = no double-advance / clobber; manual is out-of-band by construction. |
| Failure handling | Capture the **actual** error (start-time, API, or mid-run) into `lastError`; surface in UI. Because `nextRunAt` advances at attempt, a failure waits for the next scheduled time — no 60s retry storm. | Robust to any failure, not one special case. |
| Catch-up window | Default **36h**, configurable, **clamped** to a sane range. Fire the **most-recent** missed occurrence if it's within the window (collapsing older misses); else roll forward without firing. | Measuring from the *oldest* miss let one stale occurrence cancel a recent wanted run. See §4.2. |
| Master off with a run in flight | **The running job finishes; no new runs start.** Not aborted mid-work. | Cleaner than killing live work. |
| Manual "Run now" | Same `runJob()` as the scheduler, sourced from the **last-good in-memory** job set. Out-of-band: never touches `nextRunAt`; works when cron/that job is disabled; still respects the one-at-a-time guard (shows busy). Records `lastRunAt/lastError/lastSessionId`. | One code path; manual = "run once regardless of schedule." |
| Cron chats | Add a nullable `source` column (`'cron'`); title = job name (needs a small opt-out of auto-title); badge in the dropdown. Appears in the active workspace's list, live-viewable, **never steals focus**. | Recognizable, non-disruptive; "last run → open chat" works. |
| Tray / background | **No tray in v1.** Cron runs while the app is open. (macOS keeps the process alive after window-close → cron keeps firing; Windows/Linux quit on window-close → cron pauses till relaunch — catch-up covers the gap.) | A tray for always-on Win/Linux is real added scope; defer. |

---

## 3. Data model

### 3.1 `cron.json` (workspace root — source of truth)

```json
[
  { "name": "nightly-triage", "schedule": "0 2 * * *",
    "prompt": "Review today's daily note and draft tomorrow's plan.", "enabled": true }
]
```
- `name` — unique within the file, stable. Keys `cron_state`, titles the chat.
- `schedule` — 5-field cron expression, **local machine time**.
- `prompt` — sent to a fresh chat each run; self-contained (no memory of prior runs).
- `enabled` — `false` pauses without deleting. Defaults `true`.

Validation (skip-bad, keep-good): bad JSON → whole file invalid, nothing schedules,
error surfaced (§7); per-job needs non-empty unique `name`, valid `schedule`, non-empty
`prompt` — a single bad job shows "invalid" and doesn't schedule; the rest run. A
bad-schedule job can still be **Run now**'d (manual needs no schedule).

### 3.2 `cron_state` table (`shockwave.db`, machine-local — needs a drizzle migration)

```
cron_state
  id            text pk          -- `${workspace}::${jobName}`
  workspace     text notnull     -- absolute path (matches chat_session.workspace)
  jobName       text notnull
  schedule      text notnull     -- last-seen schedule, to detect edits
  nextRunAt     integer          -- epoch ms; null when disabled/cleared
  lastRunAt     integer
  lastError     text             -- actual message from the last failed run
  lastSessionId text             -- chat_session.sessionId of the last run
  createdAt     integer notnull
  updatedAt     integer notnull
  unique(workspace, jobName)
  index(nextRunAt)
```
Access fns (`src/main/db/index.ts`): `getCronState`, `listCronState(workspace)`,
`upsertCronState`, `advanceNextRun(workspace, jobName, nextRunAt, now)` (scheduler only),
`recordRun(workspace, jobName, {sessionId})`, `recordError(workspace, jobName, msg)`,
`pruneCronState(workspace, keepJobNames[])`, and a `deleteCronStateForWorkspace(workspace)`
for workspace removal.

---

## 4. Scheduler & lifecycle

New module `src/main/cron.ts`, **app-level** (one main process; not per-window).

### 4.1 Ticks
- shortly after app ready / initial workspace load,
- every **~60s** while running (`setInterval`),
- on **workspace switch**,
- when the workspace watcher reports `cron.json` changed (for promptness — see §4.4).

Each tick re-reads + reconciles `cron.json`, so scheduling is always current within a
minute even with no change event at all.

### 4.2 Due logic (per tick, active workspace only)
1. If a run is already in flight for this workspace, **or any agent session is running
   in this workspace** (`agentRunningSessions()`), → stop (defer).
2. Load + validate `cron.json`; reconcile state rows (create missing, prune removed).
3. If `cron.enabled` is false → stop (still reconciled/validated for the UI).
4. For each enabled job with `nextRunAt <= now`, decide catch-up using the **most-recent
   occurrence**, not the stored `nextRunAt`:
   - `prev = prevOccurrence(schedule, now)` (latest scheduled time ≤ now).
   - If `now - prev <= window` → **due** (collapses all older misses into this one).
   - Else → roll `nextRunAt = nextAfter(schedule, now)` forward, **don't fire**.
5. Among due jobs, pick the **single longest-overdue** (smallest `nextRunAt`; tie-break
   by `name`). Advance its `nextRunAt = nextAfter(schedule, now)` (attempt-time, scheduler
   is sole writer), then `runJob()` it. Remaining due jobs wait for a later tick.

> Concrete (the bug this fixes): daily `0 2 * * *`, 36h window, closed Fri eve → reopen
> Mon 09:00. Old rule (from stored `nextRunAt` = Sat 02:00 = 55h) skipped everything.
> New rule: `prev` = Mon 02:00 = 7h ago ≤ 36h → **fires once**, then next = Tue 02:00.

### 4.3 Enable / disable & reconcile resets (all conditioned on master state)
- **Master off→on:** for every enabled job, `nextRunAt = nextAfter(schedule, now)` (fresh
  baseline; nothing fires immediately).
- **Master on→off:** clear all `nextRunAt`; **stop firing**, but keep reconciling +
  validating + watching for the UI. An in-flight run **finishes** (not aborted).
- **New enabled job appears** (agent/hand edit) while master on: `nextRunAt = nextAfter(schedule, now)` at reconcile.
- **Per-job false→true** (master on): `nextRunAt` from now. **true→false:** clear it.
- **Schedule edited** (master on): recompute that job's `nextRunAt` from now.
- **While master off:** reconcile keeps `nextRunAt` null (no recompute).
- **Launch / workspace switch while on:** use the **persisted** `nextRunAt` (catch-up); don't reset.

### 4.4 Watching `cron.json` — no dedicated watcher
The workspace `@parcel/watcher` **already sees** `cron.json` (it's a root, non-dotfile).
In the renderer it collapses to a contentless `tree` event, but in the **main process**
the dispatch has the real path. So:
- **Correctness** needs no watcher — each 60s tick re-reads + reconciles.
- **Promptness** (modal liveness + malformed badge): hook the existing main-side dispatch —
  "changed path is `<workspace>/cron.json` → ping the cron controller" (a few lines, not a
  second watcher). Scoped to the active workspace, exactly what we want.
- **Self-echo** (the modal's enable-toggle writes `cron.json`): handled by making reconcile
  **idempotent** (pure function of file contents → state; re-running on our echo is a no-op).
- **Malformed mid-edit:** keep the **last-good** in-memory job set for scheduling + Run-now,
  raise the error badge (§7), reconcile to the new set once it parses.

### 4.5 Concurrency & the in-flight lock
- One workspace lock; a run holds it start→finish. The scheduler and Run-now both check it
  (and the broader `agentRunningSessions()` in §4.2). Blocks a second scheduled fire and a
  Run-now while busy.
- The lock is released in a **`finally`** around `await agentSend`. A run exceeding
  `cron.maxRunMinutes` is aborted (`agentAbort`), flagged, and the lock released — no
  permanent wedge.
- A cron run never blocks the user; it's the user's activity that makes cron wait.

---

## 5. Firing a run — `runJob(workspacePath, job, { manual })`

Scheduler and Run-now both call this. Replicates the `agent:send` handler
(`src/main/main.ts:1429`) but with an **explicit** workspace, not the active-workspace lookup:
- Main-side `readSettings()` (decrypts) → `codingAgent` (`provider/model/baseUrl/contextWindow/thinkingLevel`, `providerKeys[provider]`).
- Target workspace's `.shockwave/workspace.json` → `wsBuiltinSkills` (must match interactive).
- `sessionId = crypto.randomUUID()` (fresh chat → pi's create branch → unattended prompt, §6).
- Call exported `agentSend(opts, emit)` (`codingAgent.ts:349`) with explicit `workspacePath`,
  `opts.unattended = true`, plus `userDataDir`, `builtinDir`. `opts` is untyped, so `unattended` threads for free.
- **emit:** forward events to the window (live-viewable if opened) + a "recent chats changed"
  ping so the dropdown updates. Focus is **already** untouched by incoming events (routing is by
  `sessionId`), so no focus is stolen; but a cron `sessionId` the renderer never minted
  auto-materializes a chat entry — it must be tagged `source='cron'` + the cron workspace as soon
  as the `shockwave_session` event lands, and entries whose workspace ≠ active are stored, not shown.
- **Watchdog:** race `agentSend` against a `maxRunMinutes` timer; on timeout `agentAbort` + `recordError`.
- On any failure → `recordError` (real message). On the scheduled path only, the **scheduler**
  already advanced `nextRunAt`; `runJob` writes only `lastRunAt`/`lastSessionId`. Guard: a completion
  write for a job pruned mid-run (deleted from `cron.json`) is dropped.
- Chat row: `source='cron'`, `title = job.name` (needs a small flag to skip `maybeGenerateTitle`,
  which is unconditional today).

`chat_session.workspace` = the explicit path (via `upsertSession`), so the chat lands in the
correct workspace's list. pi's JSONL is global (`<userData>/pi-agent/sessions/`), independent of `cwd`.

---

## 6. Prompt / guidance changes

Thread an `unattended` flag through the untyped `opts` and change only three functions:
- `buildShockwaveHelper({ tools, unattended })` (`helper.ts:159`) — when `unattended`, append an
  `UNATTENDED` section after `BOUNDARIES`.
- `assembleSystemPrompt(workspacePath, { unattended })` (`index.ts:29`) — forward it.
- `bootSession` (`codingAgent.ts`) — pass `unattended` on the **create** branch
  (`SessionManager.create`, ~L217). Resumed sessions keep their frozen `row.systemPrompt`
  (the resume branch has a `?? assembleSystemPrompt` fallback that only fires if the frozen
  value is null — rare). Cron always mints a fresh uuid → always the create branch → always unattended.

The line it overrides, verbatim (`helper.ts:15-18`):
> `# Boundaries` … `**Never delete or move files without explicit permission.** Ask first.`

### Draft — `UNATTENDED` (only when `unattended`)
> # Unattended run
> You are running on a schedule with no user present. You will not receive a reply, so do not
> ask for confirmation or wait for input. Use your judgment, complete the task, and finish. You
> may create, edit, and — when the task requires it — move or delete files inside the workspace
> without asking. This overrides the "ask first" boundary above for this run. Your changes are
> committed automatically after the run.

### Draft — `Scheduled runs (cron)` (always present, informational)
> ## Scheduled runs (cron)
> You can schedule yourself to run unattended. Schedules live in `cron.json` at the workspace
> root — a JSON array you can read and edit like any other file. Each entry:
> `{ "name": "nightly-triage", "schedule": "0 2 * * *", "prompt": "…", "enabled": true }`
> - `name` — unique, stable; each run opens as its own chat titled after the job.
> - `schedule` — a standard 5-field cron expression in the machine's **local time**.
> - `prompt` — sent to a fresh chat each run; make it self-contained.
> - `enabled` — `false` pauses a job without deleting it.
> Cron runs only when the user has turned it on. A run starts a brand-new chat, so it sees the
> current workspace and your latest SOUL. Missed runs collapse into one catch-up run, bounded by
> a configurable window.

(The empty-state UI "ask the agent to create one" only works because this section teaches the format — they ship together.)

---

## 7. UI

### 7.1 Sidebar entry
A **clock icon** in the left sidebar toolbar, **always visible** (its watch/validation runs
regardless of the master toggle). Badge: plain (off / no jobs) · dot (on with jobs) · amber "!"
(`cron.json` malformed). Click → the Scheduled runs modal.

### 7.2 Modal
```
┌─ Scheduled runs (all workspaces) · active: My Workspace ─┐
│  [ ● ] Run scheduled tasks          next check 0:42      │  master toggle = global cron.enabled
│  catch-up window [ 36 ] h    max run [ 30 ] min          │
│                                                          │
│  nightly-triage       Every day at 02:00         [▶ ]    │  ▶ Run now (disabled+"running…" when busy)
│    next in 6h20m · last 2h ago ✓ (open)   [●enabled]     │  last → opens that chat
│  ──────────────────────────────────────────────────────  │
│  weekly-digest        Mondays 09:00              [▶ ]    │
│    next — · last never                    [○disabled]    │
│                                                          │
│  [ Open cron.json ]                                      │
└──────────────────────────────────────────────────────────┘
```
- Header/toggle worded to make the **global** scope unambiguous (it affects whichever workspace
  is active), naming the active workspace for context.
- Read-mostly; live actions: master toggle, per-job toggle (writes `cron.json`), **Run now**
  (busy-aware). Job creation/editing stays in the file ("Open cron.json").
- **Empty state:** "No scheduled tasks yet — open `cron.json` or ask the agent to schedule something."
- **No workspace open:** greyed modal, "Open a workspace to schedule tasks."
- **Malformed:** JSON error → banner + "Open cron.json"; single bad job → row shows "invalid" but keeps a live Run-now.
- Live (reflects file edits + run completions); Run-now starts a background chat that appears in the dropdown without stealing focus.

Master toggle + both numbers live **only in the modal** (the always-visible icon is the discovery point).

---

## 8. Settings / IPC / plumbing checklist

### 8.1 `settings.cron` slice — no secrets, so no encrypt/decrypt changes
```ts
cron: { enabled: boolean; maxCatchupHours: number; maxRunMinutes: number }
// default: { enabled: false, maxCatchupHours: 36, maxRunMinutes: 30 }   // opt-in; clamp both
```
Touch **all five** places:
1. `Settings` type — `src/shared/settings.ts` (this file has the type only; the default lives in main — the CLAUDE.md note that DEFAULT_SETTINGS is in shared is stale).
2. `DEFAULT_SETTINGS` — `src/main/main.ts:91`.
3. `readSettings` nested merge — `main.ts:236` **and** the deep-merge loop key list in `doWriteSettings` — `main.ts:326` (currently `['appearance','codingAgent','transcription','sync']`).
4. `useSettings` `DEFAULT_CANONICAL` mirror (`useSettings.ts:14`) **and** the explicit field enumeration in `persistSettings` (`useSettings.ts:81`) — miss it and the slice drops on save.

### 8.2 New IPC (`main.ts` + `preload.cjs` + `api.d.ts`, `cron:` namespace)
- `cron:read` → `{ jobs, state, enabled, maxCatchupHours, maxRunMinutes, fileError }` (active workspace).
- `cron:setEnabled(bool)` (master; §4.3 reset).
- `cron:setJobEnabled({ name, enabled })` (read-modify-write `cron.json`, self-echo-safe).
- `cron:runNow({ name })` → `runJob(..., {manual:true})` from the last-good in-memory set; returns `{ok}`/`{busy}`.
- `cron:setMaxCatchupHours(n)`, `cron:setMaxRunMinutes(n)` (clamped).
- Push: `cron:state`, and a "recent chats changed" ping.

### 8.3 Reuse (exists)
`agentSend` (exported, `opts` untyped); `agentRunningSessions()` (`codingAgent.ts:423`);
`agentAbort`; `readSettings` (decrypts; main-private → call inside the cron handlers);
`chat_session.workspace` + `listSessions(workspace,…)`.

---

## 9. Edge cases & notes (into code + docs)
- **Switch during a run:** the run finishes and saves; sync follows the active workspace, so those
  changes commit/push when you return (data safe on disk meanwhile). Accepted for v1.
- **Mac vs Win/Linux** process lifetime (see §2 tray row) — one-line doc note.
- **Cron write to a file you have open:** the watcher reloads/green-flashes your buffer (invariant #9);
  a keystroke in the same instant can be lost. Same as any external writer, but more surprising from an
  unattended one — note it.
- **Sync `git add -A` mid-write:** the 10s commit tick has no coordination with agent writes, so a
  multi-file cron run can be committed at an intermediate state. Consider **pausing the sync commit tick
  while a cron run is in flight**; otherwise document it.
- Duplicate job names rejected; removed jobs pruned; **removing a workspace** deletes its `cron_state`.
- Two jobs with identical next-run → tie-break by name.
- `maxCatchupHours`/`maxRunMinutes` clamped to sane ranges.
- A weekly job with a 36h window only catches up if you're around within 36h of its time — a
  consequence of one global window; the user can raise it.
- SOUL.md may contradict the unattended note; the note is phrased to win for the run.

---

## 10. Phasing
1. **Data + plumbing:** `cron.json` read/write+validate; `cron_state` table + migration + db fns; `settings.cron` slice (§8.1); IPC skeleton (§8.2).
2. **Scheduler:** `cron.ts` — reconcile, due/catch-up (§4.2 corrected math), enable-reset, longest-overdue pick, one-at-a-time + `agentRunningSessions` defer, lock/`finally`/watchdog; app-lifecycle wiring; hook the existing watcher for `cron.json`.
3. **Run:** `runJob()` (§5) + thread `unattended` (§6) + `source`/title flag.
4. **Guidance:** the two prompt sections (§6 drafts).
5. **UI:** sidebar clock + modal (§7); background-chat ping + phantom-entry tagging.
6. **Tests + docs:** §11, §12.

## 11. Testing
`node:test`: due/catch-up **from most-recent occurrence** (the H1 case — oldest miss 55h but
yesterday's occurrence 7h → fires), collapse, reconcile, enable/disable reset (incl. new-job + master-off
keeps null), longest-overdue pick + tie-break, attempt-advance-on-failure, watchdog release, clamps.
Manual e2e via **electron-dev** (create `cron.json`, watch a run fire, confirm chat + title + last-run
link + malformed badge + Run-now-while-busy).

## 12. Docs to update
Root `CLAUDE.md` (`settings.cron` slice; `cron.json` reconcile-is-idempotent note); `src/main/CLAUDE.md`
(new "Scheduled runs (cron)" section); `tests/CLAUDE.md` (coverage rows).

---

## Appendix — review findings resolved
- **H1** catch-up math → §4.2 (most-recent occurrence) + §11 test.
- **H2** watch lifecycle vs master-off → §4.3/§4.4 (master gates firing only; watch follows workspace).
- **H3** ignores user's concurrent chat → §4.2/§4.5 (`agentRunningSessions` defer).
- **H4** hung run wedges scheduler → §4.5 (`finally` + `maxRunMinutes` watchdog).
- **H5** two `nextRunAt` writers / manual advances → §2 + §5 (scheduler sole writer; manual never touches).
- **M1** new-job initial next-run → §4.3. **M2** global-toggle framing → §7.2. **M3** Run-now on malformed → §4.4/§8.2 (last-good set). **M4** Run-now busy feedback → §7.2. **M5** master-off in-flight → §2 (finishes). **M6** no workspace open → §7.2. **M7** resets conditioned on master → §4.3. **M8** phantom chat / focus → §5.
- **L1** tie-break, **L2** tz per tick, **L3** workspace-remove cleanup, **L4** open-buffer reload, **L5** sync mid-write, **L6** delete-job-mid-run drop, **L7** clamps → §2/§9.
- **Fact-check:** watcher reasoning corrected (§4.4); `agent:send` at `main.ts:1429`; `BOUNDARIES` quoted verbatim (§6); "only place minted" precise (§6); "title = job name" needs a flag (§5); settings line refs 91/236/326 (§8.1).
