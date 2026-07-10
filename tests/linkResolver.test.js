// Unit tests for the pure link resolver (resolveLinkTarget + shortestUniqueLinkFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLinkTarget, shortestUniqueLinkFor } from '../src/renderer/linkResolver.js';
import { parseTarget } from '../src/renderer/linkIndex.js';

const WS = '/ws';
const abs = (rel) => `${WS}/${rel}`;

// Build a Map<basenameLower, absPath[]> from a list of workspace-relative paths.
function indexOf(...rels) {
  const m = new Map();
  for (const rel of rels) {
    const base = rel.split('/').pop().replace(/\.md$/i, '').toLowerCase();
    const arr = m.get(base) || [];
    arr.push(abs(rel));
    m.set(base, arr);
  }
  return m;
}

const resolve = (linkBody, sourceRel, index) =>
  resolveLinkTarget(parseTarget(linkBody), abs(sourceRel), (b) => index.get(b) || [], WS);

test('bare link, unique basename → resolves', () => {
  const idx = indexOf('Foo.md', 'Bar.md');
  assert.equal(resolve('Foo', 'Bar.md', idx), abs('Foo.md'));
});

test('bare link, no match → null (unresolved)', () => {
  const idx = indexOf('Foo.md');
  assert.equal(resolve('Nope', 'Foo.md', idx), null);
});

test('bare link, duplicate basename → same-folder wins', () => {
  const idx = indexOf('clients/acme/Meeting.md', 'clients/globex/Meeting.md');
  assert.equal(resolve('Meeting', 'clients/acme/Notes.md', idx), abs('clients/acme/Meeting.md'));
  assert.equal(resolve('Meeting', 'clients/globex/Notes.md', idx), abs('clients/globex/Meeting.md'));
});

test('bare link, duplicate, no same-folder → shortest path (shallowest)', () => {
  const idx = indexOf('Meeting.md', 'archive/2019/Meeting.md');
  assert.equal(resolve('Meeting', 'Inbox.md', idx), abs('Meeting.md'));
});

test('path-qualified link resolves to the exact folder', () => {
  const idx = indexOf('clients/acme/Meeting.md', 'clients/globex/Meeting.md');
  assert.equal(resolve('globex/Meeting', 'Index.md', idx), abs('clients/globex/Meeting.md'));
  assert.equal(resolve('acme/Meeting', 'Index.md', idx), abs('clients/acme/Meeting.md'));
});

test('full-path-qualified link resolves exactly', () => {
  const idx = indexOf('clients/acme/Meeting.md', 'clients/globex/Meeting.md');
  assert.equal(resolve('clients/acme/Meeting', 'Index.md', idx), abs('clients/acme/Meeting.md'));
});

test('stale path-qualified link falls back to basename when now unique', () => {
  // Link says archive/Meeting but only one Meeting exists (it moved) → resolve it.
  const idx = indexOf('current/Meeting.md');
  assert.equal(resolve('archive/Meeting', 'Index.md', idx), abs('current/Meeting.md'));
});

test('shortestUniqueLinkFor: unique basename → bare name', () => {
  const idx = indexOf('clients/acme/Meeting.md');
  assert.equal(shortestUniqueLinkFor(abs('clients/acme/Meeting.md'), (b) => idx.get(b) || [], WS), 'Meeting');
});

test('shortestUniqueLinkFor: duplicate → shortest disambiguating prefix', () => {
  const idx = indexOf('clients/acme/Meeting.md', 'clients/globex/Meeting.md');
  assert.equal(shortestUniqueLinkFor(abs('clients/acme/Meeting.md'), (b) => idx.get(b) || [], WS), 'acme/Meeting');
  assert.equal(shortestUniqueLinkFor(abs('clients/globex/Meeting.md'), (b) => idx.get(b) || [], WS), 'globex/Meeting');
});

test('shortestUniqueLinkFor: preserves original case', () => {
  const idx = indexOf('A/Foo.md', 'B/Foo.md');
  assert.equal(shortestUniqueLinkFor(abs('A/Foo.md'), (b) => idx.get(b) || [], WS), 'A/Foo');
});
