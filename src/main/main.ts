import { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, protocol, net, safeStorage, screen } from 'electron';
// CJS package with lazy getter exports — named ESM imports fail at runtime
// (cjs-module-lexer can't see them); destructure off the default instead.
import electronUpdater from 'electron-updater';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as parcelWatcher from '@parcel/watcher';
import { parseLinks } from './linkParser.js';
import { createRenameCorrelator } from './renameCorrelator.js';
import { createWatcherDispatch } from './watcherDispatch.js';
import { agentSend, agentAbort, agentReset, agentOpenSession, listThinkingLevels } from './codingAgent.js';
import { listSessions, listStarred, searchSessions, getMessages, getSession, deleteSession, setSessionTitle, setSessionStarred } from './db/index.js';
import { isMdFile, uniquePath, walkMarkdownPaths, isIgnoredSegment } from './pathResolver.js';
import { scaffoldNewProject } from './prompt/index.js';
// Static-catalog reads moved off the pi-ai root to `/compat` in pi-ai 0.80.0.
import { getProviders, getModels } from '@earendil-works/pi-ai/compat';
import { listBuiltinSkills, listWorkspaceSkills, importSkillToWorkspace, removeWorkspaceSkill, workspaceSkillsDir } from './skillLibrary.js';
import { installAgentTokensBridge } from './agentTokensExtension.js';
import { installOpenFileBridge } from './openFileExtension.js';
import { ensureCliShims, prependPath } from './cliTools.js';
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
  userDisable as engineUserDisable,
  drainBeforeQuit as engineDrainBeforeQuit,
  handleFlushDone as engineHandleFlushDone,
  getCurrentStatus as engineGetCurrentStatus,
  getConflicts as engineGetConflicts,
  resolveConflict as engineResolveConflict,
  keepConflict as engineKeepConflict,
  resetConflict as engineResetConflict,
  keepAll as engineKeepAll,
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
  appearance: { themeMode: 'system', hideLineNumbers: false, dailyNotesInBookmarks: false },
  // Daily-note + template config moved to per-workspace `.shockwave/workspace.json`.
  codingAgent: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    providerKeys: {},
    // OpenAI-compatible endpoint URL; only set when provider is 'openai-compatible'.
    baseUrl: '',
    // Extended-thinking level. 'medium' preserves pi's implicit default for
    // reasoning-capable hosted models (no behavior change); openai-compatible
    // endpoints stay effectively off because their model is registered
    // reasoning:false unless a level > off is chosen.
    thinkingLevel: 'medium',
    // System prompt is no longer a setting — it's assembled at session boot from
    // the workspace's SOUL.md (or a built-in default) + the internal Shockwave
    // helper. See src/main/prompt/.
    // GLOBAL built-in skill on/off (folderName → 'enabled'|'disabled'; absent ⇒
    // enabled). A workspace can override per-skill in its workspace.json. User
    // uploads live in `<workspace>/.shockwave/skills/`.
    builtinSkills: {},
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
  // Whether the file-tree is filtered to bookmarks only. Persisted globally so
  // the view survives restarts and workspace switches.
  bookmarkFilterActive: false,
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

// Bundled built-in skills. Shipped via electron-builder `extraResources` →
// process.resourcesPath/built-in-skills in production; read from the repo in dev.
function builtinSkillsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'built-in-skills')
    : path.join(app.getAppPath(), 'resources', 'built-in-skills');
}

// Bundled CLI tools. Shipped via `files` + `asarUnpack` → app.asar.unpacked in
// production; read from the repo in dev.
function cliToolsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'cli-tools')
    : path.join(app.getAppPath(), 'cli-tools');
}

// Auto-provision empty agent-secret slots for the secrets that enabled built-in
// skills declare (SKILL.md `required-secrets`). The user just pastes their key
// into the slot. Always re-adds a missing slot for an enabled built-in (so a
// deleted one returns), but never overwrites a value the user already filled —
// we only ADD names not already present. Disabling a built-in leaves its slot.
async function ensureBuiltinSecretSlots() {
  try {
    const settings = await readSettings();
    const installed = await listBuiltinSkills(builtinSkillsDir());
    const have = new Set((settings.agentSecrets ?? []).map((s) => s.name));
    const additions: any[] = [];
    const now = Date.now();
    // Built-in on/off is per-workspace now, but agent secrets are global — so we
    // provision a slot for every built-in's required secret regardless of any
    // single workspace's toggle (we only ADD missing names, never overwrite).
    for (const sk of installed) {
      for (const name of (sk.requiredSecrets ?? [])) {
        if (have.has(name) || additions.some((a) => a.name === name)) continue;
        additions.push({ name, description: `Used by the ${sk.name} skill`, token: '', createdAt: now, updatedAt: now });
      }
    }
    if (additions.length) {
      await writeSettings({ agentSecrets: [...(settings.agentSecrets ?? []), ...additions] });
    }
  } catch (err: any) {
    console.warn('[secrets] built-in slot provisioning failed:', err?.message ?? err);
  }
}

