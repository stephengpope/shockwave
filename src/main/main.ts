import { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, protocol, net, safeStorage, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import chokidar from 'chokidar';
import { parseLinks } from './linkParser.js';
import { createRenameCorrelator } from './renameCorrelator.js';
import { agentSend, agentAbort, agentReset } from './codingAgent.js';
import { isMdFile, uniquePath, uniqueInWorkspace, walkMarkdownPaths, collectMarkdownBasenamesLower } from './pathResolver.js';
import { getProviders, getModels } from '@earendil-works/pi-ai';
import { listInstalled, importFromPath, removeSkill, libraryDirFor } from './skillLibrary.js';
import { installAgentTokensBridge } from './agentTokensExtension.js';
import { DEFAULT_AGENT_SYSTEM_PROMPT } from './agentSystemPrompt.js';
import {
  verifyPat as syncVerifyPat,
  checkGit as syncCheckGit,
  workspaceStatus as syncWorkspaceStatus,
  setupClone as syncSetupClone,
  setupInitAndCreate as syncSetupInitAndCreate,
  setupLink as syncSetupLink,
  teardown as syncTeardown,
  listRepos as syncListRepos,
} from './sync.js';
import {
  start as engineStart,
  stop as engineStop,
  drainBeforeQuit as engineDrainBeforeQuit,
  handleFlushDone as engineHandleFlushDone,
  getCurrentStatus as engineGetCurrentStatus,
  getConflicts as engineGetConflicts,
  resolveConflict as engineResolveConflict,
  resetToRemote as engineResetToRemote,
} from './syncEngine.js';
import {
  APP_NAME,
  FILE_ACTIONS,
  FOLDER_ACTIONS,
  EDITOR_ACTIONS,
  SUPPORTED_PROVIDER_SLUGS as SUPPORTED_PROVIDER_SLUGS_LIST,
} from '../shared/constants';

const SUPPORTED_PROVIDER_SLUGS = new Set(SUPPORTED_PROVIDER_SLUGS_LIST);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName(APP_NAME);

// __dirname under electron-vite is `<project>/out/main/` in dev and inside the
// asar at runtime. Both layouts have `build/icon.png` two levels up.
const ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.png');

// Pop up a native context menu and resolve with the value attached to the
// clicked item (or null on dismiss). Items in `template` use the standard
// Electron MenuItem shape, with one addition: `{ label, value }` items get a
// click handler synthesized for you that records the value. Built-in role
// items (`{ role: 'cut' }` etc.) and items with a custom `click` pass
// through unchanged.
function popupContextMenu(win, template) {
  return new Promise((resolve) => {
    let chosen: any = null;
    const items = template.map((item) => {
      if (item && typeof item === 'object' && 'value' in item && !item.click) {
        const { value, ...rest } = item;
        return { ...rest, click: () => { chosen = value; } };
      }
      return item;
    });
    const menu = Menu.buildFromTemplate(items);
    menu.on('menu-will-close', () => {
      setImmediate(() => resolve(chosen));
    });
    menu.popup({ window: win });
  });
}

const DEFAULT_SETTINGS = {
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: 'system', hideLineNumbers: false },
  // Daily-note settings. `format` is a dayjs format string (Obsidian-style).
  // It may contain "/" — those become folder boundaries beneath `folder`.
  // `folder` is a workspace-relative path ('' or '/' = workspace root).
  dailyNote: { format: 'YYYY-MM-DD', folder: '' },
  codingAgent: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKey: '',
    // Pre-filled with the default on first install so users can read + edit.
    // "Reset to default" in the UI writes the current default back into here.
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    // Skill enable/disable state. Source of truth for what's actually loaded into
    // the pi session — the on-disk skill folder is the source of truth for what
    // EXISTS (read from pi-agent/skill-library/ at request time).
    //   global[name]               = 'enabled' | 'disabled'
    //   workspaces[wsId][name]     = 'inherit' | 'enabled' | 'disabled'
    skills: { global: {}, workspaces: {} },
  },
  // Global, user-managed API tokens. Each entry: { name, description, token, createdAt, updatedAt }.
  // `name` is the unique identifier (case-insensitive). `token` is encrypted on disk
  // via safeStorage (see encryptSecret).
  agentSecrets: [],
  // Voice transcription. `apiKey` is the AssemblyAI key, encrypted on disk via
  // safeStorage. The renderer never sees the key — it requests short-lived (60s)
  // streaming tokens via the `voice:getToken` IPC, which is what the WebSocket
  // to AssemblyAI authenticates with.
  transcription: { provider: 'assemblyai', apiKey: '' },
  // GitHub sync. `pat` is a GitHub Personal Access Token, encrypted on disk
  // via safeStorage. Decrypted only into the env of git child processes (via
  // GIT_ASKPASS helper); never written to .git/config or any other on-disk
  // location. `pullIntervalSeconds` is the tick cadence for the sync loop.
  sync: { pat: '', pullIntervalSeconds: 10, disabledWorkspaceIds: [] },
  chatSidebarOpen: false,
  chatSidebarWidth: 360,
  // Left sidebar (file tree) width in px, and the editor view mode. Both are
  // persisted by the renderer; they must be declared here so a fresh install
  // has a default and readSettings can surface them. (See src/shared/settings.ts.)
  sidebarWidth: 260,
  viewMode: 'live',
  // File-tree sort order. One of: 'name-asc' | 'name-desc' | 'modified-desc' |
  // 'modified-asc' | 'created-desc' | 'created-asc'. Folders are always pinned
  // to the top in A→Z order; this setting only re-orders files.
  treeSortOrder: 'name-asc',
  // Window bounds. `null` until the user resizes/moves at least once. Stored
  // as `{ x, y, width, height, maximized }`. On restore we validate against
  // currently-attached displays and fall back to a centered 1200×800 if the
  // saved rect no longer intersects any display.
  windowBounds: null,
};

// ─── Secret encryption ───────────────────────────────────────────────────────
// safeStorage uses the OS keychain (macOS Keychain / Windows DPAPI / libsecret
// on Linux). Encrypted values are tagged with ENC_PREFIX so legacy plaintext
// values (from before encryption was wired in) still load and auto-migrate on
// the next write. On Linux without a keyring, safeStorage falls back to a
// hardcoded-password mode; warn once so the user knows.
const ENC_PREFIX = 'enc:v1:';
let warnedNoEncryption = false;

