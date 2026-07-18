// PURE key policy + shape mapping for the settings layer. No electron, no db —
// plain `.js` so `node --test` can exercise it directly, the same split as
// cronScheduler.js (pure) vs cron.ts (stateful). settingsStore.ts is the
// stateful half that does the crypto and SQL.
//
// Secrets no longer live in the `setting` table, so "is this key secret" is no
// longer a property of a settings key — it's a question of which (owner, field)
// pairs belong in `secret_value`. That table's crypto columns are NOT NULL, so a
// value routed there cannot be stored in the clear; the lists below decide only
// WHERE a value goes, not whether it happens to get encrypted.

// Standalone credentials, owned by 'settings' in secret_value. The settings key
// IS the field. Anything matching these is stripped out of the settings tree on
// write and spliced back in on read.
export const SETTINGS_SECRET_PATTERNS = [
  /^codingAgent\.providerKeys\.[^.]+$/,
  /^transcription\.apiKey$/,
  /^sync\.pat$/,
];

export const SETTINGS_SECRET_OWNER = 'settings';

export function isSettingsSecretKey(key) {
  return SETTINGS_SECRET_PATTERNS.some((re) => re.test(key));
}

// Credential fields on an agent secret, owned by that secret's name.
export const AGENT_SECRET_FIELDS = [
  'token',
  'oauth.clientSecret',
  'oauth.accessToken',
  'oauth.refreshToken',
];

export function isAgentSecretField(field) {
  return AGENT_SECRET_FIELDS.includes(field);
}

// Written by the OAuth flow only (oauth.ts → patchAgentSecretOAuth). A bulk
// writeSettings never authors these, so a caller echoing back pre-refresh state
// cannot overwrite a token main just rotated — Google rotates refresh tokens on
// every refresh, and a lost write there kills the connection permanently.
//
// clientId/clientSecret are deliberately absent: the user types those into
// Settings, so a bulk write MUST still be able to author them.
export const OAUTH_OWNED_FIELDS = ['oauth.accessToken', 'oauth.refreshToken'];
export const OAUTH_OWNED_COLUMNS = ['oauthExpiresAt', 'oauthStatus', 'oauthAccountEmail'];

export function isOAuthOwnedField(field) {
  return OAUTH_OWNED_FIELDS.includes(field);
}

// Stored whole rather than exploded: no secrets inside, and per-element rows
// would buy nothing. (`workspaces` and `sync.disabledWorkspaceIds` are NOT here
// — they're routed to the `workspace` table before flattening sees them.)
export const LEAF_KEYS = new Set(['windowBounds']);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Walks a settings sub-tree into dotted leaf keys. Arrays and LEAF_KEYS entries
// terminate the walk; plain objects recurse.
export function flattenInto(prefix, val, out) {
  if (LEAF_KEYS.has(prefix) || !isPlainObject(val)) {
    out.set(prefix, val);
    return;
  }
  for (const [k, v] of Object.entries(val)) {
    flattenInto(prefix ? `${prefix}.${k}` : k, v, out);
  }
}

export function setPath(root, dotted, value) {
  const parts = dotted.split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isPlainObject(node[p])) node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}

// Splits an agent-secret entry into the columns of `agent_secret` and the
// credential fields destined for `secret_value`. The single place that knows how
// the renderer's AgentSecret shape maps onto the two tables.
export function splitAgentSecret(entry) {
  const o = isPlainObject(entry.oauth) ? entry.oauth : null;
  const row = {
    name: entry.name,
    description: entry.description ?? null,
    kind: entry.kind ?? null,
    oauthProvider: o?.provider ?? null,
    oauthClientId: o?.clientId ?? null,
    oauthAuthUrl: o?.authUrl ?? null,
    oauthTokenUrl: o?.tokenUrl ?? null,
    oauthScopes: o?.scopes ? JSON.stringify(o.scopes) : null,
    oauthExpiresAt: o?.expiresAt ?? null,
    oauthStatus: o?.status ?? null,
    oauthAccountEmail: o?.accountEmail ?? null,
    createdAt: entry.createdAt ?? 0,
    updatedAt: entry.updatedAt ?? 0,
  };
  const secrets = {
    token: entry.token ?? '',
    ...(o
      ? {
          'oauth.clientSecret': o.clientSecret ?? '',
          'oauth.accessToken': o.accessToken ?? '',
          'oauth.refreshToken': o.refreshToken ?? '',
        }
      : {}),
  };
  return { row, secrets };
}

// Inverse of splitAgentSecret: an `agent_secret` row plus its decrypted
// credential fields, back into the AgentSecret shape the renderer expects.
// `oauth` is present only when the row carries OAuth config, matching the old
// behavior where non-OAuth entries had no `oauth` key at all.
export function joinAgentSecret(row, secrets) {
  const out = {
    name: row.name,
    description: row.description ?? '',
    token: secrets.token ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.kind) out.kind = row.kind;
  const hasOAuth = row.kind === 'oauth' || row.oauthProvider != null || row.oauthClientId != null;
  if (hasOAuth) {
    out.oauth = {
      provider: row.oauthProvider ?? '',
      clientId: row.oauthClientId ?? '',
      clientSecret: secrets['oauth.clientSecret'] ?? '',
      scopes: parseJsonArray(row.oauthScopes),
      accessToken: secrets['oauth.accessToken'] ?? '',
      refreshToken: secrets['oauth.refreshToken'] ?? '',
      status: row.oauthStatus ?? 'disconnected',
    };
    if (row.oauthAuthUrl != null) out.oauth.authUrl = row.oauthAuthUrl;
    if (row.oauthTokenUrl != null) out.oauth.tokenUrl = row.oauthTokenUrl;
    if (row.oauthExpiresAt != null) out.oauth.expiresAt = row.oauthExpiresAt;
    if (row.oauthAccountEmail != null) out.oauth.accountEmail = row.oauthAccountEmail;
  }
  return out;
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ── Row value encoding ───────────────────────────────────────────────────────
// `type` tells the reader how to parse `value` back.

export function typeOf(v) {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'json';
}

export function encodeValue(v, type) {
  if (type === 'string') return v;
  if (type === 'json') return JSON.stringify(v ?? null);
  return String(v);
}

export function decodeValue(raw, type) {
  if (type === 'string') return raw;
  if (type === 'number') return Number(raw);
  if (type === 'boolean') return raw === 'true';
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