async function readSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      appearance: { ...DEFAULT_SETTINGS.appearance, ...(parsed.appearance ?? {}) },
      codingAgent: {
        ...DEFAULT_SETTINGS.codingAgent,
        ...(parsed.codingAgent ?? {}),
        providerKeys: { ...(parsed.codingAgent?.providerKeys ?? {}) },
        builtinSkills: { ...(parsed.codingAgent?.builtinSkills ?? {}) },
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
    // Migrate the legacy single apiKey → providerKeys[provider] (one-time). The
    // on-disk value is still enc:v1-wrapped; move as-is, then decrypt below.
    const ca = merged.codingAgent as any;
    if (parsed.codingAgent?.apiKey && ca.providerKeys[ca.provider] == null) {
      ca.providerKeys[ca.provider] = parsed.codingAgent.apiKey;
    }
    delete ca.apiKey;
    for (const slug of Object.keys(ca.providerKeys)) {
      ca.providerKeys[slug] = decryptSecret(ca.providerKeys[slug]);
    }
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
  // Defensive one-level deep-merge for every nested-object setting: a caller
  // that builds a partial sub-object (e.g. { sync: { pat } }) would otherwise
  // wipe sibling fields on disk via the shallow spread above. The renderer
  // currently always sends whole sub-objects, but this removes that as a
  // load-bearing convention. Scalars/arrays (workspaces, windowBounds, etc.)
  // stay shallow — a partial array patch is meaningless.
  for (const key of ['appearance', 'codingAgent', 'transcription', 'sync'] as const) {
    if ((patch as any)[key] && (existing as any)[key]) {
      (out as any)[key] = { ...(existing as any)[key], ...(patch as any)[key] };
    }
  }
  // Encrypt secret-bearing fields. encryptSecret is idempotent so values that
  // came from the on-disk file (already encrypted) pass through unchanged.
  const pk = (out as any).codingAgent?.providerKeys;
  if (pk) for (const slug of Object.keys(pk)) pk[slug] = encryptSecret(pk[slug] ?? '');
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
    // macOS: deliver the click that reactivates a background window straight to
    // the web content, so clicking a file in the sidebar when the app isn't
    // frontmost opens it in one click instead of two (first to activate, second
    // to act). No-op on Windows/Linux.
    acceptsFirstMouse: true,
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

// Seed SOUL.md (agent identity) + an empty AGENTS.md into a workspace on
// creation, so a new workspace has them from the start — not only when a repo
// is created via GitHub sync. Idempotent: writes only files that don't exist,
// best-effort (never throws).
ipcMain.handle('workspace:scaffold', async (_evt, workspacePath) => {
  if (typeof workspacePath !== 'string' || !workspacePath) return;
  await scaffoldNewProject(workspacePath);
});

async function buildTree(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((e) => !isIgnoredSegment(e.name))
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

// --- Persisted parse cache (Obsidian-style metadata cache) -----------------
// Stores each .md file's parsed wiki-links keyed by path, validated by mtime +
// size, so a cold start re-parses only the files that changed while the app was
// closed. Kept under userData (per-machine, NOT in the workspace) so it never
// syncs — mtimes differ per machine and would churn git.
//
// Full rebuild-from-scratch happens when: (a) LINK_CACHE_VERSION doesn't match
// the on-disk cache — bump it whenever parseLinks' output shape changes so a
// cache written by an older build is discarded rather than trusted; (b) the
// cache file is missing/corrupt; (c) the user triggers `fs:rebuildLinkCache`.
// Per-file re-parse happens when a file's mtime OR size differs from the cache
// (size guards against edits that preserve mtime).
const LINK_CACHE_VERSION = 1;   // bump when parseLinks' output shape changes (e.g. added targetParsed)

function linkCachePath(dirPath) {
  const key = crypto.createHash('sha1').update(dirPath).digest('hex');
  return path.join(app.getPath('userData'), 'link-cache', `${key}.json`);
}

async function loadLinkCache(dirPath) {
  try {
    const raw = await fs.readFile(linkCachePath(dirPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === LINK_CACHE_VERSION && parsed.entries) return parsed.entries;
  } catch { /* missing / corrupt / version mismatch → cold parse */ }
  return {};
}

async function saveLinkCache(dirPath, entries) {
  try {
    const file = linkCachePath(dirPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: LINK_CACHE_VERSION, entries }), 'utf8');
    await fs.rename(tmp, file);
  } catch { /* cache persistence is best-effort — never block a load */ }
}

async function readAllMarkdown(dirPath) {
  const cache = await loadLinkCache(dirPath);
  const paths = await walkMarkdownPaths(dirPath);
  const out: any[] = [];
  const nextEntries: Record<string, any> = {};
  let hits = 0, misses = 0;
  for (const full of paths) {
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    const cached = cache[full];
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
      // Unchanged since last load → reuse the cached parse, skip read + parse.
      out.push({ path: full, mtime: stat.mtimeMs, outgoingLinks: cached.outgoingLinks });
      nextEntries[full] = cached;
      hits++;
      continue;
    }
    try {
      const content = await fs.readFile(full, 'utf8');
      const links = parseLinks(content);
      out.push({ path: full, mtime: stat.mtimeMs, outgoingLinks: links });
      nextEntries[full] = { mtime: stat.mtimeMs, size: stat.size, outgoingLinks: links };
      misses++;
    } catch {
      // swallow per-file errors so one bad file doesn't kill the vault load
    }
  }
  // Rebuild the cache from the current file set (drops entries for deleted files).
  await saveLinkCache(dirPath, nextEntries);
  if (misses > 0 || hits > 0) console.log(`[link-cache] ${hits} hits, ${misses} reparsed (${paths.length} files)`);
  return out;
}

ipcMain.handle('fs:readAllMarkdown', async (_evt, dirPath) => {
  return readAllMarkdown(dirPath);
});