function encryptSecret(plain) {
  if (!plain) return '';
  // Idempotent: a value already wrapped with our prefix is treated as
  // already-encrypted and passed through unchanged. Lets writeSettings
  // accept a merged object that mixes plaintext (from renderer) and
  // ciphertext (preserved from disk) without double-encrypting.
  if (typeof plain === 'string' && plain.startsWith(ENC_PREFIX)) return plain;
  if (!safeStorage.isEncryptionAvailable()) {
    if (!warnedNoEncryption) {
      console.warn('[secrets] safeStorage encryption unavailable — secrets stored in plaintext');
      warnedNoEncryption = true;
    }
    return plain;
  }
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
}

function decryptSecret(stored) {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch (err: any) {
    console.warn('[secrets] failed to decrypt:', err.message);
    return '';
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function readSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      appearance: { ...DEFAULT_SETTINGS.appearance, ...(parsed.appearance ?? {}) },
      dailyNote: { ...DEFAULT_SETTINGS.dailyNote, ...(parsed.dailyNote ?? {}) },
      codingAgent: {
        ...DEFAULT_SETTINGS.codingAgent,
        ...(parsed.codingAgent ?? {}),
        skills: {
          global: { ...(parsed.codingAgent?.skills?.global ?? {}) },
          workspaces: { ...(parsed.codingAgent?.skills?.workspaces ?? {}) },
        },
      },
      agentSecrets: Array.isArray(parsed.agentSecrets) ? parsed.agentSecrets : [],
      transcription: {
        ...DEFAULT_SETTINGS.transcription,
        ...(parsed.transcription ?? {}),
      },
      sync: {
        ...DEFAULT_SETTINGS.sync,
        ...(parsed.sync ?? {}),
        disabledWorkspaceIds: Array.isArray(parsed.sync?.disabledWorkspaceIds)
          ? parsed.sync.disabledWorkspaceIds
          : [],
      },
    };
    // Decrypt secret-bearing fields. Legacy plaintext values pass through
    // unchanged via decryptSecret's no-prefix branch and get re-encrypted on
    // the next write.
    merged.codingAgent.apiKey = decryptSecret(merged.codingAgent.apiKey);
    merged.agentSecrets = merged.agentSecrets.map((s) => ({
      ...s,
      token: decryptSecret(s.token ?? ''),
    }));
    merged.transcription.apiKey = decryptSecret(merged.transcription.apiKey);
    merged.sync.pat = decryptSecret(merged.sync.pat);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS, agentSecrets: [] };
  }
}

// Serialize all settings writes through this promise chain so concurrent
// callers (renderer-side persistSettings vs main-side persistWindowBounds)
// can't race a partial overwrite of the file.
let settingsWriteQueue = Promise.resolve();

// Shallow-merges `patch` over the on-disk file, then atomically writes back.
// This is what lets main write only `{ windowBounds }` without clobbering the
// renderer's other fields, and vice versa.
async function writeSettings(patch) {
  const task = settingsWriteQueue.then(() => doWriteSettings(patch));
  settingsWriteQueue = task.catch(() => {});
  return task;
}

async function doWriteSettings(patch) {
  const file = settingsPath();
  const tmp = `${file}.tmp`;
  let existing = {};
  try {
    const raw = await fs.readFile(file, 'utf8');
    existing = JSON.parse(raw);
  } catch {
    // No file yet — first write creates it.
  }
  const out = { ...existing, ...patch };
  // Defensive deep-merge for codingAgent: a renderer caller that builds a
  // partial sub-object (e.g. forgetting systemPrompt) would otherwise wipe
  // sibling fields on disk via the shallow spread above.
  if (patch.codingAgent && (existing as any).codingAgent) {
    (out as any).codingAgent = { ...(existing as any).codingAgent, ...patch.codingAgent };
  }
  // Encrypt secret-bearing fields. encryptSecret is idempotent so values that
  // came from the on-disk file (already encrypted) pass through unchanged.
  if ((out as any).codingAgent) (out as any).codingAgent.apiKey = encryptSecret((out as any).codingAgent.apiKey ?? '');
  if (Array.isArray(out.agentSecrets)) {
    out.agentSecrets = out.agentSecrets.map((s) => ({
      ...s,
      token: encryptSecret(s.token ?? ''),
    }));
  }
  if (out.transcription) out.transcription.apiKey = encryptSecret(out.transcription.apiKey ?? '');
  if (out.sync) out.sync.pat = encryptSecret(out.sync.pat ?? '');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// electron-vite sets ELECTRON_RENDERER_URL in dev. In production the renderer
// is loaded from the built out/renderer/ directory.
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

// Custom `app://` scheme used to serve workspace files (images) to the
// renderer with webSecurity intact. Must be registered before app.ready.
// Renderer requests `app://media/<rel-path-from-vault>`; the handler resolves
// the file against the active vault root (watcherRootDir) and returns it
// via net.fetch(file://…). Path-traversal outside the vault is rejected.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 };

// True if `bounds` overlaps the work area of any currently-connected display.
// We accept partial overlap (so a window mostly off-screen still restores) —
// the OS clamps it on show. Returns false for nullish/zero-size rects too.
function boundsAreVisible(bounds) {
  if (!bounds) return false;
  const { x, y, width, height } = bounds;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (!(width > 100) || !(height > 100)) return false;
  for (const d of screen.getAllDisplays()) {
    const w = d.workArea;
    const intersects =
      x < w.x + w.width &&
      x + width > w.x &&
      y < w.y + w.height &&
      y + height > w.y;
    if (intersects) return true;
  }
  return false;
}

// Debounced + close-flushed persistence for window bounds. Captures the
// last-known *unmaximized* bounds (so restoring after a maximized session
// brings the window back to the size the user was actually using before
// maximizing).
function attachWindowBoundsPersistence(win) {
  let normalBounds = win.getBounds();
  let timer: any = null;

  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const bounds = maximized ? normalBounds : win.getBounds();
    if (!maximized) normalBounds = bounds;
    writeSettings({ windowBounds: { ...bounds, maximized } }).catch((err) => {
      console.warn('[settings] failed to persist window bounds:', err.message);
    });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  const onChange = () => {
    if (!win.isMaximized() && !win.isFullScreen()) {
      normalBounds = win.getBounds();
    }
    schedule();
  };

  win.on('resize', onChange);
  win.on('move', onChange);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer) { clearTimeout(timer); timer = null; }
    save();
  });
}

