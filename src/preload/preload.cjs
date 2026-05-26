const { contextBridge, ipcRenderer, webUtils } = require('electron');

// =============================================================================
// JSDoc types for the window.api surface.
//
// This preload file is the ONLY mapping between renderer-side `window.api.foo`
// calls and main-process `ipcMain.handle('foo', ...)` handlers. The types below
// document each method's contract so callers (and Claude) don't have to read
// the main handler to learn the input/output shape. The types are advisory —
// runtime arguments are NOT validated here.
//
// When adding a new IPC method:
//   1. Register the handler in main.js
//   2. Add the binding here
//   3. Add a JSDoc @typedef for any new payload shape and @param/@returns above
//      the binding.
// =============================================================================

/**
 * A node in the workspace file tree. Folders have `children`; files don't.
 * @typedef {Object} TreeNode
 * @property {string} id              Absolute path on disk (also used as React key).
 * @property {string} name            Basename (e.g. "Foo.md" or "Notes").
 * @property {number} mtime           File modification time (ms since epoch).
 * @property {number} ctime           File creation time (ms since epoch).
 * @property {TreeNode[]} [children]  Present iff the node is a folder.
 */

/**
 * A parsed wiki-link extracted from a markdown file.
 * @typedef {Object} ParsedLink
 * @property {string} target   Lowercased basename (no extension, no folder).
 * @property {string} [alias]  Display text after `|` if present.
 * @property {string} [heading] Heading after `#` if present.
 * @property {number} startPos Character offset of the `[[`.
 * @property {number} endPos   Character offset just past the `]]`.
 */

/**
 * One markdown file with its parsed links + mtime, as shipped from main at
 * workspace load. The renderer uses this to seed its in-memory link index.
 * @typedef {Object} ParsedFile
 * @property {string} path
 * @property {number} mtime
 * @property {ParsedLink[]} outgoingLinks
 */

/**
 * Events shipped to the renderer over `fs:changed`. Discriminated by `type`.
 * @typedef {Object} FsAddOrChangeEvent
 * @property {'add'|'change'} type
 * @property {string} path
 * @property {number} mtime
 * @property {ParsedLink[]} outgoingLinks
 *
 * @typedef {Object} FsUnlinkEvent
 * @property {'unlink'} type
 * @property {string} path
 *
 * @typedef {Object} FsRenameEvent
 * @property {'rename'} type
 * @property {string} oldPath
 * @property {string} newPath
 * @property {number} mtime
 * @property {ParsedLink[]} outgoingLinks
 *
 * @typedef {Object} FsTreeEvent
 * @property {'tree'} type            Non-.md or folder change; renderer should refetch the tree.
 *
 * @typedef {FsAddOrChangeEvent|FsUnlinkEvent|FsRenameEvent|FsTreeEvent} FsChangedEvent
 */

/**
 * An installed skill. Returned by skills.list().
 * @typedef {Object} InstalledSkill
 * @property {string} folderName   Folder under the on-disk skill library.
 * @property {string} name         Display name from SKILL.md frontmatter.
 * @property {string} description  Frontmatter description (used for picker).
 */

/**
 * Returns a function that detaches the listener. Always call on unmount.
 * @typedef {() => void} Unsubscribe
 */