// Escape hatch: discard the persisted cache so the next load re-parses fully.
ipcMain.handle('fs:rebuildLinkCache', async (_evt, dirPath) => {
  try { await fs.rm(linkCachePath(dirPath), { force: true }); } catch { /* ignore */ }
  return { ok: true };
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
// eagerly so we still have an identity when the watcher reports a delete (the
// file is gone, so we can't read it then).
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
  // Default new files to .md; honor an explicit extension in `name` (e.g.
  // "Notes.txt"). Internal callers (wiki-link target, daily note) pass an
  // explicit ".md"; a user-typed draft title may carry any extension or none.
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;   // not a leading/trailing dot
  const base = hasExt ? name.slice(0, dot) : name.replace(/\.$/, '');
  const ext = hasExt ? name.slice(dot) : '.md';
  // Same-folder uniqueness only. Duplicate basenames across different folders
  // are allowed now (the link resolver disambiguates by path); the filesystem
  // still forbids two identical names in one folder.
  const target = await uniquePath(dirPath, base, ext);
  await fs.writeFile(target, content, 'utf8');
  const st = await fs.stat(target);
  return { path: target, mtime: st.mtimeMs };
});

// Literal rename (file-browser + title bar): the new name is used verbatim — no
// `.md` stripping or forcing. A name ending in `.md` stays markdown; anything
// else is a plain file. Rejects (throws) on a same-folder collision; duplicate
// basenames across different folders are allowed. The renderer blocks collisions
// live; this is the backstop.
ipcMain.handle('fs:renameFileLiteral', async (_evt, { fromPath, toName }) => {
  const dir = path.dirname(fromPath);
  const name = (toName ?? '').trim();
  if (!name) throw new Error('Name cannot be empty');
  if (name.includes('/') || name.includes('\\')) throw new Error('Name cannot contain a path separator');
  const target = path.join(dir, name);
  if (target === fromPath) return fromPath;
  // Same-folder collision only, for any extension. Duplicate basenames across
  // different folders are allowed; the filesystem forbids two identical names
  // in one folder.
  let exists = true;
  try { await fs.access(target); } catch { exists = false; }
  if (exists) throw new Error(`"${name}" already exists in this folder.`);
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

// Confirmation lives in the renderer (ConfirmDialog), same as bulk delete —
// these just move the item to the Trash. Return true so existing callers that
// gate cleanup on the result keep working.
ipcMain.handle('fs:trashFolder', async (_evt, folderPath) => {
  await shell.trashItem(folderPath);
  return true;
});

ipcMain.handle('fs:trashFile', async (_evt, filePath) => {
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
  const { isMd = true, isOpenable = isMd, isBookmarked = false, selectionCount = 1, conflictMode = false } = opts;
  // Conflict view, per file: accept as-edited, keep ours, or take remote.
  if (conflictMode) {
    return popupContextMenu(win, [
      { label: 'Conflict resolved', value: FILE_ACTIONS.RESOLVE },
      { label: 'Keep our file', value: FILE_ACTIONS.KEEP },
      { label: 'Reset to remote', value: FILE_ACTIONS.RESET },
    ]);
  }
  const multi = selectionCount > 1;
  const template: any[] = [];
  if (multi) {
    // Bulk-safe actions only: open all in new tabs (if openable), bookmark
    // toggle, delete. Rename/Duplicate/Reveal don't make sense across a
    // selection. Bookmark is .md-only (keyed by basename via the link index).
    if (isOpenable) template.push({ label: `Open ${selectionCount} files in new tabs`, value: FILE_ACTIONS.NEW_TAB });
    if (isMd) template.push(
      { label: isBookmarked ? `Remove ${selectionCount} bookmarks` : `Bookmark ${selectionCount} files`, value: FILE_ACTIONS.TOGGLE_BOOKMARK },
      { type: 'separator' },
    );
    template.push({ label: `Delete ${selectionCount} files`, value: FILE_ACTIONS.DELETE });
  } else {
    if (isOpenable) template.push({ label: 'Open in new tab', value: FILE_ACTIONS.NEW_TAB });
    template.push({ label: 'Duplicate', value: FILE_ACTIONS.DUPLICATE });
    // Bookmark is .md-only.
    if (isMd) template.push(
      { type: 'separator' },
      { label: isBookmarked ? 'Remove bookmark' : 'Bookmark', value: FILE_ACTIONS.TOGGLE_BOOKMARK },
    );
    template.push(
      { type: 'separator' },
      { label: revealLabel(), value: FILE_ACTIONS.REVEAL },
      { type: 'separator' },
      { label: 'Rename', value: FILE_ACTIONS.RENAME },
      { label: 'Delete', value: FILE_ACTIONS.DELETE },
    );
  }
  return popupContextMenu(win, template);
});

// Right-click on the sync-conflict cloud icon: whole-tree resolution.
ipcMain.handle('context:conflictCloudMenu', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  return popupContextMenu(win, [
    { label: 'Keep entire tree (take ours)', value: 'keep' },
    { label: 'Reset entire tree (take remote)', value: 'reset' },
  ]);
});

ipcMain.handle('context:folderMenu', async (evt, opts = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const { isRoot = false } = opts;
  const template: any[] = [
    { label: 'New file', value: FOLDER_ACTIONS.NEW_FILE },
    { label: 'New folder', value: FOLDER_ACTIONS.NEW_FOLDER },
    { type: 'separator' },
    { label: revealLabel(), value: FOLDER_ACTIONS.REVEAL },
  ];
  if (!isRoot) {
    template.push(
      { type: 'separator' },
      { label: 'Rename', value: FOLDER_ACTIONS.RENAME },
      { label: 'Delete', value: FOLDER_ACTIONS.DELETE },
    );
  }
  return popupContextMenu(win, template);
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

// ─── Per-workspace settings (.shockwave/workspace.json) ──────────────────────
// One file per workspace holding everything workspace-scoped: bookmarks, daily-
// note config, templates config, and built-in skill toggles. It lives under the
// `.shockwave/` dotfile segment the watcher ignores, so our writes don't echo
// back as fs:changed events. `bookmarks` are `.md` basenames (no folder, no
// extension); the rest mirror the shapes the renderer uses.
function workspaceFilePath(workspacePath) {
  return path.join(workspacePath, '.shockwave', 'workspace.json');
}
function legacyBookmarksPath(workspacePath) {
  return path.join(workspacePath, '.shockwave', 'bookmarks.json');
}

function workspaceDefaults() {
  return {
    schemaVersion: 1,
    bookmarks: [] as string[],
    dailyNote: { format: 'YYYY-MM-DD', folder: '', templatePath: '' },
    templates: { folder: '' },
    // Built-in skill folderName → 'enabled' | 'disabled'. Absent ⇒ enabled.
    builtinSkills: {},
  };
}

function normalizeWorkspaceData(raw) {
  const d = workspaceDefaults();
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.bookmarks)) {
      d.bookmarks = Array.from(new Set(raw.bookmarks.filter((n) => typeof n === 'string' && n.length > 0)));
    }
    if (raw.dailyNote && typeof raw.dailyNote === 'object') {
      d.dailyNote = {
        format: raw.dailyNote.format || d.dailyNote.format,
        folder: raw.dailyNote.folder ?? '',
        templatePath: raw.dailyNote.templatePath ?? '',
      };
    }
    if (raw.templates && typeof raw.templates === 'object') {
      d.templates = { folder: raw.templates.folder ?? '' };
    }
    if (raw.builtinSkills && typeof raw.builtinSkills === 'object') {
      d.builtinSkills = { ...raw.builtinSkills };
    }
  }
  return d;
}

