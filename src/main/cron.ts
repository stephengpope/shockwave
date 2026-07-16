// Cron scheduler controller (stateful; main process). The pure scheduling math
// lives in cronScheduler.js; this module owns the side effects: reading
// cron.json, reconciling the cron_state table, ticking, and firing runs through
// the coding agent exactly like an interactive chat.
//
// Model (see docs/cron-plan.md): ACTIVE workspace only; next-run/catch-up;
// LOCAL machine time; one run at a time (defers to ANY agent running in the
// workspace, including the user's own chat); the scheduler is the SOLE writer of
// nextRunAt (manual "Run now" never touches it); a run exceeding maxRunMinutes
// is aborted so a hung provider can't wedge the scheduler.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  CRON_FILE, parseCronJobs, planTick, nextAfter, describeSchedule, localTz,
} from './cronScheduler.js';
import { agentRunningSessions, agentAbort } from './codingAgent.js';
import {
  getSession, listCronState, ensureCronRow, updateCronState, pruneCronState, deleteCronStateForWorkspace,
} from './db/index.js';

const TICK_MS = 60_000;

// Injected by main at startup (initCron) to avoid importing main.ts (circular)
// and to keep the decrypted-settings + opts-building plumbing where it lives.
interface CronDeps {
  readSettings: () => Promise<any>;
  writeSettings: (patch: any) => Promise<void>;
  // Build the full agentSend opts for a workspace and run one turn. Mirrors the
  // `agent:send` IPC handler but with an explicit workspace + cron fields.
  runAgentTurn: (
    args: { workspacePath: string; sessionId: string; text: string; unattended: boolean; source: string; cronTitle: string },
    emit: (event: any) => void,
  ) => Promise<void>;
  getWindow: () => BrowserWindow | null;
}

let deps: CronDeps | null = null;
let activeWs: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;          // a cron/manual run is executing for activeWs
let runningJobName: string | null = null;
let ticking = false;           // re-entrancy guard for the async tick

export function initCron(d: CronDeps) { deps = d; }

// ---- lifecycle (tied to the workspace watcher in main) ------------------------

export function cronActivate(workspacePath: string) {
  if (activeWs === workspacePath && timer) return;
  activeWs = workspacePath;
  if (!timer) timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick(); // immediate catch-up on activate
}

export function cronDeactivate() {
  activeWs = null;
  if (timer) { clearInterval(timer); timer = null; }
}

// Called by the workspace watcher when cron.json changes (promptness only —
// the 60s tick would catch it anyway). Reconciles + refires the tick.
export function cronOnFileChanged() { void tick(); }

// ---- helpers ------------------------------------------------------------------

function cronPath(ws: string) { return path.join(ws, CRON_FILE); }

