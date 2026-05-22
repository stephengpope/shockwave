import { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, protocol, net } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import chokidar from 'chokidar';
import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { parseLinks } from './linkParser.js';
import { getAction } from './aiActions.js';
import { createRenameCorrelator } from './renameCorrelator.js';

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

// Custom `app://` scheme used to serve workspace files (images) to the
// renderer with webSecurity intact. Must be registered before app.ready.
// Renderer requests `app://media/<rel-path-from-vault>`; the handler resolves
// the file against the active vault root (watcherRootDir) and returns it
// via net.fetch(file://…). Path-traversal outside the vault is rejected.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

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

// Walk the workspace and collect lowercased basenames (without .md) for every
// .md file, excluding any paths in `excludePaths`. Used to enforce workspace-
// wide name uniqueness for files (case-insensitive), since the link index is
// keyed by basename and two files sharing a name break it.
async function collectMarkdownBasenamesLower(root, excludePaths = new Set()) {
  const out = new Set();
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (excludePaths.has(full)) continue;
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.add(e.name.slice(0, -3).toLowerCase());
      }
    }
  }
  await walk(root);
  return out;
}

// Auto-disambiguate a target path within a workspace. Appends " 1", " 2", ...
// to the basename until the resulting file is:
//   - not present at the literal destination path, AND
//   - its basename (case-insensitive) is not used by any other .md file in
//     the workspace (so the link index doesn't collapse two files into one key).
// `excludePaths` lets the caller exempt files that are about to be renamed
// out of the way (otherwise renaming Foo.md -> Foo.md would collide with itself).
async function uniqueInWorkspace({ workspaceRoot, destDir, base, ext, excludePaths = [] }) {
  const exclude = new Set(excludePaths);
  // For folders or files outside a workspace, fall back to same-dir uniqueness.
  if (!workspaceRoot || ext !== '.md') {
    return uniquePath(destDir, base, ext);
  }
  const taken = await collectMarkdownBasenamesLower(workspaceRoot, exclude);
  let candidateName = base;
  let i = 1;
  while (true) {
    const candidatePath = path.join(destDir, `${candidateName}${ext}`);
    let onDisk = false;
    try {
      await fs.access(candidatePath);
      onDisk = !exclude.has(candidatePath);
    } catch {
      onDisk = false;
    }
    if (!onDisk && !taken.has(candidateName.toLowerCase())) {
      return candidatePath;
    }
    candidateName = `${base} ${i}`;
    i++;
  }
}

// Walk a directory and return absolute paths of every .md file under it
// (recursively). Used so callers can exclude the contents of a file/folder
// being moved from the collision check (you can't collide with yourself).
async function listMarkdownPathsUnder(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  }
  try {
    const st = await fs.stat(root);
    if (st.isDirectory()) await walk(root);
    else if (root.toLowerCase().endsWith('.md')) out.push(root);
  } catch {}
  return out;
}

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
  const ext = name.endsWith('.md') ? '' : '.md';
  const base = ext ? name : name.slice(0, -3);
  const target = await uniquePath(dirPath, base, ext || '.md');
  await fs.writeFile(target, content, 'utf8');
  return target;
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
  // Reject moving a folder into itself or its own descendant.
  if (path.join(destDir, name).startsWith(srcPath + path.sep) || destDir === srcPath) {
    throw new Error('Cannot move a folder into itself.');
  }
  const isMd = name.toLowerCase().endsWith('.md');
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
    const inside = await listMarkdownPathsUnder(srcPath);
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

let currentWatcher = null;
let watcherRootDir = null;
let watcherWindowId = null;
let pendingByPath = new Map();    // path -> 'add' | 'change' | 'unlink'
let pendingTreeOnly = false;       // folder events or non-.md events
let flushTimer = null;
let correlator = null;             // createRenameCorrelator instance, reset per workspace
let renameQueue = [];              // emitted rename events awaiting flush to renderer

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
    } catch {
      // file may have been deleted between event and read
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
  if (!p.toLowerCase().endsWith('.md')) {
    pendingTreeOnly = true;
    scheduleFlush();
    return;
  }
  const [ino, hash] = await Promise.all([statInoOf(p), hashFileOf(p)]);
  correlator.onPathAppeared(p, ino, hash);
}

async function onChokidarChange(p) {
  if (!p.toLowerCase().endsWith('.md')) {
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
  if (!p.toLowerCase().endsWith('.md')) {
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
  const paths = await listMarkdownPathsUnder(root);
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