// Serialize all reads/writes of a given workspace file so a bookmarks write and
// a settings update (both read-modify-write the same JSON) can't clobber each
// other. One promise chain per workspace path.
const workspaceFileQueues = new Map();
function queueWorkspaceFile(workspacePath, fn) {
  const prev = workspaceFileQueues.get(workspacePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  workspaceFileQueues.set(workspacePath, next.then(() => {}, () => {}));
  return next;
}

async function writeWorkspaceFileRaw(workspacePath, data) {
  const file = workspaceFilePath(workspacePath);
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function readWorkspaceFileRaw(workspacePath) {
  try {
    const raw = await fs.readFile(workspaceFilePath(workspacePath), 'utf8');
    return normalizeWorkspaceData(JSON.parse(raw));
  } catch {
    // No unified file yet — migrate a legacy bookmarks.json into it if present,
    // then remove the legacy file. Otherwise return defaults.
    try {
      const raw = await fs.readFile(legacyBookmarksPath(workspacePath), 'utf8');
      const parsed = JSON.parse(raw);
      const data = normalizeWorkspaceData({ bookmarks: Array.isArray(parsed?.names) ? parsed.names : [] });
      await writeWorkspaceFileRaw(workspacePath, data);
      await fs.rm(legacyBookmarksPath(workspacePath), { force: true });
      return data;
    } catch {
      return workspaceDefaults();
    }
  }
}

ipcMain.handle('workspaceSettings:read', async (_evt, workspacePath) => {
  if (!workspacePath) return workspaceDefaults();
  return queueWorkspaceFile(workspacePath, () => readWorkspaceFileRaw(workspacePath));
});

// Merge `patch` (a partial of the workspace data) into the current file and
// write the whole thing back. Returns the merged object.
ipcMain.handle('workspaceSettings:update', async (_evt, { workspacePath, patch }) => {
  if (!workspacePath) return workspaceDefaults();
  return queueWorkspaceFile(workspacePath, async () => {
    const cur = await readWorkspaceFileRaw(workspacePath);
    const next = normalizeWorkspaceData({ ...cur, ...(patch || {}) });
    await writeWorkspaceFileRaw(workspacePath, next);
    return next;
  });
});

// Bookmarks live in the `bookmarks` array of the unified file. These thin
// handlers keep the renderer's existing bookmarks API working.
ipcMain.handle('bookmarks:read', async (_evt, workspacePath) => {
  if (!workspacePath) return [];
  const data = await queueWorkspaceFile(workspacePath, () => readWorkspaceFileRaw(workspacePath));
  return Array.from(new Set(data.bookmarks));
});

ipcMain.handle('bookmarks:write', async (_evt, { workspacePath, paths: names }) => {
  if (!workspacePath) return;
  await queueWorkspaceFile(workspacePath, async () => {
    const cur = await readWorkspaceFileRaw(workspacePath);
    cur.bookmarks = Array.isArray(names) ? Array.from(new Set(names.filter((n) => typeof n === 'string' && n.length > 0))) : [];
    await writeWorkspaceFileRaw(workspacePath, cur);
  });
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
    // .md file move: same-folder uniqueness only. Duplicate basenames in
    // different folders are allowed (the resolver disambiguates by path).
    const base = name.slice(0, -3);
    target = await uniquePath(destDir, base, '.md');
  } else {
    // Folder or non-.md file: same-dir uniqueness on the item's own name. A
    // folder's nested .md files may now share basenames with files elsewhere —
    // that's fine, so there's no cross-folder collision check anymore.
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

// ---- App update check ------------------------------------------------------
//
// Packaged builds use electron-updater (feed baked in from package.json's
// `build.publish` GitHub block): check → auto-download → push status with
// `downloaded: true`; install happens via app:restartToUpdate (quitAndInstall)
// or on normal quit (autoInstallOnAppQuit). macOS requires the signed +
// notarized build — electron-updater refuses unsigned apps there.
//
// Dev (unpackaged) has no app-update.yml, so we keep the old notify-only
// GitHub API poll: same UpdateStatus shape, `downloaded` just never flips
// true. Unauthenticated GitHub API allows ~60 req/hr — a daily poll plus the
// odd manual check is nowhere near that.
const { autoUpdater } = electronUpdater;
const UPDATE_REPO = { owner: 'stephengpope', repo: 'shockwave' };
const UPDATE_POLL_MS = 24 * 60 * 60 * 1000; // daily auto-check

// "v1.2.3" / "1.2.3-beta" → [1,2,3]; the leading "v" and any pre-release/build
// suffix are dropped (we only compare the numeric core).
function parseVersion(v: string): number[] {
  const core = String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((n) => parseInt(n, 10) || 0);
}
// >0 when `a` is newer than `b`, <0 when older, 0 when equal.
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Last computed status, served to renderers that subscribe after a background
// check already ran (so the pill hydrates without waiting for the next poll).
let lastUpdateResult: any = null;

function pushUpdateStatus(status: any) {
  lastUpdateResult = status;
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('app:updateStatus', lastUpdateResult);
  }
}

function releasePageUrl(version: string | null) {
  const tail = version ? `tag/v${version}` : 'latest';
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/${tail}`;
}

if (app.isPackaged) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const current = app.getVersion();
  autoUpdater.on('update-available', (info) => pushUpdateStatus({
    updateAvailable: true, latest: info.version, current,
    url: releasePageUrl(info.version), error: null, downloaded: false,
  }));
  autoUpdater.on('update-not-available', (info) => pushUpdateStatus({
    updateAvailable: false, latest: info?.version ?? null, current,
    url: releasePageUrl(info?.version ?? null), error: null, downloaded: false,
  }));
  autoUpdater.on('update-downloaded', (info) => pushUpdateStatus({
    updateAvailable: true, latest: info.version, current,
    url: releasePageUrl(info.version), error: null, downloaded: true,
  }));
  autoUpdater.on('error', (err) => {
    console.warn('[update] electron-updater error:', err.message);
    pushUpdateStatus({
      updateAvailable: false, latest: null, current,
      url: null, error: err.message || 'update failed', downloaded: false,
    });
  });
}

async function runUpdateCheck() {
  const current = app.getVersion();
  if (app.isPackaged) {
    // Events above push status as the check/download progresses; the resolved
    // value is just the freshest snapshot for the invoking caller.
    try { await autoUpdater.checkForUpdates(); } catch { /* 'error' event already pushed */ }
    return lastUpdateResult;
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    const url = data.html_url
      || `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`;
    pushUpdateStatus({
      updateAvailable: latest ? compareVersions(latest, current) > 0 : false,
      latest, current, url, error: null, downloaded: false,
    });
  } catch (err: any) {
    console.warn('[update] check failed:', err.message);
    pushUpdateStatus({ updateAvailable: false, latest: null, current, url: null, error: err.message || 'check failed', downloaded: false });
  }
  return lastUpdateResult;
}

// Manual check (Settings → Updates button) — always hits the network.
ipcMain.handle('app:checkForUpdates', async () => runUpdateCheck());
// Cached status for a freshly-mounted renderer (null until the first check).
ipcMain.handle('app:getUpdateStatus', async () => lastUpdateResult);
// Install the downloaded update and relaunch. Goes through app.quit(), so the
// before-quit/will-quit drains (agent, sync, settings queue) still run.
ipcMain.handle('app:restartToUpdate', () => {
  if (app.isPackaged && lastUpdateResult?.downloaded) autoUpdater.quitAndInstall();
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
  // User turned sync off for this workspace → don't start the engine, but show
  // the DISABLED (stop) icon so they can re-enable from the status bar. Origin
  // stays in .git/config so re-enabling is a single engineStart, no setup.
  // (Only when there's a remote to sync to — otherwise it's just unconfigured.)
  if (wsId && disabledIds.includes(wsId)) {
    const ws = await syncWorkspaceStatus(workspacePath);
    if (ws.hasOrigin) await engineUserDisable();
    else await engineStop();
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
      // Show the DISABLED (stop) icon — not hidden — so it can be re-enabled
      // from the status bar. (Falls back to a plain stop if there's no remote.)
      const ws = await syncWorkspaceStatus(workspacePath);
      if (ws.hasOrigin) await engineUserDisable();
      else await engineStop();
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

// Per file: keep ours / take remote.
ipcMain.handle('sync:keepConflict', async (_evt, { workspacePath, relPath }) => {
  if (!workspacePath || !relPath) return [];
  return engineKeepConflict(workspacePath, relPath);
});
ipcMain.handle('sync:resetConflict', async (_evt, { workspacePath, relPath }) => {
  if (!workspacePath || !relPath) return [];
  return engineResetConflict(workspacePath, relPath);
});

// Whole tree: keep ours everywhere (then complete the merge), or hard-reset to origin.
ipcMain.handle('sync:keepAll', async (_evt, workspacePath) => {
  if (!workspacePath) return;
  return engineKeepAll(workspacePath);
});
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
    const { provider, model, baseUrl, contextWindow, thinkingLevel, builtinSkills, providerKeys } = settings.codingAgent ?? {};
    const apiKey = providerKeys?.[provider] ?? '';
    // Per-workspace built-in override lives in the workspace file; it wins over
    // the global default above.
    const wsData = workspacePath ? await readWorkspaceFileRaw(workspacePath) : null;

    await agentSend(
      {
        text,
        images,
        workspacePath,
        provider,
        model,
        apiKey,
        baseUrl,
        contextWindow,
        thinkingLevel,
        userDataDir: app.getPath('userData'),
        builtinDir: builtinSkillsDir(),
        globalBuiltinSkills: builtinSkills ?? {},
        wsBuiltinSkills: wsData?.builtinSkills ?? {},
      },
      (event) => emit('agent:event', event),
    );
  } catch (err: any) {
    emit('agent:error', { message: err?.message ?? String(err) });
  }
});

// ---- Skills (built-in = bundled, app-global; uploaded = per-workspace) ----
// `skills:list` returns both sets for the given workspace; built-in toggle state
// is read by the renderer from the workspace file.
ipcMain.handle('skills:list', async (_evt, workspacePath) => {
  const [builtin, workspace] = await Promise.all([
    listBuiltinSkills(builtinSkillsDir()),
    listWorkspaceSkills(workspacePath),
  ]);
  return { builtin, workspace };
});

// The active workspace's uploaded-skills folder (for a "Reveal" button).
ipcMain.handle('skills:libraryDir', async (_evt, workspacePath) => {
  return workspacePath ? workspaceSkillsDir(workspacePath) : null;
});

ipcMain.handle('skills:importPicker', async (_evt, workspacePath) => {
  if (!workspacePath) throw new Error('Open a workspace first.');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose a skill folder (must contain SKILL.md)',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return importSkillToWorkspace(workspacePath, result.filePaths[0]);
});

ipcMain.handle('skills:importFromPath', async (_evt, { workspacePath, srcPath }) => {
  if (!workspacePath) throw new Error('Open a workspace first.');
  if (typeof srcPath !== 'string' || !srcPath) throw new Error('No path provided.');
  return importSkillToWorkspace(workspacePath, srcPath);
});

ipcMain.handle('skills:remove', async (_evt, { workspacePath, folderName }) => {
  if (!workspacePath) throw new Error('Open a workspace first.');
  if (typeof folderName !== 'string' || !folderName) throw new Error('No skill name provided.');
  return removeWorkspaceSkill(workspacePath, folderName);
});

ipcMain.handle('agent:abort', async () => {
  try { await agentAbort(); } catch { /* abort is best-effort */ }
});

ipcMain.handle('agent:reset', async () => {
  try { await agentReset(); } catch { /* reset is best-effort */ }
});

// ---- Chat history (SQLite: display + search; pi's JSONL: continuation) ----
// The active workspace scopes every list/search (chats are workspace-scoped).
async function activeWorkspacePath(): Promise<string | null> {
  const settings = await readSettings();
  const ws = (settings.workspaces || []).find((w) => w.id === settings.activeWorkspaceId);
  return ws?.path ?? null;
}

// Recent chats for the picker (keyset paginated on updatedAt; pass `before`).
ipcMain.handle('chat:listSessions', async (_evt, opts = {}) => {
  const ws = await activeWorkspacePath();
  if (!ws) return [];
  return listSessions(ws, opts);
});

// Starred chats (the pinned section at the top of the picker).
ipcMain.handle('chat:listStarred', async () => {
  const ws = await activeWorkspacePath();
  if (!ws) return [];
  return listStarred(ws);
});

// Toggle a chat's starred flag.
ipcMain.handle('chat:setStarred', async (_evt, { sessionId, starred }) => {
  if (sessionId) setSessionStarred(sessionId, !!starred);
});

// Cross-chat full-text search over message content.
ipcMain.handle('chat:searchSessions', async (_evt, { query, limit } = {}) => {
  const ws = await activeWorkspacePath();
  if (!ws || !query) return [];
  return searchSessions(ws, query, { limit });
});

// Messages for one chat — the renderer rebuilds the transcript from these.
ipcMain.handle('chat:getMessages', async (_evt, sessionId) => {
  if (!sessionId) return [];
  return getMessages(sessionId);
});

// Start a fresh chat (same as the chat "new session" button → agentReset).
ipcMain.handle('chat:newSession', async () => {
  try { await agentReset(); } catch { /* best-effort */ }
});

// Resume a saved chat: hand pi the JSONL + stored prompt for the next send.
// Returns the messages so the renderer can hydrate the UI immediately.
ipcMain.handle('chat:openSession', async (_evt, sessionId) => {
  const row = getSession(sessionId);
  if (!row) return { messages: [] };
  await agentOpenSession({ jsonlPath: row.jsonlPath, systemPrompt: row.systemPrompt });
  return { session: row, messages: getMessages(sessionId) };
});

ipcMain.handle('chat:deleteSession', async (_evt, sessionId) => {
  if (sessionId) deleteSession(sessionId);
});

ipcMain.handle('chat:renameSession', async (_evt, { sessionId, title }) => {
  if (sessionId && typeof title === 'string') setSessionTitle(sessionId, title.slice(0, 100));
});

// Provider + model lookups for the Settings UI. Pi-ai's `getProviders()` is
// the source of truth; we intersect with this allowlist so OAuth /
// multi-credential providers (bedrock, vertex, azure, cloudflare, copilot,
// codex) are filtered out — our settings schema only carries a single API
// key, which is insufficient for those.
//
// 'openai-compatible' is our own generic local/remote endpoint — pi-ai's
// registry doesn't know it, so inject it after the registry filter.
const INJECTED_PROVIDERS = ['openai-compatible'];
ipcMain.handle('agent:listProviders', () => {
  const fromPi = getProviders().filter((slug) => SUPPORTED_PROVIDER_SLUGS.has(slug as any));
  return [...new Set([...fromPi, ...INJECTED_PROVIDERS])].sort();
});

ipcMain.handle('agent:listModels', (_evt, provider) => {
  if (!provider) return [];
  // openai-compatible has no static catalog — models come from the Validate
  // call (GET /v1/models) or are typed free-form. getModels returns [] here.
  return getModels(provider).map((m) => m.id).sort();
});

// Thinking levels supported by the given (provider, model), for the Settings
// dropdown. Returns ['off'] for non-reasoning / unknown models — the UI hides
// the control when the list has a single entry.
ipcMain.handle('agent:listThinkingLevels', (_evt, { provider, model }) => {
  return listThinkingLevels(provider, model);
});

// Validate an OpenAI-compatible endpoint by hitting `{baseUrl}/models` — no
// inference, no tokens. Confirms reachability + key validity and returns the
// model list to populate the dropdown. Scoped to openai-compatible only: that
// path is uniform (the user types a /v1 baseUrl), whereas built-in cloud
// providers have non-uniform /models paths + auth and pi already supplies their
// model lists. Security: a 5s timeout (no hang), and we never echo upstream
// response bodies back to the renderer.
ipcMain.handle('agent:validateConnection', async (_evt, { baseUrl, apiKey }) => {
  try {
    if (!baseUrl) return { ok: false, error: 'Base URL is required' };
    const base = String(baseUrl).replace(/\/+$/, '');
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    const body: any = await res.json();
    const models = (body.data ?? body.models ?? [])
      .map((m: any) => m.id ?? m.name)
      .filter(Boolean);
    return { ok: true, models: models.length ? models : undefined };
  } catch (err: any) {
    if (err?.name === 'TimeoutError') return { ok: false, error: 'Connection timed out' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
let watchDispatch: any = null;          // createWatcherDispatch instance, reset per workspace
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
      // Drawings carry no wiki-links — stat for the mtime only; the renderer
      // re-reads the JSON itself when it needs to reload an open canvas.
      if (isDrawingFile(p)) {
        const stat = await fs.stat(p);
        win.webContents.send('fs:changed', { type, path: p, mtime: stat.mtimeMs });
        continue;
      }
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

// Wire the watcher -> correlator -> pendingByPath. The correlator emits one of
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
  watchDispatch = createWatcherDispatch({
    correlator,
    isMdFile,
    isDrawingFile,
    statPath: (p) => fs.stat(p, { bigint: true }).catch(() => null),
    hashFile: hashFileOf,
    walkMarkdown: walkMarkdownPaths,
    isIgnored: isIgnoredWatchPath,
    getPending: (p) => pendingByPath.get(p),
    setPending: (p, type) => { pendingByPath.set(p, type); scheduleFlush(); },
    markTreeOnly: () => { pendingTreeOnly = true; scheduleFlush(); },
  });
}

// `.excalidraw` drawings get content events too (so an open drawing reloads
// when the agent rewrites it), but they bypass the rename correlator — that's
// .md-only machinery for re-keying the basename link index, which drawings
// aren't part of. A drawing rename therefore surfaces as unlink+add, which is
// fine: drawings carry no backlinks to rewrite.
function isDrawingFile(p) { return /\.excalidraw$/i.test(p); }

// Skip any event under a dotfile segment (mirrors buildTree's rule; excludes
// .git / .obsidian / .shockwave). @parcel/watcher's `ignore` globs are a perf
// hint that keeps the native watcher from reporting these at all; this
// predicate is the authoritative filter in case a backend reports them anyway.
function isIgnoredWatchPath(p) {
  if (!watcherRootDir) return true;
  const rel = path.relative(watcherRootDir, p);
  if (!rel || rel.startsWith('..')) return false;
  return rel.split(path.sep).some((seg) => isIgnoredSegment(seg));
}

// @parcel/watcher hands the callback a batch of events. The mapping from that
// batch to correlator/pending-state updates lives in `watcherDispatch.js` so
// main and the correlator tests exercise identical logic.
async function onParcelEvents(err, events) {
  if (err) {
    console.warn('[watcher] subscribe error', err?.message ?? err);
    return;
  }
  if (watchDispatch) await watchDispatch.handleBatch(events);
}

// Seed the correlator with current identity for every .md file in the
// workspace. Runs once on watchStart, before parcel delivers any events, so an
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
    try { await w.unsubscribe(); } catch { /* ignore teardown errors */ }
  }
  if (bookmarksWatcher) {
    const bw = bookmarksWatcher;
    bookmarksWatcher = null;
    try { await bw.unsubscribe(); } catch { /* ignore teardown errors */ }
  }
  correlator = null;
  watchDispatch = null;
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
  // @parcel/watcher is recursive and reports only changes after subscribe (no
  // initial scan), so seeding above is our only startup enumeration. The
  // `ignore` globs keep the native backend from reporting dotfile trees at all;
  // `isIgnoredWatchPath` in the callback is the authoritative backstop.
  currentWatcher = await parcelWatcher.subscribe(dirPath, onParcelEvents, {
    ignore: ['**/.*', '**/.*/**', '**/node_modules', '**/node_modules/**'],
  });

  // The main watcher ignores everything under `.shockwave/`, so changes to the
  // workspace file (sync pull, another machine, a hand edit) never reach the
  // renderer. Watch that dir separately and tell the renderer to re-read.
  // @parcel/watcher requires the directory to exist before subscribing, so
  // ensure it (it's created lazily on the first bookmarks/workspace write).
  const shockwaveDir = path.dirname(workspaceFilePath(dirPath));
  await fs.mkdir(shockwaveDir, { recursive: true }).catch(() => {});
  bookmarksWatcher = await parcelWatcher.subscribe(shockwaveDir, (err, events) => {
    if (err) return;
    const w = watcherWindowId != null ? BrowserWindow.fromId(watcherWindowId) : null;
    if (!w || w.isDestroyed()) return;
    for (const e of events) {
      if (path.basename(e.path) === 'workspace.json') { w.webContents.send('bookmarks:changed'); return; }
    }
  });
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

// Bridge for the open-file pi extension: validate the agent's path against the
// active workspace, then ask the renderer to open it in a new tab. Confined to
// the workspace (the agent's cwd); only display-able types open. The extension
// (cwd) ext list must stay in sync with the renderer's isOpenable (MediaView).
const OPENABLE_RE = /\.(md|markdown|mdx|txt|text|log|org|rst|tex|bib|csv|tsv|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|properties|xml|html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|c|h|cpp|hpp|cc|hh|cs|php|swift|m|mm|sh|bash|zsh|fish|ps1|bat|sql|graphql|gql|lua|pl|pm|r|dart|vue|svelte|astro|clj|cljs|ex|exs|erl|hs|ml|scala|groovy|gradle|proto|diff|patch|png|jpe?g|gif|webp|bmp|ico|avif|mp4|webm|mov|m4v|ogv|ogg|excalidraw)$/i;
installOpenFileBridge(async (relPath) => {
  if (!watcherRootDir) return { ok: false, error: 'No workspace is open.' };
  if (typeof relPath !== 'string' || !relPath.trim()) return { ok: false, error: 'No path provided.' };
  // Tolerate a leading `[cwd]/` and leading slashes; resolve against the workspace.
  const rel = relPath.replace(/^\[cwd\]\/?/, '').replace(/^\/+/, '');
  const abs = path.resolve(watcherRootDir, rel);
  if (abs !== watcherRootDir && !abs.startsWith(watcherRootDir + path.sep)) {
    return { ok: false, error: 'Path is outside the workspace.' };
  }
  if (!OPENABLE_RE.test(abs)) {
    return { ok: false, error: 'Only text, image, video, or .excalidraw files can be opened.' };
  }
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return { ok: false, error: 'Not a file.' };
  } catch {
    return { ok: false, error: `File not found: ${rel}` };
  }
  const win = senderWindow();
  if (!win) return { ok: false, error: 'App window is not available.' };
  win.webContents.send('agent:openFile', { path: abs });
  return { ok: true };
});

// Generate the CLI shims (firecrawl, playwright-cli) into <userData>/pi-agent/bin
// and put that dir on PATH so the agent's bash can invoke them by name. Runs
// every launch; failures are non-fatal (the agent simply won't find the CLIs).
(async () => {
  try {
    const binDir = path.join(app.getPath('userData'), 'pi-agent', 'bin');
    const { made } = await ensureCliShims({ cliToolsDir: cliToolsDir(), binDir, execPath: process.execPath });
    prependPath(binDir);
    // Playwright downloads its browser into a user-writable cache (no root). Point
    // it at app userData so `playwright-cli install-browser` and `open` agree on
    // location. Inherited by pi's bash → the shim's electron-as-node child. The
    // browser is fetched lazily by the agent on first use (the skill instructs it),
    // so users who never touch Playwright never pay the ~77 MB download.
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(app.getPath('userData'), 'ms-playwright');
    if (made.length) console.log('[cli-tools] shims ready on PATH:', made.join(', '));
  } catch (err: any) {
    console.warn('[cli-tools] shim setup failed:', err?.message ?? err);
  }
})();

app.whenReady().then(async () => {
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
  // Provision empty secret slots for enabled built-in skills BEFORE the window
  // opens, so the renderer hydrates with them present (no clobber race).
  await ensureBuiltinSecretSlots();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Update check: once shortly after launch (let the window mount + subscribe
  // first), then daily. Notify-only; failures are swallowed (offline is fine).
  setTimeout(() => { runUpdateCheck().catch(() => {}); }, 8000);
  setInterval(() => { runUpdateCheck().catch(() => {}); }, UPDATE_POLL_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