async function createWindow() {
  const settings = await readSettings();
  const saved = settings.windowBounds;
  const useSaved = saved && boundsAreVisible(saved);
  const opts: any = {
    ...DEFAULT_WINDOW_SIZE,
    title: APP_NAME,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (useSaved) {
    opts.x = saved.x;
    opts.y = saved.y;
    opts.width = saved.width;
    opts.height = saved.height;
  }
  const win = new BrowserWindow(opts);

  if (useSaved && saved.maximized) win.maximize();

  attachWindowBoundsPersistence(win);

  // Navigation hard-block. The renderer is a single page that should NEVER
  // navigate away — if it does, the app blanks and the user has no way back.
  // This kicks in for: a stray <a href="https://…"> click anywhere in the UI
  // that the renderer didn't intercept (e.g. markdown links in chat that
  // weren't routed through openExternal), location.href changes, form
  // submits, etc. http/https URLs are routed to the system browser;
  // anything else is silently blocked.
  win.webContents.on('will-navigate', (event, url) => {
    // Allow the very first load (DEV_URL or file://…) — will-navigate also
    // fires for the initial loadURL/loadFile on some Electron versions.
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

ipcMain.handle('dialog:openFolder', async () => {
  // `createDirectory` (macOS) adds a "New Folder" button to the open dialog so
  // users can create a fresh workspace directory in one step.
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

async function buildTree(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith('.'))
      .map(async (e) => {
        const fullPath = path.join(dirPath, e.name);
        if (e.isDirectory()) {
          return {
            id: fullPath,
            name: e.name,
            children: await buildTree(fullPath),
          };
        }
        // Stat each file so the renderer can sort by modified/created time.
        // birthtimeMs is the file's true creation time on macOS/Windows; on
        // Linux it may equal mtime depending on the fs.
        let mtime = 0;
        let ctime = 0;
        try {
          const st = await fs.stat(fullPath);
          mtime = st.mtimeMs;
          ctime = st.birthtimeMs || st.ctimeMs;
        } catch {
          // Race with concurrent rm/move — leave as 0; node still appears in the tree.
        }
        return { id: fullPath, name: e.name, mtime, ctime };
      })
  );
  // Default order — folders first, names A→Z. Renderer re-sorts files per the
  // user's chosen sort order; folders stay in this base order.
  children.sort((a, b) => {
    const aDir = !!a.children;
    const bDir = !!b.children;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return children;
}

ipcMain.handle('fs:readTree', async (_evt, dirPath) => {
  return buildTree(dirPath);
});

async function readAllMarkdown(dirPath) {
  const paths = await walkMarkdownPaths(dirPath);
  const out: any[] = [];
  for (const full of paths) {
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(full, 'utf8'),
        fs.stat(full),
      ]);
      out.push({ path: full, mtime: stat.mtimeMs, outgoingLinks: parseLinks(content) });
    } catch {
      // swallow per-file errors so one bad file doesn't kill the vault load
    }
  }
  return out;
}

ipcMain.handle('fs:readAllMarkdown', async (_evt, dirPath) => {
  return readAllMarkdown(dirPath);
});

ipcMain.handle('fs:readFile', async (_evt, filePath) => {
  return fs.readFile(filePath, 'utf8');
});

ipcMain.handle('fs:writeFile', async (_evt, { filePath, content }) => {
  await fs.writeFile(filePath, content, 'utf8');
  // Return the file's real mtime so the renderer's self-echo guard can compare
  // apples-to-apples against the watcher event's stat.mtimeMs. Using Date.now()
  // in the renderer drops fractional ms, which can cause a same-ms write to
  // look "fresh" to the guard.
  const st = await fs.stat(filePath);
  return st.mtimeMs;
});

// File identity helpers used by the rename correlator. Hash is computed
// eagerly so we still have an identity when chokidar fires `unlink` (the file
// is gone, so we can't read it then).
async function statInoOf(p) {
  try {
    const st = await fs.stat(p, { bigint: true });
    return st.ino.toString();
  } catch {
    return null;
  }
}

async function hashFileOf(p) {
  try {
    const buf = await fs.readFile(p);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

ipcMain.handle('fs:createFile', async (_evt, { dirPath, name, content = '' }) => {
  const base = name.replace(/\.md$/i, '');
  // Workspace-wide uniqueness: the link index is keyed by basename, so two
  // .md files sharing a basename in different folders would break it. Match
  // fs:renameFile / fs:moveItem.
  const target = await uniqueInWorkspace({
    workspaceRoot: watcherRootDir,
    destDir: dirPath,
    base,
    ext: '.md',
  });
  await fs.writeFile(target, content, 'utf8');
  const st = await fs.stat(target);
  return { path: target, mtime: st.mtimeMs };
});

ipcMain.handle('fs:renameFile', async (_evt, { fromPath, toName }) => {
  const dir = path.dirname(fromPath);
  const base = toName.replace(/\.md$/i, '').trim();
  if (!base) throw new Error('Name cannot be empty');
  const target = await uniqueInWorkspace({
    workspaceRoot: watcherRootDir,
    destDir: dir,
    base,
    ext: '.md',
    excludePaths: [fromPath],
  });
  if (target === fromPath) return target;
  await fs.rename(fromPath, target);
  return target;
});

ipcMain.handle('fs:duplicateFile', async (_evt, filePath) => {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const target = await uniquePath(dir, base, ext);
  const content = await fs.readFile(filePath);
  await fs.writeFile(target, content);
  return target;
});

ipcMain.handle('fs:trashFolder', async (evt, folderPath) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const name = path.basename(folderPath);
  let entries: any[] = [];
  try {
    entries = (await fs.readdir(folderPath)).filter((n) => !n.startsWith('.'));
  } catch {
    entries = [];
  }
  const isEmpty = entries.length === 0;
  const result = await dialog.showMessageBox(win as any, {
    type: 'warning',
    title: 'Delete folder',
    message: `Delete "${name}"?`,
    detail: isEmpty
      ? 'The folder will be moved to the Trash.'
      : `"${name}" contains items. Everything inside will be moved to the Trash.`,
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response !== 1) return false;
  await shell.trashItem(folderPath);
  return true;
});

ipcMain.handle('fs:trashFile', async (evt, filePath) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const name = path.basename(filePath);
  const result = await dialog.showMessageBox(win as any, {
    type: 'warning',
    title: 'Delete file',
    message: `Delete "${name}"?`,
    detail: 'The file will be moved to the Trash.',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response !== 1) return false;
  await shell.trashItem(filePath);
  return true;
});

// Bulk trash. The renderer is responsible for confirming with the user before
// calling this — no per-file system dialog. Returns the paths that were
// successfully trashed; failures are logged but don't abort the rest so a
// partial success still cleans up what it can.
ipcMain.handle('fs:trashFiles', async (_evt, filePaths) => {
  if (!Array.isArray(filePaths)) return [];
  const trashed: any[] = [];
  for (const p of filePaths) {
    try {
      await shell.trashItem(p);
      trashed.push(p);
    } catch (err: any) {
      console.warn('[trashFiles] failed:', p, err);
    }
  }
  return trashed;
});

ipcMain.handle('shell:revealInFolder', async (_evt, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:openExternal', async (_evt, url) => {
  // Only allow http/https — never let an arbitrary string become a shell launch.
  if (typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url)) return;
  await shell.openExternal(url);
});

function revealLabel() {
  if (process.platform === 'darwin') return 'Reveal in Finder';
  if (process.platform === 'win32') return 'Show in Explorer';
  return 'Show in file manager';
}

ipcMain.handle('context:fileMenu', async (evt, opts = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const { isMd = true, isBookmarked = false, selectionCount = 1, conflictMode = false } = opts;
  // In the conflict-resolution view: Resolve (= git add this file) or the
  // whole-repo escape hatch, Reset to Remote (discard local, take GitHub).
  if (conflictMode) {
    return popupContextMenu(win, [
      { label: 'Resolve', value: FILE_ACTIONS.RESOLVE },
      { type: 'separator' },
      { label: 'Reset to Remote (discard local)', value: FILE_ACTIONS.RESET_TO_REMOTE },
    ]);
  }
  const multi = selectionCount > 1;
  const template: any[] = [];
  if (multi) {
    // Bulk-safe actions only: open all in new tabs (if md), bookmark toggle, delete.
    // Rename/Duplicate/Reveal don't make sense across a selection.
    if (isMd) template.push({ label: `Open ${selectionCount} files in new tabs`, value: FILE_ACTIONS.NEW_TAB });
    template.push(
      { label: isBookmarked ? `Remove ${selectionCount} bookmarks` : `Bookmark ${selectionCount} files`, value: FILE_ACTIONS.TOGGLE_BOOKMARK },
      { type: 'separator' },
      { label: `Delete ${selectionCount} files`, value: FILE_ACTIONS.DELETE },
    );
  } else {
    if (isMd) template.push({ label: 'Open in new tab', value: FILE_ACTIONS.NEW_TAB });
    template.push(
      { label: 'Duplicate', value: FILE_ACTIONS.DUPLICATE },
      { type: 'separator' },
      { label: isBookmarked ? 'Remove bookmark' : 'Bookmark', value: FILE_ACTIONS.TOGGLE_BOOKMARK },
      { type: 'separator' },
      { label: revealLabel(), value: FILE_ACTIONS.REVEAL },
      { type: 'separator' },
      { label: 'Rename', value: FILE_ACTIONS.RENAME },
      { label: 'Delete', value: FILE_ACTIONS.DELETE },
    );
  }
  return popupContextMenu(win, template);
});

ipcMain.handle('context:folderMenu', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  return popupContextMenu(win, [
    { label: 'New file', value: FOLDER_ACTIONS.NEW_FILE },
    { label: 'New folder', value: FOLDER_ACTIONS.NEW_FOLDER },
    { type: 'separator' },
    { label: revealLabel(), value: FOLDER_ACTIONS.REVEAL },
    { type: 'separator' },
    { label: 'Rename', value: FOLDER_ACTIONS.RENAME },
    { label: 'Delete', value: FOLDER_ACTIONS.DELETE },
  ]);
});

ipcMain.handle('fs:createFolder', async (_evt, { dirPath, name = 'New folder' }) => {
  let candidate = path.join(dirPath, name);
  let i = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dirPath, `${name} ${i}`);
      i++;
    } catch {
      break;
    }
  }
  await fs.mkdir(candidate, { recursive: true });
  return candidate;
});

