// The persisted settings schema — the single typed source of truth shared by
// main (readSettings/writeSettings) and the renderer (settingsRef).
//
// This is the shape the renderer sees. On disk it spans four sqlite tables —
// `setting` (scalar prefs), `workspace`, `agent_secret`, `secret_value` (all
// encrypted values) — but readSettings/writeSettings hide that entirely.
// `DEFAULT_SETTINGS` lives beside the store in src/main/settingsStore.ts, and a
// key with no row falls back to it. Keep the two in sync when adding a field —
// and if the field holds a credential, add its key pattern to
// SETTINGS_SECRET_PATTERNS in src/main/settingsKeys.js, or it lands in the
// `setting` table in plaintext.

export type ThemeMode = 'system' | 'light' | 'dark';
// What the quick-access panel pinned below the file tree shows (Explorer and
// Bookmarks views alike). 'both' lists Recent Files and Daily Notes as two
// sections, with daily notes excluded from Recent Files. Lists are always
// sorted last-modified desc and capped to `count` items each.
export type TreePanelContent = 'off' | 'recent' | 'daily' | 'both';
export type ViewMode = 'live' | 'raw';
export type TreeSortOrder =
  | 'name-asc'
  | 'name-desc'
  | 'modified-desc'
  | 'modified-asc'
  | 'created-desc'
  | 'created-asc';

export interface WorkspaceEntry {
  id: string;
  name: string;
  /** Absolute path of the checkout on THIS machine, or null when the workspace
   *  exists but isn't cloned here (a synced DB, or a folder that vanished). */
  path: string | null;
  /** "owner/name", for display. */
  repo: string;
  /** Whether this workspace syncs to GitHub ON THIS MACHINE. Lives here rather
   *  than in `sync` because it's per-workspace: as a list inside the sync object
   *  it was rebuilt — and dropped — whenever anything else in that object
   *  changed.
   *
   *  Stored as `workspace_local.sync_disabled` (0 = syncing), because a zero /
   *  absent row should mean normal behaviour. The negation happens once, in the
   *  projection — it used to leak up here and get negated three more times in
   *  the one switch that renders it. */
  syncEnabled: boolean;
}

export type SkillState = 'enabled' | 'disabled';

// Pi's thinking/reasoning levels. 'off' disables extended thinking; the rest map
// to pi's ModelThinkingLevel and are clamped to what each model actually supports
// (via getSupportedThinkingLevels in main). Kept as a local literal union so this
// shared file has no dependency on the pi SDK.
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodingAgentSettings {
  provider: string;
  model: string;
  // Per-provider API keys, keyed by provider slug, each encrypted at rest
  // (AES-256-GCM). Replaces the former single `apiKey` so switching providers keeps
  // each key. openai-compatible's key lives here too (under 'openai-compatible');
  // its baseUrl/contextWindow stay in the active fields below.
  providerKeys: Record<string, string>;
  // OpenAI-compatible endpoint URL (Ollama, LM Studio, vLLM, remote gateways).
  // Empty for built-in providers; set only when provider === 'openai-compatible'.
  baseUrl: string;
  // Optional context-window override (tokens) for openai-compatible models, whose
  // size pi can't know. Built-in providers carry authoritative values, so it's
  // unused there. Empty/undefined → 128000 default.
  contextWindow?: number;
  // Extended-thinking level applied at session boot. Clamped per-model by pi.
  // Note: an unset/omitted level makes pi fall back to 'medium' for reasoning-
  // capable models — this field makes the choice explicit and user-controllable.
  thinkingLevel: ThinkingLevel;
}

