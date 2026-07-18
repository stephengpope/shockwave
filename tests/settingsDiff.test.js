// Patch-diffing for settings saves (src/renderer/settingsDiff.js).
//
// The stakes: settings are stored one row per leaf key, but per-field setters
// build whole sub-objects, so they read every sibling — credentials included —
// out of the local cache. If those siblings reach the store, a slider nudge
// re-encrypts the GitHub PAT, and a stale cache value overwrites a fresher one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPatch, changedLeaves } from '../src/renderer/settingsDiff.js';

test('a changed leaf is sent alone, siblings are not', () => {
  const prev = { sync: { pat: 'ghp_secret', pullIntervalSeconds: 10, disabledWorkspaceIds: [] } };
  const next = { sync: { ...prev.sync, pullIntervalSeconds: 11 } };
  // This is exactly what onSyncChange builds — note it carries `pat` verbatim.
  assert.deepEqual(buildPatch(next, prev), { 'sync.pullIntervalSeconds': 11 });
});

test('an unchanged sub-object produces no write at all', () => {
  const prev = { appearance: { themeMode: 'light', hideLineNumbers: true, treePanel: { content: 'recent', count: 7 } } };
  assert.deepEqual(buildPatch({ appearance: { ...prev.appearance } }, prev), {});
});

test('a nested leaf is addressed by its full dotted path', () => {
  const prev = { appearance: { themeMode: 'light', treePanel: { content: 'recent', count: 7 } } };
  const next = { appearance: { ...prev.appearance, treePanel: { content: 'recent', count: 12 } } };
  assert.deepEqual(buildPatch(next, prev), { 'appearance.treePanel.count': 12 });
});

test('a credential is written only when it actually changes', () => {
  const prev = { sync: { pat: 'old', pullIntervalSeconds: 10 } };
  assert.deepEqual(buildPatch({ sync: { pat: 'new', pullIntervalSeconds: 10 } }, prev), { 'sync.pat': 'new' });
  assert.deepEqual(buildPatch({ sync: { pat: 'old', pullIntervalSeconds: 10 } }, prev), {});
});

test('provider keys are addressed individually', () => {
  // Changing the model must not rewrite (and re-encrypt) every provider key.
  const prev = { codingAgent: { model: 'a', providerKeys: { anthropic: 'sk-1', openai: 'sk-2' } } };
  const next = { codingAgent: { model: 'b', providerKeys: { ...prev.codingAgent.providerKeys } } };
  assert.deepEqual(buildPatch(next, prev), { 'codingAgent.model': 'b' });
});

test('collections pass through whole, even when unchanged', () => {
  // They reconcile by membership in the store — a "nothing changed" diff would
  // be wrong, and an empty array must still be able to clear the table.
  const list = [{ id: 'w1', name: 'demo', path: '/demo' }];
  assert.deepEqual(buildPatch({ workspaces: list }, { workspaces: list }), { workspaces: list });
  assert.deepEqual(buildPatch({ agentSecrets: [] }, { agentSecrets: [] }), { agentSecrets: [] });
});

test('main-owned keys are never authored by the renderer', () => {
  assert.deepEqual(buildPatch({ windowBounds: { x: 1 }, cron: { enabled: true } }, {}), {});
});

test('arrays are compared structurally, not by identity', () => {
  const prev = { sync: { disabledWorkspaceIds: ['a', 'b'] } };
  assert.deepEqual(buildPatch({ sync: { disabledWorkspaceIds: ['a', 'b'] } }, prev), {});
  assert.deepEqual(buildPatch({ sync: { disabledWorkspaceIds: ['a'] } }, prev),
    { 'sync.disabledWorkspaceIds': ['a'] });
});

test('a key absent from the cache is treated as changed', () => {
  // First write of a setting that has no row yet must not be swallowed.
  assert.deepEqual(buildPatch({ viewMode: 'raw' }, {}), { viewMode: 'raw' });
});

test('null and false are real values, not "unset"', () => {
  assert.deepEqual(buildPatch({ bookmarkFilterActive: false }, { bookmarkFilterActive: true }),
    { bookmarkFilterActive: false });
  assert.deepEqual(buildPatch({ activeWorkspaceId: null }, { activeWorkspaceId: 'ws_1' }),
    { activeWorkspaceId: null });
  // …and an unchanged false must still produce nothing.
  assert.deepEqual(buildPatch({ bookmarkFilterActive: false }, { bookmarkFilterActive: false }), {});
});

test('changedLeaves writes into the accumulator it is given', () => {
  const out = {};
  changedLeaves('a', { b: 1, c: 2 }, { b: 1, c: 9 }, out);
  assert.deepEqual(out, { 'a.c': 2 });
});

// ── Open-ended maps ──────────────────────────────────────────────────────────

test('providerKeys travels whole so removals are visible to the store', () => {
  // A per-leaf diff would only mention keys still present, so a deleted slug
  // would never be written — leaving the credential encrypted on disk and
  // reappearing on the next read.
  const prev = { codingAgent: { model: 'a', providerKeys: { anthropic: 'sk-1', openai: 'sk-2' } } };
  const next = { codingAgent: { model: 'a', providerKeys: { anthropic: 'sk-1' } } };
  assert.deepEqual(buildPatch(next, prev), { 'codingAgent.providerKeys': { anthropic: 'sk-1' } });
});

test('an unchanged providerKeys map is still not sent', () => {
  const prev = { codingAgent: { model: 'a', providerKeys: { anthropic: 'sk-1' } } };
  const next = { codingAgent: { model: 'b', providerKeys: { anthropic: 'sk-1' } } };
  assert.deepEqual(buildPatch(next, prev), { 'codingAgent.model': 'b' });
});

test('clearing the last provider key sends an empty map, not nothing', () => {
  const prev = { codingAgent: { providerKeys: { anthropic: 'sk-1' } } };
  assert.deepEqual(buildPatch({ codingAgent: { providerKeys: {} } }, prev),
    { 'codingAgent.providerKeys': {} });
});
