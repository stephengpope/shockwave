// End-to-end test for the entire linking system.
//
// Simulates the full pipeline with no Electron:
//   - A real on-disk workspace in a tmp dir.
//   - The main-process pieces: @parcel/watcher + the shared watcherDispatch +
//     the rename correlator + the parseLinks parser + the stat-and-hash helpers.
//   - The renderer-side link index (createLinkIndex) wired into a
//     simulated `fs:changed` handler that mirrors src/App.jsx's logic
//     (rename -> renameFile + applyParsedLinks + rewriteReferences).
//
// Each test performs filesystem operations the way an external actor
// (Finder, `mv`, an agent shelling out to `fs.rename`) would, and asserts
// that the link index ends up in the same state it would have reached if
// the operations had been performed in-app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import watcher from '@parcel/watcher';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRenameCorrelator } from '../src/main/renameCorrelator.js';
import { createWatcherDispatch } from '../src/main/watcherDispatch.js';
import { parseLinks } from '../src/main/linkParser.js';
import { createMetadataCache } from '../src/renderer/metadataCache.js';
import { rewriteReferences, captureRewriteContext } from '../src/renderer/renameOps.js';

const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase();

async function hashOf(p) {
  try { return crypto.createHash('sha1').update(await fs.readFile(p)).digest('hex'); }
  catch { return null; }
}
async function inoOf(p) {
  try { return (await fs.stat(p, { bigint: true })).ino.toString(); }
  catch { return null; }
}

