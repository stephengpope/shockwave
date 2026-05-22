// Unit tests for the rename correlator (pure logic, no fs/chokidar).
// Run via `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenameCorrelator } from '../electron/renameCorrelator.js';

function setup(opts = {}) {
  const emitted = [];
  const corr = createRenameCorrelator({
    emit: (e) => emitted.push(e),
    graceMs: opts.graceMs ?? 1000,
    now: opts.now,
  });
  return { corr, emitted };
}

test('single rename: pairs unlink+add by inode', () => {
  const { corr, emitted } = setup();
  corr.onPathSeen('/a.md', '100', 'hashA');
  corr.onPathGone('/a.md');
  corr.onPathAppeared('/b.md', '100', 'hashA');
  assert.deepEqual(emitted, [{ type: 'rename', oldPath: '/a.md', newPath: '/b.md' }]);
});

test('add of brand-new file: emits add', () => {
  const { corr, emitted } = setup();
  corr.onPathAppeared('/new.md', '200', 'hashNew');
  assert.deepEqual(emitted, [{ type: 'add', path: '/new.md' }]);
});

test('real delete: emits unlink after grace expires', async () => {
  const { corr, emitted } = setup({ graceMs: 50 });
  corr.onPathSeen('/del.md', '300', 'hashDel');
  corr.onPathGone('/del.md');
  assert.deepEqual(emitted, []);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(emitted, [{ type: 'unlink', path: '/del.md' }]);
});

test('batch rename of 10 files: each pairs by ino', () => {
  const { corr, emitted } = setup();
  // seed identities
  for (let i = 0; i < 10; i++) corr.onPathSeen(`/old-${i}.md`, String(i + 1000), `h${i}`);
  // chokidar emits all unlinks first, then all adds
  for (let i = 0; i < 10; i++) corr.onPathGone(`/old-${i}.md`);
  for (let i = 0; i < 10; i++) corr.onPathAppeared(`/new-${i}.md`, String(i + 1000), `h${i}`);

  assert.equal(emitted.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(emitted[i], { type: 'rename', oldPath: `/old-${i}.md`, newPath: `/new-${i}.md` });
  }
});

test('rename + simultaneous delete: rename matches, delete commits later', async () => {
  const { corr, emitted } = setup({ graceMs: 50 });
  corr.onPathSeen('/ren-src.md', '500', 'hashR');
  corr.onPathSeen('/del.md', '501', 'hashD');

  // Simultaneous: 2 unlinks, then 1 add
  corr.onPathGone('/ren-src.md');
  corr.onPathGone('/del.md');
  corr.onPathAppeared('/ren-dst.md', '500', 'hashR');

  // Immediate: rename emitted, delete still pending
  assert.deepEqual(emitted, [{ type: 'rename', oldPath: '/ren-src.md', newPath: '/ren-dst.md' }]);

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(emitted[1], { type: 'unlink', path: '/del.md' });
});

test('hash fallback: ino missing on both sides, hash matches', () => {
  const { corr, emitted } = setup();
  // Simulate FAT-like: ino is null
  corr.onPathSeen('/a.md', null, 'samehash');
  corr.onPathGone('/a.md');
  corr.onPathAppeared('/b.md', null, 'samehash');
  assert.deepEqual(emitted, [{ type: 'rename', oldPath: '/a.md', newPath: '/b.md' }]);
});

test('hash fallback: ino mismatch falls through to hash match', () => {
  // Pathological: filesystem returns different inos for same file pre/post rename.
  // We expect hash to save us.
  const { corr, emitted } = setup();
  corr.onPathSeen('/a.md', '100', 'samehash');
  corr.onPathGone('/a.md');
  corr.onPathAppeared('/b.md', '200', 'samehash');  // ino differs but hash matches
  assert.deepEqual(emitted, [{ type: 'rename', oldPath: '/a.md', newPath: '/b.md' }]);
});

test('ino wins over hash when both could match', () => {
  // Two unlinks pending: one with matching ino, one with matching hash.
  const { corr, emitted } = setup();
  corr.onPathSeen('/a.md', '100', 'hashCommon');
  corr.onPathSeen('/c.md', '300', 'hashCommon');
  corr.onPathGone('/a.md');
  corr.onPathGone('/c.md');
  // Add with ino matching A and hash matching both -> ino should win
  corr.onPathAppeared('/b.md', '100', 'hashCommon');
  assert.deepEqual(emitted, [{ type: 'rename', oldPath: '/a.md', newPath: '/b.md' }]);
});

test('hash collision: oldest pending wins (deterministic)', () => {
  // Two unlinks with same hash, no ino. Add with same hash. We should pair
  // with the OLDEST buffered unlink for determinism.
  let nowMs = 1000;
  const { corr, emitted } = setup({ now: () => nowMs });
  corr.onPathSeen('/older.md', null, 'samehash');
  corr.onPathGone('/older.md');
  nowMs += 10;
  corr.onPathSeen('/newer.md', null, 'samehash');
  corr.onPathGone('/newer.md');
  corr.onPathAppeared('/new.md', null, 'samehash');
  assert.deepEqual(emitted, [{ type: 'rename', oldPath: '/older.md', newPath: '/new.md' }]);
});

test('add for path we already knew about (path collision): no false rename', () => {
  // If unlink for /a.md is buffered with ino=100, and an add comes in for a
  // DIFFERENT path with a DIFFERENT ino and DIFFERENT hash, we should NOT
  // pair them.
  const { corr, emitted } = setup();
  corr.onPathSeen('/a.md', '100', 'hashA');
  corr.onPathGone('/a.md');
  corr.onPathAppeared('/totally-new.md', '999', 'hashNew');
  assert.deepEqual(emitted, [{ type: 'add', path: '/totally-new.md' }]);
});

test('unlink for path we never saw: emit unlink immediately', () => {
  const { corr, emitted } = setup();
  corr.onPathGone('/never-seen.md');
  assert.deepEqual(emitted, [{ type: 'unlink', path: '/never-seen.md' }]);
});

test('double rename A->B->C in quick succession', () => {
  const { corr, emitted } = setup();
  corr.onPathSeen('/A.md', '100', 'h');
  corr.onPathGone('/A.md');
  corr.onPathAppeared('/B.md', '100', 'h');
  corr.onPathGone('/B.md');
  corr.onPathAppeared('/C.md', '100', 'h');
  assert.deepEqual(emitted, [
    { type: 'rename', oldPath: '/A.md', newPath: '/B.md' },
    { type: 'rename', oldPath: '/B.md', newPath: '/C.md' },
  ]);
});

test('cleared timer: rename does not fire stray unlink later', async () => {
  const { corr, emitted } = setup({ graceMs: 50 });
  corr.onPathSeen('/a.md', '100', 'h');
  corr.onPathGone('/a.md');
  corr.onPathAppeared('/b.md', '100', 'h');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(emitted, [{ type: 'rename', oldPath: '/a.md', newPath: '/b.md' }]);
});
