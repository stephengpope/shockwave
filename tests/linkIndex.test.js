// Unit tests for the in-memory link index — the data structure that drives
// backlinks, the page graph, and (most importantly for these tests) the
// "which files reference this name?" lookup used at rename time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinkIndex, normalizeTarget, parseLinks, prettyName } from '../src/renderer/linkIndex.js';

test('normalizeTarget lowercases, strips .md, drops #heading and |alias', () => {
  assert.equal(normalizeTarget('Foo'), 'foo');
  assert.equal(normalizeTarget('Foo.md'), 'foo');
  assert.equal(normalizeTarget('Foo#Heading'), 'foo');
  assert.equal(normalizeTarget('Foo|Display'), 'foo');
  assert.equal(normalizeTarget('Foo#H|Alias'), 'foo');
  assert.equal(normalizeTarget('  Foo  '), 'foo');
});

test('parseLinks finds every [[link]] on every line with line numbers', () => {
  const content = 'first line\n[[Alpha]] and [[Beta]]\nno link\n[[Gamma#H|alias]]\n';
  const links = parseLinks(content);
  assert.equal(links.length, 3);
  assert.equal(links[0].target, 'alpha'); assert.equal(links[0].lineNumber, 2);
  assert.equal(links[1].target, 'beta');  assert.equal(links[1].lineNumber, 2);
  assert.equal(links[2].target, 'gamma'); assert.equal(links[2].lineNumber, 4);
});

test('parseLinks ignores brackets without paired close on same line', () => {
  const links = parseLinks('text [not a link\n[[real]] yes\n');
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'real');
});

test('parseLinks ignores empty target', () => {
  const links = parseLinks('[[]] and [[ ]]\n');
  // [[]] body is forbidden by the regex (needs at least one non-]/non-\n char),
  // [[ ]] passes the body check but normalizeTarget returns empty -> skip.
  assert.equal(links.length, 0);
});

test('updateFile records outgoing and backlinks', () => {
  const idx = createLinkIndex();
  idx.updateFile('/A.md', '[[Beta]]\n', 100);
  assert.deepEqual(idx.getOutgoing('/A.md'), ['beta']);
  assert.equal(idx.getBacklinks('beta').length, 1);
  assert.equal(idx.getBacklinks('beta')[0].fromPath, '/A.md');
  assert.equal(idx.getMtime('/A.md'), 100);
});

test('updateFile replaces prior outgoing/backlinks for the same file', () => {
  const idx = createLinkIndex();
  idx.updateFile('/A.md', '[[Beta]]\n');
  idx.updateFile('/A.md', '[[Gamma]]\n');
  assert.deepEqual(idx.getOutgoing('/A.md'), ['gamma']);
  assert.equal(idx.getBacklinks('beta').length, 0);
  assert.equal(idx.getBacklinks('gamma').length, 1);
});

test('removeFile removes outgoing and backlinks', () => {
  const idx = createLinkIndex();
  idx.updateFile('/A.md', '[[Beta]]\n');
  idx.removeFile('/A.md');
  assert.deepEqual(idx.getOutgoing('/A.md'), []);
  assert.equal(idx.getBacklinks('beta').length, 0);
});

test('renameFile re-keys outgoing AND updates fromPath in backlinks', () => {
  const idx = createLinkIndex();
  idx.updateFile('/A.md', '[[Target]]\n');
  idx.renameFile('/A.md', '/A2.md');
  assert.deepEqual(idx.getOutgoing('/A2.md'), ['target']);
  assert.deepEqual(idx.getOutgoing('/A.md'), []);
  const back = idx.getBacklinks('target');
  assert.equal(back.length, 1);
  assert.equal(back[0].fromPath, '/A2.md');
});

test('renameFile preserves mtime', () => {
  const idx = createLinkIndex();
  idx.updateFile('/A.md', '[[X]]\n', 500);
  idx.renameFile('/A.md', '/B.md');
  assert.equal(idx.getMtime('/B.md'), 500);
  assert.equal(idx.getMtime('/A.md'), undefined);
});

test('rebuild replaces everything', () => {
  const idx = createLinkIndex();
  idx.updateFile('/Old.md', '[[X]]\n');
  idx.rebuild([
    { path: '/A.md', content: '[[Beta]]\n', mtime: 1 },
    { path: '/B.md', content: '[[Beta]]\n[[Gamma]]\n', mtime: 2 },
  ]);
  assert.deepEqual(idx.getOutgoing('/Old.md'), []);
  assert.deepEqual(idx.getOutgoing('/A.md'), ['beta']);
  assert.deepEqual(idx.getOutgoing('/B.md'), ['beta', 'gamma']);
  assert.equal(idx.getBacklinks('beta').length, 2);
  assert.equal(idx.getBacklinks('gamma').length, 1);
});

test('rebuild accepts pre-parsed outgoingLinks (main-process shape)', () => {
  const idx = createLinkIndex();
  idx.rebuild([
    { path: '/A.md', mtime: 1, outgoingLinks: [
      { target: 'beta', lineNumber: 1, lineText: '[[Beta]]', contextLines: [] },
    ]},
  ]);
  assert.equal(idx.getBacklinks('beta').length, 1);
});

test('getEntriesGroupedBySource groups by fromPath, sorts by mtime desc', () => {
  const idx = createLinkIndex();
  idx.updateFile('/A.md', '[[T]]\n[[T]]\n', 100);
  idx.updateFile('/B.md', '[[T]]\n', 200);
  const groups = idx.getEntriesGroupedBySource('t');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].fromPath, '/B.md'); // higher mtime first
  assert.equal(groups[1].fromPath, '/A.md');
  assert.equal(groups[1].matches.length, 2); // both links from /A.md grouped
});

test('case-insensitive: [[FOO]] backlinks match key "foo"', () => {
  const idx = createLinkIndex();
  idx.updateFile('/A.md', '[[FOO]]\n');
  idx.updateFile('/B.md', '[[Foo]]\n');
  idx.updateFile('/C.md', '[[foo]]\n');
  assert.equal(idx.getBacklinks('foo').length, 3);
});

test('alias and heading are stripped for indexing but preserved on the line', () => {
  const idx = createLinkIndex();
  idx.updateFile('/A.md', '[[Foo#Section|Display]]\n');
  assert.equal(idx.getBacklinks('foo').length, 1);
  assert.equal(idx.getBacklinks('foo')[0].lineText, '[[Foo#Section|Display]]');
});

test('prettyName strips workspace prefix and .md extension', () => {
  assert.equal(prettyName('/ws/folder/Foo.md', '/ws'), 'folder/Foo');
  assert.equal(prettyName('/ws/Foo.md', '/ws'), 'Foo');
  assert.equal(prettyName('/ws/Foo.MD', '/ws'), 'Foo');
});
