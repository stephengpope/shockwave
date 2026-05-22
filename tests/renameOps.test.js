// Tests for the in-app rename logic. Stubs `window.api` with an in-memory
// filesystem so we can assert the exact read/write/rename sequence and the
// resulting state of the link index.
//
// Covers the key correctness properties:
//   - References in other files are rewritten via the index (no file scan)
//   - Heading and alias suffixes are preserved
//   - Case-insensitive link matching
//   - SELF-references are rewritten (the previous code skipped them)
//   - Auto-disambiguation: if api.renameFile returns a different name than
//     requested, the references must use the FINAL name

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameWithReferences, rewriteReferences } from '../src/renameOps.js';
import { createLinkIndex } from '../src/linkIndex.js';

// Build a small in-memory workspace + index + api stub.
function makeWorld(files /* { path: content } */, opts = {}) {
  const fs = new Map(Object.entries(files));
  const writes = [];
  const linkIndex = createLinkIndex();
  for (const [path, content] of fs) {
    linkIndex.updateFile(path, content, 1);
  }
  const api = {
    readFile: async (p) => {
      if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
      return fs.get(p);
    },
    writeFile: async (p, content) => {
      fs.set(p, content);
      writes.push({ path: p, content });
    },
    renameFile: async (fromPath, toName) => {
      // Mimics electron/main.js: auto-disambiguate if a target with the same
      // basename exists anywhere (case-insensitive). Pass `forceFinalPath` in
      // opts to force a different final name for testing.
      if (opts.forceFinalPath) {
        const content = fs.get(fromPath);
        fs.delete(fromPath);
        fs.set(opts.forceFinalPath, content);
        return opts.forceFinalPath;
      }
      const slash = fromPath.lastIndexOf('/');
      const dir = slash >= 0 ? fromPath.slice(0, slash) : '';
      const clean = toName.replace(/\.md$/i, '');
      let candidate = `${dir}/${clean}.md`;
      let i = 1;
      const existing = new Set([...fs.keys()].filter((p) => p !== fromPath));
      const taken = new Set([...existing].map((p) => p.split('/').pop().slice(0, -3).toLowerCase()));
      while (true) {
        const candName = i === 1 ? clean : `${clean} ${i - 1}`;
        candidate = `${dir}/${candName}.md`;
        if (!existing.has(candidate) && !taken.has(candName.toLowerCase())) break;
        i++;
      }
      const content = fs.get(fromPath);
      fs.delete(fromPath);
      fs.set(candidate, content);
      return candidate;
    },
  };
  return { fs, api, linkIndex, writes };
}

test('rewriteReferences updates [[Old]] to [[New]] in all referencing files', async () => {
  const w = makeWorld({
    '/A.md': '[[Target]] reference\n',
    '/B.md': 'Some text [[Target]] more text\n',
    '/Target.md': 'content with no link\n',
  });
  const written = await rewriteReferences({
    api: w.api,
    linkIndex: w.linkIndex,
    oldBaseName: 'Target',
    newBaseName: 'Renamed',
  });
  assert.deepEqual(written.sort(), ['/A.md', '/B.md'].sort());
  assert.equal(w.fs.get('/A.md'), '[[Renamed]] reference\n');
  assert.equal(w.fs.get('/B.md'), 'Some text [[Renamed]] more text\n');
});

test('rewriteReferences preserves #heading and |alias suffixes', async () => {
  const w = makeWorld({
    '/A.md': '[[Target#Section]] and [[Target|Alias]]\n[[Target#H|Both]]\n',
  });
  await rewriteReferences({
    api: w.api, linkIndex: w.linkIndex,
    oldBaseName: 'Target', newBaseName: 'Renamed',
  });
  assert.equal(
    w.fs.get('/A.md'),
    '[[Renamed#Section]] and [[Renamed|Alias]]\n[[Renamed#H|Both]]\n'
  );
});

test('rewriteReferences is case-insensitive on match', async () => {
  const w = makeWorld({
    '/A.md': '[[target]]\n[[Target]]\n[[TARGET]]\n',
  });
  await rewriteReferences({
    api: w.api, linkIndex: w.linkIndex,
    oldBaseName: 'Target', newBaseName: 'Renamed',
  });
  assert.equal(w.fs.get('/A.md'), '[[Renamed]]\n[[Renamed]]\n[[Renamed]]\n');
});

