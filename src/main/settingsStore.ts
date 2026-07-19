// Settings persistence. Replaces the old `<userData>/settings.json` read/write
// pair; `readSettings` and `writeSettings` keep their signatures, so every call
// site in main.ts, oauth.ts and cron.ts is unchanged and the renderer still sees
// one flat `Settings` object.
//
// ── Four tables, by what the data IS ─────────────────────────────────────────
//   setting          scalar preferences, one row per dotted leaf key
//   workspace        workspace entities — which GitHub repo each one is
//   workspace_local  per (workspace, machine): path, active, sync on/off
//   agent_secret     agent-secret entities, no crypto columns
//   secret_value     EVERY encrypted value, crypto columns NOT NULL
//
// Key-value suits preferences — heterogeneous, sparse, unrelated scalars. It
// suits collections badly: an entity spread across N rows has no atomicity, so a
// partial delete leaves a half-record. Those get real tables.
//
// Secrets get their own table because the crypto columns can then be NOT NULL,
// which makes a plaintext credential unrepresentable. The two designs this
// replaced both failed silently in the same way: hand-maintained encrypt/decrypt
// field lists in main.ts (miss one, it persists in the clear), then a `secret`
// flag on `setting` (set it wrong, same result). A row in `secret_value` cannot
// hold a plaintext value at all.
//
// ── Write ownership ──────────────────────────────────────────────────────────
// The renderer sends whole subtrees from React state on every save. Anything
// main authors could therefore be clobbered by a stale echo. Two fields are
// fenced off:
//   - OAuth tokens (OAUTH_OWNED_FIELDS / OAUTH_OWNED_COLUMNS) — writable only via
//     patchAgentSecretOAuth. Google rotates refresh tokens on every refresh, so a
//     lost write there killed the connection permanently.
//   - `workspaces` and `activeWorkspaceId` — both DERIVED from the two workspace
//     tables on read. A settings save can rename and reorder; it cannot create a
//     workspace (it has no repo columns to create one from) and cannot delete
//     one (removal is its own IPC), so a stale renderer list can't erase a
//     workspace it hadn't heard about.

import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage, BrowserWindow } from 'electron';
import { and, eq, like, notInArray } from 'drizzle-orm';
import {
  getDb, listWorkspaces, updateWorkspaces,
  getActiveWorkspaceId, setActiveWorkspace,
} from './db/index.js';
import { setting, agentSecret, secretValue } from './db/schema.js';
import { projectWorkspaceRow } from './workspaceRow.js';
import { seal, unseal } from './masterKey.js';
// Pure key policy + shape mapping, in a plain `.js` sibling so node --test can
// exercise it without Electron. See settingsKeys.js.
import {
  isSettingsSecretKey, SETTINGS_SECRET_OWNER, AGENT_SECRET_FIELDS, isOAuthOwnedField,
  OAUTH_OWNED_COLUMNS, flattenInto, setPath, typeOf, encodeValue, decodeValue,
  isPlainObject, splitAgentSecret, joinAgentSecret,
} from './settingsKeys.js';

const KEY_VERSION = 1;

// ─── Change notification ─────────────────────────────────────────────────────
// The DB is the source of truth, but the renderer necessarily holds a copy to
// render from. Main writes settings in several places the renderer has no way to
// learn about — OAuth token refresh, window bounds, cron toggles,
// ensureBuiltinSecretSlots — and that copy would silently go stale.
//
// Fires ONLY for main-initiated writes. The `settings:write` IPC passes
// `notify: false`, because the renderer already knows what it just wrote and
// echoing it back could clobber a newer local edit mid-flight.
//
// The payload carries the changed top-level KEYS plus a fresh full read. The
// renderer applies only those keys, so an unrelated main write (window bounds,
// say) can't stomp a settings field the user is editing right now.
async function emitChanged(keys: string[]) {
  if (!keys.length) return;
  try {
    const settings = await readSettings();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed', { keys, settings });
    }
  } catch (err: any) {
    console.warn('[settings] could not emit change event:', err?.message ?? err);
  }
}

