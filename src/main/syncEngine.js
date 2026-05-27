// Per-workspace sync engine.
//
// One instance at a time, bound to the active workspace. Lifecycle:
//   start(workspacePath)  — kicks off the tick interval
//   stop()                — clears interval, awaits any in-flight tick
//
// Each tick (sequential, never overlapping with itself):
//   1. ask renderer to flush dirty editor tabs (with a timeout)
//   2. git status --porcelain  → if dirty, git add -A && git commit
//   3. git pull --rebase
//      └─ if rebase paused (conflict markers in file): emit 'paused', return
//   4. if local ahead of origin: git push
//
// Status is pushed to the renderer via `sync:status` events whenever the
// engine state changes. The renderer's status icon consumes these.
//
// Conflicts: deferred. If pull --rebase pauses with conflict markers in
// files, we surface 'paused' and stop ticking. The user resolves (or asks
// the agent to) and we'll add a `rebase --continue` resume path later.

import path from 'node:path';
import fs from 'node:fs/promises';
import { BrowserWindow } from 'electron';
import { gitSpawn, workspaceStatus } from './sync.js';

// ─── Engine state ──────────────────────────────────────────────────────────

let state = {
  running: false,           // is the tick interval armed?
  workspacePath: null,
  pat: null,
  intervalMs: 10_000,
  windowId: null,           // BrowserWindow target for status + flush events
  ticking: false,           // a tick is currently executing
  intervalHandle: null,
  pendingTickPromise: null, // resolves when current tick finishes (for stop())
};

// Status surfaced to the renderer. Status icon (task 6) maps these to icon
// states. The renderer reads `status` + `detail` + `lastSyncAt`.
const STATUS = Object.freeze({
  DISABLED: 'disabled',     // not configured (no origin in workspace)
  IDLE: 'idle',             // last tick ok, waiting for next
  SYNCING: 'syncing',       // a tick is in progress
  PAUSED: 'paused',         // rebase conflict, needs user resolution
  ERROR: 'error',           // last tick failed (auth/network/etc.)
});

let currentStatus = { status: STATUS.DISABLED, detail: '', lastSyncAt: null };

function emitStatus(patch) {
  currentStatus = { ...currentStatus, ...patch };
  const win = state.windowId ? BrowserWindow.fromId(state.windowId) : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('sync:status', currentStatus);
  }
}

export function getCurrentStatus() {
  return currentStatus;
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
  if (!win || win.isDestroyed()) return Promise.resolve();
  const token = nextFlushToken++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingFlushes.delete(token);
      resolve();
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
  entry.resolve();
}

// ─── Tick ──────────────────────────────────────────────────────────────────

async function isRebasePaused(workspacePath) {
  try {
    await fs.access(path.join(workspacePath, '.git', 'rebase-merge'));
    return true;
  } catch {}
  try {
    await fs.access(path.join(workspacePath, '.git', 'rebase-apply'));
    return true;
  } catch {}
  return false;
}

