// Integration test — correlator + real chokidar + real fs ops.
// Run via `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import chokidar from 'chokidar';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRenameCorrelator } from '../electron/renameCorrelator.js';

// Hash helper used by both the seeder and the watcher path.
async function hashFile(p) {
  try {
    const buf = await fs.readFile(p);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

async function statIno(p) {
  try {
    const st = await fs.stat(p, { bigint: true });
    return st.ino.toString();
  } catch {
    return null;
  }
}

// Build a harness with a fresh tmp dir + chokidar + correlator.
// Returns control handles for the test.
async function setupHarness() {
  const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-int-'));
  const emitted = [];
  const corr = createRenameCorrelator({
    emit: (e) => emitted.push(e),
    graceMs: 400,
  });

  // Wire chokidar -> correlator. Mirrors how main.js would wire it.
  const watcher = chokidar.watch(ROOT, {
    ignored: (p) => {
      const rel = path.relative(ROOT, p);
      if (!rel || rel.startsWith('..')) return false;
      return rel.split(path.sep).some((seg) => seg.startsWith('.'));
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  });

  watcher
    .on('add', async (p) => {
      // The real main.js would also re-parse links here. For correlation we
      // only need ino + hash.
      const [ino, hash] = await Promise.all([statIno(p), hashFile(p)]);
      corr.onPathAppeared(p, ino, hash);
    })
    .on('change', async (p) => {
      // Atomic saves arrive here; we update the identity but don't run correlator.
      const [ino, hash] = await Promise.all([statIno(p), hashFile(p)]);
      corr.onPathSeen(p, ino, hash);
    })
    .on('unlink', (p) => {
      corr.onPathGone(p);
    });

  await new Promise((r) => watcher.on('ready', r));

  async function settle(quiet = 700) {
    let last = -1;
    while (true) {
      const c = emitted.length;
      if (c === last) {
        await new Promise((r) => setTimeout(r, quiet));
        if (emitted.length === c) return;
      }
      last = c;
      await new Promise((r) => setTimeout(r, quiet));
    }
  }

  async function teardown() {
    await watcher.close();
    await fs.rm(ROOT, { recursive: true, force: true });
  }

  // Seed the correlator's identity map for a file as if main.js had just
  // written/observed it. The watcher will also fire 'add' for it; we wait
  // for that and clear the emitted log before the test action.
  async function seed(name, content) {
    const p = path.join(ROOT, name);
    await fs.writeFile(p, content);
    await settle();
    emitted.length = 0;
    return p;
  }

  return { ROOT, corr, emitted, settle, teardown, seed };
}

test('integration: single rename emits exactly one rename event', async () => {
  const h = await setupHarness();
  try {
    const a = await h.seed('a.md', 'hello a\n');
    const b = path.join(h.ROOT, 'b.md');
    await fs.rename(a, b);
    await h.settle();
    assert.deepEqual(h.emitted, [{ type: 'rename', oldPath: a, newPath: b }]);
  } finally {
    await h.teardown();
  }
});

test('integration: batch rename of 10 files -> 10 renames, 0 unlinks, 0 adds', async () => {
  const h = await setupHarness();
  try {
    const olds = [];
    for (let i = 0; i < 10; i++) {
      olds.push(await h.seed(`b-${i}.md`, `content ${i}\n`));
    }
    const news = olds.map((p) => p.replace(/b-(\d+)\.md$/, 'b-$1-renamed.md'));
    await Promise.all(olds.map((from, i) => fs.rename(from, news[i])));
    await h.settle();

    const counts = h.emitted.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
    assert.deepEqual(counts, { rename: 10 }, `counts: ${JSON.stringify(counts)}`);

    // Each old paired to its expected new
    const renames = new Map();
    for (const e of h.emitted) renames.set(e.oldPath, e.newPath);
    for (let i = 0; i < 10; i++) {
      assert.equal(renames.get(olds[i]), news[i]);
    }
  } finally {
    await h.teardown();
  }
});

test('integration: real delete -> unlink event after grace', async () => {
  const h = await setupHarness();
  try {
    const p = await h.seed('del.md', 'going away\n');
    await fs.unlink(p);
    await h.settle();
    assert.deepEqual(h.emitted, [{ type: 'unlink', path: p }]);
  } finally {
    await h.teardown();
  }
});

test('integration: new file -> add event (no false rename)', async () => {
  const h = await setupHarness();
  try {
    const p = path.join(h.ROOT, 'brand-new.md');
    await fs.writeFile(p, 'fresh\n');
    await h.settle();
    assert.deepEqual(h.emitted, [{ type: 'add', path: p }]);
  } finally {
    await h.teardown();
  }
});

test('integration: rename + simultaneous delete + simultaneous new add', async () => {
  const h = await setupHarness();
  try {
    const renSrc = await h.seed('R.md', 'rename me\n');
    const delPath = await h.seed('D.md', 'delete me\n');
    const newPath = path.join(h.ROOT, 'N.md');
    const renDst = path.join(h.ROOT, 'R2.md');

    await Promise.all([
      fs.rename(renSrc, renDst),
      fs.unlink(delPath),
      fs.writeFile(newPath, 'new file\n'),
    ]);
    await h.settle();

    const types = h.emitted.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
    assert.deepEqual(types, { rename: 1, unlink: 1, add: 1 }, `types: ${JSON.stringify(types)} emitted: ${JSON.stringify(h.emitted)}`);

    const rename = h.emitted.find((e) => e.type === 'rename');
    const unlink = h.emitted.find((e) => e.type === 'unlink');
    const add = h.emitted.find((e) => e.type === 'add');
    assert.equal(rename.oldPath, renSrc);
    assert.equal(rename.newPath, renDst);
    assert.equal(unlink.path, delPath);
    assert.equal(add.path, newPath);
  } finally {
    await h.teardown();
  }
});

test('integration: atomic save -> NOT classified as rename (no unlink/add seen)', async () => {
  const h = await setupHarness();
  try {
    const target = await h.seed('note.md', 'v1\n');
    const tmp = path.join(h.ROOT, 'note.md.tmp');
    await fs.writeFile(tmp, 'v2\n');
    await fs.rename(tmp, target);
    await h.settle();
    // Atomic save shows up as 'change' in chokidar (per phase 2), which we route
    // to onPathSeen — not through the correlator's emit path. So h.emitted should
    // not contain anything.
    assert.deepEqual(h.emitted, []);
  } finally {
    await h.teardown();
  }
});

test('integration: rename of identical-content files: both pair correctly', async () => {
  const h = await setupHarness();
  try {
    // Identical content, different files. macOS APFS will assign different inos.
    const content = 'exactly the same\n';
    const a = await h.seed('iden-a.md', content);
    const b = await h.seed('iden-b.md', content);
    const aRen = path.join(h.ROOT, 'iden-a-r.md');
    const bRen = path.join(h.ROOT, 'iden-b-r.md');

    await Promise.all([fs.rename(a, aRen), fs.rename(b, bRen)]);
    await h.settle();

    const counts = h.emitted.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
    assert.deepEqual(counts, { rename: 2 }, `counts: ${JSON.stringify(counts)}`);

    const map = new Map(h.emitted.map((e) => [e.oldPath, e.newPath]));
    assert.equal(map.get(a), aRen);
    assert.equal(map.get(b), bRen);
  } finally {
    await h.teardown();
  }
});

test('integration: file moves between subfolders', async () => {
  const h = await setupHarness();
  try {
    await fs.mkdir(path.join(h.ROOT, 'src'));
    await fs.mkdir(path.join(h.ROOT, 'dest'));
    const a = path.join(h.ROOT, 'src', 'moved.md');
    await fs.writeFile(a, 'will move\n');
    await h.settle();
    h.emitted.length = 0;

    const b = path.join(h.ROOT, 'dest', 'moved.md');
    await fs.rename(a, b);
    await h.settle();

    // Filter to file events (folder events would show up as separate types only
    // when we add/remove the folders, not when we rename inside them).
    const fileEvents = h.emitted.filter((e) => e.type === 'rename' || e.type === 'add' || e.type === 'unlink');
    assert.deepEqual(fileEvents, [{ type: 'rename', oldPath: a, newPath: b }]);
  } finally {
    await h.teardown();
  }
});

test('integration: folder rename -> per-file renames inside', async () => {
  const h = await setupHarness();
  try {
    const folder = path.join(h.ROOT, 'old-folder');
    await fs.mkdir(folder);
    const f1 = path.join(folder, 'one.md');
    const f2 = path.join(folder, 'two.md');
    await fs.writeFile(f1, 'one\n');
    await fs.writeFile(f2, 'two\n');
    await h.settle();
    h.emitted.length = 0;

    const newFolder = path.join(h.ROOT, 'new-folder');
    await fs.rename(folder, newFolder);
    await h.settle();

    const renames = h.emitted.filter((e) => e.type === 'rename');
    const expectedNew1 = path.join(newFolder, 'one.md');
    const expectedNew2 = path.join(newFolder, 'two.md');
    const map = new Map(renames.map((e) => [e.oldPath, e.newPath]));
    assert.equal(map.get(f1), expectedNew1);
    assert.equal(map.get(f2), expectedNew2);

    // No stray unlinks or adds for the files inside (the folder itself isn't
    // tracked by this correlator).
    const stray = h.emitted.filter((e) =>
      (e.type === 'unlink' && (e.path === f1 || e.path === f2))
      || (e.type === 'add' && (e.path === expectedNew1 || e.path === expectedNew2))
    );
    assert.deepEqual(stray, [], `stray events: ${JSON.stringify(stray)}`);
  } finally {
    await h.teardown();
  }
});

test('integration: many simultaneous renames including deletes and adds', async () => {
  const h = await setupHarness();
  try {
    // 20 files: rename 10, delete 5, leave 5 alone. Also add 5 brand-new files.
    const all = [];
    for (let i = 0; i < 20; i++) {
      all.push(await h.seed(`f-${i}.md`, `c${i}\n`));
    }

    const renameOld = all.slice(0, 10);
    const renameNew = renameOld.map((p) => p.replace('.md', '-r.md'));
    const deletes = all.slice(10, 15);
    const newPaths = [];
    for (let i = 0; i < 5; i++) newPaths.push(path.join(h.ROOT, `new-${i}.md`));

    const ops = [
      ...renameOld.map((from, i) => fs.rename(from, renameNew[i])),
      ...deletes.map((p) => fs.unlink(p)),
      ...newPaths.map((p, i) => fs.writeFile(p, `n${i}\n`)),
    ];
    await Promise.all(ops);
    await h.settle();

    const types = h.emitted.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
    assert.deepEqual(types, { rename: 10, unlink: 5, add: 5 }, `types: ${JSON.stringify(types)}`);

    // Spot-check: every renameOld[i] paired to renameNew[i]
    const map = new Map(h.emitted.filter((e) => e.type === 'rename').map((e) => [e.oldPath, e.newPath]));
    for (let i = 0; i < 10; i++) assert.equal(map.get(renameOld[i]), renameNew[i]);
  } finally {
    await h.teardown();
  }
});
