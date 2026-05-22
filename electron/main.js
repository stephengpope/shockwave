import { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import chokidar from 'chokidar';
import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { parseLinks } from './linkParser.js';
import { getAction } from './aiActions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep in sync with src/constants.js APP_NAME and package.json productName.
const APP_NAME = 'Shockwave';
app.setName(APP_NAME);

const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

const DEFAULT_SETTINGS = {
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: 'system' },
  ai: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKey: '',
    includeContextByDefault: false,
  },
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function readSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      appearance: { ...DEFAULT_SETTINGS.appearance, ...(parsed.appearance ?? {}) },
      ai: { ...DEFAULT_SETTINGS.ai, ...(parsed.ai ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(obj) {
  const file = settingsPath();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// Keep in sync with src/constants.js FILE_ACTIONS.
const FILE_ACTIONS = Object.freeze({
  NEW_TAB: 'newTab',
  DUPLICATE: 'duplicate',
  REVEAL: 'reveal',
  RENAME: 'rename',
  DELETE: 'delete',
});

// Keep in sync with src/constants.js EDITOR_ACTIONS.
const EDITOR_ACTIONS = Object.freeze({
  ADD_LINK: 'addLink',
  ADD_EXTERNAL_LINK: 'addExternalLink',
  INLINE_AI: 'inlineAi',
});

// Keep in sync with src/constants.js FOLDER_ACTIONS.
const FOLDER_ACTIONS = Object.freeze({
  NEW_FILE: 'newFile',
  NEW_FOLDER: 'newFolder',
  REVEAL: 'reveal',
  RENAME: 'rename',
  DELETE: 'delete',
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_NAME,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
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
        return { id: fullPath, name: e.name };
      })
  );
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

async function readAllMarkdown(dirPath, out = []) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isSymbolicLink()) continue;
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      await readAllMarkdown(full, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      try {
        const [content, stat] = await Promise.all([
          fs.readFile(full, 'utf8'),
          fs.stat(full),
        ]);
        const outgoingLinks = parseLinks(content);
        out.push({ path: full, mtime: stat.mtimeMs, outgoingLinks });
      } catch {
        // swallow per-file errors so one bad file doesn't kill the vault load
      }
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
});

async function uniquePath(dirPath, base, ext) {
  let candidate = path.join(dirPath, `${base}${ext}`);
  let i = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dirPath, `${base} ${i}${ext}`);
      i++;
    } catch {
      return candidate;
    }
  }
}

ipcMain.handle('fs:createFile', async (_evt, { dirPath, name, content = '' }) => {
  const ext = name.endsWith('.md') ? '' : '.md';
  const base = ext ? name : name.slice(0, -3);
  const target = await uniquePath(dirPath, base, ext || '.md');
  await fs.writeFile(target, content, 'utf8');
  return target;
});