contextBridge.exposeInMainWorld('api', {
  // ---- Dialogs ------------------------------------------------------------

  /** Open a folder picker. @returns {Promise<string|null>} chosen absolute path, or null if cancelled. */
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  // ---- Filesystem reads ---------------------------------------------------

  /** @param {string} dirPath @returns {Promise<TreeNode[]>} Top-level tree under dirPath (folders A→Z then files). */
  readTree: (dirPath) => ipcRenderer.invoke('fs:readTree', dirPath),
  /** @param {string} dirPath @returns {Promise<ParsedFile[]>} Every .md under dirPath with parsed links + mtime. */
  readAllMarkdown: (dirPath) => ipcRenderer.invoke('fs:readAllMarkdown', dirPath),
  /** @param {string} filePath @returns {Promise<string>} UTF-8 contents. Throws on missing/EACCES. */
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  /** @param {string} p @returns {Promise<boolean>} True if the path exists. */
  pathExists: (p) => ipcRenderer.invoke('fs:pathExists', p),

  // ---- Filesystem writes --------------------------------------------------

  /** @param {string} filePath @param {string} content @returns {Promise<void>} */
  writeFile: (filePath, content) =>
    ipcRenderer.invoke('fs:writeFile', { filePath, content }),
  /**
   * Create a new file. Main auto-disambiguates the basename workspace-wide.
   * @param {string} dirPath @param {string} name @param {string} [content='']
   * @returns {Promise<string>} Final absolute path used (may differ from requested if collided).
   */
  createFile: (dirPath, name, content) =>
    ipcRenderer.invoke('fs:createFile', { dirPath, name, content }),
  /**
   * Rename a file. Main auto-disambiguates the new basename workspace-wide.
   * @param {string} fromPath @param {string} toName @returns {Promise<string>} Final new absolute path.
   */
  renameFile: (fromPath, toName) =>
    ipcRenderer.invoke('fs:renameFile', { fromPath, toName }),
  /** @param {string} filePath @returns {Promise<string>} Path of the new duplicate. */
  duplicateFile: (filePath) => ipcRenderer.invoke('fs:duplicateFile', filePath),
  /**
   * Write a pasted/dropped image into the workspace.
   * @param {string} dirPath @param {ArrayBuffer|Uint8Array} bytes @param {string} ext (with leading dot) @param {string} baseName
   * @returns {Promise<string>} Final absolute path on disk.
   */
  writeImage: (dirPath, bytes, ext, baseName) =>
    ipcRenderer.invoke('fs:writeImage', { dirPath, bytes, ext, baseName }),
  /** Move file to OS trash. @param {string} filePath @returns {Promise<boolean>} True if removed. */
  trashFile: (filePath) => ipcRenderer.invoke('fs:trashFile', filePath),
  /** Move folder to OS trash (requires user confirmation in main). @param {string} folderPath @returns {Promise<boolean>} */
  trashFolder: (folderPath) => ipcRenderer.invoke('fs:trashFolder', folderPath),

  // ---- Folder ops ---------------------------------------------------------

  /** @param {string} dirPath @param {string} [name='New folder'] @returns {Promise<string>} New folder absolute path. */
  createFolder: (dirPath, name) => ipcRenderer.invoke('fs:createFolder', { dirPath, name }),
  /** @param {string} dirPath @returns {Promise<void>} Recursive mkdir. */
  ensureDir: (dirPath) => ipcRenderer.invoke('fs:ensureDir', dirPath),
  /** @param {string} fromPath @param {string} toName @returns {Promise<string>} Final new absolute path. */
  renameFolder: (fromPath, toName) => ipcRenderer.invoke('fs:renameFolder', { fromPath, toName }),
  /** @param {string} srcPath @param {string} destDir @returns {Promise<string>} New absolute path after move. */
  moveItem: (srcPath, destDir) => ipcRenderer.invoke('fs:moveItem', { srcPath, destDir }),

  // ---- Shell --------------------------------------------------------------

  /** @param {string} filePath @returns {Promise<void>} Show in Finder/Explorer/etc. */
  revealInFolder: (filePath) => ipcRenderer.invoke('shell:revealInFolder', filePath),
  /** Opens a URL in the system browser. Validates scheme in main. @param {string} url @returns {Promise<void>} */
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ---- Native context menus ----------------------------------------------

  /**
   * Pop up the right-click menu for a file row in the sidebar.
   * @param {{ isMd?: boolean, isBookmarked?: boolean }} opts
   * @returns {Promise<string|null>} The chosen FILE_ACTIONS value, or null if dismissed.
   */
  showFileContextMenu: (opts) => ipcRenderer.invoke('context:fileMenu', opts),
  /** @returns {Promise<string|null>} The chosen FOLDER_ACTIONS value, or null. */
  showFolderContextMenu: () => ipcRenderer.invoke('context:folderMenu'),
  /**
   * Pop up the right-click menu inside the editor.
   * @param {{ hasSelection?: boolean, hasFilePath?: boolean, hasLink?: boolean }} opts
   * @returns {Promise<string|null>} The chosen EDITOR_ACTIONS value, or null.
   */
  showEditorContextMenu: (opts) => ipcRenderer.invoke('context:editorMenu', opts),

  // ---- File watcher (push) ------------------------------------------------

  /** Start watching `dirPath` for `fs:changed` events. @param {string} dirPath @returns {Promise<void>} */
  watchStart: (dirPath) => ipcRenderer.invoke('fs:watchStart', dirPath),
  /** Stop the current watcher. @returns {Promise<void>} */
  watchStop: () => ipcRenderer.invoke('fs:watchStop'),
  /** @param {(evt: FsChangedEvent) => void} cb @returns {Unsubscribe} */
  onFsChanged: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('fs:changed', listener);
    return () => ipcRenderer.removeListener('fs:changed', listener);
  },

  // ---- Bookmarks (per-workspace, persisted to .shockwave/bookmarks.json) -

  bookmarks: {
    /** @param {string} workspacePath @returns {Promise<{ version: number, paths: string[] }>} Workspace-relative POSIX paths. */
    read: (workspacePath) => ipcRenderer.invoke('bookmarks:read', workspacePath),
    /** @param {string} workspacePath @param {string[]} paths Workspace-relative POSIX paths. @returns {Promise<void>} */
    write: (workspacePath, paths) => ipcRenderer.invoke('bookmarks:write', { workspacePath, paths }),
  },

  // ---- Settings -----------------------------------------------------------

  settings: {
    /** @returns {Promise<object>} Full merged settings; secrets decrypted. */
    read: () => ipcRenderer.invoke('settings:read'),
    /** Shallow-merges patch onto the on-disk settings; secrets are encrypted before write.
     *  @param {object} obj @returns {Promise<void>} */
    write: (obj) => ipcRenderer.invoke('settings:write', obj),
  },

  // ---- Theme --------------------------------------------------------------

  theme: {
    /** @returns {Promise<{ dark: boolean }>} */
    getInitial: () => ipcRenderer.invoke('theme:getInitial'),
    /** @param {(payload: { dark: boolean }) => void} cb @returns {Unsubscribe} */
    onSystemChange: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('theme:systemChanged', listener);
      return () => ipcRenderer.removeListener('theme:systemChanged', listener);
    },
  },

  // ---- Skill library ------------------------------------------------------

  skills: {
    /** @returns {Promise<InstalledSkill[]>} Installed skills under <userData>/pi-agent/skill-library. */
    list: () => ipcRenderer.invoke('skills:list'),
    /** @returns {Promise<string>} Absolute path of the skill library directory. */
    libraryDir: () => ipcRenderer.invoke('skills:libraryDir'),
    /** Open a folder picker and import the chosen folder as a skill.
     *  @returns {Promise<string|null>} Destination folder path, or null if cancelled. */
    importPicker: () => ipcRenderer.invoke('skills:importPicker'),
    /** Import a folder as a skill (must contain SKILL.md).
     *  @param {string} srcPath @returns {Promise<string>} Destination folder path. */
    importFromPath: (srcPath) => ipcRenderer.invoke('skills:importFromPath', srcPath),
    /** Remove an installed skill folder. @param {string} folderName @returns {Promise<void>} */
    remove: (folderName) => ipcRenderer.invoke('skills:remove', folderName),
    /** Resolves the absolute disk path of a drag-dropped File (via Electron's
     *  webUtils.getPathForFile). Returns '' for File objects not backed by disk.
     *  @param {File} file @returns {string} */
    pathForFile: (file) => webUtils.getPathForFile(file),
  },

  // ---- Coding agent (pi) --------------------------------------------------

  agent: {
    /** Send a prompt to the agent. Resolves when pi's `agent_end` fires (or the call rejects on setup error).
     *  Images are pi `ImageContent[]` shapes (data URLs decoded by main).
     *  @param {string} text @param {Array<{ type:'image', source: any }>} [images] @returns {Promise<void>} */
    send: (text, images) => ipcRenderer.invoke('agent:send', { text, images }),
    /** Abort the running agent. Resolves once teardown completes. @returns {Promise<void>} */
    abort: () => ipcRenderer.invoke('agent:abort'),
    /** Tear down the current session. Next send creates a fresh one. @returns {Promise<void>} */
    reset: () => ipcRenderer.invoke('agent:reset'),
    /** @returns {Promise<string>} The DEFAULT_AGENT_SYSTEM_PROMPT constant, for the "Reset to default" UI. */
    getDefaultSystemPrompt: () => ipcRenderer.invoke('agent:getDefaultSystemPrompt'),
    /** @returns {Promise<Array<{ slug: string, label: string }>>} Available LLM providers. */
    listProviders: () => ipcRenderer.invoke('agent:listProviders'),
    /** @param {string} provider @returns {Promise<Array<{ id: string, label: string }>>} Models for that provider. */
    listModels: (provider) => ipcRenderer.invoke('agent:listModels', provider),
    /** Subscribe to pi event stream (agent_start/end, turn_*, message_update, tool_execution_*, etc.).
     *  @param {(evt: any) => void} cb @returns {Unsubscribe} */
    onEvent: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    },
    /** Fires when the agent fails to start (no key, bad model, etc.).
     *  @param {(payload: { message: string }) => void} cb @returns {Unsubscribe} */
    onError: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('agent:error', listener);
      return () => ipcRenderer.removeListener('agent:error', listener);
    },
  },

  // ---- Voice transcription (AssemblyAI streaming) ------------------------
  //
  // The long-lived AssemblyAI API key sits encrypted in settings and never
  // crosses this bridge. The renderer only ever asks for a 60s temp token
  // that authenticates the WebSocket connection to AssemblyAI's /v3/ws.

  voice: {
    /** Mint a fresh 60-second AssemblyAI streaming token using the configured key.
     *  @returns {Promise<{ token?: string, error?: string }>} */
    getToken: () => ipcRenderer.invoke('voice:getToken'),
  },
});
