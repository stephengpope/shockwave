// Per-workspace sync engine.
//
// One instance at a time, bound to the active workspace. Lifecycle:
//   start(workspacePath)  — kicks off the tick interval
//   stop()                — clears interval, awaits any in-flight tick
//
// Each tick (sequential, never overlapping with itself):
//   1. if there are unmerged files (conflicts), emit 'paused' + the list and
//      return — BEFORE any `git add -A` (see hazard below)
//   2. ask renderer to flush dirty editor tabs (with a timeout)
//   3. git status --porcelain  → if dirty, git add -A && git commit
//      (this also concludes a resolved-but-still-open merge — a `git commit`
//       with MERGE_HEAD present makes the merge commit)
//   4. git fetch; if origin is ahead → git merge origin/<branch>
//      └─ if the merge conflicts: emit 'paused' + the file list, return
//   5. if local ahead of origin: git push
//
// Status is pushed to the renderer via `sync:status` events whenever the
// engine state changes. The renderer's status icon consumes these; the paused
// payload carries `conflicts: string[]` (workspace-relative paths) so the
// renderer can render its conflict-resolution view.
//
// Conflicts: a `git merge` that conflicts leaves unmerged files + MERGE_HEAD.
// We pause and surface the file list. The user resolves each file and hits
// "Resolve" (→ resolveConflict → `git add <file>`). Once no unmerged files
// remain, the next tick's `git add -A && commit` concludes the merge and
// pushes — the engine is stateless about the pause (it just re-checks for
// unmerged files each tick). CRITICAL: `git add -A` while a conflict is live
// stages the files WITH their `<<<<` markers and git treats them resolved, so
// step 1 MUST bail before step 3 ever runs.

import { BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import { gitSpawn } from './sync.js';
import { findWorkspaceByPath } from './db/index.js';

// ─── Engine state ──────────────────────────────────────────────────────────

let state: any = {
  running: false,           // is the tick interval armed?
  workspacePath: null,
  // Repo + branch off the workspace ROW, read once at start(). The engine used
  // to re-derive both from the checkout every tick (`git remote get-url` /
  // `rev-parse`) because the DB only cached them; the row owns them now, so a
  // hand-edited `.git/config` no longer changes where a push lands.
  branch: 'main',
  repoOwner: null,
  repoName: null,
  pat: null,
  intervalMs: 10_000,
  windowId: null,           // BrowserWindow target for status + flush events
  ticking: false,           // a tick is currently executing
  intervalHandle: null,
  pendingTickPromise: null, // resolves when current tick finishes (for stop())
  backoffStep: 0,           // network-error backoff: 0 = none, 1/2/3 = 10s/30s/60s
  retryAt: null,            // timestamp before which ticks are skipped (backing off)
};

// Status surfaced to the renderer → maps to a status-bar icon:
//   unconfigured → icon HIDDEN (sync not set up; or a benign engine stop)
//   idle         → cloud-check (synced) / gray cloud (lastSyncAt null = not synced yet)
//   syncing      → spinner
//   paused       → yellow triangle (merge conflicts; carries conflicts[])
//   offline      → cloud-alert (can't reach GitHub; retrying with backoff)
//   disabled     → stop (turned off, or a TERMINAL error stopped it); click → Enable
const STATUS = Object.freeze({
  UNCONFIGURED: 'unconfigured',
  IDLE: 'idle',
  SYNCING: 'syncing',
  PAUSED: 'paused',
  OFFLINE: 'offline',
  DISABLED: 'disabled',
});

// Network/transient errors NEVER disable sync — they back off and keep retrying.
// Only an explicit allowlist of "the server refused, retrying is pointless"
// errors stops sync. Bias: anything unrecognized is treated as transient.
function isTerminalGitError(stderr) {
  const s = (stderr || '').toLowerCase();
  return (
    s.includes('gh001') || s.includes('file size limit') || s.includes('large files detected') ||  // file too big
    s.includes('gh013') || s.includes('push protection') || s.includes('secret') ||                // secret scanning
    s.includes('protected branch') || s.includes('pre-receive hook declined') ||                   // branch protection
    isAuthError(s) || s.includes('permission denied') || s.includes('403') ||                      // auth / perms
    s.includes('repository not found')                                                             // bad repo / no access
  );
}

let currentStatus = { status: STATUS.UNCONFIGURED, detail: '', lastSyncAt: null, repoUrl: null, conflicts: [] };

function emitStatus(patch) {
  // Reset `conflicts` every emit unless the patch sets it — only the paused
  // status carries a list, so any other status implicitly clears it.
  currentStatus = { ...currentStatus, conflicts: [], ...patch };
  const win = state.windowId ? BrowserWindow.fromId(state.windowId) : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('sync:status', currentStatus);
  }
}