// ─── Defaults ────────────────────────────────────────────────────────────────
// Single source of truth for the persisted shape; main.ts imports this. A key
// with no row falls back to its value here — which is what lets the old
// hand-written per-key deep-merge in readSettings stay gone.
export const DEFAULT_SETTINGS = {
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: 'system', hideLineNumbers: false, treePanel: { content: 'off', count: 10 } },
  // Daily-note + template config are per-workspace (`.shockwave/workspace.json`).
  codingAgent: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    providerKeys: {},
    baseUrl: '',
    thinkingLevel: 'medium',
  },
  agentSecrets: [],
  transcription: { provider: 'assemblyai', apiKey: '' },
  sync: { pat: '', pullIntervalSeconds: 10 },
  cron: { enabled: false, maxCatchupHours: 36, maxRunMinutes: 30 },
  chatSidebarOpen: false,
  chatSidebarWidth: 360,
  sidebarWidth: 260,
  viewMode: 'live',
  treeSortOrder: 'name-asc',
  bookmarkFilterActive: false,
  windowBounds: null,
};

// ─── secret_value helpers ────────────────────────────────────────────────────

function secretRow(owner: string, field: string, plain: string, now: number) {
  const sealed = seal(plain);
  return {
    owner, field,
    ciphertext: sealed.value, iv: sealed.iv, tag: sealed.tag,
    keyVersion: KEY_VERSION, updatedAt: now,
  };
}

// Upsert, or DELETE when the value is empty — absence means "not set", so we
// never store an encrypted empty string (and "is it configured" stays a
// row-existence check rather than decrypt-then-compare).
function putSecret(tx: any, owner: string, field: string, plain: string, now: number) {
  if (!plain) {
    tx.delete(secretValue).where(and(eq(secretValue.owner, owner), eq(secretValue.field, field))).run();
    return;
  }
  const row = secretRow(owner, field, plain, now);
  tx.insert(secretValue).values(row).onConflictDoUpdate({
    target: [secretValue.owner, secretValue.field],
    set: { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyVersion: row.keyVersion, updatedAt: row.updatedAt },
  }).run();
}

// owner → { field: plaintext }. A row that fails to decrypt yields '' and warns
// (inside unseal), so one bad row can't take down the whole settings read.
function loadSecrets(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const row of getDb().select().from(secretValue).all() as any[]) {
    const bucket = out.get(row.owner) ?? {};
    bucket[row.field] = unseal({ value: row.ciphertext, iv: row.iv as Buffer, tag: row.tag as Buffer });
    out.set(row.owner, bucket);
  }
  return out;
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function readSettings(): Promise<any> {
  const db = getDb();
  const merged: any = structuredClone(DEFAULT_SETTINGS);
  const secrets = loadSecrets();

  for (const row of db.select().from(setting).all() as any[]) {
    setPath(merged, row.key, decodeValue(row.value, row.type));
  }

  // Standalone credentials: the field IS the settings key.
  for (const [field, plain] of Object.entries(secrets.get(SETTINGS_SECRET_OWNER) ?? {})) {
    setPath(merged, field, plain);
  }

  // Agent secrets: entity row + its credential fields, ordered oldest-first so
  // the list is stable without storing an explicit order (which would be a
  // shared row, reintroducing the cross-writer collision this design removes).
  merged.agentSecrets = (db.select().from(agentSecret).all() as any[])
    .map((row) => joinAgentSecret(row, secrets.get(row.name) ?? {}))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.name).localeCompare(String(b.name)));

  // Workspaces are entities but surfaced here so the renderer keeps seeing plain
  // Settings fields. `path` is NULL for a workspace that exists but isn't cloned
  // on this machine — the list renders it with a "set up here" action rather
  // than hiding it. `repo` is display-only ("owner/name"); the columns behind it
  // stay main-only.
  merged.workspaces = listWorkspaces().map(projectWorkspaceRow);
  // Derived, like the list above: it's `workspace_local.active` on THIS machine,
  // not a stored scalar. As a `setting` row it was a foreign key hiding in a
  // key-value store — global when it should be per-machine, and free to name a
  // workspace that had been deleted.
  merged.activeWorkspaceId = getActiveWorkspaceId();

  return merged;
}

// ─── Write ───────────────────────────────────────────────────────────────────

