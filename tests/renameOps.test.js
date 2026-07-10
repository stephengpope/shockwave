// Tests for the reference rewriters, driven the way App/watcher drive them:
// capture the rewrite context, rewrite, then re-key the cache. Uses an in-memory
// fs stub + a real metadataCache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteReferences, rewriteReferencesForMove, captureRewriteContext } from '../src/renderer/renameOps.js';
import { createMetadataCache } from '../src/renderer/metadataCache.js';

const WS = '/ws';

function makeWorld(files) {
  const fs = new Map();
  const cache = createMetadataCache();
  cache.setWorkspacePath(WS);
  const seed = [];
  for (const [rel, content] of Object.entries(files)) {
    const path = `${WS}/${rel}`;
    fs.set(path, content);
    seed.push({ path, content, mtime: 1 });
  }
  cache.rebuild(seed);
  const api = {
    readFile: async (p) => { if (!fs.has(p)) throw new Error(`ENOENT ${p}`); return fs.get(p); },
    writeFile: async (p, content) => { fs.set(p, content); return 2; },
  };
  return { fs, cache, api, read: (rel) => fs.get(`${WS}/${rel}`), p: (rel) => `${WS}/${rel}` };
}

// Rename helper mirroring App.renameFileWithTransitions' order.
async function rename(w, oldRel, newRel) {
  const oldPath = w.p(oldRel), finalPath = w.p(newRel);
  const oldBaseName = oldRel.split('/').pop().replace(/\.md$/i, '');
  const newBaseName = newRel.split('/').pop().replace(/\.md$/i, '');
  w.fs.set(finalPath, w.fs.get(oldPath)); w.fs.delete(oldPath);
  const ctx = captureRewriteContext(w.cache, oldPath);
  await rewriteReferences({ api: w.api, cache: w.cache, sources: ctx.sources, candidatesFor: ctx.candidatesFor, workspacePath: WS, oldPath, finalPath, oldBaseName, newBaseName });
  w.cache.renameFile(oldPath, finalPath);
}

test('rewrites references in other files', async () => {
  const w = makeWorld({ 'A.md': '[[Target]] in A', 'B.md': 'B has [[Target]] too', 'Target.md': 'x' });
  await rename(w, 'Target.md', 'Goal.md');
  assert.equal(w.read('A.md'), '[[Goal]] in A');
  assert.equal(w.read('B.md'), 'B has [[Goal]] too');
});

test('preserves #heading and |alias suffixes', async () => {
  const w = makeWorld({ 'A.md': '[[Old#Section]] and [[Old|Display]] and [[Old#H|D]]', 'Old.md': 'x' });
  await rename(w, 'Old.md', 'New.md');
  assert.equal(w.read('A.md'), '[[New#Section]] and [[New|Display]] and [[New#H|D]]');
});

test('case-insensitive match', async () => {
  const w = makeWorld({ 'A.md': 'link [[old]] here', 'Old.md': 'x' });
  await rename(w, 'Old.md', 'New.md');
  assert.equal(w.read('A.md'), 'link [[New]] here');
});

test('rewrites self-references in the renamed file', async () => {
  const w = makeWorld({ 'Foo.md': 'I am [[Foo]] and [[Foo]] again', 'Other.md': 'ref [[Foo]]' });
  await rename(w, 'Foo.md', 'Bar.md');
  assert.equal(w.read('Bar.md'), 'I am [[Bar]] and [[Bar]] again');
  assert.equal(w.read('Other.md'), 'ref [[Bar]]');
});

test('rename with no backlinks → no spurious writes', async () => {
  const w = makeWorld({ 'A.md': 'no links', 'Orphan.md': 'nobody links me' });
  await rename(w, 'Orphan.md', 'Lonely.md');
  assert.equal(w.read('A.md'), 'no links');
});

test('resolution-filtered: only the link resolving to the renamed file is rewritten', async () => {
  const w = makeWorld({
    'acme/Meeting.md': '# acme', 'globex/Meeting.md': '# globex',
    'acme/Notes.md': 'see [[Meeting]]', 'globex/Notes.md': 'see [[Meeting]]',
    'Index.md': 'top [[acme/Meeting]]',
  });
  await rename(w, 'acme/Meeting.md', 'acme/Standup.md');
  assert.equal(w.read('acme/Notes.md'), 'see [[Standup]]');    // same-folder → rewritten
  assert.equal(w.read('globex/Notes.md'), 'see [[Meeting]]');  // other duplicate → untouched
  assert.equal(w.read('Index.md'), 'top [[acme/Standup]]');    // path-qualified prefix preserved
});

// --- move re-qualification ---

async function move(w, oldRel, newRel) {
  const oldPath = w.p(oldRel), newPath = w.p(newRel);
  const ctx = captureRewriteContext(w.cache, oldPath);
  await rewriteReferencesForMove({ api: w.api, cache: w.cache, sources: ctx.sources, candidatesFor: ctx.candidatesFor, workspacePath: WS, oldPath, newPath });
  w.fs.set(newPath, w.fs.get(oldPath)); w.fs.delete(oldPath);
  w.cache.renameFile(oldPath, newPath);
}

test('move re-qualifies path-links when a duplicate moves', async () => {
  const w = makeWorld({
    'acme/Meeting.md': '# a', 'globex/Meeting.md': '# g',
    'acme/Notes.md': 'bare [[Meeting]]', 'Index.md': 'qualified [[acme/Meeting]]',
  });
  await move(w, 'acme/Meeting.md', 'archive/Meeting.md');
  assert.equal(w.read('acme/Notes.md'), 'bare [[archive/Meeting]]');
  assert.equal(w.read('Index.md'), 'qualified [[archive/Meeting]]');
});

test('move of a unique basename is a no-op (bare links self-heal)', async () => {
  const w = makeWorld({ 'a/Solo.md': '# s', 'Ref.md': 'link [[Solo]]' });
  const ctx = captureRewriteContext(w.cache, w.p('a/Solo.md'));
  const rewritten = await rewriteReferencesForMove({
    api: w.api, cache: w.cache, sources: ctx.sources, candidatesFor: ctx.candidatesFor,
    workspacePath: WS, oldPath: w.p('a/Solo.md'), newPath: w.p('b/Solo.md'),
  });
  assert.deepEqual(rewritten, []);
  assert.equal(w.read('Ref.md'), 'link [[Solo]]');
});