export function getCurrentStatus() {
  return currentStatus;
}

// A transient/network error: don't disable — back off (10s → 30s → 1m) and keep
// retrying. The tick-top guard skips ticks until `retryAt`.
function enterOffline() {
  state.backoffStep = Math.min(state.backoffStep + 1, 3);
  const ms = [10_000, 30_000, 60_000][state.backoffStep - 1];
  state.retryAt = Date.now() + ms;
  emitStatus({ status: STATUS.OFFLINE, detail: "Can't reach GitHub — retrying" });
}

// A terminal error (server refused; retrying is pointless): stop ticking and
// surface the reason. The user fixes it and clicks Enable (→ engineStart).
function disableOnError(reason) {
  if (state.intervalHandle) { clearInterval(state.intervalHandle); state.intervalHandle = null; }
  state.running = false;
  state.retryAt = null;
  state.backoffStep = 0;
  emitStatus({ status: STATUS.DISABLED, detail: reason });
}

// Route a failed git command: terminal (allowlisted) → disable; else → offline.
function handleGitFailure(stderr, label) {
  if (isTerminalGitError(stderr)) disableOnError((stderr || '').trim() || `${label} failed`);
  else enterOffline();
}

// ─── Flush-renderer-dirty bridge ───────────────────────────────────────────
//
// Main asks the renderer "please flush dirty tabs and tell me when done" with
// a request token. Renderer's handler awaits its writeNow(), then invokes
// `sync:flushDone` with the token. We resolve the pending promise and
// continue. 1-second timeout so a hung renderer doesn't stall the engine.

const pendingFlushes = new Map(); // token → { resolve, timer }
let nextFlushToken = 1;

function requestFlush() {
  const win = state.windowId ? BrowserWindow.fromId(state.windowId) : null;
  if (!win || win.isDestroyed()) return Promise.resolve(undefined);
  const token = nextFlushToken++;
  return new Promise<any>((resolve) => {
    const timer = setTimeout(() => {
      pendingFlushes.delete(token);
      resolve(undefined);
    }, 1000);
    pendingFlushes.set(token, { resolve, timer });
    win.webContents.send('sync:flushRequest', token);
  });
}

export function handleFlushDone(token) {
  const entry = pendingFlushes.get(token);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingFlushes.delete(token);
  entry.resolve(undefined);
}

// ─── Tick ──────────────────────────────────────────────────────────────────

// The list of unmerged (conflicted) files, workspace-relative POSIX paths.
// `-z` is required: the default output escapes/quotes paths with spaces or
// non-ASCII (e.g. `"My Folder/note \303\251.md"`), which we'd then mis-parse.
// NUL-separated output is raw. Empty array = no conflicts.
async function listConflicts(workspacePath) {
  const res = await gitSpawn(workspacePath, ['diff', '--name-only', '--diff-filter=U', '-z'], { timeoutMs: 10_000 });
  if (!res.ok) return [];
  return res.stdout.split('\0').filter((p) => p.length > 0);
}

// Treat a stderr blob as an auth failure. Same heuristic used in several places.
function isAuthError(stderr) {
  const s = stderr.toLowerCase();
  return s.includes('authentication') || s.includes('401') || s.includes('could not read username');
}

// A leftover `.git/index.lock` (from a git process killed mid-write — our own
// SIGKILL-on-timeout, an app crash, sleep, or an external git) makes every
// later `git add`/`commit` fail with "Unable to create '…/index.lock': File
// exists", which would wedge sync permanently (the tick just retry-fails
// forever, surfaced as a misleading "offline"). git only holds the lock for
// well under a second during a normal index write, and our ticks never overlap,
// so a lock older than this is certainly orphaned and safe to remove.
const STALE_INDEX_LOCK_MS = 10_000;

function isIndexLockError(stderr) {
  const s = (stderr || '').toLowerCase();
  return s.includes('index.lock') && s.includes('file exists');
}

// Remove an orphaned index.lock if it's older than STALE_INDEX_LOCK_MS. Returns
// true if a stale lock was cleared (so the caller should retry the command).
async function clearStaleIndexLock(workspacePath) {
  const lockPath = path.join(workspacePath, '.git', 'index.lock');
  try {
    const st = await fs.stat(lockPath);
    if (Date.now() - st.mtimeMs < STALE_INDEX_LOCK_MS) return false; // maybe a live writer — leave it
    await fs.unlink(lockPath);
    console.warn(`[sync] removed stale ${lockPath} (orphaned ${Math.round((Date.now() - st.mtimeMs) / 1000)}s ago)`);
    return true;
  } catch {
    return false; // no lock present, or it vanished — nothing to recover
  }
}