// Recursive mkdir for an absolute path. Unlike fs:createFolder it does NOT
// auto-disambiguate — the caller wants this exact path. Idempotent. Used by
// the daily-note flow when the format contains "/" (e.g. "YYYY/MM/DD") so
// intermediate year/month folders get created in place.
ipcMain.handle('fs:ensureDir', async (_evt, dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
});

// ─── Bookmarks ──────────────────────────────────────────────────────────────
// Stored at `<workspace>/.shockwave/bookmarks.json` as:
//   { "version": 1, "paths": ["folder/sub/file.md", ...] }
// Paths are workspace-relative (POSIX-style) so renames + folder moves can be
// applied in place and the file survives the workspace folder moving on disk.
// The `.shockwave` segment starts with a dot, which matches the watcher's
// `ignored` predicate — our own writes don't trigger fs:changed events.

function bookmarksPath(workspacePath) {
  return path.join(workspacePath, '.shockwave', 'bookmarks.json');
}

ipcMain.handle('bookmarks:read', async (_evt, workspacePath) => {
  if (!workspacePath) return [];
  try {
    const raw = await fs.readFile(bookmarksPath(workspacePath), 'utf8');
    const parsed = JSON.parse(raw);
    const paths = Array.isArray(parsed?.paths) ? parsed.paths : [];
    // De-dupe + keep only strings.
    return Array.from(new Set(paths.filter((p) => typeof p === 'string' && p.length > 0)));
  } catch {
    // Missing or corrupt — treat as empty. A subsequent write will replace it.
    return [];
  }
});

ipcMain.handle('bookmarks:write', async (_evt, { workspacePath, paths }) => {
  if (!workspacePath) return;
  const file = bookmarksPath(workspacePath);
  const tmp = `${file}.tmp`;
  const body = JSON.stringify({ version: 1, paths: Array.isArray(paths) ? paths : [] }, null, 2);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
});