async function listMd(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

// Build the harness:
//   - tmp workspace dir
//   - link index (renderer-side)
//   - correlator + @parcel/watcher + watcherDispatch (main-side)
//   - simulated fs:changed handler matching src/App.jsx
async function setupWorkspace(initialFiles) {
  // realpath so the seeded/asserted paths match @parcel/watcher's realpath-
  // resolved event paths (macOS os.tmpdir() is a symlink).
  const ROOT = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sw-e2e-')));
  for (const [rel, content] of Object.entries(initialFiles)) {
    const full = path.join(ROOT, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }

  // Renderer-side metadata cache, seeded the way main.js does on workspace load.
  const cache = createMetadataCache();
  cache.setWorkspacePath(ROOT);
  const seedFiles = [];
  for (const p of await listMd(ROOT)) {
    const [content, st] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)]);
    seedFiles.push({ path: p, mtime: st.mtimeMs, outgoingLinks: parseLinks(content) });
  }
  cache.rebuild(seedFiles);

  // Thin shim exposing the methods the harness + assertions use. getOutgoing /
  // getBacklinks translate the cache's resolvedLinks/backlinks into the flat
  // basename-keyed shapes the tests assert against.
  const linkIndex = {
    cache,
    cacheRef: { current: cache },
    rebuild: (f) => cache.rebuild(f),
    removeFile: (p) => cache.removeFile(p),
    renameFile: (a, b) => cache.renameFile(a, b),
    applyParsedLinks: (p, l, m) => cache.applyParsedLinks(p, l, m),
    updateFile: (p, c) => cache.updateFile(p, c),
    getMtime: (p) => cache.getMtime(p),
    getOutgoing: (p) => {
      const out = [];
      const r = cache.resolvedLinks.get(p); if (r) for (const d of r.keys()) out.push(baseOf(d));
      const u = cache.unresolvedLinks.get(p); if (u) for (const k of u.keys()) out.push(k);
      return out;
    },
    getBacklinks: (basename) => {
      const entries = [];
      for (const dest of cache.candidatesFor(basename)) {
        for (const g of cache.getBacklinksForFile(dest)) {
          for (const mm of g.matches) entries.push({ fromPath: g.fromPath, lineNumber: mm.lineNumber });
        }
      }
      return entries;
    },
  };

  // Renderer-side `api` stub that the rewriter calls. Production uses
  // window.api.{readFile,writeFile}; here we use fs directly.
  const api = {
    readFile: (p) => fs.readFile(p, 'utf8'),
    writeFile: (p, content) => fs.writeFile(p, content),
  };

  // The simulated fs:changed handler. Mirrors src/App.jsx — same branches,
  // same order, just no React. Tests await `applyEvent(evt)` directly.
  async function applyEvent(evt) {
    if (evt.type === 'tree') return;
    if (evt.type === 'unlink') {
      linkIndex.removeFile(evt.path);
      return;
    }
    if (evt.type === 'rename') {
      const oldBaseName = evt.oldPath.split('/').pop().replace(/\.md$/i, '');
      const newBaseName = evt.newPath.split('/').pop().replace(/\.md$/i, '');
      // Capture context BEFORE re-keying (mirrors App/watcher), then re-key.
      const ctx = captureRewriteContext(cache, evt.oldPath);
      cache.renameFile(evt.oldPath, evt.newPath);
      const stored = cache.getMtime(evt.newPath);
      if (stored == null || evt.mtime > stored) {
        cache.applyParsedLinks(evt.newPath, evt.outgoingLinks, evt.mtime);
      }
      if (oldBaseName !== newBaseName) {
        await rewriteReferences({
          api, cache, sources: ctx.sources, candidatesFor: ctx.candidatesFor,
          workspacePath: ROOT, oldPath: evt.oldPath, finalPath: evt.newPath, oldBaseName, newBaseName,
        });
        try {
          const content = await fs.readFile(evt.newPath, 'utf8');
          cache.updateFile(evt.newPath, content);
        } catch { /* file may be gone in delete-race scenarios */ }
      }
      return;
    }
    // 'add' | 'change'
    const stored = linkIndex.getMtime(evt.path);
    if (stored == null || evt.mtime > stored) {
      linkIndex.applyParsedLinks(evt.path, evt.outgoingLinks, evt.mtime);
    }
  }

  // Set up the correlator + the shared dispatch + parcel, mirroring main.ts.
  // correlator emits (rename/add/unlink) and the dispatch's setPending feed a
  // single pendingByPath + renameQueue, exactly as main's setupCorrelator does;
  // `flush()` below is the test's stand-in for main's flushWatcher.
  const pendingByPath = new Map();
  const renameQueue = [];
  const correlator = createRenameCorrelator({
    emit: (e) => {
      if (e.type === 'rename') renameQueue.push(e);
      else if (e.type === 'unlink') pendingByPath.set(e.path, 'unlink');
      else if (e.type === 'add') pendingByPath.set(e.path, pendingByPath.get(e.path) === 'unlink' ? 'change' : 'add');
    },
    graceMs: 600,
  });
  // Seed identity for every existing .md.
  for (const p of await listMd(ROOT)) {
    const [ino, hash] = await Promise.all([inoOf(p), hashOf(p)]);
    correlator.onPathSeen(p, ino, hash);
  }

  const isIgnored = (p) => {
    const rel = path.relative(ROOT, p);
    if (!rel || rel.startsWith('..')) return false;
    return rel.split(path.sep).some((seg) => seg.startsWith('.'));
  };
  const dispatch = createWatcherDispatch({
    correlator,
    isMdFile: (p) => p.toLowerCase().endsWith('.md'),
    isDrawingFile: (p) => /\.excalidraw$/i.test(p),
    isReloadableText: (p) => /\.(txt|text|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|sh|sql|csv|tsv|log)$/i.test(p),
    statPath: (p) => fs.stat(p, { bigint: true }).catch(() => null),
    hashFile: hashOf,
    walkMarkdown: listMd,
    isIgnored,
    getPending: (p) => pendingByPath.get(p),
    setPending: (p, type) => pendingByPath.set(p, type),
    markTreeOnly: () => {},   // tree events aren't asserted here
  });

  let seen = 0;
  let inFlight = Promise.resolve();
  const sub = await watcher.subscribe(ROOT, (err, events) => {
    if (err) return;
    seen += events.length;
    inFlight = inFlight.then(() => dispatch.handleBatch(events));
  }, { ignore: ['**/.*', '**/.*/**'] });

  // main's flushWatcher stand-in: renames first (so the renderer re-keys before
  // any follow-up), then the coalesced per-path entries.
  async function flush() {
    await inFlight;
    const renames = renameQueue.splice(0);
    const entries = [...pendingByPath.entries()];
    pendingByPath.clear();
    for (const { oldPath, newPath } of renames) {
      const [content, st] = await Promise.all([
        fs.readFile(newPath, 'utf8').catch(() => null),
        fs.stat(newPath).catch(() => null),
      ]);
      if (content == null || st == null) { await applyEvent({ type: 'unlink', path: oldPath }); continue; }
      await applyEvent({ type: 'rename', oldPath, newPath, mtime: st.mtimeMs, outgoingLinks: parseLinks(content) });
    }
    for (const [p, type] of entries) {
      if (type === 'unlink') { await applyEvent({ type: 'unlink', path: p }); continue; }
      const [content, st] = await Promise.all([
        fs.readFile(p, 'utf8').catch(() => null),
        fs.stat(p).catch(() => null),
      ]);
      if (content == null || st == null) continue;
      await applyEvent({ type, path: p, mtime: st.mtimeMs, outgoingLinks: parseLinks(content) });
    }
  }

  // Wait for parcel to stop delivering events (one quiet window > the correlator
  // grace, so buffered unlinks have committed), then flush once.
  async function settle(quiet = 1100) {
    let last = -1;
    while (true) {
      const c = seen;
      if (c === last) break;
      last = c;
      await new Promise((r) => setTimeout(r, quiet));
    }
    await flush();
  }

  return {
    ROOT,
    linkIndex,
    async readFile(rel) { return fs.readFile(path.join(ROOT, rel), 'utf8'); },
    async writeFile(rel, content) {
      const p = path.join(ROOT, rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content);
    },
    async rename(relFrom, relTo) {
      const from = path.join(ROOT, relFrom);
      const to = path.join(ROOT, relTo);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
    },
    async unlink(rel) { await fs.unlink(path.join(ROOT, rel)); },
    p(rel) { return path.join(ROOT, rel); },
    settle,
    async teardown() {
      await sub.unsubscribe();
      await fs.rm(ROOT, { recursive: true, force: true });
    },
  };
}