// OAuth connection state carried by an `oauth`-kind AgentSecret. The three
// secret-bearing fields (clientSecret, accessToken, refreshToken) are encrypted
// at rest like `token` — they live in `secret_value`, keyed by this entry's
// name; see AGENT_SECRET_FIELDS in src/main/settingsKeys.js. The token lifecycle
// fields (accessToken/refreshToken/expiresAt/status/accountEmail) are written
// ONLY by oauth.ts via patchAgentSecretOAuth; a bulk settings save cannot author
// them (OAUTH_OWNED_FIELDS / OAUTH_OWNED_COLUMNS), which is what stops a stale
// renderer copy from clobbering a token main just refreshed.
// `expiresAt` is an absolute epoch-ms deadline for the access
// token; the refresh-on-demand getter (oauth.ts) refreshes before it lapses.
export interface AgentSecretOAuth {
  provider: string;              // preset id (e.g. 'google') or 'custom'
  clientId: string;
  clientSecret: string;          // encrypted at rest
  authUrl?: string;              // custom provider only (presets bake these in)
  tokenUrl?: string;             // custom provider only
  scopes: string[];
  accessToken?: string;          // encrypted at rest
  refreshToken?: string;         // encrypted at rest
  expiresAt?: number;            // epoch ms; access-token expiry deadline
  accountEmail?: string;         // display only, decoded from an OIDC id_token
  status: 'disconnected' | 'connected' | 'expired';
}

// A credential the coding agent can use. Two kinds, discriminated by `kind`
// (absent ⇒ 'static' for back-compat with pre-OAuth settings files):
//   - 'static' — a pasted API token, in `token`.
//   - 'oauth'  — an OAuth2 connection, in `oauth`; `token` is unused. The agent
//                still fetches it by name via get_agent_secret, which returns a
//                freshly-refreshed access token (see oauth.ts / the bridge).
export interface AgentSecret {
  name: string;
  description: string;
  kind?: 'static' | 'oauth';
  token: string;
  oauth?: AgentSecretOAuth;
  createdAt?: number;
  updatedAt?: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

// Per-workspace data persisted to `<workspace>/.shockwave/workspace.json`.
// Everything scoped to a single workspace lives here (not in global settings):
// bookmarks, daily-note config, templates config, and built-in skill toggles.
export interface WorkspaceData {
  schemaVersion: number;
  // `.md` basenames (no folder, no extension), lowercased.
  bookmarks: string[];
  // `templatePath` is the workspace-relative path of the template seeded into a
  // newly-created daily note ('' = none).
  dailyNote: { format: string; folder: string; templatePath: string };
  // `folder` is the workspace-relative folder whose `.md` files are offered as
  // templates ('' = templates disabled / none configured).
  templates: { folder: string };
  // Built-in skill on/off for this workspace, by folderName. Absent key ⇒
  // enabled (built-ins are default-on). This is the only tier — there is no
  // global default.
  builtinSkills: Record<string, SkillState>;
}

export interface Settings {
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string | null;
  // `treePanel` replaced the boolean `dailyNotesInBookmarks` (old true migrates
  // to content 'daily' in useSettings.hydrateSettings).
  appearance: { themeMode: ThemeMode; hideLineNumbers: boolean; treePanel: { content: TreePanelContent; count: number } };
  // NOTE: `dailyNote` and `templates` are no longer global — they're per-
  // workspace, stored in `<workspace>/.shockwave/workspace.json` (see
  // `WorkspaceData` below), loaded on workspace switch.
  codingAgent: CodingAgentSettings;
  agentSecrets: AgentSecret[];
  transcription: { provider: string; apiKey: string };
  sync: { pat: string; pullIntervalSeconds: number };
  // Scheduled runs (cron). Machine-local and global: `enabled` is the master
  // on/off (gates FIRING only — watching/validation/UI stay live when off), and
  // cron follows the active workspace. Job definitions live per-workspace in
  // `<workspace>/cron.json`; only these knobs are global settings.
  // `maxCatchupHours`: a missed run fires only if its most-recent occurrence is
  // within this window (else it rolls forward). `maxRunMinutes`: a run exceeding
  // this is aborted so a hung provider can't wedge the scheduler.
  cron: { enabled: boolean; maxCatchupHours: number; maxRunMinutes: number };
  chatSidebarOpen: boolean;
  chatSidebarWidth: number;
  sidebarWidth: number;
  viewMode: ViewMode;
  treeSortOrder: TreeSortOrder;
  // Whether the file-tree is filtered to bookmarks only. Persisted globally so
  // the view survives restarts and workspace switches.
  bookmarkFilterActive: boolean;
  windowBounds: WindowBounds | null;
}