ipcMain.handle('fs:moveItem', async (_evt, { srcPath, destDir }) => {
  const name = path.basename(srcPath);
  // Reject moving a folder into itself or its own descendant.
  if (path.join(destDir, name).startsWith(srcPath + path.sep) || destDir === srcPath) {
    throw new Error('Cannot move a folder into itself.');
  }
  const isMd = isMdFile(name);
  let stat;
  try { stat = await fs.stat(srcPath); } catch { stat = null; }
  const isFolder = stat?.isDirectory();

  let target;
  if (isMd && !isFolder) {
    // .md file move: workspace-wide name uniqueness so the link index stays consistent.
    const base = name.slice(0, -3);
    target = await uniqueInWorkspace({
      workspaceRoot: watcherRootDir,
      destDir,
      base,
      ext: '.md',
      excludePaths: [srcPath],
    });
  } else if (isFolder) {
    // Folder move: same-dir uniqueness (folders don't share the link-index basename space),
    // plus workspace-wide uniqueness for every .md file the folder contains, treating its
    // own .md files as excluded (they move with it).
    const inside = await walkMarkdownPaths(srcPath);
    target = path.join(destDir, name);
    // If the literal target dir already exists, append " 1", " 2", ...
    let candidate = target;
    let i = 1;
    while (true) {
      try { await fs.access(candidate); candidate = path.join(destDir, `${name} ${i}`); i++; }
      catch { break; }
    }
    target = candidate;
    // Verify no nested .md inside this folder will collide with a same-named file already
    // in the workspace (outside this folder). If any do, auto-disambiguate the FOLDER name
    // (simpler than renaming individual files mid-move).
    if (watcherRootDir && inside.length > 0) {
      const excludeSet = new Set(inside);
      const taken = await collectMarkdownBasenamesLower(watcherRootDir, excludeSet);
      const ourNames = new Set(inside.map((p) => path.basename(p).slice(0, -3).toLowerCase()));
      for (const n of ourNames) {
        if (taken.has(n)) {
          // Bump the folder name once more — but at this point all collision is from the
          // nested files, which keep their names. We cannot resolve this via folder rename
          // alone. The least-surprising thing is to reject the move so the user picks
          // explicit names.
          throw new Error(`Cannot move "${name}": one or more files inside share a name with files elsewhere in the workspace.`);
        }
      }
    }
  } else {
    target = path.join(destDir, name);
    let candidate = target;
    let i = 1;
    while (true) {
      try { await fs.access(candidate); candidate = path.join(destDir, `${name} ${i}`); i++; }
      catch { break; }
    }
    target = candidate;
  }

  if (target === srcPath) return target;
  await fs.rename(srcPath, target);
  return target;
});

ipcMain.handle('fs:renameFolder', async (_evt, { fromPath, toName }) => {
  const dir = path.dirname(fromPath);
  const finalName = toName.trim();
  if (!finalName) throw new Error('Name cannot be empty');
  // Folders don't share the link-index basename space, so same-dir uniqueness is sufficient.
  let candidate = path.join(dir, finalName);
  if (candidate === fromPath) return candidate;
  let i = 1;
  while (true) {
    try { await fs.access(candidate); candidate = path.join(dir, `${finalName} ${i}`); i++; }
    catch { break; }
  }
  await fs.rename(fromPath, candidate);
  return candidate;
});

ipcMain.handle('context:editorMenu', async (evt, { hasSelection, hasFilePath, hasLink } = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const template: any[] = [];
  if (hasSelection) {
    template.push(
      { label: 'Add link',          value: EDITOR_ACTIONS.ADD_LINK },
      { label: 'Add external link', value: EDITOR_ACTIONS.ADD_EXTERNAL_LINK },
      { type: 'separator' },
    );
  }
  if (hasLink) {
    template.push(
      { label: 'Edit external link',   value: EDITOR_ACTIONS.EDIT_EXTERNAL_LINK },
      { label: 'Remove external link', value: EDITOR_ACTIONS.REMOVE_EXTERNAL_LINK },
      { type: 'separator' },
    );
  }
  if (hasFilePath) {
    template.push(
      { label: 'Message Agent', value: EDITOR_ACTIONS.SEND_TO_AGENT },
      { type: 'separator' },
    );
  }
  template.push(
    { role: 'cut',   enabled: hasSelection },
    { role: 'copy',  enabled: hasSelection },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'selectAll' },
  );
  return popupContextMenu(win, template);
});

ipcMain.handle('settings:read', async () => {
  return readSettings();
});

ipcMain.handle('settings:write', async (_evt, obj) => {
  await writeSettings(obj);
});

// Mint a short-lived AssemblyAI streaming token. The long-lived API key sits
// encrypted in settings and never crosses to the renderer — only the 60s temp
// token does, which is just the WebSocket session credential.
ipcMain.handle('voice:getToken', async () => {
  const settings = await readSettings();
  const apiKey = settings.transcription?.apiKey;
  if (!apiKey) return { error: 'Voice transcription not configured' };
  try {
    const res = await fetch(
      'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60',
      { headers: { Authorization: apiKey } },
    );
    if (!res.ok) return { error: 'Failed to get voice token' };
    const data = await res.json();
    return { token: data.token };
  } catch (err: any) {
    console.warn('[voice] token request failed:', err.message);
    return { error: 'Voice token request failed' };
  }
});

// ---- GitHub sync ----
//
// PAT-bearing operations all happen in main; the renderer never receives the
// PAT. `sync:verifyPat` runs the PAT through GET /user as a sanity check on
// settings save. `sync:checkGit` reports whether the git CLI is available so
// the UI can show install instructions before the user gets to "configure
// sync".

ipcMain.handle('sync:verifyPat', async (_evt, pat) => {
  // The renderer passes the PAT explicitly (the value sitting in its draft
  // settings form) — we don't read from settings here because the user might
  // be verifying a token they haven't saved yet.
  return syncVerifyPat(pat);
});

ipcMain.handle('sync:checkGit', async () => {
  return syncCheckGit();
});

// Per-workspace status — does it have .git, does it have an origin, what URL?
// Drives the "Configure sync" UI's button enablement.
ipcMain.handle('sync:workspaceStatus', async (_evt, workspacePath) => {
  return syncWorkspaceStatus(workspacePath);
});

// Helper: load the decrypted PAT from settings for sync setup IPCs that need
// it. We don't accept PAT from the renderer for these flows — the user has
// already saved one (otherwise the UI gates them out) so we read straight
// from disk. Returns null + an error result if PAT isn't set.
async function readSyncPat() {
  const settings = await readSettings();
  const pat = settings.sync?.pat || '';
  if (!pat) return { ok: false, error: 'GitHub Sync not configured. Set a PAT in Settings → GitHub Sync.' };
  return { ok: true, pat };
}

ipcMain.handle('sync:setupClone', async (_evt, { workspacePath, remoteUrl }) => {
  const auth = await readSyncPat();
  if (!auth.ok) return auth;
  return syncSetupClone({ workspacePath, remoteUrl, pat: auth.pat });
});

