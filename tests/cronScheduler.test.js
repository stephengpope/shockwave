// Unit tests for the pure cron scheduling math (src/main/cronScheduler.js).
// Everything is evaluated in a fixed UTC tz for determinism (the app uses the
// machine's local tz at runtime).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCronJobs, planTick, nextAfter, prevOccurrence, isValidCron, describeSchedule,
} from '../src/main/cronScheduler.js';

const TZ = 'UTC';
const validJob = (over = {}) => ({ name: 'j', schedule: '0 2 * * *', prompt: 'do', enabled: true, invalid: null, ...over });

test('parseCronJobs: valid array with defaults', () => {
  const { jobs, fileError } = parseCronJobs(JSON.stringify([
    { name: 'a', schedule: '0 2 * * *', prompt: 'x' },       // enabled defaults true
    { name: 'b', schedule: '*/5 * * * *', prompt: 'y', enabled: false },
  ]));
  assert.equal(fileError, null);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].enabled, true);
  assert.equal(jobs[0].invalid, null);
  assert.equal(jobs[1].enabled, false);
});

test('parseCronJobs: per-job invalidity is flagged, others kept', () => {
  const { jobs, fileError } = parseCronJobs(JSON.stringify([
    { name: 'ok', schedule: '0 2 * * *', prompt: 'x' },
    { name: 'badsched', schedule: 'nope', prompt: 'x' },
    { name: '', schedule: '* * * * *', prompt: 'x' },
    { name: 'noprompt', schedule: '* * * * *', prompt: '' },
    { name: 'ok', schedule: '* * * * *', prompt: 'dup' },     // duplicate name
  ]));
  assert.equal(fileError, null);
  assert.equal(jobs[0].invalid, null);
  assert.equal(jobs[1].invalid, 'invalid schedule');
  assert.equal(jobs[2].invalid, 'missing name');
  assert.equal(jobs[3].invalid, 'missing prompt');
  assert.equal(jobs[4].invalid, 'duplicate name');
});

test('parseCronJobs: bad JSON and non-array yield fileError', () => {
  assert.match(parseCronJobs('{not json').fileError, /not valid JSON/);
  assert.match(parseCronJobs('{"a":1}').fileError, /array/);
});

test('isValidCron', () => {
  assert.equal(isValidCron('0 2 * * *'), true);
  assert.equal(isValidCron('*/15 9-17 * * 1-5'), true);
  assert.equal(isValidCron('nope'), false);
  assert.equal(isValidCron(''), false);
});

test('planTick: H1 — a 55h-old stored next-run still fires when the most-recent occurrence is within the window', () => {
  // Daily 02:00. Stored next = Sat 02:00 (55h before Mon 09:00), but the most
  // recent occurrence is Mon 02:00 (7h ago) — inside a 36h window → FIRE once.
  const now = Date.UTC(2026, 0, 5, 9, 0, 0);       // Mon 09:00
  const storedNext = Date.UTC(2026, 0, 3, 2, 0, 0); // Sat 02:00
  const { fire, rollForward } = planTick(
    [validJob({ name: 'daily' })],
    new Map([['daily', storedNext]]), now, 36, TZ,
  );
  assert.ok(fire, 'should fire the collapsed catch-up run');
  assert.equal(fire.name, 'daily');
  assert.equal(rollForward.length, 0);
  // nextRunAt advanced to the next occurrence after now (Tue 02:00).
  assert.equal(fire.nextRunAt, Date.UTC(2026, 0, 6, 2, 0, 0));
});

test('planTick: too-stale (most-recent occurrence beyond window) rolls forward without firing', () => {
  // Weekly Monday 09:00, window 36h, now is Thursday — last Monday is ~3 days
  // ago, beyond 36h → roll forward, do not fire.
  const now = Date.UTC(2026, 0, 22, 9, 0, 0);        // Thu
  const storedNext = Date.UTC(2026, 0, 19, 9, 0, 0); // that Monday
  const { fire, rollForward } = planTick(
    [validJob({ name: 'wk', schedule: '0 9 * * 1' })],
    new Map([['wk', storedNext]]), now, 36, TZ,
  );
  assert.equal(fire, null);
  assert.equal(rollForward.length, 1);
  assert.equal(rollForward[0].name, 'wk');
  assert.equal(rollForward[0].nextRunAt, Date.UTC(2026, 0, 26, 9, 0, 0)); // next Monday
});

test('planTick: among several due jobs, the single longest-overdue fires; others untouched', () => {
  const now = Date.UTC(2026, 0, 5, 9, 0, 0);
  const jobs = [
    validJob({ name: 'recent', schedule: '0 8 * * *' }),  // 08:00 → 1h ago
    validJob({ name: 'older', schedule: '0 3 * * *' }),   // 03:00 → 6h ago (longest overdue)
  ];
  const next = new Map([
    ['recent', Date.UTC(2026, 0, 5, 8, 0, 0)],
    ['older', Date.UTC(2026, 0, 5, 3, 0, 0)],
  ]);
  const { fire, rollForward } = planTick(jobs, next, now, 36, TZ);
  assert.equal(fire.name, 'older');
  assert.equal(rollForward.length, 0); // 'recent' stays due (not rolled), fires a later tick
});

test('planTick: tie-break by name when next-run is equal', () => {
  const now = Date.UTC(2026, 0, 5, 9, 0, 0);
  const stored = Date.UTC(2026, 0, 5, 2, 0, 0);
  const jobs = [validJob({ name: 'zebra' }), validJob({ name: 'apple' })];
  const next = new Map([['zebra', stored], ['apple', stored]]);
  const { fire } = planTick(jobs, next, now, 36, TZ);
  assert.equal(fire.name, 'apple');
});

test('planTick: disabled, invalid, null-next, and not-yet-due jobs never fire', () => {
  const now = Date.UTC(2026, 0, 5, 9, 0, 0);
  const past = Date.UTC(2026, 0, 5, 2, 0, 0);
  const future = Date.UTC(2026, 0, 5, 23, 0, 0);
  const jobs = [
    validJob({ name: 'disabled', enabled: false }),
    validJob({ name: 'invalid', invalid: 'invalid schedule' }),
    validJob({ name: 'cleared' }),   // null nextRunAt
    validJob({ name: 'future' }),
  ];
  const next = new Map([
    ['disabled', past], ['invalid', past], ['cleared', null], ['future', future],
  ]);
  const { fire, rollForward } = planTick(jobs, next, now, 36, TZ);
  assert.equal(fire, null);
  assert.equal(rollForward.length, 0);
});

test('nextAfter / prevOccurrence are strict and bracket now', () => {
  const now = Date.UTC(2026, 0, 5, 9, 0, 0);
  assert.equal(nextAfter('0 2 * * *', now, TZ), Date.UTC(2026, 0, 6, 2, 0, 0));
  assert.equal(prevOccurrence('0 2 * * *', now, TZ), Date.UTC(2026, 0, 5, 2, 0, 0));
});

test('describeSchedule: common shapes', () => {
  assert.equal(describeSchedule('0 2 * * *'), 'Every day at 02:00');
  assert.equal(describeSchedule('30 9 * * 1'), 'Mon at 09:30');
  assert.equal(describeSchedule('15 * * * *'), 'Hourly at :15');
  assert.equal(describeSchedule('*/5 9-17 * * 1-5'), '*/5 9-17 * * 1-5'); // echoes uncommon
});
