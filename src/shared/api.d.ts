// Types for the `window.api` bridge exposed by src/preload/preload.cjs.
//
// The preload is the ONLY mapping between renderer `window.api.foo` calls and
// main `ipcMain.handle('foo', ...)`. This file mirrors the JSDoc there so any
// .ts/.tsx renderer code gets compile-time checking of the IPC surface. Keep in
// sync with the preload: add a method there → add it here.

import type { FileAction, FolderAction, EditorAction } from './constants';
import type { Settings, WorkspaceData } from './settings';

/** A curated scope bundle for the connect form's second dropdown. */
export interface OAuthSetup {
  id: string;
  label: string;
  description?: string;
  scopes: string[];
}

/** A provider preset for the OAuth connect form (mirror of oauth.ts's ProviderPreset). */
export interface OAuthProviderPreset {
  id: string;
  label: string;
  authUrl?: string;
  tokenUrl?: string;
  defaultScopes: string[];
  pkce: boolean;
  authParams?: Record<string, string>;
  custom?: boolean;
  hint?: string;
  setups?: OAuthSetup[];
}

/** A node in the workspace file tree. Folders have `children`; files don't. */
export interface TreeNode {
  /** Absolute path on disk (also the React key). */
  id: string;
  /** Basename (e.g. "Foo.md" or "Notes"). */
  name: string;
  /** Modification time (ms since epoch). */
  mtime: number;
  /** Creation time (ms since epoch). */
  ctime: number;
  /** Present iff the node is a folder. */
  children?: TreeNode[];
}

/** A parsed wiki-link extracted from a markdown file. */
export interface ParsedLink {
  /** Lowercased basename (no extension, no folder). */
  target: string;
  alias?: string;
  heading?: string;
  startPos: number;
  endPos: number;
}

/** One markdown file with its parsed links + mtime, shipped at workspace load. */
export interface ParsedFile {
  path: string;
  mtime: number;
  outgoingLinks: ParsedLink[];
}

export interface FsAddOrChangeEvent {
  type: 'add' | 'change';
  path: string;
  mtime: number;
  // Present for `.md` files; absent for `.excalidraw` drawings (no wiki-links).
  outgoingLinks?: ParsedLink[];
}
export interface FsUnlinkEvent {
  type: 'unlink';
  path: string;
}
export interface FsRenameEvent {
  type: 'rename';
  oldPath: string;
  newPath: string;
  mtime: number;
  outgoingLinks: ParsedLink[];
}
export interface FsTreeEvent {
  type: 'tree';
}
/** Events shipped to the renderer over `fs:changed`, discriminated by `type`. */
export type FsChangedEvent = FsAddOrChangeEvent | FsUnlinkEvent | FsRenameEvent | FsTreeEvent;

/** An installed skill (skills.list()). */
export interface InstalledSkill {
  folderName: string;
  name: string;
  description: string;
  hasSkillMd?: boolean;
  /** 'builtin' = bundled with the app; 'workspace' = uploaded into the workspace. */
  source?: 'builtin' | 'workspace';
  /** Agent-secret names the skill declares (SKILL.md `required-secrets`). */
  requiredSecrets?: string[];
}

/** Detaches a listener. Always call on unmount. */
export type Unsubscribe = () => void;

export interface UpdateStatus {
  /** True when the latest GitHub release is newer than the running version. */
  updateAvailable: boolean;
  /** Latest release version (tag with leading "v" stripped), or null on error. */
  latest: string | null;
  /** Running app version (app.getVersion()). */
  current: string;
  /** Release page to open, or null on error. */
  url: string | null;
  /** Error message when the check failed (offline, rate-limited, …), else null. */
  error: string | null;
  /** True once electron-updater has the update downloaded and ready to install
   *  on restart. Always false in dev (notify-only fallback). */
  downloaded: boolean;
}

export interface SyncStatus {
  status: 'unconfigured' | 'idle' | 'syncing' | 'paused' | 'offline' | 'disabled' | string;
  detail: string;
  lastSyncAt: number | null;
  repoUrl?: string | null;
  /** Unmerged files (workspace-relative POSIX paths). Present on the paused status. */
  conflicts?: string[];
}

/** A saved chat (row of `chat_session`). */
export interface ChatSession {
  sessionId: string;
  workspace: string;
  jsonlPath: string;
  title: string | null;
  systemPrompt: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  archived: number;
  starred: number;
}

/** A stored chat message (row of `message`). Tool CALLS ride on the assistant
 *  row (`toolCalls` JSON); each tool RESULT is a `role:'tool'` row keyed by
 *  `toolCallId`. */
export interface ChatMessage {
  id: number;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | string;
  content: string | null;
  reasoning: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  toolName: string | null;
  createdAt: number;
}