test('e2e: initial workspace load builds the link index correctly', async () => {
  const w = await setupWorkspace({
    'A.md': '[[Beta]] reference\n',
    'B.md': 'no links\n',
    'Beta.md': 'I am referenced\n',
  });
  try {
    assert.deepEqual(w.linkIndex.getOutgoing(w.p('A.md')), ['beta']);
    assert.deepEqual(w.linkIndex.getOutgoing(w.p('B.md')), []);
    assert.equal(w.linkIndex.getBacklinks('beta').length, 1);
    assert.equal(w.linkIndex.getBacklinks('beta')[0].fromPath, w.p('A.md'));
  } finally {
    await w.teardown();
  }
});

test('e2e: external rename rewrites references in OTHER files', async () => {
  const w = await setupWorkspace({
    'A.md': '[[Target]] in A\n',
    'B.md': 'B has [[Target]] too\n',
    'Target.md': 'I am the target\n',
  });
  try {
    // External actor renames Target.md to Goal.md (Finder, mv, agent, etc.)
    await w.rename('Target.md', 'Goal.md');
    await w.settle();
    assert.equal(await w.readFile('A.md'), '[[Goal]] in A\n');
    assert.equal(await w.readFile('B.md'), 'B has [[Goal]] too\n');
    // Index reflects the move
    assert(w.linkIndex.getOutgoing(w.p('Target.md')).length === 0);
    assert.equal(w.linkIndex.getBacklinks('target').length, 0);
    assert.equal(w.linkIndex.getBacklinks('goal').length, 2);
  } finally {
    await w.teardown();
  }
});