export async function writeSettings(patch: any, opts: { notify?: boolean } = {}): Promise<void> {
  if (!patch || typeof patch !== 'object') return;
  const db = getDb();
  const now = Date.now();

  const flat = new Map<string, any>();
  let agentSecretsPatch: any[] | null = null;
  // Set when the caller sends the whole providerKeys map (see below).
  let providerKeysPatch: Record<string, any> | null = null;

  // The renderer may address this map by its dotted path (settingsDiff's
  // MAP_KEYS) rather than nesting it under codingAgent.
  if (isPlainObject((patch as any)['codingAgent.providerKeys'])) {
    providerKeysPatch = (patch as any)['codingAgent.providerKeys'];
    delete (patch as any)['codingAgent.providerKeys'];
  }

  for (const [key, value] of Object.entries(patch)) {
    // Entity collections are routed to their tables BEFORE flattening, so no
    // stray settings row can reappear and shadow the table.
    if (key === 'agentSecrets') {
      agentSecretsPatch = Array.isArray(value) ? value : [];
      continue;
    }
    if (key === 'workspaces') {
      // Renames + reorder only. It cannot insert (a workspace needs repo
      // columns the renderer doesn't carry) and it cannot delete — removal is
      // its own IPC, so a settings save built from a stale list can't erase a
      // workspace the renderer hadn't heard about yet.
      updateWorkspaces(Array.isArray(value) ? (value as any[]) : []);
      continue;
    }
    if (key === 'activeWorkspaceId') {
      // Derived on read, so it's routed to its column on write rather than
      // flattening into a `setting` row that would then shadow the truth.
      setActiveWorkspace(typeof value === 'string' ? value : null);
      continue;
    }
    if (key === 'codingAgent' && isPlainObject(value)) {
      // Nested form: pull the map out so it reconciles instead of flattening
      // into per-slug rows that can never be removed.
      const { providerKeys, ...rest } = value as any;
      if (isPlainObject(providerKeys)) providerKeysPatch = providerKeys;
      flattenInto(key, rest, flat);
      continue;
    }
    flattenInto(key, value, flat);
  }

  db.transaction((tx: any) => {
    for (const [key, value] of flat) {
      // Credentials never become settings rows.
      if (isSettingsSecretKey(key)) {
        putSecret(tx, SETTINGS_SECRET_OWNER, key, typeof value === 'string' ? value : '', now);
        continue;
      }
      const type = typeOf(value);
      const row = { key, value: encodeValue(value, type), type, updatedAt: now };
      tx.insert(setting).values(row).onConflictDoUpdate({ target: setting.key, set: row }).run();
    }

    if (providerKeysPatch) reconcileProviderKeys(tx, providerKeysPatch, now);
    if (agentSecretsPatch) writeAgentSecrets(tx, agentSecretsPatch, now);
  });

  // Default true: a main-side caller shouldn't have to remember to notify. The
  // `settings:write` IPC is the one place that opts out.
  if (opts.notify !== false) await emitChanged(Object.keys(patch));
}

// Reconciles the per-provider API keys against the full map the caller sent.
//
// Removal is the whole point. Per-key rows only ever get written for keys the
// caller mentions, so a slug dropped from the map would otherwise keep its row —
// and readSettings would put the deleted key straight back into settings. That
// made "delete this API key" a lie: the credential stayed encrypted on disk and
// reappeared on the next read.
function reconcileProviderKeys(tx: any, map: Record<string, any>, now: number) {
  const prefix = 'codingAgent.providerKeys.';
  const keep = new Set(Object.keys(map).map((slug) => `${prefix}${slug}`));
  const existing = tx.select({ field: secretValue.field }).from(secretValue)
    .where(and(eq(secretValue.owner, SETTINGS_SECRET_OWNER), like(secretValue.field, `${prefix}%`)))
    .all() as { field: string }[];

  for (const { field } of existing) {
    if (!keep.has(field)) {
      tx.delete(secretValue)
        .where(and(eq(secretValue.owner, SETTINGS_SECRET_OWNER), eq(secretValue.field, field)))
        .run();
    }
  }
  for (const [slug, val] of Object.entries(map)) {
    putSecret(tx, SETTINGS_SECRET_OWNER, `${prefix}${slug}`, typeof val === 'string' ? val : '', now);
  }
}

