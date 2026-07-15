// OAuth2 engine for user-managed agent credentials (the `oauth`-kind
// AgentSecret). Runs entirely in the main process. The redirect problem — a
// desktop app has no web server to catch the provider's callback — is solved
// the RFC 8252 way: open the user's SYSTEM browser (shell.openExternal), and
// catch the redirect on a throwaway loopback HTTP server (127.0.0.1:<ephemeral
// port>). Auth code + PKCE exchange and refresh are done by `arctic`.
//
// Deliberately BYO-client: the user creates their own OAuth client in the
// provider console (for Google, the "Desktop app" client type, which accepts
// loopback redirects) and pastes clientId + clientSecret into settings. We only
// ever handle their tokens, never our own app identity.
//
// This module holds no settings of its own — main.ts injects readSettings /
// writeSettings via initOAuth (same inversion as installAgentTokensBridge), so
// there's no circular import back into the entry file.

import http from 'node:http';
import { shell } from 'electron';
import {
  OAuth2Client,
  CodeChallengeMethod,
  generateState,
  generateCodeVerifier,
} from 'arctic';

// Refresh this many ms BEFORE the real expiry, so a token handed to the agent
// isn't already stale by the time the outbound API call lands.
const EXPIRY_SKEW_MS = 60_000;

// ── Provider presets ────────────────────────────────────────────────────────
// Endpoints/scopes/quirks baked in (sourced from arctic's provider defs). The
// user always supplies their own client id + secret. `custom` lets them point
// at any other OAuth2 provider by pasting the two endpoint URLs.
export interface ProviderPreset {
  id: string;
  label: string;
  authUrl?: string; // omitted for `custom`
  tokenUrl?: string;
  defaultScopes: string[];
  pkce: boolean;
  authParams?: Record<string, string>; // extra authorize-URL params
  custom?: boolean;
  hint?: string;
  // Curated "popular setup" scope bundles for the connect form's second
  // dropdown. Purely a UI convenience — selecting one fills the scopes field;
  // nothing about a setup is persisted (the stored secret carries only scopes).
  setups?: OAuthSetup[];
}

export interface OAuthSetup {
  id: string;
  label: string;
  description?: string;
  scopes: string[];
}

