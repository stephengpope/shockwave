// Types for the `window.api` bridge exposed by src/preload/preload.cjs.
//
// The preload is the ONLY mapping between renderer `window.api.foo` calls and
// main `ipcMain.handle('foo', ...)`. This file mirrors the JSDoc there so any
// .ts/.tsx renderer code gets compile-time checking of the IPC surface. Keep in
// sync with the preload: add a method there → add it here.

import type { FileAction, FolderAction, EditorAction } from './constants';
import type { Settings, WorkspaceData } from './settings';

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
    send(text: string, images?: Array<{ type: 'image'; source: unknown }>): Promise<void>;
    abort(): Promise<void>;
    reset(): Promise<void>;
    listProviders(): Promise<Array<{ slug: string; label: string }>>;
    listModels(provider: string): Promise<Array<{ id: string; label: string }>>;
    listThinkingLevels(opts: { provider: string; model: string }): Promise<string[]>;
    validateConnection(opts: { baseUrl: string; apiKey?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }>;
    onEvent(cb: (evt: unknown) => void): Unsubscribe;
    onError(cb: (payload: { message: string }) => void): Unsubscribe;
    onOpenFile(cb: (payload: { path: string }) => void): Unsubscribe;
  };

  chat: {
    listSessions(opts?: { limit?: number; before?: number }): Promise<ChatSession[]>;
    listStarred(): Promise<ChatSession[]>;
    setStarred(opts: { sessionId: string; starred: boolean }): Promise<void>;
    searchSessions(opts: { query: string; limit?: number }): Promise<ChatSearchHit[]>;
    getMessages(sessionId: string): Promise<ChatMessage[]>;
    newSession(): Promise<void>;
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
}

declare global {
  interface Window {
    api: ShockwaveApi;
  }
}
