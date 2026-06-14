// Types for the `window.api` bridge exposed by src/preload/preload.cjs.
//
// The preload is the ONLY mapping between renderer `window.api.foo` calls and
// main `ipcMain.handle('foo', ...)`. This file mirrors the JSDoc there so any
// .ts/.tsx renderer code gets compile-time checking of the IPC surface. Keep in
// sync with the preload: add a method there → add it here.

import type { FileAction, FolderAction, EditorAction } from './constants';
import type { Settings } from './settings';

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
  /** 'builtin' = bundled with the app; 'global' = user-imported. */
  source?: 'builtin' | 'global';
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
}

export interface SyncStatus {
  status: 'unconfigured' | 'idle' | 'syncing' | 'paused' | 'offline' | 'disabled' | string;
  detail: string;
  lastSyncAt: number | null;
  repoUrl?: string | null;
  /** Unmerged files (workspace-relative POSIX paths). Present on the paused status. */
  conflicts?: string[];
}

export interface ShockwaveApi {
  // Dialogs
  openFolder(): Promise<string | null>;

  // Filesystem reads
  readTree(dirPath: string): Promise<TreeNode[]>;
  readAllMarkdown(dirPath: string): Promise<ParsedFile[]>;
  readFile(filePath: string): Promise<string>;
  pathExists(p: string): Promise<boolean>;

  // Filesystem writes
  writeFile(filePath: string, content: string): Promise<number>;
  createFile(dirPath: string, name: string, content?: string): Promise<{ path: string; mtime: number }>;
  renameFile(fromPath: string, toName: string): Promise<string>;
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
    /** Fires when bookmarks.json changes on disk (sync, another machine, hand edit). */
    onChanged(cb: () => void): Unsubscribe;
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
    list(): Promise<InstalledSkill[]>;
    libraryDir(): Promise<string>;
    importPicker(): Promise<string | null>;
    importFromPath(srcPath: string): Promise<string>;
    remove(folderName: string): Promise<void>;
    pathForFile(file: File): string;
  };

  agent: {
    send(text: string, images?: Array<{ type: 'image'; source: unknown }>): Promise<void>;
    abort(): Promise<void>;
    reset(): Promise<void>;
    getDefaultSystemPrompt(): Promise<string>;
    listProviders(): Promise<Array<{ slug: string; label: string }>>;
    listModels(provider: string): Promise<Array<{ id: string; label: string }>>;
    validateConnection(opts: { baseUrl: string; apiKey?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }>;
    onEvent(cb: (evt: unknown) => void): Unsubscribe;
    onError(cb: (payload: { message: string }) => void): Unsubscribe;
    onOpenFile(cb: (payload: { path: string }) => void): Unsubscribe;
  };

  voice: {
    getToken(): Promise<{ token?: string; error?: string }>;
  };

  app: {
    checkForUpdates(): Promise<UpdateStatus>;
    getUpdateStatus(): Promise<UpdateStatus | null>;
    onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe;
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
