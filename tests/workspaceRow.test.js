// The renderer-facing projection of a workspace row.
//
// The DB column is `sync_disabled` (0 = syncing) because an absent or zero row
// should mean normal behaviour. Everything above the projection sees
// `syncEnabled`. Getting that negation wrong silently inverts every Sync switch
// in Settings with nothing failing, so it's pinned here rather than left to
// reading.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectWorkspaceRow } from '../src/main/workspaceRow.js';

// The DB column is `sync_disabled` (0 = syncing) because an absent or zero row
// should mean normal behaviour. Everything above the projection sees
// `syncEnabled`. Getting that negation wrong silently inverts every Sync switch
// in Settings, so it's pinned here rather than left to reading.


test('syncEnabled is the inverse of the stored sync_disabled column', () => {
  assert.equal(projectWorkspaceRow({ syncDisabled: 0 }).syncEnabled, true);
  assert.equal(projectWorkspaceRow({ syncDisabled: 1 }).syncEnabled, false);
});

test('a missing sync_disabled reads as syncing', () => {
  // No row / null must mean "normal", which is the whole reason the column is
  // stored as *disabled* rather than *enabled*.
  assert.equal(projectWorkspaceRow({}).syncEnabled, true);
  assert.equal(projectWorkspaceRow({ syncDisabled: null }).syncEnabled, true);
});

test('projectWorkspaceRow carries repo as owner/name and keeps a null path', () => {
  const row = projectWorkspaceRow({
    id: 'w1', name: 'Notes', path: null,
    repoOwner: 'acme', repoName: 'widgets', syncDisabled: 0,
  });
  assert.equal(row.repo, 'acme/widgets');
  assert.equal(row.path, null);   // "exists, not checked out on this machine"
  assert.equal(row.id, 'w1');
});