// Run an index-writing git command; if it fails because of an orphaned
// index.lock, clear the stale lock and retry once. Self-heals the wedge that
// would otherwise make every future tick fail.
async function gitLocking(workspacePath, args, timeoutMs) {
  let res = await gitSpawn(workspacePath, args, { timeoutMs });
  if (!res.ok && isIndexLockError(res.stderr) && (await clearStaleIndexLock(workspacePath))) {
    res = await gitSpawn(workspacePath, args, { timeoutMs });
  }
  return res;
}

// Commit any dirty changes in the working tree. Returns true if everything is
// clean by the end, false on a git error (status emitted by caller).
async function commitDirty(workspacePath) {
  const status = await gitSpawn(workspacePath, ['status', '--porcelain'], { timeoutMs: 10_000 });
  if (!status.ok) { enterOffline(); return false; }       // local git hiccup → retry, never disable
  if (status.stdout.trim().length === 0) return true;
  const add = await gitLocking(workspacePath, ['add', '-A'], 30_000);
  if (!add.ok) { enterOffline(); return false; }
  const commit = await gitLocking(workspacePath, ['commit', '-m', `Shockwave sync: ${new Date().toISOString()}`], 30_000);
  if (!commit.ok) { enterOffline(); return false; }
  return true;
}

async function runTick() {
  if (!state.running) return;
  if (state.ticking) return; // serial: never overlap a tick with itself
  if (state.retryAt && Date.now() < state.retryAt) return; // backing off after a network error
  state.ticking = true;
  let tickResolve;
  state.pendingTickPromise = new Promise<any>((res) => { tickResolve = res; });

  try {
    // 0. If there are unmerged files (a merge is paused on conflicts), do NOT
    // touch the tree — `git add -A` here would stage the marker-laden files and
    // git would treat them as resolved. Surface the list and wait for the user
    // to resolve each (resolveConflict → git add). Once the list is empty, the
    // next tick falls through and commitDirty's commit concludes the merge.
    const conflicts = await listConflicts(state.workspacePath);
    if (conflicts.length > 0) {
      emitStatus({ status: STATUS.PAUSED, detail: `${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} — resolve to continue`, conflicts });
      return;
    }

    // 1. Flush dirty editor buffers to disk. Silent — no status emit. The
    // status icon should only light up for actual upload/download work, not
    // for the routine checks we run every tick.
    await requestFlush();

    // The branch comes from the workspace row (recorded at setup from what git
    // actually checked out). Passed explicitly to fetch / merge / push so we
    // don't depend on an upstream being configured — the first tick on a
    // freshly-init'd repo has no upstream yet.
    const branchName = state.branch;

    // 2. Commit local changes if dirty. Silent.
    if (!(await commitDirty(state.workspacePath))) return;

    // 3. Fetch from origin so we can compare HEAD to origin/<branch>. Silent.
    // On a freshly-init'd repo with no remote branch yet, fetch fails with
    // "couldn't find remote ref"; we treat that as "no remote branch, skip
    // pull, fall through to push".
    let remoteBranchExists = true;
    const fetch = await gitSpawn(state.workspacePath, ['fetch', 'origin', branchName], {
      pat: state.pat,
      timeoutMs: 60_000,
    });
    if (!fetch.ok) {
      if (fetch.stderr.toLowerCase().includes("couldn't find remote ref")) {
        remoteBranchExists = false;        // fresh repo, no remote branch yet
      } else {
        handleGitFailure(fetch.stderr, 'git fetch');  // auth/perms → disabled; network → offline+retry
        return;
      }
    }
    // Reached the remote → connectivity is confirmed; clear any network backoff
    // (even if we go on to pause on a conflict, we're not "offline" anymore).
    state.backoffStep = 0;
    state.retryAt = null;

    // 4. If remote has new commits we don't have, merge. Visible — this is
    // the "downloading from git" case the user actually wants to see. Merge
    // (not rebase): it touches only files that genuinely differ and resolves
    // in one pass, vs rebase replaying every commit. The working tree must be
    // clean first, so re-flush + commit (the user may have typed during fetch).
    if (remoteBranchExists) {
      const aheadRes = await gitSpawn(state.workspacePath, ['rev-list', '--count', `HEAD..origin/${branchName}`], { timeoutMs: 5_000 });
      const remoteAhead = aheadRes.ok && parseInt(aheadRes.stdout.trim(), 10) > 0;
      if (remoteAhead) {
        await requestFlush();
        if (!(await commitDirty(state.workspacePath))) return;
        emitStatus({ status: STATUS.SYNCING, detail: 'Pulling from origin' });
        const merge = await gitSpawn(state.workspacePath, ['merge', `origin/${branchName}`], { timeoutMs: 60_000 });
        if (!merge.ok) {
          // Conflicts → unmerged files + MERGE_HEAD left in place. Surface the
          // list and stop; the user resolves, then a later tick concludes it.
          const merged = await listConflicts(state.workspacePath);
          if (merged.length > 0) {
            emitStatus({ status: STATUS.PAUSED, detail: `${merged.length} conflict${merged.length > 1 ? 's' : ''} — resolve to continue`, conflicts: merged });
            return;
          }
          handleGitFailure(merge.stderr, 'git merge');
          return;
        }
      }
    }

    // 5. Push if local is ahead of origin (or remote branch doesn't exist
    // yet — first push). Visible — "uploading to git".
    let needPush;
    if (!remoteBranchExists) {
      needPush = true;
    } else {
      const localAheadRes = await gitSpawn(state.workspacePath, ['rev-list', '--count', `origin/${branchName}..HEAD`], { timeoutMs: 5_000 });
      needPush = localAheadRes.ok && parseInt(localAheadRes.stdout.trim(), 10) > 0;
    }
    if (needPush) {
      emitStatus({ status: STATUS.SYNCING, detail: 'Pushing to origin' });
      const push = await gitSpawn(state.workspacePath, ['push', '--set-upstream', 'origin', branchName], {
        pat: state.pat,
        timeoutMs: 60_000,
      });
      if (!push.ok) {
        const stderr = push.stderr.toLowerCase();
        if (push.code !== 0 && !stderr.includes('up-to-date') && !stderr.includes('nothing to')) {
          handleGitFailure(push.stderr, 'git push');  // big file/auth/etc → disabled; network → offline+retry
          return;
        }
      }
    }

    // Success → clear any backoff and mark synced.
    state.backoffStep = 0;
    state.retryAt = null;
    emitStatus({ status: STATUS.IDLE, detail: '', lastSyncAt: Date.now() });
  } finally {
    state.ticking = false;
    tickResolve();
    state.pendingTickPromise = null;
  }
}

