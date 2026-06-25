// Regression test for the per-workspace `.shockwave/workspace.json` watcher.
//
// Why this exists: the watcher originally watched the single file
// `workspace.json`. In chokidar 5 a single-file watch unreliably drops the
// change event — a `git merge` that updated the file fired NOTHING, so synced
// daily-note / template / bookmark changes never reloaded in the renderer. The
// fix watches the `.shockwave/` DIR (depth 0) and filters to `workspace.json`.
//
// This test pins that behavior against a REAL git repo + REAL `git merge` (the
// exact thing GitHub sync does) using the app's exact chokidar config. If a
// future chokidar bump (or a revert to single-file watching) re-breaks it, this
// fails instead of silently shipping. Run via `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import chokidar from 'chokidar';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mirror of main.ts: watch the `.shockwave/` dir (depth 0), notify only for
// workspace.json. Returns { count, close } where count is read after the wait.
function watchShockwaveDir(shockwaveDir) {
  let count = 0;
  const w = chokidar.watch(shockwaveDir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  });
  const onEvt = (p) => {
    if (typeof p === 'string' && path.basename(p) === 'workspace.json') count++;
  };
  w.on('add', onEvt).on('change', onEvt);
  return { ready: new Promise((r) => w.on('ready', r)), get count() { return count; }, close: () => w.close() };
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
  const watcher = watchShockwaveDir(repo.dir);
  try {
    await watcher.ready;
    repo.merge();
    // The on-disk file really changed (proves the merge applied).
    const disk = JSON.parse(fs.readFileSync(path.join(repo.dir, 'workspace.json'), 'utf8'));
    assert.equal(disk.dailyNote.templatePath, 'Templates/Daily Tasks.md');
    await wait(700); // > stabilityThreshold
    assert.equal(watcher.count, 1, 'workspace.json change should notify exactly once');
  } finally {
    await watcher.close();
    repo.cleanup();
  }
});

test('dir watch does NOT fire for sibling-only changes (bookmarks.json, skills/)', async () => {
  const repo = makeRepo(({ dir }) => {
    fs.writeFileSync(path.join(dir, 'bookmarks.json'), '{"version":1,"names":["x"]}');
    fs.writeFileSync(path.join(dir, 'skills', 's.md'), 'changed');
  });
  const watcher = watchShockwaveDir(repo.dir);
  try {
    await watcher.ready;
    repo.merge();
    await wait(700);
    assert.equal(watcher.count, 0, 'sibling-only changes must not notify');
  } finally {
    await watcher.close();
    repo.cleanup();
  }
});