async function readCron(ws: string): Promise<{ exists: boolean; jobs: any[]; fileError: string | null }> {
  let text: string;
  try {
    text = await fs.readFile(cronPath(ws), 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { exists: false, jobs: [], fileError: null };
    return { exists: false, jobs: [], fileError: `Could not read cron.json — ${e?.message ?? e}` };
  }
  const { jobs, fileError } = parseCronJobs(text);
  return { exists: true, jobs, fileError };
}

const clampHours = (n: any) => Math.min(720, Math.max(1, Math.round(Number(n) || 36)));
const clampMinutes = (n: any) => Math.min(240, Math.max(1, Math.round(Number(n) || 30)));

// Is any agent (cron's own run OR the user's interactive chat) running in this
// workspace? Cron defers to all of them — the user always wins.
function anyAgentBusy(ws: string): boolean {
  return agentRunningSessions().some((id) => {
    const row = getSession(id);
    return !!row && row.workspace === ws;
  });
}

// Reconcile cron_state rows against the current cron.json. `masterOn` gates
// whether a schedulable job carries a nextRunAt. Pure DB side effects.
function reconcile(ws: string, jobs: any[], masterOn: boolean) {
  const states = listCronState(ws);
  const byName = new Map(states.map((s) => [s.jobName, s]));
  const now = Date.now();
  const keep: string[] = [];
  for (const job of jobs) {
    if (!job.name) continue; // unnamed → can't key; skip (still shown in UI)
    keep.push(job.name);
    const st = byName.get(job.name);
    const schedulable = masterOn && job.enabled && !job.invalid;
    const baseline = () => nextAfter(job.schedule, now, localTz());
    if (!st) {
      ensureCronRow({ workspace: ws, jobName: job.name, schedule: job.schedule, nextRunAt: schedulable ? baseline() : null, now });
    } else if (st.schedule !== job.schedule) {
      // Schedule edited → reset timing from now.
      updateCronState(ws, job.name, { schedule: job.schedule, nextRunAt: schedulable ? baseline() : null }, now);
    } else if (!schedulable && st.nextRunAt != null) {
      updateCronState(ws, job.name, { nextRunAt: null }, now); // disabled / invalid / master off → clear
    } else if (schedulable && st.nextRunAt == null) {
      updateCronState(ws, job.name, { nextRunAt: baseline() }, now); // (re)enabled → baseline
    }
  }
  pruneCronState(ws, keep);
}

// ---- the tick -----------------------------------------------------------------

async function tick() {
  if (!deps || !activeWs || ticking) return;
  const ws = activeWs;
  ticking = true;
  try {
    const settings = await deps.readSettings();
    const cron = settings.cron || {};
    const masterOn = !!cron.enabled;
    const windowHours = clampHours(cron.maxCatchupHours);

    const { jobs } = await readCron(ws);
    reconcile(ws, jobs, masterOn);
    pushState();

    if (!masterOn) return;                 // master gates FIRING only
    if (inFlight || anyAgentBusy(ws)) return; // one run at a time; user wins

    const states = listCronState(ws);
    const nextByName = new Map(states.map((s) => [s.jobName, s.nextRunAt]));
    const plan = planTick(jobs, nextByName, Date.now(), windowHours, localTz());
    const now = Date.now();
    for (const rf of plan.rollForward) updateCronState(ws, rf.name, { nextRunAt: rf.nextRunAt }, now);
    if (plan.fire) {
      // Scheduler is the sole writer of nextRunAt: advance at attempt time.
      updateCronState(ws, plan.fire.name, { nextRunAt: plan.fire.nextRunAt }, now);
      void runJob(ws, plan.fire.job, { manual: false }); // fire-and-forget; inFlight set synchronously inside
    }
  } catch (e: any) {
    console.warn('[cron] tick failed', e?.message ?? e);
  } finally {
    ticking = false;
  }
}

// ---- firing a run (scheduled OR manual go through here) -----------------------

async function runJob(ws: string, job: any, { manual }: { manual: boolean }): Promise<{ ok?: boolean; busy?: boolean; sessionId?: string }> {
  if (!deps) return { busy: true };
  if (inFlight || anyAgentBusy(ws)) return { busy: true };
  inFlight = true;                 // set synchronously before any await
  runningJobName = job.name;
  const sessionId = randomUUID();
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  try {
    const settings = await deps.readSettings();
    const maxRunMin = clampMinutes(settings.cron?.maxRunMinutes);
    const emit = (event: any) => {
      const w = deps!.getWindow();
      if (w && !w.isDestroyed()) w.webContents.send('agent:event', event);
    };
    pushChats(); // a background chat is being created — let the sidebar refetch

    const run = deps.runAgentTurn(
      { workspacePath: ws, sessionId, text: job.prompt, unattended: true, source: 'cron', cronTitle: job.name },
      emit,
    );
    const timeout = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error(`Run exceeded ${maxRunMin} min`)), maxRunMin * 60_000);
    });
    await Promise.race([run, timeout]);
    // Success: record last-run/session; DO NOT touch nextRunAt (scheduler owns it).
    updateCronState(ws, job.name, { lastRunAt: Date.now(), lastError: null, lastSessionId: sessionId }, Date.now());
  } catch (e: any) {
    try { await agentAbort(sessionId); } catch { /* best-effort */ }
    updateCronState(ws, job.name, { lastRunAt: Date.now(), lastError: e?.message ?? String(e), lastSessionId: sessionId }, Date.now());
  } finally {
    if (watchdog) clearTimeout(watchdog);
    inFlight = false;
    runningJobName = null;
    pushState();
    pushChats();
  }
  return { ok: true, sessionId };
}

// ---- IPC-facing API (called from cron:* handlers in main) ---------------------

