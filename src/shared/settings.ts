// The persisted settings schema — the single typed source of truth shared by
// main (DEFAULT_SETTINGS / readSettings) and the renderer (settingsRef). Until
// those files are TypeScript this type isn't enforced against them at build
// time, but it's the contract: keep DEFAULT_SETTINGS in main.js in sync, and
// any .ts consumer (e.g. a future useSettings) is checked against it.

export type ThemeMode = 'system' | 'light' | 'dark';
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
  path: string;
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
  // (enc:v1). Replaces the former single `apiKey` so switching providers keeps
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
// at rest with the same enc:v1 wrapping as `token` — see the encrypt/decrypt
// loops in main.ts. `expiresAt` is an absolute epoch-ms deadline for the access
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
  appearance: { themeMode: ThemeMode; hideLineNumbers: boolean; dailyNotesInBookmarks: boolean };
  // NOTE: `dailyNote` and `templates` are no longer global — they're per-
  // workspace, stored in `<workspace>/.shockwave/workspace.json` (see
  // `WorkspaceData` below), loaded on workspace switch.
  codingAgent: CodingAgentSettings;
  agentSecrets: AgentSecret[];
  transcription: { provider: string; apiKey: string };
  sync: { pat: string; pullIntervalSeconds: number; disabledWorkspaceIds: string[] };
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
