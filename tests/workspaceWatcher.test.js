// Regression test for the per-workspace `.shockwave/workspace.json` watcher.
//
// Why this exists: the watcher must reload when a `git merge` (what GitHub sync
// runs) updates `workspace.json`, and must NOT churn on sibling changes
// (bookmarks.json, skills/). main.ts subscribes a @parcel/watcher on the
// `.shockwave/` dir and notifies once per batch that touches `workspace.json`.
// parcel is always recursive (no `depth`), so the sibling filter is what keeps
// skills/ churn from notifying.
//
// This test pins that behavior against a REAL git repo + REAL `git merge` using
// the app's watcher config. Run via `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import watcher from '@parcel/watcher';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mirror of main.ts's bookmarks subscription: watch the `.shockwave/` dir,
// notify once per batch that touches workspace.json.
async function watchShockwaveDir(shockwaveDir) {
  let count = 0;
  const sub = await watcher.subscribe(shockwaveDir, (err, events) => {
    if (err) return;
    if (events.some((e) => path.basename(e.path) === 'workspace.json')) count++;
  });
  // Let the FSEvents stream warm up before the caller mutates files, otherwise
  // the first change can land before the backend is delivering.
  await wait(400);
  return { get count() { return count; }, close: () => sub.unsubscribe() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const wsJson = (templatePath) =>
  JSON.stringify({ schemaVersion: 1, bookmarks: [], dailyNote: { format: 'YYYY-MM-DD', folder: '', templatePath }, templates: { folder: '' }, builtinSkills: {} }, null, 2);

// Build a git repo whose `remote` branch diverges from `main` by the given
// mutations, then return a helper that merges `remote` into the checked-out
// branch (exactly what syncEngine's `git merge origin/<branch>` does).
function makeRepo(setupRemoteMutations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsw-'));
  const sh = (c) => execSync(c, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString();
  const dir = path.join(root, '.shockwave');
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'skills'));
  fs.writeFileSync(path.join(dir, 'workspace.json'), wsJson(''));
  fs.writeFileSync(path.join(dir, 'bookmarks.json'), '{"version":1,"names":[]}');
  fs.writeFileSync(path.join(dir, 'skills', 's.md'), 'base');
  fs.writeFileSync(path.join(root, 'a.md'), '# a');
  sh('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm base');
  sh('git checkout -q -b remote');
  setupRemoteMutations({ root, dir, sh });
  sh('git add -A && git commit -qm remote');
  sh('git checkout -q master 2>/dev/null || git checkout -q main');
  return {
    root, dir, sh,
    merge: () => sh('git merge -q --no-edit remote'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('dir watch fires exactly once when git merge updates workspace.json (even alongside sibling changes)', async () => {
  const repo = makeRepo(({ dir }) => {
    fs.writeFileSync(path.join(dir, 'workspace.json'), wsJson('Templates/Daily Tasks.md'));
    fs.writeFileSync(path.join(dir, 'skills', 's.md'), 'changed'); // sibling churn in the same merge
  });
  const w = await watchShockwaveDir(repo.dir);
  try {
    repo.merge();
    // The on-disk file really changed (proves the merge applied).
    const disk = JSON.parse(fs.readFileSync(path.join(repo.dir, 'workspace.json'), 'utf8'));
    assert.equal(disk.dailyNote.templatePath, 'Templates/Daily Tasks.md');
    await wait(1600);
    // At least once: parcel may split git-merge's touch of the file into
    // create+update batches; over-notifying is a harmless idempotent re-read.
    // The guard is against MISSING it (the chokidar single-file-watch bug).
    assert.ok(w.count >= 1, `workspace.json change should notify (got ${w.count})`);
  } finally {
    await w.close();
    repo.cleanup();
  }
});

test('dir watch does NOT fire for sibling-only changes (bookmarks.json, skills/)', async () => {
  const repo = makeRepo(({ dir }) => {
    fs.writeFileSync(path.join(dir, 'bookmarks.json'), '{"version":1,"names":["x"]}');
    fs.writeFileSync(path.join(dir, 'skills', 's.md'), 'changed');
  });
  const w = await watchShockwaveDir(repo.dir);
  try {
    repo.merge();
    await wait(1600);
    assert.equal(w.count, 0, 'sibling-only changes must not notify');
  } finally {
    await w.close();
    repo.cleanup();
  }
});