ipcMain.handle('fs:renameFile', async (_evt, { fromPath, toName }) => {
  const dir = path.dirname(fromPath);
  const finalName = toName.endsWith('.md') ? toName : `${toName}.md`;
  const target = path.join(dir, finalName);
  if (target === fromPath) return target;
  let exists = false;
  try {
    await fs.access(target);
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (exists) {
    throw new Error(`A file named "${finalName}" already exists in this folder.`);
  }
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
  let entries = [];
  try {
    entries = (await fs.readdir(folderPath)).filter((n) => !n.startsWith('.'));
  } catch {
    entries = [];
  }
  const isEmpty = entries.length === 0;
  const result = await dialog.showMessageBox(win, {
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
  const result = await dialog.showMessageBox(win, {
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

ipcMain.handle('context:fileMenu', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  return new Promise((resolve) => {
    let chosen = null;
    const menu = Menu.buildFromTemplate([
      { label: 'Open in new tab', click: () => { chosen = FILE_ACTIONS.NEW_TAB; } },
      { label: 'Duplicate', click: () => { chosen = FILE_ACTIONS.DUPLICATE; } },
      { type: 'separator' },
      { label: revealLabel(), click: () => { chosen = FILE_ACTIONS.REVEAL; } },
      { type: 'separator' },
      { label: 'Rename', click: () => { chosen = FILE_ACTIONS.RENAME; } },
      { label: 'Delete', click: () => { chosen = FILE_ACTIONS.DELETE; } },
    ]);
    menu.on('menu-will-close', () => {
      setImmediate(() => resolve(chosen));
    });
    menu.popup({ window: win });
  });
});

ipcMain.handle('context:folderMenu', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  return new Promise((resolve) => {
    let chosen = null;
    const menu = Menu.buildFromTemplate([
      { label: 'New file', click: () => { chosen = FOLDER_ACTIONS.NEW_FILE; } },
      { label: 'New folder', click: () => { chosen = FOLDER_ACTIONS.NEW_FOLDER; } },
      { type: 'separator' },
      { label: revealLabel(), click: () => { chosen = FOLDER_ACTIONS.REVEAL; } },
      { type: 'separator' },
      { label: 'Rename', click: () => { chosen = FOLDER_ACTIONS.RENAME; } },
      { label: 'Delete', click: () => { chosen = FOLDER_ACTIONS.DELETE; } },
    ]);
    menu.on('menu-will-close', () => {
      setImmediate(() => resolve(chosen));
    });
    menu.popup({ window: win });
  });
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

ipcMain.handle('fs:moveItem', async (_evt, { srcPath, destDir }) => {
  const name = path.basename(srcPath);
  const target = path.join(destDir, name);
  if (target === srcPath) return target;
  // Reject moving a folder into itself or its own descendant.
  if (target.startsWith(srcPath + path.sep)) {
    throw new Error('Cannot move a folder into itself.');
  }
  let exists = false;
  try {
    await fs.access(target);
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (exists) {
    throw new Error(`"${name}" already exists in this folder.`);
  }
  await fs.rename(srcPath, target);
  return target;
});

ipcMain.handle('fs:renameFolder', async (_evt, { fromPath, toName }) => {
  const dir = path.dirname(fromPath);
  const finalName = toName.trim();
  if (!finalName) throw new Error('Name cannot be empty');
  const target = path.join(dir, finalName);
  if (target === fromPath) return target;
  let exists = false;
  try {
    await fs.access(target);
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (exists) {
    throw new Error(`A folder named "${finalName}" already exists in this location.`);
  }
  await fs.rename(fromPath, target);
  return target;
});

ipcMain.handle('context:editorMenu', async (evt, { hasSelection } = {}) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  return new Promise((resolve) => {
    let chosen = null;
    const template = [];
    if (hasSelection) {
      template.push(
        { label: 'Add link',          click: () => { chosen = EDITOR_ACTIONS.ADD_LINK; } },
        { label: 'Add external link', click: () => { chosen = EDITOR_ACTIONS.ADD_EXTERNAL_LINK; } },
        { type: 'separator' },
      );
    }
    template.push(
      {
        label: hasSelection ? 'Rewrite with AI' : 'Insert AI Response',
        click: () => { chosen = EDITOR_ACTIONS.INLINE_AI; },
      },
      { type: 'separator' },
    );
    template.push(
      { role: 'cut',   enabled: hasSelection },
      { role: 'copy',  enabled: hasSelection },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    );
    const menu = Menu.buildFromTemplate(template);
    menu.on('menu-will-close', () => {
      setImmediate(() => resolve(chosen));
    });
    menu.popup({ window: win });
  });
});

ipcMain.handle('settings:read', async () => {
  return readSettings();
});

ipcMain.handle('settings:write', async (_evt, obj) => {
  await writeSettings(obj);
});

// ---- AI streaming ----
//
// One in-flight request per requestId. The renderer sends:
//   { requestId, action: 'ask'|'rewrite', params: {...} }
// The action registry (electron/aiActions.js) maps that to a system prompt
// and a user message; everything else (streaming, cancellation, error
// reporting) is action-agnostic.

const inflightAi = new Map(); // requestId -> AbortController

function modelFactoryFor(provider) {
  return provider === 'openai' ? createOpenAI : createAnthropic;
}

ipcMain.handle('ai:run', async (evt, { requestId, action: actionId, params }) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  const send = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  try {
    const action = getAction(actionId);
    if (!action) {
      send('ai:error', { requestId, message: `Unknown AI action: ${actionId}` });
      return;
    }

    const settings = await readSettings();
    const { provider, model, apiKey } = settings.ai ?? {};
    if (!apiKey) {
      send('ai:error', { requestId, message: 'No API key set. Open Settings → AI / Coding Agent to add one.' });
      return;
    }
    if (!model) {
      send('ai:error', { requestId, message: 'No model set. Open Settings → AI / Coding Agent to choose one.' });
      return;
    }

    const client = modelFactoryFor(provider)({ apiKey });

    const userMessage = action.buildUserMessage(params ?? {});

    const controller = new AbortController();
    inflightAi.set(requestId, controller);

    let errorMessage = null;

    const result = streamText({
      model: client(model),
      system: action.systemPrompt,
      prompt: userMessage,
      abortSignal: controller.signal,
      onError: ({ error }) => {
        errorMessage = error?.message ?? String(error);
      },
    });

    try {
      for await (const delta of result.textStream) {
        if (controller.signal.aborted) break;
        send('ai:chunk', { requestId, delta });
      }
    } catch (err) {
      errorMessage = errorMessage ?? (err?.message ?? String(err));
    }

    if (!controller.signal.aborted) {
      if (errorMessage) send('ai:error', { requestId, message: errorMessage });
      else send('ai:done', { requestId });
    }
    inflightAi.delete(requestId);
  } catch (err) {
    send('ai:error', { requestId, message: err?.message ?? String(err) });
    inflightAi.delete(requestId);
  }
});

ipcMain.handle('ai:cancel', async (_evt, { requestId }) => {
  const ctrl = inflightAi.get(requestId);
  if (ctrl) ctrl.abort();
  inflightAi.delete(requestId);
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
// One watcher per app. Per CLAUDE.md "Link index": main pre-parses .md files
// and ships {path, mtime, outgoingLinks} rows to the renderer. The watcher
// reuses that same pattern for incremental updates — see parseLinks above.
//
// Events are coalesced per-path within WATCH_DEBOUNCE_MS so a burst of writes
// (atomic rename, multi-file save) collapses to one notification per path.

const WATCH_DEBOUNCE_MS = 150;
let currentWatcher = null;
let watcherRootDir = null;
let watcherWindowId = null;
let pendingByPath = new Map();    // path -> 'add' | 'change' | 'unlink'
let pendingTreeOnly = false;       // folder events or non-.md events
let flushTimer = null;

function senderWindow() {
  if (watcherWindowId == null) return null;
  const win = BrowserWindow.fromId(watcherWindowId);
  return win && !win.isDestroyed() ? win : null;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushWatcher, WATCH_DEBOUNCE_MS);
}

async function flushWatcher() {
  flushTimer = null;
  const win = senderWindow();
  const entries = [...pendingByPath.entries()];
  const treeOnly = pendingTreeOnly;
  pendingByPath.clear();
  pendingTreeOnly = false;
  if (!win) return;

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
    } catch {
      // file may have been deleted between event and read
    }
  }

  if (treeOnly && entries.length === 0) {
    win.webContents.send('fs:changed', { type: 'tree' });
  }
}

function recordFileEvent(type, p) {
  if (p.toLowerCase().endsWith('.md')) {
    const prev = pendingByPath.get(p);
    if (type === 'unlink') {
      pendingByPath.set(p, 'unlink');
    } else if (type === 'add') {
      pendingByPath.set(p, prev === 'unlink' ? 'change' : 'add');
    } else {
      // change
      pendingByPath.set(p, prev === 'add' ? 'add' : 'change');
    }
  } else {
    pendingTreeOnly = true;
  }
  scheduleFlush();
}

async function stopWatcher() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  pendingByPath.clear();
  pendingTreeOnly = false;
  if (currentWatcher) {
    const w = currentWatcher;
    currentWatcher = null;
    try { await w.close(); } catch { /* ignore close errors */ }
  }
  watcherRootDir = null;
  watcherWindowId = null;
}

ipcMain.handle('fs:watchStart', async (evt, dirPath) => {
  await stopWatcher();
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  watcherWindowId = win.id;
  watcherRootDir = dirPath;
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
    .on('add', (p) => recordFileEvent('add', p))
    .on('change', (p) => recordFileEvent('change', p))
    .on('unlink', (p) => recordFileEvent('unlink', p))
    .on('addDir', () => { pendingTreeOnly = true; scheduleFlush(); })
    .on('unlinkDir', () => { pendingTreeOnly = true; scheduleFlush(); });
});

ipcMain.handle('fs:watchStop', stopWatcher);

app.on('before-quit', () => { stopWatcher(); });

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

app.whenReady().then(() => {
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