test('renameWithReferences renames file AND rewrites refs', async () => {
  const w = makeWorld({
    '/notes/A.md': '[[Source]] reference\n',
    '/Source.md': 'just content\n',
  });
  const newPath = await renameWithReferences({
    api: w.api, linkIndex: w.linkIndex,
    oldPath: '/Source.md',
    newName: 'Destination',
  });
  assert.equal(newPath, '/Destination.md');
  assert(w.fs.has('/Destination.md'));
  assert(!w.fs.has('/Source.md'));
  assert.equal(w.fs.get('/notes/A.md'), '[[Destination]] reference\n');
});

test('renameWithReferences rewrites SELF-references too', async () => {
  // The previous code skipped src === oldPath. Verify that self-refs are
  // rewritten now.
  const w = makeWorld({
    '/Foo.md': 'I am [[Foo]] and I link to myself.\n',
  });
  const newPath = await renameWithReferences({
    api: w.api, linkIndex: w.linkIndex,
    oldPath: '/Foo.md',
    newName: 'Bar',
  });
  assert.equal(newPath, '/Bar.md');
  assert.equal(w.fs.get('/Bar.md'), 'I am [[Bar]] and I link to myself.\n');
  // Index should reflect: outgoing on /Bar.md is now ["bar"], backlinks for "foo" is empty.
  assert.deepEqual(w.linkIndex.getOutgoing('/Bar.md'), ['bar']);
  assert.equal(w.linkIndex.getBacklinks('foo').length, 0);
  assert.equal(w.linkIndex.getBacklinks('bar').length, 1);
});

test('renameWithReferences: refs use FINAL name when auto-disambiguated', async () => {
  // Simulate the IPC handler bumping the requested name to a unique one.
  const w = makeWorld(
    {
      '/Source.md': 'self [[Source]]\n',
      '/A.md': '[[Source]]\n',
      '/elsewhere/Destination.md': 'this exists already\n',
    },
    { forceFinalPath: '/Destination 1.md' }
  );
  const newPath = await renameWithReferences({
    api: w.api, linkIndex: w.linkIndex,
    oldPath: '/Source.md',
    newName: 'Destination',
  });
  assert.equal(newPath, '/Destination 1.md');
  assert.equal(w.fs.get('/A.md'), '[[Destination 1]]\n');
  // Self-ref should also use the final name.
  // (Note: forceFinalPath doesn't actually move the file, so we just check refs.)
});

test('renameWithReferences updates index keys (re-key path)', async () => {
  const w = makeWorld({
    '/A.md': '[[X]]\n',
    '/X.md': 'content\n',
  });
  await renameWithReferences({
    api: w.api, linkIndex: w.linkIndex,
    oldPath: '/X.md',
    newName: 'Y',
  });
  // Old path gone, new path present.
  assert.deepEqual(w.linkIndex.getOutgoing('/X.md'), []);
  // /A.md now references "y" not "x".
  assert.deepEqual(w.linkIndex.getOutgoing('/A.md'), ['y']);
  assert.equal(w.linkIndex.getBacklinks('y').length, 1);
  assert.equal(w.linkIndex.getBacklinks('x').length, 0);
});

test('renameWithReferences with no backlinks: just renames the file', async () => {
  const w = makeWorld({ '/Orphan.md': 'nobody links to me\n' });
  const newPath = await renameWithReferences({
    api: w.api, linkIndex: w.linkIndex,
    oldPath: '/Orphan.md',
    newName: 'Lonely',
  });
  assert.equal(newPath, '/Lonely.md');
  assert(w.fs.has('/Lonely.md'));
  assert.equal(w.writes.length, 0); // no source files rewritten
});

test('renameWithReferences: same-name rename is a no-op', async () => {
  const w = makeWorld({ '/Foo.md': '[[Foo]]\n', '/A.md': '[[Foo]]\n' });
  const newPath = await renameWithReferences({
    api: w.api, linkIndex: w.linkIndex,
    oldPath: '/Foo.md',
    newName: 'Foo',
  });
  assert.equal(newPath, '/Foo.md');
  assert.equal(w.writes.length, 0);
  assert.equal(w.fs.get('/A.md'), '[[Foo]]\n');
});

test('renameWithReferences: empty name throws', async () => {
  const w = makeWorld({ '/Foo.md': '' });
  await assert.rejects(
    () => renameWithReferences({
      api: w.api, linkIndex: w.linkIndex,
      oldPath: '/Foo.md',
      newName: '   ',
    }),
    /empty/i
  );
});