/** A search result: the matching chat + a highlighted snippet. */
export interface ChatSearchHit {
  sessionId: string;
  title: string | null;
  updatedAt: number;
  snippet: string;
}

export interface ShockwaveApi {
  // Dialogs
  openFolder(): Promise<string | null>;
  scaffoldWorkspace(workspacePath: string): Promise<void>;

  // Filesystem reads
  readTree(dirPath: string): Promise<TreeNode[]>;
  readAllMarkdown(dirPath: string): Promise<ParsedFile[]>;
  /** Discard the persisted parse cache; the next readAllMarkdown re-parses every file. */
  rebuildLinkCache(dirPath: string): Promise<{ ok: boolean }>;
  readFile(filePath: string): Promise<string>;
  pathExists(p: string): Promise<boolean>;

  // Filesystem writes
  writeFile(filePath: string, content: string): Promise<number>;
  createFile(dirPath: string, name: string, content?: string): Promise<{ path: string; mtime: number }>;
  /** Literal file-browser rename — `toName` verbatim, no `.md` forcing; throws on collision. */
  renameFileLiteral(fromPath: string, toName: string): Promise<string>;
  duplicateFile(filePath: string): Promise<string>;
  writeImage(dirPath: string, bytes: ArrayBuffer | Uint8Array, ext: string, baseName: string): Promise<string>;
  trashFile(filePath: string): Promise<boolean>;
  trashFiles(filePaths: string[]): Promise<string[]>;
  trashFolder(folderPath: string): Promise<boolean>;

  // Folder ops
  createFolder(dirPath: string, name?: string): Promise<string>;
  ensureDir(dirPath: string): Promise<void>;
  renameFolder(fromPath: string, toName: string): Promise<string>;
  moveItem(srcPath: string, destDir: string): Promise<string>;
  importFiles(destDir: string | null, paths: string[]): Promise<{ imported: string[]; errors: string[] }>;

