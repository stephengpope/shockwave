// Folder classification for the add-workspace flow, against REAL git repos in
// tmp dirs (same posture as workspaceWatcher.test.js — the thing being tested is
// what git actually reports, so stubbing git would test the stub).
//
// This is the decision the whole flow hangs off: a workspace IS a GitHub repo,
// so before anything else the app has to know whether the folder you picked is
// empty (clone into it), already a checkout (attach to it), or unusable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { classifyFolder, parseGithubUrl, cloneUrlFor, repoMismatch } from '../src/main/workspaceFolder.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'shockwave-ws-'));
}

// A real repo with one commit, so HEAD resolves and `rev-parse` reports a branch.
function initRepo(dir, { origin, branch = 'main' } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', branch);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  execFileSync('touch', ['README.md'], { cwd: dir });
  git('add', '-A');
  git('commit', '-m', 'init');
  if (origin) git('remote', 'add', 'origin', origin);
}

// ─── empty ─────────────────────────────────────────────────────────────────

test('an empty folder is clonable-into', async () => {
  const dir = await tmpDir();
  assert.equal((await classifyFolder(dir)).state, 'empty');
});

test('dotfiles and .DS_Store do not make a folder occupied', async () => {
  // A failed clone's leftovers, or Finder's droppings. Refusing here would send
  // the user off to delete invisible files.
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, '.DS_Store'), 'x');
  await fs.writeFile(path.join(dir, '.hidden'), 'x');
  assert.equal((await classifyFolder(dir)).state, 'empty');
});

// ─── clone ─────────────────────────────────────────────────────────────────

test('a github https clone reports its repo and branch', async () => {
  const dir = await tmpDir();
  initRepo(dir, { origin: 'https://github.com/acme/widgets.git' });
  const info = await classifyFolder(dir);
  assert.equal(info.state, 'clone');
  assert.equal(info.repoOwner, 'acme');
  assert.equal(info.repoName, 'widgets');
  assert.equal(info.defaultBranch, 'main');
});

test('a github ssh clone is recognised too', async () => {
  const dir = await tmpDir();
  initRepo(dir, { origin: 'git@github.com:acme/widgets.git' });
  const info = await classifyFolder(dir);
  assert.equal(info.state, 'clone');
  assert.equal(info.repoOwner, 'acme');
  assert.equal(info.repoName, 'widgets');
});

test('the branch reported is what is CHECKED OUT, not an assumed default', async () => {
  // The workspace row stores this and the sync engine pushes to it, so reading
  // it off the checkout is the only answer that can't be stale.
  const dir = await tmpDir();
  initRepo(dir, { origin: 'https://github.com/acme/widgets.git', branch: 'develop' });
  const info = await classifyFolder(dir);
  assert.equal(info.state, 'clone');
  assert.equal(info.defaultBranch, 'develop');
});

// ─── occupied ──────────────────────────────────────────────────────────────

test('files with no .git are refused', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'notes.md'), '# hi');
  const info = await classifyFolder(dir);
  assert.equal(info.state, 'occupied');
  assert.match(info.error, /isn't a git repo/);
});

test('a git repo with no origin is refused', async () => {
  const dir = await tmpDir();
  initRepo(dir);
  const info = await classifyFolder(dir);
  assert.equal(info.state, 'occupied');
  assert.match(info.error, /origin/);
});

test('a git repo whose origin is not GitHub is refused', async () => {
  // Sync is GitHub-only (hardcoded api.github.com), so adopting a gitlab
  // checkout would produce a workspace that can never push.
  const dir = await tmpDir();
  initRepo(dir, { origin: 'https://gitlab.com/acme/widgets.git' });
  const info = await classifyFolder(dir);
  assert.equal(info.state, 'occupied');
  assert.match(info.error, /GitHub/);
});

test('a folder that does not exist is refused, not crashed on', async () => {
  const info = await classifyFolder(path.join(os.tmpdir(), 'shockwave-does-not-exist-xyz'));
  assert.equal(info.state, 'occupied');
  assert.match(info.error, /Can't read/);
});

test('an empty path is refused', async () => {
  assert.equal((await classifyFolder('')).state, 'occupied');
});

// ─── repo match guard ──────────────────────────────────────────────────────

test('repoMismatch passes a folder holding the workspace\'s own repo', () => {
  const info = { repoOwner: 'acme', repoName: 'widgets' };
  assert.equal(repoMismatch(info, { repoOwner: 'acme', repoName: 'widgets' }), null);
});

test('repoMismatch names BOTH repos when they differ', () => {
  // Attaching a row to a folder holding a different repo would make the row lie
  // about its own contents, and the engine would push one repo at another.
  const err = repoMismatch(
    { repoOwner: 'acme', repoName: 'widgets' },
    { repoOwner: 'acme', repoName: 'gadgets', name: 'Gadgets' },
  );
  assert.match(err, /acme\/widgets/);
  assert.match(err, /acme\/gadgets/);
});

test('repoMismatch is case-sensitive on the repo name', () => {
  // GitHub treats owner/name case-insensitively for lookup but we compare what
  // we stored against what git reported; both come from GitHub, so a difference
  // here means a genuinely different remote rather than a spelling variant.
  assert.notEqual(repoMismatch(
    { repoOwner: 'acme', repoName: 'Widgets' },
    { repoOwner: 'acme', repoName: 'widgets' },
  ), null);
});

// ─── URL parsing ───────────────────────────────────────────────────────────

test('parseGithubUrl accepts the forms git actually stores', () => {
  const expected = { owner: 'acme', repo: 'widgets' };
  for (const url of [
    'https://github.com/acme/widgets.git',
    'https://github.com/acme/widgets',
    'http://github.com/acme/widgets',
    'github.com/acme/widgets',
    'www.github.com/acme/widgets',
    'git@github.com:acme/widgets.git',
    'git@github.com:acme/widgets',
  ]) {
    assert.deepEqual(parseGithubUrl(url), expected, url);
  }
});

test('parseGithubUrl rejects non-GitHub and malformed input', () => {
  for (const url of [
    'https://gitlab.com/acme/widgets.git',
    'https://github.com/acme',        // no repo
    '/Users/me/notes',                // a path
    'not a url',
    '',
    null,
    undefined,
  ]) {
    assert.equal(parseGithubUrl(url), null, String(url));
  }
});

test('parseGithubUrl keeps dots in a repo name and strips only a trailing .git', () => {
  // Real case from this project's own workspaces: `kontentengine.io`.
  assert.deepEqual(
    parseGithubUrl('https://github.com/stephengpope/kontentengine.io.git'),
    { owner: 'stephengpope', repo: 'kontentengine.io' },
  );
  assert.deepEqual(
    parseGithubUrl('https://github.com/stephengpope/kontentengine.io'),
    { owner: 'stephengpope', repo: 'kontentengine.io' },
  );
});

test('cloneUrlFor round-trips through parseGithubUrl', () => {
  assert.deepEqual(parseGithubUrl(cloneUrlFor('acme', 'widgets')), { owner: 'acme', repo: 'widgets' });
});
