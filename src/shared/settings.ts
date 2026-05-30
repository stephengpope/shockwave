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
export type WorkspaceSkillState = 'inherit' | 'enabled' | 'disabled';

export interface CodingAgentSettings {
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  skills: {
    global: Record<string, SkillState>;
    workspaces: Record<string, Record<string, WorkspaceSkillState>>;
  };
}

export interface AgentSecret {
  name: string;
  description: string;
  token: string;
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

export interface Settings {
  workspaces: WorkspaceEntry[];
  activeWorkspaceId: string | null;
  appearance: { themeMode: ThemeMode; hideLineNumbers: boolean };
  dailyNote: { format: string; folder: string };
  codingAgent: CodingAgentSettings;
  agentSecrets: AgentSecret[];
  transcription: { provider: string; apiKey: string };
  sync: { pat: string; pullIntervalSeconds: number; disabledWorkspaceIds: string[] };
  chatSidebarOpen: boolean;
  chatSidebarWidth: number;
  sidebarWidth: number;
  viewMode: ViewMode;
  treeSortOrder: TreeSortOrder;
  windowBounds: WindowBounds | null;
}