  // Shell
  revealInFolder(filePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;

  // Native context menus
  showFileContextMenu(opts: { isMd?: boolean; isOpenable?: boolean; isBookmarked?: boolean; selectionCount?: number; conflictMode?: boolean }): Promise<FileAction | null>;
  showConflictCloudMenu(): Promise<'keep' | 'reset' | null>;
  showFolderContextMenu(opts?: { isRoot?: boolean }): Promise<FolderAction | null>;
  showEditorContextMenu(opts: { hasSelection?: boolean; hasFilePath?: boolean; hasLink?: boolean }): Promise<EditorAction | null>;

  // File watcher (push)
  watchStart(dirPath: string): Promise<void>;
  watchStop(): Promise<void>;
  onFsChanged(cb: (evt: FsChangedEvent) => void): Unsubscribe;

  bookmarks: {
    read(workspacePath: string): Promise<string[]>;
    write(workspacePath: string, paths: string[]): Promise<void>;
    /** Fires when the workspace file changes on disk (sync, another machine, hand edit). */
    onChanged(cb: () => void): Unsubscribe;
  };

  /** Per-workspace settings persisted to `<workspace>/.shockwave/workspace.json`. */
  workspaceSettings: {
    read(workspacePath: string): Promise<WorkspaceData>;
    update(workspacePath: string, patch: Partial<WorkspaceData>): Promise<WorkspaceData>;
  };

  settings: {
    read(): Promise<Settings>;
    write(obj: Partial<Settings>): Promise<void>;
  };

  oauth: {
    listPresets(): Promise<OAuthProviderPreset[]>;
    /** Runs browser+loopback authorization for an oauth secret, persists tokens. */
    startConnect(name: string): Promise<{ ok: boolean; accountEmail?: string; error?: string }>;
    /** Clears live tokens (keeps client config so the user can re-connect). */
    disconnect(name: string): Promise<{ ok: boolean; error?: string }>;
  };

  theme: {
    getInitial(): Promise<{ dark: boolean }>;
    onSystemChange(cb: (payload: { dark: boolean }) => void): Unsubscribe;
  };

  skills: {
    list(workspacePath: string | null): Promise<{ builtin: InstalledSkill[]; workspace: InstalledSkill[] }>;
    libraryDir(workspacePath: string | null): Promise<string | null>;
    importPicker(workspacePath: string | null): Promise<string | null>;
    importFromPath(workspacePath: string | null, srcPath: string): Promise<string>;
    remove(workspacePath: string | null, folderName: string): Promise<void>;
    pathForFile(file: File): string;
  };

  agent: {
    /** Send to a chat. sessionId is renderer-minted (UUID) for new chats.
     *  Mid-turn sends are steered into the running turn. */
    send(opts: { sessionId: string; text: string; images?: Array<{ type: 'image'; source: unknown }> }): Promise<void>;
    abort(sessionId: string): Promise<void>;
    /** Chats with a turn in flight (re-seed the running set after reload). */
    runningSessions(): Promise<string[]>;
    listProviders(): Promise<Array<{ slug: string; label: string }>>;
    listModels(provider: string): Promise<Array<{ id: string; label: string }>>;
    listThinkingLevels(opts: { provider: string; model: string }): Promise<string[]>;
    validateConnection(opts: { baseUrl: string; apiKey?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }>;
    /** Every event is stamped with the sessionId of the chat it belongs to. */
    onEvent(cb: (evt: unknown) => void): Unsubscribe;
    onError(cb: (payload: { sessionId?: string; message: string }) => void): Unsubscribe;
    onOpenFile(cb: (payload: { path: string }) => void): Unsubscribe;
  };

  chat: {
    listSessions(opts?: { limit?: number; before?: number }): Promise<ChatSession[]>;
    listStarred(): Promise<ChatSession[]>;
    setStarred(opts: { sessionId: string; starred: boolean }): Promise<void>;
    searchSessions(opts: { query: string; limit?: number }): Promise<ChatSearchHit[]>;
    getMessages(sessionId: string): Promise<ChatMessage[]>;
    openSession(sessionId: string): Promise<{ session?: ChatSession; messages: ChatMessage[] }>;
    deleteSession(sessionId: string): Promise<void>;
    renameSession(opts: { sessionId: string; title: string }): Promise<void>;
  };

  voice: {
    getToken(): Promise<{ token?: string; error?: string }>;
  };

  app: {
    checkForUpdates(): Promise<UpdateStatus>;
    getUpdateStatus(): Promise<UpdateStatus | null>;
    onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe;
    restartToUpdate(): Promise<void>;
  };

  sync: {
    verifyPat(pat: string): Promise<{ ok: boolean; login?: string; id?: number; name?: string | null; error?: string }>;
    checkGit(): Promise<{ ok: boolean; version?: string; error?: string; platform: NodeJS.Platform }>;
    workspaceStatus(workspacePath: string): Promise<{ hasGit: boolean; hasOrigin: boolean; originUrl: string | null }>;
    setupClone(opts: { workspacePath: string; remoteUrl: string }): Promise<{ ok: boolean; remoteUrl?: string; error?: string }>;
    listRepos(): Promise<{ ok: boolean; repos?: Array<{ full_name: string; clone_url: string; private: boolean; default_branch: string; pushed_at: string }>; error?: string }>;
    setupInitAndCreate(opts: { workspacePath: string; repoName: string; private?: boolean }): Promise<{ ok: boolean; remoteUrl?: string; full_name?: string; html_url?: string; error?: string }>;
    setupLink(opts: { workspacePath: string; remoteUrl: string }): Promise<{ ok: boolean; remoteUrl?: string; error?: string }>;
    teardown(opts: { workspacePath: string }): Promise<{ ok: boolean; error?: string }>;
    setWorkspaceDisabled(opts: { workspacePath: string; disabled: boolean }): Promise<{ ok: boolean; error?: string }>;
    engineStart(opts: { workspacePath: string; intervalSeconds?: number }): Promise<void>;
    engineStop(): Promise<void>;
    engineStatus(): Promise<SyncStatus>;
    listConflicts(workspacePath: string): Promise<string[]>;
    resolveConflict(workspacePath: string, relPath: string): Promise<string[]>;
    keepConflict(workspacePath: string, relPath: string): Promise<string[]>;
    resetConflict(workspacePath: string, relPath: string): Promise<string[]>;
    keepAll(workspacePath: string): Promise<void>;
    resetToRemote(workspacePath: string): Promise<void>;
    flushDone(token: number): Promise<void>;
    onFlushRequest(cb: (token: number) => void): Unsubscribe;
    onStatus(cb: (status: SyncStatus) => void): Unsubscribe;
  };
  cron: {
    read(): Promise<CronView>;
    setEnabled(enabled: boolean): Promise<void>;
    runNow(name: string): Promise<{ ok?: boolean; busy?: boolean; error?: string }>;
    setMaxCatchupHours(n: number): Promise<void>;
    setMaxRunMinutes(n: number): Promise<void>;
    onState(cb: (view: CronView) => void): Unsubscribe;
    onChatsChanged(cb: () => void): Unsubscribe;
  };
}

export interface CronJobView {
  name: string;
  schedule: string;
  description: string;
  enabled: boolean;
  invalid: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  lastSessionId: string | null;
}

export interface CronView {
  activeWorkspace: string | null;
  exists?: boolean;
  fileError: string | null;
  enabled: boolean;
  maxCatchupHours: number;
  maxRunMinutes: number;
  jobs: CronJobView[];
  inFlight: boolean;
  runningJobName: string | null;
}

declare global {
  interface Window {
    api: ShockwaveApi;
  }
}