ipcMain.handle('sync:setupInitAndCreate', async (_evt, { workspacePath, repoName, private: isPrivate = true }) => {
  const auth = await readSyncPat();
  if (!auth.ok) return auth;
  return syncSetupInitAndCreate({ workspacePath, repoName, private: isPrivate, pat: auth.pat });
});

ipcMain.handle('sync:setupLink', async (_evt, { workspacePath, remoteUrl }) => {
  const auth = await readSyncPat();
  if (!auth.ok) return auth;
  return syncSetupLink({ workspacePath, remoteUrl, pat: auth.pat });
});

ipcMain.handle('sync:teardown', async (_evt, { workspacePath }) => {
  return syncTeardown({ workspacePath });
});

// List repos visible to the configured PAT, for the per-workspace "link to
// existing repo" picker. PAT is read from settings here so the renderer never
// touches it.
ipcMain.handle('sync:listRepos', async () => {
  const auth = await readSyncPat();
  if (!auth.ok) return auth;
  return syncListRepos(auth.pat);
});

// ---- Sync engine lifecycle ----
//
// Engine is bound to the renderer's active workspace. The renderer calls
// start/stop as workspaces load/unload. Status events are pushed back via
// `sync:status` and consumed by the status-bar icon.

ipcMain.handle('sync:engineStart', async (evt, { workspacePath, intervalSeconds }) => {
  const settings = await readSettings();
  const pat = settings.sync?.pat || '';
  const wsId = (settings.workspaces || []).find((w) => w.path === workspacePath)?.id ?? null;
  const disabledIds = settings.sync?.disabledWorkspaceIds || [];
  const win = BrowserWindow.fromWebContents(evt.sender);
  // User paused sync for this workspace → don't start the engine. engineStop
  // emits a `disabled` status (icon hidden) which matches the rest of the
  // "not syncing" cases. Origin stays in .git/config so re-enabling is a
  // single engineStart with no setup required.
  if (wsId && disabledIds.includes(wsId)) {
    await engineStop();
    return;
  }
  await engineStart({
    workspacePath,
    pat,
    intervalSeconds: intervalSeconds ?? settings.sync?.pullIntervalSeconds ?? 10,
    windowId: win?.id ?? null,
  });
});

// Toggle per-workspace sync. Persists the flag; if this is the active
// workspace, reconciles by stopping or starting the engine. Origin is left
// in .git/config either way so re-enable is a no-touch resume.
ipcMain.handle('sync:setWorkspaceDisabled', async (evt, { workspacePath, disabled }) => {
  const settings = await readSettings();
  const wsId = (settings.workspaces || []).find((w) => w.path === workspacePath)?.id ?? null;
  if (!wsId) return { ok: false, error: 'Workspace not found in settings' };
  const cur = new Set(settings.sync?.disabledWorkspaceIds || []);
  if (disabled) cur.add(wsId);
  else cur.delete(wsId);
  const nextSync = { ...settings.sync, disabledWorkspaceIds: [...cur] };
  await writeSettings({ sync: nextSync });

  // Reconcile only if this is the active workspace. The engine is bound to
  // one workspace at a time; touching engine state for a non-active one
  // would yank the engine away from the workspace the user is editing.
  if (settings.activeWorkspaceId === wsId) {
    if (disabled) {
      await engineStop();
    } else {
      const win = BrowserWindow.fromWebContents(evt.sender);
      await engineStart({
        workspacePath,
        pat: nextSync.pat || '',
        intervalSeconds: nextSync.pullIntervalSeconds ?? 10,
        windowId: win?.id ?? null,
      });
    }
  }
  return { ok: true };
});

ipcMain.handle('sync:engineStop', async () => {
  await engineStop();
});

// Renderer's ack of the flush-dirty-tabs request. The engine waits on this
// before proceeding with the rest of the tick.
ipcMain.handle('sync:flushDone', async (_evt, token) => {
  engineHandleFlushDone(token);
});

// One-shot status read (renderer asks for current state on mount before the
// next push event would arrive).
ipcMain.handle('sync:engineStatus', async () => {
  return engineGetCurrentStatus();
});

// Conflict-resolution view: list unmerged files, and resolve one (git add).
// Both return workspace-relative POSIX paths.
ipcMain.handle('sync:listConflicts', async (_evt, workspacePath) => {
  if (!workspacePath) return [];
  return engineGetConflicts(workspacePath);
});

ipcMain.handle('sync:resolveConflict', async (_evt, { workspacePath, relPath }) => {
  if (!workspacePath || !relPath) return [];
  return engineResolveConflict(workspacePath, relPath);
});

// Whole-repo escape hatch: discard local divergence, hard-reset to origin.
ipcMain.handle('sync:resetToRemote', async (_evt, workspacePath) => {
  if (!workspacePath) return;
  return engineResetToRemote(workspacePath);
});

// ---- Coding agent (pi) ----
//
// One pi AgentSession at a time. The renderer sends `agent:send` with the prompt
// text; main reads the current workspace and coding-agent settings, lazily creates
// or reuses a session, then forwards every pi event back via `agent:event`. The
// renderer relies on the event stream's `agent_start` / `agent_end` boundaries to
// gate its send button.

ipcMain.handle('agent:send', async (evt, { text, images }) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  const emit = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  try {
    const settings = await readSettings();
    const ws = (settings.workspaces || []).find((w) => w.id === settings.activeWorkspaceId);
    const workspacePath = ws?.path ?? null;
    const { provider, model, apiKey, skills, systemPrompt } = settings.codingAgent ?? {};

    await agentSend(
      {
        text,
        images,
        workspacePath,
        provider,
        model,
        apiKey,
        systemPrompt,
        userDataDir: app.getPath('userData'),
        skillsState: skills,
        workspaceId: ws?.id ?? null,
      },
      (event) => emit('agent:event', event),
    );
  } catch (err: any) {
    emit('agent:error', { message: err?.message ?? String(err) });
  }
});

// ---- Skills ----
ipcMain.handle('skills:list', async () => {
  return listInstalled(app.getPath('userData'));
});

ipcMain.handle('skills:libraryDir', async () => {
  return libraryDirFor(app.getPath('userData'));
});

ipcMain.handle('skills:importPicker', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose a skill folder (must contain SKILL.md)',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return importFromPath(app.getPath('userData'), result.filePaths[0]);
});

ipcMain.handle('skills:importFromPath', async (_evt, srcPath) => {
  if (typeof srcPath !== 'string' || !srcPath) throw new Error('No path provided.');
  return importFromPath(app.getPath('userData'), srcPath);
});