// Reconciles agent_secret + secret_value against the full list the caller sent.
// Removed entries take their credentials with them; surviving entries keep the
// OAuth-flow-owned fields untouched, because the caller isn't their author and
// its silence is not a deletion.
function writeAgentSecrets(tx: any, list: any[], now: number) {
  const keep = list.filter((s) => s?.name).map((s) => s.name as string);

  if (keep.length) {
    tx.delete(agentSecret).where(notInArray(agentSecret.name, keep)).run();
    tx.delete(secretValue).where(and(
      notInArray(secretValue.owner, [...keep, SETTINGS_SECRET_OWNER]),
    )).run();
  } else {
    tx.delete(agentSecret).run();
    tx.delete(secretValue).where(notInArray(secretValue.owner, [SETTINGS_SECRET_OWNER])).run();
  }

  for (const entry of list) {
    if (!entry?.name) continue;
    const { row, secrets } = splitAgentSecret(entry);

    // Strip flow-owned columns so a stale echo can't roll back OAuth state.
    const insertRow: any = { ...row, createdAt: row.createdAt || now, updatedAt: now };
    const updateRow: any = { ...insertRow };
    for (const col of OAUTH_OWNED_COLUMNS) delete updateRow[col];
    delete updateRow.createdAt;

    tx.insert(agentSecret).values(insertRow)
      .onConflictDoUpdate({ target: agentSecret.name, set: updateRow }).run();

    for (const field of AGENT_SECRET_FIELDS) {
      if (isOAuthOwnedField(field)) continue; // patchAgentSecretOAuth owns these
      if (!(field in secrets)) continue;
      putSecret(tx, entry.name, field, (secrets as any)[field] ?? '', now);
    }
  }
}

// Targeted OAuth-state write — the point of the split. Touches only this
// connection's token fields and status columns, so a concurrent settings save
// cannot carry a stale copy of them over the top.
export async function patchAgentSecretOAuth(name: string, patch: Record<string, any>): Promise<void> {
  const db = getDb();
  const now = Date.now();
  db.transaction((tx: any) => {
    const cols: any = { updatedAt: now };
    if ('expiresAt' in patch) cols.oauthExpiresAt = patch.expiresAt ?? null;
    if ('status' in patch) cols.oauthStatus = patch.status ?? null;
    if ('accountEmail' in patch) cols.oauthAccountEmail = patch.accountEmail ?? null;
    if ('provider' in patch) cols.oauthProvider = patch.provider ?? null;
    if ('clientId' in patch) cols.oauthClientId = patch.clientId ?? null;
    if ('scopes' in patch) cols.oauthScopes = patch.scopes ? JSON.stringify(patch.scopes) : null;
    tx.update(agentSecret).set(cols).where(eq(agentSecret.name, name)).run();

    for (const [k, field] of [
      ['accessToken', 'oauth.accessToken'],
      ['refreshToken', 'oauth.refreshToken'],
      ['clientSecret', 'oauth.clientSecret'],
    ] as const) {
      if (k in patch) putSecret(tx, name, field, patch[k] ?? '', now);
    }
  });
  // Always main-initiated (oauth.ts). This is what makes the renderer's manual
  // reloadAgentSecrets after Connect/Disconnect unnecessary.
  await emitChanged(['agentSecrets']);
}

// Push the workspace list after main has inserted or deleted a row. Keeps the
// renderer's copy fresh for RENDERING; it is no longer load-bearing for
// correctness the way it would be if a settings save could still delete.
export async function notifyWorkspacesChanged(): Promise<void> {
  await emitChanged(['workspaces', 'activeWorkspaceId']);
}

// ─── One-time import from the legacy settings.json ───────────────────────────
//
// Ships permanently: every install from v1.0.12 and earlier has a settings.json
// that must be carried across on first launch of a sqlite build. Runs once
// (guarded on the tables being empty), then never again.
//
// It can't be a standalone script — the legacy values are safeStorage-encrypted
// and safeStorage only exists inside a running Electron process, so the unwrap
// has to happen in main.
//
// Safe to delete only once no supported upgrade path still starts from a
// settings.json — i.e. long after the sqlite build is the floor version.

const ENC_PREFIX = 'enc:v1:';