async function runTick() {
  if (!state.running) return;
  if (state.ticking) return; // serial: never overlap a tick with itself
  state.ticking = true;
  let tickResolve;
  state.pendingTickPromise = new Promise((res) => { tickResolve = res; });

  try {
    // If we're sitting in a paused rebase, don't try to do anything — the
    // user needs to resolve markers and call resume (resume path to come).
    if (await isRebasePaused(state.workspacePath)) {
      emitStatus({ status: STATUS.PAUSED, detail: 'Rebase paused — resolve conflicts' });
      return;
    }

    emitStatus({ status: STATUS.SYNCING, detail: 'Checking for local changes' });

    // 1. Flush dirty editor buffers to disk so step 2 sees them.
    await requestFlush();

    // Resolve the current branch once. We pass it explicitly to pull and push
    // so we don't depend on an upstream being configured (the first tick on
    // a freshly-init'd repo has no upstream yet).
    const branchRes = await gitSpawn(state.workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 });
    const branchName = branchRes.ok ? branchRes.stdout.trim() : 'main';

    // 2. Commit if local has changes.
    const status = await gitSpawn(state.workspacePath, ['status', '--porcelain'], { timeoutMs: 10_000 });
    if (!status.ok) {
      emitStatus({ status: STATUS.ERROR, detail: `git status failed: ${status.stderr.trim()}` });
      return;
    }
    const dirty = status.stdout.trim().length > 0;
    if (dirty) {
      emitStatus({ status: STATUS.SYNCING, detail: 'Committing local changes' });
      const add = await gitSpawn(state.workspacePath, ['add', '-A'], { timeoutMs: 30_000 });
      if (!add.ok) {
        emitStatus({ status: STATUS.ERROR, detail: `git add failed: ${add.stderr.trim()}` });
        return;
      }
      const msg = `Shockwave sync: ${new Date().toISOString()}`;
      const commit = await gitSpawn(state.workspacePath, ['commit', '-m', msg], { timeoutMs: 30_000 });
      if (!commit.ok) {
        emitStatus({ status: STATUS.ERROR, detail: `git commit failed: ${commit.stderr.trim()}` });
        return;
      }
    }

    // 3. Pull (rebase). Check first whether the remote branch actually exists
    // — on a freshly-created repo with no commits pushed yet, ls-remote shows
    // no heads, so pull would fail with "couldn't find remote ref". Skip the
    // pull in that case; the push step below will create the branch.
    emitStatus({ status: STATUS.SYNCING, detail: 'Fetching from origin' });
    const lsRemote = await gitSpawn(state.workspacePath, ['ls-remote', '--heads', 'origin', branchName], {
      pat: state.pat,
      timeoutMs: 30_000,
    });
    if (!lsRemote.ok) {
      const stderr = lsRemote.stderr.toLowerCase();
      if (stderr.includes('authentication') || stderr.includes('401') || stderr.includes('could not read username')) {
        emitStatus({ status: STATUS.PAUSED, detail: 'Authentication failed — check your PAT' });
        return;
      }
      emitStatus({ status: STATUS.ERROR, detail: `git ls-remote failed: ${lsRemote.stderr.trim()}` });
      return;
    }
    const remoteHasBranch = lsRemote.stdout.trim().length > 0;
    if (remoteHasBranch) {
      emitStatus({ status: STATUS.SYNCING, detail: 'Pulling from origin' });
      const pull = await gitSpawn(state.workspacePath, ['pull', '--rebase', '--autostash', 'origin', branchName], {
        pat: state.pat,
        timeoutMs: 60_000,
      });
      if (!pull.ok) {
        // Common causes: auth (401), network, or rebase conflict. Distinguish
        // by checking for paused rebase state and by string-matching stderr
        // for auth errors. Anything else → generic error (will retry next tick).
        if (await isRebasePaused(state.workspacePath)) {
          emitStatus({ status: STATUS.PAUSED, detail: 'Rebase paused — resolve conflicts in editor' });
          return;
        }
        const stderr = pull.stderr.toLowerCase();
        if (stderr.includes('authentication') || stderr.includes('401') || stderr.includes('could not read username')) {
          emitStatus({ status: STATUS.PAUSED, detail: 'Authentication failed — check your PAT' });
          return;
        }
        emitStatus({ status: STATUS.ERROR, detail: `git pull failed: ${pull.stderr.trim()}` });
        return;
      }
    }

    // 4. Push if ahead. Use --set-upstream the first time so subsequent
    // pulls/pushes can use the tracking branch.
    emitStatus({ status: STATUS.SYNCING, detail: 'Pushing to origin' });
    const push = await gitSpawn(state.workspacePath, ['push', '--set-upstream', 'origin', branchName], {
      pat: state.pat,
      timeoutMs: 60_000,
    });
    if (!push.ok) {
      const stderr = push.stderr.toLowerCase();
      if (stderr.includes('authentication') || stderr.includes('401') || stderr.includes('could not read username')) {
        emitStatus({ status: STATUS.PAUSED, detail: 'Authentication failed — check your PAT' });
        return;
      }
      // "Everything up-to-date" or "nothing to push" → not really an error.
      if (push.code !== 0 && !stderr.includes('up-to-date') && !stderr.includes('nothing to')) {
        emitStatus({ status: STATUS.ERROR, detail: `git push failed: ${push.stderr.trim()}` });
        return;
      }
    }

    emitStatus({ status: STATUS.IDLE, detail: '', lastSyncAt: Date.now() });
  } finally {
    state.ticking = false;
    tickResolve();
    state.pendingTickPromise = null;
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

export async function start({ workspacePath, pat, intervalSeconds, windowId }) {
  // Stop any previous engine instance first.
  await stop();
  if (!workspacePath || !pat) {
    state.windowId = windowId ?? state.windowId;
    emitStatus({ status: STATUS.DISABLED, detail: pat ? 'No workspace' : 'No PAT set', lastSyncAt: null });
    return;
  }
  // Verify the workspace actually has an origin — without one, sync is a
  // no-op. Surface 'disabled' so the icon hides itself.
  const ws = await workspaceStatus(workspacePath);
  if (!ws.hasOrigin) {
    state.windowId = windowId ?? state.windowId;
    emitStatus({ status: STATUS.DISABLED, detail: 'Workspace has no remote', lastSyncAt: null });
    return;
  }
  state.running = true;
  state.workspacePath = workspacePath;
  state.pat = pat;
  state.intervalMs = Math.max(5_000, Math.min(600_000, (intervalSeconds ?? 10) * 1000));
  state.windowId = windowId ?? state.windowId;
  emitStatus({ status: STATUS.IDLE, detail: '', lastSyncAt: null });
  // First tick fires immediately (so workspace switch picks up remote
  // changes without waiting up to 10s), then on the interval.
  state.intervalHandle = setInterval(runTick, state.intervalMs);
  // Don't await — let it run in the background and update status events.
  runTick().catch((err) => {
    emitStatus({ status: STATUS.ERROR, detail: `Tick failed: ${err.message}` });
  });
}

export async function stop() {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
  state.running = false;
  // Let any in-flight tick finish so we don't leave a partial commit/push.
  if (state.pendingTickPromise) {
    await state.pendingTickPromise.catch(() => {});
  }
  state.workspacePath = null;
  state.pat = null;
  emitStatus({ status: STATUS.DISABLED, detail: '', lastSyncAt: currentStatus.lastSyncAt });
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