ipcMain.handle('skills:remove', async (_evt, folderName) => {
  if (typeof folderName !== 'string' || !folderName) throw new Error('No skill name provided.');
  return removeSkill(app.getPath('userData'), folderName);
});

ipcMain.handle('agent:abort', async () => {
  try { await agentAbort(); } catch { /* abort is best-effort */ }
});

ipcMain.handle('agent:reset', async () => {
  try { await agentReset(); } catch { /* reset is best-effort */ }
});

ipcMain.handle('agent:getDefaultSystemPrompt', async () => DEFAULT_AGENT_SYSTEM_PROMPT);

// Provider + model lookups for the Settings UI. Pi-ai's `getProviders()` is
// the source of truth; we intersect with this allowlist so OAuth /
// multi-credential providers (bedrock, vertex, azure, cloudflare, copilot,
// codex) are filtered out — our settings schema only carries a single API
// key, which is insufficient for those.
//
ipcMain.handle('agent:listProviders', () => {
  return getProviders().filter((slug) => SUPPORTED_PROVIDER_SLUGS.has(slug as any)).sort();
});

ipcMain.handle('agent:listModels', (_evt, provider) => {
  if (!provider) return [];
  return getModels(provider).map((m) => m.id).sort();
});

function timestampForFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Save a binary image alongside its associated note.
//   dirPath  — target directory (typically the dir of the active .md file)
//   bytes    — Uint8Array of the image bytes
//   ext      — file extension including leading dot, e.g. '.png'
//   baseName — optional preferred basename (without extension). If a file
//              with this name already exists, uniquePath will add " 1", " 2", ...
//              Falls back to a timestamped "Pasted image …" name when omitted.
ipcMain.handle('fs:writeImage', async (_evt, { dirPath, bytes, ext, baseName }) => {
  if (!dirPath) throw new Error('No target folder for image.');
  if (!ext || !ext.startsWith('.')) throw new Error('Invalid image extension.');
  const base = baseName && baseName.trim()
    ? baseName.trim()
    : `Pasted image ${timestampForFilename()}`;
  const target = await uniquePath(dirPath, base, ext);
  await fs.writeFile(target, Buffer.from(bytes));
  return target;
});

ipcMain.handle('fs:pathExists', async (_evt, p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
});

// ---- workspace file watcher ----
//
// One watcher per app. Two responsibilities:
//   1. Coalesce per-path events into a 'fs:changed' stream for the renderer
//      (parses outgoing wiki-links so the renderer doesn't have to read every
//      changed file again).
//   2. Detect renames. Chokidar reports a rename as unlink(old)+add(new). We
//      pair these via the rename correlator using inode (primary) and content
//      hash (fallback for FAT/SMB-style filesystems where ino is unreliable),
//      so an external `mv` or an agent's `fs.rename` becomes a single
//      {type:'rename', oldPath, newPath} event the renderer can act on.
//
// Events are coalesced per-path within WATCH_DEBOUNCE_MS so a burst of writes
// collapses to one notification per path.

const WATCH_DEBOUNCE_MS = 150;
const RENAME_GRACE_MS = 800;   // how long we hold an unlink waiting for a possible add to pair with

let currentWatcher: any = null;
let bookmarksWatcher: any = null;       // dedicated watcher for .shockwave/bookmarks.json (main watcher ignores .shockwave)
let watcherRootDir: any = null;
let watcherWindowId: any = null;
let pendingByPath = new Map();    // path -> 'add' | 'change' | 'unlink'
let pendingTreeOnly = false;       // folder events or non-.md events
let flushTimer: any = null;
let correlator: any = null;             // createRenameCorrelator instance, reset per workspace
let renameQueue: any[] = [];              // emitted rename events awaiting flush to renderer

function senderWindow() {
  if (watcherWindowId == null) return null;
  const win = BrowserWindow.fromId(watcherWindowId);
  return win && !win.isDestroyed() ? win : null;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushWatcher, WATCH_DEBOUNCE_MS);
}

// Ship a 'rename' event with the new file's mtime + outgoingLinks so the
// renderer can: (1) re-key its link index, (2) refresh outgoing links if
// content changed during the move, (3) rewrite references in other files.
async function sendRename(win, oldPath, newPath) {
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(newPath, 'utf8'),
      fs.stat(newPath),
    ]);
    win.webContents.send('fs:changed', {
      type: 'rename',
      oldPath,
      newPath,
      mtime: stat.mtimeMs,
      outgoingLinks: parseLinks(content),
    });
  } catch {
    // The new file may have been renamed/deleted again before we could read it.
    // Fall back to an unlink for the old path so the index doesn't drift.
    win.webContents.send('fs:changed', { type: 'unlink', path: oldPath });
  }
}

async function flushWatcher() {
  flushTimer = null;
  const win = senderWindow();
  const entries = [...pendingByPath.entries()];
  const treeOnly = pendingTreeOnly;
  const queuedRenames = renameQueue.splice(0);
  pendingByPath.clear();
  pendingTreeOnly = false;
  if (!win) return;

  // Renames first — the renderer needs to re-key paths before any subsequent
  // add/change/unlink for the new path arrives.
  for (const { oldPath, newPath } of queuedRenames) {
    await sendRename(win, oldPath, newPath);
  }

  for (const [p, type] of entries) {
    if (type === 'unlink') {
      win.webContents.send('fs:changed', { type: 'unlink', path: p });
      continue;
    }
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(p, 'utf8'),
        fs.stat(p),
      ]);
      win.webContents.send('fs:changed', {
        type,                         // 'add' | 'change'
        path: p,
        mtime: stat.mtimeMs,
        outgoingLinks: parseLinks(content),
      });
    } catch (err: any) {
      // ENOENT = file was deleted between watcher event and read (expected
      // race). Anything else (permission denied, decode error) is worth
      // surfacing so users can investigate why their file isn't appearing.
      if (err?.code !== 'ENOENT') {
        console.warn('[watcher] flush read failed', p, err?.code ?? '', err?.message ?? err);
      }
    }
  }

  if (treeOnly && entries.length === 0 && queuedRenames.length === 0) {
    win.webContents.send('fs:changed', { type: 'tree' });
  }
}