// Legacy per-field safeStorage unwrap — used only by the import below.
function legacyDecrypt(stored: any): string {
  if (typeof stored !== 'string' || !stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored; // pre-encryption plaintext
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch (err: any) {
    console.warn('[settings] legacy decrypt failed during import:', err?.message ?? err);
    return '';
  }
}

// Runs once at startup, before anything reads settings. No-op when any table
// already holds data or no legacy file exists. The old file is RENAMED, never
// deleted — if the import gets something wrong the original is still on disk.
export async function importLegacySettingsIfNeeded(): Promise<boolean> {
  const db = getDb();
  if (db.select({ key: setting.key }).from(setting).limit(1).all().length) return false;
  if (db.select({ name: agentSecret.name }).from(agentSecret).limit(1).all().length) return false;

  const file = path.join(app.getPath('userData'), 'settings.json');
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // fresh install — defaults apply
  }

  // Decrypt every legacy secret so the import hands writeSettings plaintext,
  // which re-seals under the master key. Last place the old field list exists.
  const ca = parsed.codingAgent ?? {};
  if (ca.apiKey && ca.providerKeys?.[ca.provider] == null) {
    // Legacy single-key → per-provider migration, carried across as-is.
    ca.providerKeys = { ...(ca.providerKeys ?? {}), [ca.provider]: ca.apiKey };
  }
  delete ca.apiKey;
  for (const slug of Object.keys(ca.providerKeys ?? {})) {
    ca.providerKeys[slug] = legacyDecrypt(ca.providerKeys[slug]);
  }
  const agentSecrets = (Array.isArray(parsed.agentSecrets) ? parsed.agentSecrets : []).map((s: any) => ({
    ...s,
    token: legacyDecrypt(s?.token ?? ''),
    ...(s?.oauth
      ? {
          oauth: {
            ...s.oauth,
            clientSecret: legacyDecrypt(s.oauth.clientSecret ?? ''),
            accessToken: legacyDecrypt(s.oauth.accessToken ?? ''),
            refreshToken: legacyDecrypt(s.oauth.refreshToken ?? ''),
          },
        }
      : {}),
  }));
  if (parsed.transcription) parsed.transcription.apiKey = legacyDecrypt(parsed.transcription.apiKey ?? '');
  if (parsed.sync) parsed.sync.pat = legacyDecrypt(parsed.sync.pat ?? '');

  // Import only keys the current schema knows about. Old files carry retired
  // top-level keys (`ai`, and `dailyNote`/`templates` from before those moved to
  // per-workspace `.shockwave/workspace.json`); they'd just seed dead rows.
  const known: any = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in parsed) known[key] = parsed[key];
  }
  // Workspaces can't come across. A legacy entry is `{id, name, path}` — no
  // repo — and a workspace without one is unrepresentable now. Leaving them in
  // would be worse than dropping them: `writeSettings` routes `workspaces` to
  // `updateWorkspaces`, which by design cannot insert, so they'd vanish
  // silently while appearing to import. The folders and their repos are
  // untouched on disk; re-adding one is Settings → Workspaces → Add.
  delete known.workspaces;
  delete known.activeWorkspaceId;
  // Retired NESTED keys. Can't be caught by shape-matching against
  // DEFAULT_SETTINGS, because providerKeys is an open-ended map — a recursive
  // filter would delete real provider keys along with the cruft.
  //   codingAgent.systemPrompt — the prompt is assembled from SOUL.md now
  //   codingAgent.skills       — built-in toggles moved to per-workspace data
  //   appearance.dailyNotesInBookmarks — superseded by appearance.treePanel
  delete known.codingAgent?.systemPrompt;
  delete known.codingAgent?.skills;
  delete known.appearance?.dailyNotesInBookmarks;
  const full = { ...DEFAULT_SETTINGS, ...known, codingAgent: { ...DEFAULT_SETTINGS.codingAgent, ...ca }, agentSecrets };

  // OAuth token fields are flow-owned and skipped by writeSettings, so they're
  // seeded through the targeted patch afterwards.
  // notify:false — this runs before any window exists, and the renderer will
  // read the imported values on its own boot read anyway.
  await writeSettings(full, { notify: false });
  for (const s of agentSecrets) {
    if (!s?.oauth || !s?.name) continue;
    const { accessToken, refreshToken, expiresAt, status, accountEmail } = s.oauth;
    await patchAgentSecretOAuth(s.name, { accessToken, refreshToken, expiresAt, status, accountEmail });
  }

  try {
    fs.renameSync(file, `${file}.migrated`);
  } catch (err: any) {
    console.warn('[settings] could not rename legacy settings.json:', err?.message ?? err);
  }
  console.log(`[settings] imported legacy settings.json → sqlite (${agentSecrets.length} agent secrets)`);
  return true;
}