test('e2e: external rename rewrites SELF-references', async () => {
  const w = await setupWorkspace({
    'Foo.md': 'I am [[Foo]] linking to myself\n',
    'Other.md': 'I reference [[Foo]] too\n',
  });
  try {
    await w.rename('Foo.md', 'Bar.md');
    await w.settle();
    assert.equal(await w.readFile('Bar.md'), 'I am [[Bar]] linking to myself\n');
    assert.equal(await w.readFile('Other.md'), 'I reference [[Bar]] too\n');
    assert.equal(w.linkIndex.getBacklinks('foo').length, 0);
    // Backlinks exclude a file's own self-reference, so only Other.md counts.
    assert.equal(w.linkIndex.getBacklinks('bar').length, 1);
  } finally {
    await w.teardown();
  }
});

test('e2e: external rename preserves headings and aliases', async () => {
  const w = await setupWorkspace({
    'A.md': '[[Old#Section]] and [[Old|Display]] and [[Old#H|D]]\n',
    'Old.md': 'content\n',
  });
  try {
    await w.rename('Old.md', 'New.md');
    await w.settle();
    assert.equal(
      await w.readFile('A.md'),
      '[[New#Section]] and [[New|Display]] and [[New#H|D]]\n'
    );
  } finally {
    await w.teardown();
  }
});

test('e2e: external delete removes file from index, leaves orphan refs as unresolved', async () => {
  const w = await setupWorkspace({
    'A.md': '[[Target]] ref\n',
    'Target.md': 'goodbye\n',
  });
  try {
    await w.unlink('Target.md');
    await w.settle();
    assert.equal(w.linkIndex.getOutgoing(w.p('Target.md')).length, 0);
    // In the resolved-links model an unresolved link has no backlink entry (it
    // lives in unresolvedLinks). A's [[Target]] is now unresolved: no backlink,
    // but A still carries the outgoing (unresolved) reference on disk + in cache.
    assert.equal(w.linkIndex.getBacklinks('target').length, 0);
    assert.deepEqual(w.linkIndex.getOutgoing(w.p('A.md')), ['target']);
    assert.equal(await w.readFile('A.md'), '[[Target]] ref\n');
  } finally {
    await w.teardown();
  }
});

test('e2e: external add of a new file is indexed', async () => {
  const w = await setupWorkspace({
    'A.md': '[[Newcomer]] anticipated\n',
  });
  try {
    await w.writeFile('Newcomer.md', 'I have arrived [[A]]\n');
    await w.settle();
    assert.deepEqual(w.linkIndex.getOutgoing(w.p('Newcomer.md')), ['a']);
    assert.equal(w.linkIndex.getBacklinks('a').length, 1);
    assert.equal(w.linkIndex.getBacklinks('newcomer').length, 1);
  } finally {
    await w.teardown();
  }
});

test('e2e: external move across folders re-keys index and updates refs', async () => {
  const w = await setupWorkspace({
    'A.md': '[[Movable]]\n',
    'src/Movable.md': 'will move\n',
  });
  try {
    await w.rename('src/Movable.md', 'dest/Movable.md');
    await w.settle();
    // Same basename = no reference rewrite needed; just an index re-key.
    assert.equal(w.linkIndex.getOutgoing(w.p('src/Movable.md')).length, 0);
    assert(w.linkIndex.getMtime(w.p('dest/Movable.md')) != null);
    assert.equal(w.linkIndex.getBacklinks('movable').length, 1);
    assert.equal(await w.readFile('A.md'), '[[Movable]]\n'); // unchanged
  } finally {
    await w.teardown();
  }
});