// Wire chokidar -> correlator -> pendingByPath. The correlator emits one of
// 'add' | 'unlink' | 'rename'. The first two go through pendingByPath so they
// pick up the per-path coalescing behavior; 'rename' goes through renameQueue
// since it's already a paired event and shouldn't be merged with anything.
function setupCorrelator() {
  correlator = createRenameCorrelator({
    emit: (e) => {
      if (e.type === 'rename') {
        renameQueue.push(e);
        scheduleFlush();
      } else if (e.type === 'unlink') {
        pendingByPath.set(e.path, 'unlink');
        scheduleFlush();
      } else if (e.type === 'add') {
        // Preserve unlink->add merge semantic from the prior implementation:
        // an unlink immediately followed by an add for the same path is a change.
        const prev = pendingByPath.get(e.path);
        pendingByPath.set(e.path, prev === 'unlink' ? 'change' : 'add');
        scheduleFlush();
      }
    },
    graceMs: RENAME_GRACE_MS,
  });
}

async function onChokidarAdd(p) {
  if (!isMdFile(p)) {
    pendingTreeOnly = true;
    scheduleFlush();
    return;
  }
  const [ino, hash] = await Promise.all([statInoOf(p), hashFileOf(p)]);
  correlator.onPathAppeared(p, ino, hash);
}

async function onChokidarChange(p) {
  if (!isMdFile(p)) {
    pendingTreeOnly = true;
    scheduleFlush();
    return;
  }
  // Atomic saves (vim/VS Code) arrive here, with a new inode. Update identity
  // so a future unlink for this path has the latest ino+hash to correlate with.
  const [ino, hash] = await Promise.all([statInoOf(p), hashFileOf(p)]);
  correlator.onPathSeen(p, ino, hash);
  pendingByPath.set(p, pendingByPath.get(p) === 'add' ? 'add' : 'change');
  scheduleFlush();
}

function onChokidarUnlink(p) {
  if (!isMdFile(p)) {
    pendingTreeOnly = true;
    scheduleFlush();
    return;
  }
  correlator.onPathGone(p);
}

// Seed the correlator with current identity for every .md file in the
// workspace. Runs once on watchStart, before chokidar fires any events, so an
// unlink right after startup can still be correlated to its prior identity.
async function seedCorrelator(root) {
  const paths = await walkMarkdownPaths(root);
  await Promise.all(paths.map(async (p) => {
    const [ino, hash] = await Promise.all([statInoOf(p), hashFileOf(p)]);
    correlator.onPathSeen(p, ino, hash);
  }));
}

async function stopWatcher() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  pendingByPath.clear();
  pendingTreeOnly = false;
  renameQueue.length = 0;
  if (currentWatcher) {
    const w = currentWatcher;
    currentWatcher = null;
    try { await w.close(); } catch { /* ignore close errors */ }
  }
  if (bookmarksWatcher) {
    const bw = bookmarksWatcher;
    bookmarksWatcher = null;
    try { await bw.close(); } catch { /* ignore close errors */ }
  }
  correlator = null;
  watcherRootDir = null;
  watcherWindowId = null;
}

ipcMain.handle('fs:watchStart', async (evt, dirPath) => {
  await stopWatcher();
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  watcherWindowId = win.id;
  watcherRootDir = dirPath;
  setupCorrelator();
  await seedCorrelator(dirPath);
  currentWatcher = chokidar.watch(dirPath, {
    ignored: (p) => {
      // Skip if any path segment within the watched root starts with '.'
      // (mirrors buildTree's dotfile rule, including .git, .obsidian, etc.).
      const rel = path.relative(dirPath, p);
      if (!rel || rel.startsWith('..')) return false;
      return rel.split(path.sep).some((seg) => seg.startsWith('.'));
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  });
  currentWatcher
    .on('add', onChokidarAdd)
    .on('change', onChokidarChange)
    .on('unlink', onChokidarUnlink)
    .on('addDir', () => { pendingTreeOnly = true; scheduleFlush(); })
    .on('unlinkDir', () => { pendingTreeOnly = true; scheduleFlush(); });

  // The main watcher ignores everything under `.shockwave/`, so changes to the
  // bookmarks file (sync pull, another machine, a hand edit) never reach the
  // renderer. Watch that one file on its own and tell the renderer to re-read.
  bookmarksWatcher = chokidar.watch(bookmarksPath(dirPath), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  });
  const notifyBookmarks = () => {
    const w = watcherWindowId != null ? BrowserWindow.fromId(watcherWindowId) : null;
    if (w && !w.isDestroyed()) w.webContents.send('bookmarks:changed');
  };
  bookmarksWatcher.on('add', notifyBookmarks).on('change', notifyBookmarks);
});

ipcMain.handle('fs:watchStop', stopWatcher);

app.on('before-quit', () => { stopWatcher(); agentReset().catch(() => {}); });

// Drain any pending settings writes (notably the window-bounds save fired
// from each window's `close` handler) before the process exits. Without this
// step a fast Cmd+Q can race the async tmp+rename and lose the last bounds.
// Also drain the sync engine — let any in-flight git push/pull finish so we
// don't leave a partial commit on the remote.
let cleanQuitting = false;
app.on('will-quit', (event) => {
  if (cleanQuitting) return;
  event.preventDefault();
  cleanQuitting = true;
  Promise.allSettled([
    settingsWriteQueue,
    engineDrainBeforeQuit(),
  ]).finally(() => app.exit());
});

ipcMain.handle('theme:getInitial', () => ({
  dark: nativeTheme.shouldUseDarkColors,
}));

nativeTheme.on('updated', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('theme:systemChanged', {
      dark: nativeTheme.shouldUseDarkColors,
    });
  }
});

// Install the bridge the agent-tokens pi extension uses to fetch decrypted
// secrets. Re-reads on every call so user-side edits to secrets are picked
// up mid-conversation without restarting the session.
installAgentTokensBridge(async () => {
  const settings = await readSettings();
  return settings.agentSecrets ?? [];
});

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    try {
      const url = new URL(req.url);
      if (url.host !== 'media') return new Response('not found', { status: 404 });
      if (!watcherRootDir) return new Response('no vault', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const abs = path.normalize(path.join(watcherRootDir, rel));
      const rootNorm = path.normalize(watcherRootDir);
      if (abs !== rootNorm && !abs.startsWith(rootNorm + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      return await net.fetch(pathToFileURL(abs).toString());
    } catch {
      return new Response('error', { status: 500 });
    }
  });

  if (process.platform === 'darwin' && app.dock?.setIcon) {
    try {
      app.dock.setIcon(ICON_PATH);
    } catch {
      // ignore: icon file may not be present in some dev configurations
    }
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
