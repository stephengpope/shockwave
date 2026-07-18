// Pure settings key-policy + shape-mapping tests (src/main/settingsKeys.js).
//
// These lists decide WHERE a value is stored. Routing a credential to the
// `setting` table instead of `secret_value` doesn't throw — it silently writes
// an API key in the clear — so secret classification is asserted in BOTH
// directions: every credential path matches, and the non-credential neighbours
// sitting right beside them do not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSettingsSecretKey, SETTINGS_SECRET_OWNER, AGENT_SECRET_FIELDS, isAgentSecretField,
  isOAuthOwnedField, OAUTH_OWNED_COLUMNS, flattenInto, setPath, typeOf, encodeValue,
  decodeValue, splitAgentSecret, joinAgentSecret, LEAF_KEYS,
} from '../src/main/settingsKeys.js';

// Rebuilds a settings object from flat rows the way readSettings does. Kept in
// the test rather than exported, so a change to readSettings' assembly that
// breaks the round-trip fails here instead of being masked by shared code.
function unflatten(flat) {
  const out = {};
  for (const [key, value] of flat) setPath(out, key, value);
  return out;
}

// ── Settings-owned credentials ───────────────────────────────────────────────

test('every standalone credential routes to secret_value', () => {
  for (const key of [
    'codingAgent.providerKeys.anthropic',
    'codingAgent.providerKeys.openai-compatible',
    'transcription.apiKey',
    'sync.pat',
  ]) {
    assert.equal(isSettingsSecretKey(key), true, `${key} must be encrypted`);
  }
});

test('non-credential neighbours stay in the setting table', () => {
  // Each sits directly beside a credential — the likeliest place for an
  // over-broad pattern to encrypt something the renderer needs to read back.
  for (const key of [
    'codingAgent.provider',
    'codingAgent.model',
    'codingAgent.providerKeys', // the container itself is never a leaf
    'transcription.provider',
    'sync.pullIntervalSeconds',
    'cron.enabled',
    'windowBounds',
    'activeWorkspaceId',
  ]) {
    assert.equal(isSettingsSecretKey(key), false, `${key} must stay plaintext`);
  }
});

test('credential patterns match a single path segment only', () => {
  // `[^.]+` must not swallow dots, or nested keys would collide in meaning.
  assert.equal(isSettingsSecretKey('codingAgent.providerKeys.a.b'), false);
});

test('agent-secret keys are not settings-owned', () => {
  // They belong to their entry (owner = the secret's name), not to 'settings'.
  assert.equal(isSettingsSecretKey('agentSecrets.GEMINI_API_KEY.token'), false);
  assert.equal(SETTINGS_SECRET_OWNER, 'settings');
});

// ── Agent-secret credential fields ───────────────────────────────────────────

test('agent-secret credential fields are exactly the four', () => {
  assert.deepEqual(AGENT_SECRET_FIELDS,
    ['token', 'oauth.clientSecret', 'oauth.accessToken', 'oauth.refreshToken']);
  for (const f of AGENT_SECRET_FIELDS) assert.equal(isAgentSecretField(f), true, f);
  for (const f of ['name', 'description', 'oauth.clientId', 'oauth.status']) {
    assert.equal(isAgentSecretField(f), false, f);
  }
});

test('OAuth-flow ownership covers tokens but NOT client credentials', () => {
  assert.equal(isOAuthOwnedField('oauth.accessToken'), true);
  assert.equal(isOAuthOwnedField('oauth.refreshToken'), true);
  // The user types these into Settings, so a bulk write must still author them.
  assert.equal(isOAuthOwnedField('oauth.clientSecret'), false);
  assert.equal(isOAuthOwnedField('token'), false);
  assert.deepEqual(OAUTH_OWNED_COLUMNS, ['oauthExpiresAt', 'oauthStatus', 'oauthAccountEmail']);
});

test('clientSecret is a credential but not flow-owned', () => {
  // The combination that keeps a client secret encrypted while still letting the
  // Settings UI save it. Breaking either half leaks it or blocks saving.
  assert.equal(isAgentSecretField('oauth.clientSecret'), true);
  assert.equal(isOAuthOwnedField('oauth.clientSecret'), false);
});

// ── Entity split / join ──────────────────────────────────────────────────────