// Everything the modal renders: jobs (from cron.json), timing (from cron_state),
// and the global knobs. Self-contained so the renderer always gets fresh data.
export async function cronRead(): Promise<any> {
  const ws = activeWs;
  const settings = deps ? await deps.readSettings() : null;
  const cron = settings?.cron || { enabled: false, maxCatchupHours: 36, maxRunMinutes: 30 };
  if (!ws) {
    return { activeWorkspace: null, enabled: !!cron.enabled, maxCatchupHours: clampHours(cron.maxCatchupHours), maxRunMinutes: clampMinutes(cron.maxRunMinutes), jobs: [], fileError: null, exists: false, inFlight, runningJobName };
  }
  const { exists, jobs, fileError } = await readCron(ws);
  const states = listCronState(ws);
  const byName = new Map(states.map((s) => [s.jobName, s]));
  const now = Date.now();
  const merged = jobs.map((j) => {
    const st = byName.get(j.name) || null;
    // `nextRunAt` here is for DISPLAY — the next occurrence of the schedule from
    // now, computed live for any valid job so "next" is always meaningful even
    // when the master switch is off (whether it actually FIRES is the master
    // toggle's job, surfaced separately in the UI). The scheduler uses the DB
    // row's own nextRunAt, not this.
    const nextOccurrence = (j.name && !j.invalid) ? nextAfter(j.schedule, now, localTz()) : null;
    return {
      name: j.name, schedule: j.schedule, enabled: j.enabled, invalid: j.invalid,
      description: describeSchedule(j.schedule),
      nextRunAt: nextOccurrence,
      lastRunAt: st?.lastRunAt ?? null,
      lastError: st?.lastError ?? null,
      lastSessionId: st?.lastSessionId ?? null,
    };
  });
  return {
    activeWorkspace: ws, exists, fileError,
    enabled: !!cron.enabled,
    maxCatchupHours: clampHours(cron.maxCatchupHours),
    maxRunMinutes: clampMinutes(cron.maxRunMinutes),
    jobs: merged, inFlight, runningJobName,
  };
}

// Master on/off. Persists, then reconciles (off→on baselines; on→off clears).
export async function cronSetEnabled(enabled: boolean): Promise<void> {
  if (!deps) return;
  await writeCronSetting({ enabled: !!enabled });
  if (activeWs) {
    const { jobs } = await readCron(activeWs);
    reconcile(activeWs, jobs, !!enabled);
  }
  void tick();
}

export async function cronSetMaxCatchupHours(n: number): Promise<void> {
  await writeCronSetting({ maxCatchupHours: clampHours(n) });
  pushState();
}

export async function cronSetMaxRunMinutes(n: number): Promise<void> {
  await writeCronSetting({ maxRunMinutes: clampMinutes(n) });
  pushState();
}

// Flip a job's enabled flag in cron.json (read-modify-write, preserving other
// fields). The watcher self-echo is harmless (reconcile is idempotent), but we
// reconcile immediately for snappy UI.
export async function cronSetJobEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!activeWs) return { ok: false, error: 'No active workspace.' };
  let text: string;
  try { text = await fs.readFile(cronPath(activeWs), 'utf8'); }
  catch (e: any) { return { ok: false, error: `Could not read cron.json — ${e?.message ?? e}` }; }
  let arr: any;
  try { arr = JSON.parse(text); } catch (e: any) { return { ok: false, error: 'cron.json is not valid JSON.' }; }
  if (!Array.isArray(arr)) return { ok: false, error: 'cron.json must be an array.' };
  const entry = arr.find((j) => typeof j?.name === 'string' && j.name.trim() === name);
  if (!entry) return { ok: false, error: `No job named "${name}".` };
  entry.enabled = !!enabled;
  await fs.writeFile(cronPath(activeWs), JSON.stringify(arr, null, 2) + '\n', 'utf8');
  void tick();
  return { ok: true };
}

// Manual "Run now": same runJob, out-of-band (never touches nextRunAt), works
// even when cron/the job is disabled. Sourced from the live file (last-good),
// so a currently-malformed file doesn't break Run-now for a job you can see.
export async function cronRunNow(name: string): Promise<{ ok?: boolean; busy?: boolean; error?: string }> {
  if (!activeWs) return { error: 'No active workspace.' };
  if (inFlight || anyAgentBusy(activeWs)) return { busy: true };
  const { jobs } = await readCron(activeWs);
  const job = jobs.find((j) => j.name === name);
  if (!job) return { error: `No job named "${name}".` };
  if (!job.prompt?.trim()) return { error: `Job "${name}" has no prompt.` };
  return runJob(activeWs, job, { manual: true });
}

export function cronWorkspaceRemoved(ws: string) {
  deleteCronStateForWorkspace(ws);
}

// ---- persistence + push -------------------------------------------------------

async function writeCronSetting(patch: Record<string, any>): Promise<void> {
  if (deps) await deps.writeSettings({ cron: patch });
}

function send(channel: string, payload?: any) {
  const w = deps?.getWindow();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}
function pushState() { cronRead().then((v) => send('cron:state', v)).catch(() => {}); }
function pushChats() { send('cron:chatsChanged'); }