// Google API scope base — full scope URLs are this + the short suffix.
const G = 'https://www.googleapis.com/auth/';
// Identity scopes bundled into most Google/Microsoft setups so the connected
// row can show which account (an id_token is only returned with `openid`).
const GID = ['openid', 'email'];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'google',
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes: ['openid', 'email', 'profile'],
    pkce: true,
    // offline + forced consent guarantee a refresh token (incl. on re-auth)
    authParams: { access_type: 'offline', prompt: 'consent' },
    hint: 'Create a "Desktop app" OAuth client so the loopback redirect is accepted.',
    // One entry per Google service, erring toward broader access.
    setups: [
      { id: 'gmail', label: 'Gmail', description: 'Read, organize, and send mail.', scopes: [`${G}gmail.modify`, `${G}gmail.send`, ...GID] },
      { id: 'drive', label: 'Drive', description: 'Full read/write to your Drive files.', scopes: [`${G}drive`, ...GID] },
      { id: 'sheets', label: 'Sheets', description: 'Read and write spreadsheets.', scopes: [`${G}spreadsheets`, ...GID] },
      { id: 'docs', label: 'Docs', description: 'Read and write documents.', scopes: [`${G}documents`, ...GID] },
      { id: 'calendar', label: 'Calendar', description: 'View and manage calendars and events.', scopes: [`${G}calendar`, ...GID] },
      { id: 'identity', label: 'Sign-in only', description: 'Just identity (email + profile).', scopes: ['openid', 'email', 'profile'] },
    ],
  },
  {
    id: 'microsoft',
    label: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    defaultScopes: ['openid', 'email', 'profile', 'offline_access', 'User.Read'],
    pkce: true,
    authParams: { prompt: 'consent' },
    hint: "Uses the multi-tenant 'common' endpoint. offline_access is included so a refresh token is issued.",
    setups: [
      { id: 'mail', label: 'Mail', description: 'Read and send mail.', scopes: ['Mail.ReadWrite', 'Mail.Send', 'offline_access', ...GID] },
      { id: 'files', label: 'Files', description: 'Read and write OneDrive/SharePoint files.', scopes: ['Files.ReadWrite.All', 'offline_access', ...GID] },
      { id: 'calendar', label: 'Calendar', description: 'View and manage events.', scopes: ['Calendars.ReadWrite', 'offline_access', ...GID] },
      { id: 'identity', label: 'Sign-in only', description: 'Just identity + basic profile.', scopes: ['openid', 'email', 'profile', 'offline_access', 'User.Read'] },
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    defaultScopes: ['read:user'],
    pkce: false,
    hint: 'GitHub OAuth apps need an exact callback URL — loopback with a random port will not match. Prefer a device-flow provider or use a fixed-port build.',
    setups: [
      { id: 'repo', label: 'Repositories', description: 'Full control of repos plus Actions workflows.', scopes: ['repo', 'workflow'] },
      { id: 'gists', label: 'Gists', description: 'Create and edit gists.', scopes: ['gist', 'read:user'] },
      { id: 'profile', label: 'Profile & orgs', description: 'Read profile and org membership.', scopes: ['read:user', 'read:org'] },
    ],
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    authUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    defaultScopes: ['read_user'],
    pkce: true,
    setups: [
      { id: 'api', label: 'API', description: 'Full read/write API access.', scopes: ['api'] },
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    authUrl: 'https://slack.com/openid/connect/authorize',
    tokenUrl: 'https://slack.com/api/openid.connect.token',
    defaultScopes: ['openid', 'email', 'profile'],
    pkce: false,
    setups: [
      { id: 'identity', label: 'Sign-in only', description: 'OpenID identity (email + profile).', scopes: ['openid', 'email', 'profile'] },
    ],
  },
  {
    id: 'notion',
    label: 'Notion',
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    defaultScopes: [],
    pkce: false,
    authParams: { owner: 'user' },
    hint: 'Access is granted on the Notion integration, not via scopes — leave scopes empty.',
    setups: [
      { id: 'default', label: 'Default', description: 'Access is configured on the Notion integration itself.', scopes: [] },
    ],
  },
  {
    id: 'linear',
    label: 'Linear',
    authUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    defaultScopes: ['read'],
    pkce: false,
    setups: [
      { id: 'write', label: 'Read & write', description: 'Read and write issues, projects, etc.', scopes: ['read', 'write'] },
    ],
  },
  {
    id: 'dropbox',
    label: 'Dropbox',
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    defaultScopes: ['account_info.read'],
    pkce: true,
    authParams: { token_access_type: 'offline' }, // refresh token
    setups: [
      { id: 'files', label: 'Files', description: 'Read and write files.', scopes: ['account_info.read', 'files.content.read', 'files.content.write'] },
    ],
  },
  {
    id: 'atlassian',
    label: 'Atlassian (Jira/Confluence)',
    authUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    defaultScopes: ['read:me', 'offline_access'],
    pkce: false,
    authParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    setups: [
      { id: 'jira', label: 'Jira', description: 'Read and write Jira work.', scopes: ['read:jira-work', 'write:jira-work', 'offline_access'] },
      { id: 'confluence', label: 'Confluence', description: 'Read Confluence content.', scopes: ['read:confluence-content.all', 'offline_access'] },
    ],
  },
  {
    id: 'custom',
    label: 'Custom (any OAuth2 provider)',
    defaultScopes: [],
    pkce: true,
    custom: true,
    hint: "Paste the provider's authorization and token endpoint URLs.",
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

// Effective endpoints/scopes/flags for a stored connection.
interface ProviderConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce: boolean;
  authParams: Record<string, string>;
  clientId: string;
  clientSecret: string;
}

function resolveProviderConfig(o: any): ProviderConfig {
  const scopes: string[] = o.scopes ?? [];
  const base = { clientId: o.clientId, clientSecret: o.clientSecret };
  if (o.provider === 'custom') {
    if (!o.authUrl || !o.tokenUrl) throw new Error('Custom provider is missing endpoint URLs');
    return { ...base, authUrl: o.authUrl, tokenUrl: o.tokenUrl, scopes, pkce: true, authParams: {} };
  }
  const preset = getPreset(o.provider ?? '');
  if (!preset || !preset.authUrl || !preset.tokenUrl) {
    throw new Error(`Unknown OAuth provider: ${o.provider}`);
  }
  return {
    ...base,
    authUrl: preset.authUrl,
    tokenUrl: preset.tokenUrl,
    scopes: scopes.length ? scopes : preset.defaultScopes,
    pkce: preset.pkce,
    authParams: preset.authParams ?? {},
  };
}

// ── Settings injection (avoids a circular import into main.ts) ───────────────
type ReadSettings = () => Promise<any>;
type WriteSettings = (patch: any) => Promise<void>;
let _read: ReadSettings | null = null;
let _write: WriteSettings | null = null;

export function initOAuth(deps: { readSettings: ReadSettings; writeSettings: WriteSettings }) {
  _read = deps.readSettings;
  _write = deps.writeSettings;
}

async function loadSecret(name: string): Promise<any | undefined> {
  const settings = await _read!();
  return (settings.agentSecrets ?? []).find((s: any) => s.name === name);
}

// Read-modify-write the whole agentSecrets array (arrays are shallow-replaced by
// writeSettings, so we must send the full list). Values are decrypted plaintext
// here; writeSettings re-encrypts the secret fields idempotently. Serialized
// through the settings write queue in main, so writes don't tear — but the
// read→write gap is not transactional. OAuth writes are user-paced and rare, so
// a lost update is acceptable (matches the renderer's own array-write pattern).
async function patchSecret(name: string, mut: (o: any) => any): Promise<void> {
  const settings = await _read!();
  const list = settings.agentSecrets ?? [];
  const next = list.map((s: any) => (s.name === name ? { ...s, oauth: mut(s.oauth ?? {}), updatedAt: nowMs() } : s));
  await _write!({ agentSecrets: next });
}

// Injected clock — the app already avoids Date.now() in watcher/mtime paths, but
// here we genuinely need wall-clock for token expiry. Isolated so it's the one
// obvious place if that ever needs to change.
function nowMs(): number {
  return Date.now();
}

// ── Loopback server ──────────────────────────────────────────────────────────
function listenLoopback(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    // Port 0 → OS assigns an ephemeral free port. Google (Desktop client type)
    // accepts any loopback port; exact-match providers (GitHub) will not — see
    // their preset hint.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port });
      else reject(new Error('Failed to bind loopback port'));
    });
  });
}