test('e2e: external folder rename updates every nested file in the index', async () => {
  const w = await setupWorkspace({
    'top.md': '[[note1]] and [[note2]]\n',
    'old-folder/note1.md': 'one\n',
    'old-folder/note2.md': 'two\n',
  });
  try {
    await w.rename('old-folder', 'new-folder');
    await w.settle();
    // Old paths are gone from the index
    assert.equal(w.linkIndex.getMtime(w.p('old-folder/note1.md')), undefined);
    assert.equal(w.linkIndex.getMtime(w.p('old-folder/note2.md')), undefined);
    // New paths are present
    assert(w.linkIndex.getMtime(w.p('new-folder/note1.md')) != null);
    assert(w.linkIndex.getMtime(w.p('new-folder/note2.md')) != null);
    // Backlinks still work — names unchanged
    assert.equal(w.linkIndex.getBacklinks('note1').length, 1);
    assert.equal(w.linkIndex.getBacklinks('note2').length, 1);
  } finally {
    await w.teardown();
  }
});

test('e2e: external content edit (in-place write) is picked up', async () => {
  const w = await setupWorkspace({
    'A.md': '[[X]]\n',
    'X.md': 'orig\n',
    'Y.md': 'orig\n',
  });
  try {
    // External edit: A now links to Y instead of X
    await w.writeFile('A.md', '[[Y]] now\n');
    await w.settle();
    assert.deepEqual(w.linkIndex.getOutgoing(w.p('A.md')), ['y']);
    assert.equal(w.linkIndex.getBacklinks('x').length, 0);
    assert.equal(w.linkIndex.getBacklinks('y').length, 1);
  } finally {
    await w.teardown();
  }
});

test('e2e: 10 simultaneous external renames -> 10 distinct rename events, all refs rewritten', async () => {
  const files = {};
  for (let i = 0; i < 10; i++) files[`t-${i}.md`] = `target ${i}\n`;
  files['hub.md'] = Array.from({ length: 10 }, (_, i) => `[[t-${i}]]`).join(' ') + '\n';
  const w = await setupWorkspace(files);
  try {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => w.rename(`t-${i}.md`, `goal-${i}.md`))
    );
    await w.settle();
    const hub = await w.readFile('hub.md');
    for (let i = 0; i < 10; i++) {
      assert(hub.includes(`[[goal-${i}]]`), `hub missing [[goal-${i}]]: ${hub}`);
      assert(!hub.includes(`[[t-${i}]]`), `hub still has [[t-${i}]]: ${hub}`);
      assert.equal(w.linkIndex.getBacklinks(`t-${i}`).length, 0);
      assert.equal(w.linkIndex.getBacklinks(`goal-${i}`).length, 1);
    }
  } finally {
    await w.teardown();
  }
});

test('e2e: rename of a file with NO backlinks -> no spurious writes', async () => {
  const w = await setupWorkspace({
    'A.md': 'no links anywhere\n',
    'Orphan.md': 'nobody links to me\n',
  });
  try {
    await w.rename('Orphan.md', 'Lonely.md');
    await w.settle();
    assert.equal(await w.readFile('A.md'), 'no links anywhere\n'); // untouched
    assert(w.linkIndex.getMtime(w.p('Lonely.md')) != null);
    assert.equal(w.linkIndex.getMtime(w.p('Orphan.md')), undefined);
  } finally {
    await w.teardown();
  }
});

test('e2e: atomic save (vim/VS Code pattern) -> change event, NOT a false rename', async () => {
  const w = await setupWorkspace({
    'note.md': '[[Old]] content\n',
    'Old.md': 'target\n',
  });
  try {
    // Atomic save replaces note.md by writing to a tmp then renaming over it.
    const tmp = w.p('note.md.tmp');
    await fs.writeFile(tmp, '[[New]] content\n');
    await fs.rename(tmp, w.p('note.md'));
    await w.settle();

    // Outgoing links updated, BUT no reference-rewriting in any other file
    // (because no rename event was emitted).
    assert.deepEqual(w.linkIndex.getOutgoing(w.p('note.md')), ['new']);
    // Old.md was not renamed; it still exists with content unchanged.
    assert.equal(await w.readFile('Old.md'), 'target\n');
  } finally {
    await w.teardown();
  }
});