// ─── Conflict resolution (driven by the renderer's conflict view) ───────────

/** Current unmerged files, workspace-relative. Used by `sync:listConflicts`. */
export async function getConflicts(workspacePath) {
  return listConflicts(workspacePath);
}

// Run a sequence of staging commands (checkout/add) under the tick guard, then
// re-list conflicts. If any remain, emit the paused status; if none remain,
// kick a tick so the merge commit + push happen immediately. Serialized with
// the tick loop so we never touch the index mid-tick. Returns the new list.
async function stageAndReport(workspacePath, ops) {
  if (state.pendingTickPromise) await state.pendingTickPromise.catch(() => {});
  state.ticking = true;
  let remaining;
  try {
    for (const args of ops) await gitSpawn(workspacePath, args, { timeoutMs: 30_000 });
    remaining = await listConflicts(workspacePath);
    if (remaining.length > 0) {
      emitStatus({ status: STATUS.PAUSED, detail: `${remaining.length} conflict${remaining.length > 1 ? 's' : ''} — resolve to continue`, conflicts: remaining });
    }
  } finally {
    state.ticking = false;
  }
  if (remaining.length === 0) {
    runTick().catch(() => enterOffline());
  }
  return remaining;
}

/** Per file. Resolve = accept the file as-edited (`git add`). */
export function resolveConflict(workspacePath, relPath) {
  return stageAndReport(workspacePath, [['add', '--', relPath]]);
}
/** Per file. Keep = our version (`checkout --ours` + add). */
export function keepConflict(workspacePath, relPath) {
  return stageAndReport(workspacePath, [['checkout', '--ours', '--', relPath], ['add', '--', relPath]]);
}
/** Per file. Reset = remote version (`checkout --theirs` + add). */
export function resetConflict(workspacePath, relPath) {
  return stageAndReport(workspacePath, [['checkout', '--theirs', '--', relPath], ['add', '--', relPath]]);
}
/** Whole tree. Keep all = our version of every conflict (`checkout --ours .`),
 *  then complete the merge (remote's non-conflicting changes still come in). */
export function keepAll(workspacePath) {
  return stageAndReport(workspacePath, [['checkout', '--ours', '.'], ['add', '-A']]);
}