// ── Token endpoint I/O ───────────────────────────────────────────────────────
// We do the token exchange + refresh with our own fetch rather than arctic's
// OAuth2Client methods: arctic (v3.7.0) manually sets a `Content-Length` header
// on its token request, which Electron's undici rejects ("invalid content-length
// header", UND_ERR_INVALID_ARG). arctic is still used for the pure URL + PKCE
// building (no fetch there). Credentials go in the body (client_id +
// client_secret) — the form every mainstream provider accepts.
async function postToken(cfg: ProviderConfig, params: Record<string, string>): Promise<any> {
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || json.error) {
    throw new Error(json.error_description || json.error || `Token request failed (HTTP ${res.status})`);
  }
  return json;
}

type ExtractedTokens = { accessToken: string; refreshToken?: string; expiresAt?: number; accountEmail?: string };

function extractTokens(json: any): ExtractedTokens {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || undefined,
    expiresAt: typeof json.expires_in === 'number' ? nowMs() + json.expires_in * 1000 : undefined,
    accountEmail: emailFromIdToken(json.id_token) || undefined,
  };
}

function exchangeCode(cfg: ProviderConfig, code: string, redirectUri: string, verifier: string | null): Promise<any> {
  return postToken(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    ...(cfg.pkce && verifier ? { code_verifier: verifier } : {}),
  });
}