test('a static agent secret round-trips through split/join', () => {
  const entry = {
    name: 'GEMINI_API_KEY', description: 'Use for Gemini', token: 'sk-abc',
    createdAt: 100, updatedAt: 200,
  };
  const { row, secrets } = splitAgentSecret(entry);
  assert.equal(row.name, 'GEMINI_API_KEY');
  assert.equal(secrets.token, 'sk-abc');
  // No crypto anywhere on the entity row — that's the whole point of the split.
  assert.equal(row.token, undefined);

  const back = joinAgentSecret(row, secrets);
  assert.deepEqual(back, entry);
  // A non-OAuth entry must have no `oauth` key at all, matching prior behavior.
  assert.equal('oauth' in back, false);
});

test('an OAuth agent secret round-trips including nested oauth fields', () => {
  const entry = {
    name: 'google', description: 'g', kind: 'oauth', token: '',
    createdAt: 1, updatedAt: 2,
    oauth: {
      provider: 'google', clientId: 'cid', clientSecret: 'csec', scopes: ['a', 'b'],
      accessToken: 'at', refreshToken: 'rt', expiresAt: 999,
      status: 'connected', accountEmail: 'x@y.z',
    },
  };
  const { row, secrets } = splitAgentSecret(entry);
  assert.equal(row.oauthClientId, 'cid');
  assert.equal(row.oauthScopes, '["a","b"]');
  assert.equal(secrets['oauth.refreshToken'], 'rt');
  // Tokens must not leak onto the entity row.
  assert.equal(row.oauthAccessToken, undefined);
  assert.equal(row.oauthClientSecret, undefined);

  assert.deepEqual(joinAgentSecret(row, secrets), entry);
});

test('a secret with no credentials stored joins to empty strings', () => {
  // The built-in-skill slot case: an entity row exists, secret_value has none.
  const row = { name: 'FIRECRAWL_API_KEY', description: 'slot', kind: null, createdAt: 5, updatedAt: 5 };
  const back = joinAgentSecret(row, {});
  assert.equal(back.token, '');
  assert.equal('oauth' in back, false);
});

test('malformed oauth scopes degrade to an empty array', () => {
  const back = joinAgentSecret(
    { name: 'x', kind: 'oauth', oauthScopes: '{not json', createdAt: 0, updatedAt: 0 }, {});
  assert.deepEqual(back.oauth.scopes, []);
});

// ── Flatten ──────────────────────────────────────────────────────────────────

test('nested settings round-trip through flatten/unflatten', () => {
  const settings = {
    appearance: { themeMode: 'light', hideLineNumbers: true, treePanel: { content: 'recent', count: 7 } },
    codingAgent: { provider: 'anthropic', model: 'claude-opus-4-8', baseUrl: '' },
    cron: { enabled: true, maxCatchupHours: 36, maxRunMinutes: 30 },
    chatSidebarWidth: 493,
    viewMode: 'live',
  };
  const flat = new Map();
  for (const [k, v] of Object.entries(settings)) flattenInto(k, v, flat);
  assert.deepEqual(unflatten(flat), settings);
});

test('LEAF_KEYS entries stay whole instead of exploding', () => {
  const flat = new Map();
  flattenInto('windowBounds', { x: 0, y: 637, width: 3008, height: 971, maximized: true }, flat);
  assert.ok(LEAF_KEYS.has('windowBounds'));
  assert.deepEqual([...flat.keys()], ['windowBounds']);
  assert.equal(flat.get('windowBounds').width, 3008);
});

test('workspaces are NOT flattened here — they route to their own table', () => {
  assert.equal(LEAF_KEYS.has('workspaces'), false);
  assert.equal(LEAF_KEYS.has('sync.disabledWorkspaceIds'), false);
});

test('a null value is a leaf, not a recursion target', () => {
  const flat = new Map();
  flattenInto('windowBounds', null, flat);
  assert.deepEqual([...flat.keys()], ['windowBounds']);
  assert.equal(flat.get('windowBounds'), null);
});

// ── Row value encoding ───────────────────────────────────────────────────────

test('each value type round-trips through encode/decode', () => {
  for (const v of ['hello', '', 42, 0, -1.5, true, false, null, ['a', 'b'], { x: 1 }]) {
    const t = typeOf(v);
    assert.deepEqual(decodeValue(encodeValue(v, t), t), v, `failed for ${JSON.stringify(v)}`);
  }
});

test('a corrupt json value decodes to null rather than throwing', () => {
  assert.equal(decodeValue('{not json', 'json'), null);
});