/**
 * Discard ALL local divergence and take the remote as-is: abort any in-progress
 * merge, fetch, then `git reset --hard origin/<branch>`. The escape hatch when
 * the user would rather take GitHub's version than resolve file by file. This
 * throws away local-only commits + working-tree changes — the caller confirms.
 */
export async function resetToRemote(workspacePath) {
  if (state.pendingTickPromise) await state.pendingTickPromise.catch(() => {});
  state.ticking = true;
  try {
    // Same branch the tick uses (the row's). Only reachable from the conflict
    // view, which exists only while the engine is bound to this workspace.
    const branch = state.branch;
    // No-op (non-zero, ignored) if no merge is in progress.
    await gitSpawn(workspacePath, ['merge', '--abort'], { timeoutMs: 30_000 });
    await gitSpawn(workspacePath, ['fetch', 'origin', branch], { pat: state.pat, timeoutMs: 60_000 });
    const reset = await gitSpawn(workspacePath, ['reset', '--hard', `origin/${branch}`], { timeoutMs: 30_000 });
    if (!reset.ok) { handleGitFailure(reset.stderr, 'git reset'); return; }
  } finally {
    state.ticking = false;
  }
  // Back in sync with origin → resume normal ticking (clears the paused status).
  runTick().catch(() => enterOffline());
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

export async function start({ workspacePath, pat, intervalSeconds, windowId }) {
  // Stop any previous engine instance first.
  await stop();
  if (!workspacePath || !pat) {
    state.windowId = windowId ?? state.windowId;
    emitStatus({ status: STATUS.UNCONFIGURED, detail: pat ? 'No workspace' : 'No PAT set', lastSyncAt: null, repoUrl: null });
    return;
  }
  // The row IS the sync config. No row means the folder isn't a workspace —
  // which for a caller passing a path is a bug, not a user state, so it hides
  // the icon rather than reporting an error. This replaced a `git remote
  // get-url` probe: "is sync set up" used to be a question about the checkout,
  // and is now a question about the table.
  const ws = findWorkspaceByPath(workspacePath);
  if (!ws) {
    state.windowId = windowId ?? state.windowId;
    emitStatus({ status: STATUS.UNCONFIGURED, detail: 'Not a workspace', lastSyncAt: null, repoUrl: null });
    return;
  }
  state.backoffStep = 0;
  state.retryAt = null;
  state.running = true;
  state.workspacePath = workspacePath;
  state.branch = ws.defaultBranch || 'main';
  state.repoOwner = ws.repoOwner;
  state.repoName = ws.repoName;
  state.pat = pat;
  state.intervalMs = Math.max(5_000, Math.min(600_000, (intervalSeconds ?? 10) * 1000));
  state.windowId = windowId ?? state.windowId;
  // Web URL for the status-bar icon's "open on GitHub" — composed from the row
  // rather than parsed back out of a remote URL.
  const repoUrl = `https://github.com/${ws.repoOwner}/${ws.repoName}`;
  emitStatus({ status: STATUS.IDLE, detail: '', lastSyncAt: null, repoUrl });
  // First tick fires immediately (so workspace switch picks up remote
  // changes without waiting up to 10s), then on the interval.
  state.intervalHandle = setInterval(runTick, state.intervalMs);
  // Don't await — let it run in the background and update status events.
  runTick().catch(() => enterOffline());
}

export async function stop() {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
  state.running = false;
  state.retryAt = null;
  state.backoffStep = 0;
  // Let any in-flight tick finish so we don't leave a partial commit/push.
  if (state.pendingTickPromise) {
    await state.pendingTickPromise.catch(() => {});
  }
  state.workspacePath = null;
  state.pat = null;
  // Benign stop (workspace switch / window reload) → UNCONFIGURED hides the icon.
  emitStatus({ status: STATUS.UNCONFIGURED, detail: '', lastSyncAt: currentStatus.lastSyncAt, repoUrl: null });
}

/** User turned sync off for this workspace. Like stop(), but the icon STAYS
 *  (DISABLED → stop icon) so they can re-enable it right from the status bar. */
export async function userDisable() {
  await stop();
  emitStatus({ status: STATUS.DISABLED, detail: 'Sync is turned off', lastSyncAt: currentStatus.lastSyncAt, repoUrl: null });
}

/** Called from `before-quit` to drain any in-flight tick before app exits. */
export async function drainBeforeQuit() {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
  state.running = false;
  if (state.pendingTickPromise) {
    await state.pendingTickPromise.catch(() => {});
  }
}