function refreshToken(cfg: ProviderConfig, refresh: string): Promise<any> {
  return postToken(cfg, {
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
}

// Best-effort account email from an OIDC id_token (display only, never trusted).
function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  try {
    const seg = idToken.split('.')[1];
    if (!seg) return null;
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

// ── Connect flow ─────────────────────────────────────────────────────────────
// In-flight connect flows keyed by the `state` param. Holds the PKCE verifier
// and the config for the duration of the browser round-trip. Replaces knack's
// httpOnly cookies (a webapp mechanism we don't have).
interface Flow {
  verifier: string;
  cfg: ProviderConfig;
}

// Opens the system browser to the provider's consent screen and resolves once
// the loopback catches the redirect and the code is exchanged. Persists tokens
// and flips status to 'connected'. Rejects on error/denial/timeout.
export async function startConnect(secretName: string): Promise<{ accountEmail?: string }> {
  const secret = await loadSecret(secretName);
  if (!secret?.oauth) throw new Error(`No OAuth connection named "${secretName}"`);
  const cfg = resolveProviderConfig(secret.oauth);

  const { server, port } = await listenLoopback();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret, redirectUri);

  const state = generateState();
  const verifier = generateCodeVerifier();
  const flow: Flow = { verifier, cfg };

  const url = cfg.pkce
    ? client.createAuthorizationURLWithPKCE(cfg.authUrl, state, CodeChallengeMethod.S256, verifier, cfg.scopes)
    : client.createAuthorizationURL(cfg.authUrl, state, cfg.scopes);
  for (const [k, v] of Object.entries(cfg.authParams)) url.searchParams.set(k, v);

  return new Promise((resolve, reject) => {
    // Abandon the flow if the user never completes it (browser closed, etc.).
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Authorization timed out'));
    }, 5 * 60_000);

    function cleanup() {
      clearTimeout(timeout);
      try {
        server.close();
      } catch {
        /* already closed */
      }
    }

    // Render the browser page reflecting the TRUE result. `ok` false ⇒ the page
    // shows a failure and the app surfaces `detail`.
    const respond = (res: any, message: string) => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:3rem;text-align:center">${message}</body>`);
      } catch {
        /* socket already gone */
      }
    };

    server.on('request', async (req, res) => {
      try {
        const u = new URL(req.url ?? '/', redirectUri);
        if (u.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        const returnedState = u.searchParams.get('state');
        if (err || !code || returnedState !== state) {
          respond(res, 'Authorization failed. You can close this tab and return to the app.');
          cleanup();
          if (err) return reject(new Error(`Provider returned error: ${err}`));
          if (!code) return reject(new Error('No authorization code returned'));
          return reject(new Error('State mismatch (possible CSRF)')); // state check = CSRF defense
        }
        // Exchange the code BEFORE responding, so the browser message reflects
        // whether the token exchange actually succeeded (not just that the
        // redirect landed).
        const json = await exchangeCode(cfg, code, redirectUri, cfg.pkce ? flow.verifier : null);
        const extracted = extractTokens(json);
        await storeConnected(secretName, extracted);
        respond(res, 'Connected. You can close this tab and return to the app.');
        cleanup();
        resolve({ accountEmail: extracted.accountEmail });
      } catch (e: any) {
        respond(res, 'Could not complete the connection. You can close this tab and return to the app.');
        cleanup();
        reject(e);
      }
    });

    shell.openExternal(url.toString()).catch((e) => {
      cleanup();
      reject(e);
    });
  });
}

async function storeConnected(name: string, t: { accessToken: string; refreshToken?: string; expiresAt?: number; accountEmail?: string }): Promise<void> {
  await patchSecret(name, (o) => ({
    ...o,
    accessToken: t.accessToken,
    // Preserve an existing refresh token when the provider omits one on re-auth
    // (Google only returns it on the first consent unless prompt=consent forces
    // it — we force it, but other providers vary).
    refreshToken: t.refreshToken ?? o.refreshToken ?? '',
    expiresAt: t.expiresAt,
    accountEmail: t.accountEmail ?? o.accountEmail,
    status: 'connected',
  }));
}

// ── Refresh-on-demand ────────────────────────────────────────────────────────
// The pi bridge calls this for an oauth-kind secret. Returns a LIVE access
// token, refreshing first if it's within the skew window. Concurrent callers for
// the same name share one refresh (Google rotates refresh tokens, so a double
// refresh could invalidate the newer one).
const inFlightRefresh = new Map<string, Promise<string>>();

export async function getFreshToken(name: string): Promise<string> {
  const secret = await loadSecret(name);
  const o = secret?.oauth;
  if (!o) throw new Error(`No OAuth connection named "${name}"`);

  const fresh = o.expiresAt == null || o.expiresAt - EXPIRY_SKEW_MS > nowMs();
  if (o.accessToken && fresh) return o.accessToken;

  if (!o.refreshToken) {
    await patchSecret(name, (x) => ({ ...x, status: 'expired' }));
    throw new Error(`"${name}" has no refresh token — reconnect it in Settings.`);
  }

  const existing = inFlightRefresh.get(name);
  if (existing) return existing;

  const p = (async () => {
    const cfg = resolveProviderConfig(o);
    try {
      const json = await refreshToken(cfg, o.refreshToken);
      const extracted = extractTokens(json);
      await storeConnected(name, extracted);
      return extracted.accessToken;
    } catch (e: any) {
      await patchSecret(name, (x) => ({ ...x, status: 'expired' }));
      throw new Error(`Token refresh failed for "${name}" — reconnect it in Settings. (${e?.message ?? e})`);
    } finally {
      inFlightRefresh.delete(name);
    }
  })();
  inFlightRefresh.set(name, p);
  return p;
}

// ── Disconnect ───────────────────────────────────────────────────────────────
// Clears the live tokens but keeps client config so the user can re-Connect
// without re-entering client id/secret. (Full removal is a normal secret delete.)
export async function disconnect(name: string): Promise<void> {
  await patchSecret(name, (o) => ({
    ...o,
    accessToken: '',
    refreshToken: '',
    expiresAt: undefined,
    status: 'disconnected',
  }));
}
