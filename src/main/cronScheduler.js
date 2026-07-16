// Pure cron scheduling logic — no fs, no db, no timers, no Electron. Kept as a
// plain `.js` ESM module (like linkParser.js / watcherDispatch.js) so it runs
// directly under `node --test` without a TS loader. The stateful controller
// that reads cron.json, writes the DB, and fires runs lives in `cron.ts` and
// calls into here.
//
// Schedules are standard 5-field cron expressions evaluated in the machine's
// LOCAL time (single-user desktop app — "0 8 * * *" means 8am your time).

import { CronExpressionParser } from 'cron-parser';

export const CRON_FILE = 'cron.json';

// The machine's IANA timezone (e.g. 'America/New_York'). Resolved per call so a
// travel/tz change takes effect without an app restart. Falls back to UTC.
export function localTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidCron(schedule) {
  if (typeof schedule !== 'string' || !schedule.trim()) return false;
  try {
    CronExpressionParser.parse(schedule, { tz: 'UTC' });
    return true;
  } catch {
    return false;
  }
}

// Next fire time strictly after `fromMs` (epoch ms), in local tz.
export function nextAfter(schedule, fromMs, tz = localTz()) {
  return CronExpressionParser.parse(schedule, { currentDate: new Date(fromMs), tz }).next().getTime();
}

// Most-recent scheduled occurrence before `fromMs` (epoch ms), in local tz.
// Used for the catch-up window: we measure staleness from the LATEST missed
// occurrence, not the oldest stored next-run, so one ancient miss can't cancel
// a recent run the user still wants.
export function prevOccurrence(schedule, fromMs, tz = localTz()) {
  return CronExpressionParser.parse(schedule, { currentDate: new Date(fromMs), tz }).prev().getTime();
}

// Parse + validate cron.json text into annotated jobs. Skip-bad / keep-good:
// a single malformed job is flagged (`invalid`) but the rest stay usable;
// only unparseable JSON / non-array yields a whole-file error.
//
// Returns { jobs, fileError }. Each job: { name, schedule, prompt, enabled,
// invalid: string|null, index }. `enabled` defaults true when omitted.
export function parseCronJobs(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { jobs: [], fileError: `cron.json is not valid JSON — ${e.message}` };
  }
  if (!Array.isArray(data)) {
    return { jobs: [], fileError: 'cron.json must be a JSON array of jobs.' };
  }
  const seen = new Set();
  const jobs = data.map((raw, index) => {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    const schedule = typeof raw?.schedule === 'string' ? raw.schedule.trim() : '';
    const prompt = typeof raw?.prompt === 'string' ? raw.prompt : '';
    const enabled = raw?.enabled !== false; // default true
    const key = name.toLowerCase();
    let invalid = null;
    if (!name) invalid = 'missing name';
    else if (seen.has(key)) invalid = 'duplicate name';
    else if (!prompt.trim()) invalid = 'missing prompt';
    else if (!isValidCron(schedule)) invalid = 'invalid schedule';
    if (name) seen.add(key);
    return { name, schedule, prompt, enabled, invalid, index };
  });
  return { jobs, fileError: null };
}

// Decide what to do this tick. Pure: given the parsed jobs, a map of
// name -> stored nextRunAt (epoch ms | null), the current time, and the
// catch-up window, return:
//   { fire, rollForward }
// - fire: the SINGLE longest-overdue due job to run now (smallest stored
//   nextRunAt; tie-break by name), with its advanced nextRunAt — or null.
// - rollForward: due-but-too-stale jobs to advance WITHOUT firing.
// Non-chosen due jobs are intentionally left untouched (still due) so they
// fire on a later tick — one run at a time, no queue.
export function planTick(jobs, nextRunByName, nowMs, windowHours, tz = localTz()) {
  const windowMs = Math.max(0, windowHours) * 3600_000;
  const rollForward = [];
  const candidates = [];
  for (const job of jobs) {
    if (job.invalid || !job.enabled) continue;
    const storedNext = nextRunByName.get(job.name);
    if (typeof storedNext !== 'number') continue; // null/cleared → not scheduled
    if (storedNext > nowMs) continue; // not due yet
    const prev = prevOccurrence(job.schedule, nowMs, tz);
    const advanced = nextAfter(job.schedule, nowMs, tz);
    if (nowMs - prev <= windowMs) {
      candidates.push({ name: job.name, job, storedNext, advanced });
    } else {
      rollForward.push({ name: job.name, nextRunAt: advanced });
    }
  }
  candidates.sort((a, b) => a.storedNext - b.storedNext || a.name.localeCompare(b.name));
  const chosen = candidates[0] || null;
  return {
    fire: chosen ? { name: chosen.name, job: chosen.job, nextRunAt: chosen.advanced } : null,
    rollForward,
  };
}

// A light human description of a 5-field schedule for the UI. Best-effort: it
// recognizes a few common shapes and otherwise echoes the raw expression.
export function describeSchedule(schedule) {
  if (!isValidCron(schedule)) return schedule || '(none)';
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hr, dom, mon, dow] = parts;
  const at = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const numeric = (s) => /^\d+$/.test(s);
  if (numeric(min) && numeric(hr) && dom === '*' && mon === '*' && dow === '*') {
    return `Every day at ${at(hr, min)}`;
  }
  if (numeric(min) && numeric(hr) && dom === '*' && mon === '*' && numeric(dow)) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[Number(dow) % 7]} at ${at(hr, min)}`;
  }
  if (numeric(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Hourly at :${String(min).padStart(2, '0')}`;
  }
  return schedule;
}
