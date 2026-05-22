// Single runtime source of truth for the app's display name.
// Keep `productName` in package.json in sync (electron-builder uses it for .app/.dmg names at build time).
export const APP_NAME = 'Shockwave';

export const FILE_ACTIONS = Object.freeze({
  NEW_TAB: 'newTab',
  DUPLICATE: 'duplicate',
  REVEAL: 'reveal',
  RENAME: 'rename',
  DELETE: 'delete',
});

// Keep in sync with electron/main.js FOLDER_ACTIONS.
export const FOLDER_ACTIONS = Object.freeze({
  NEW_FILE: 'newFile',
  NEW_FOLDER: 'newFolder',
  REVEAL: 'reveal',
  RENAME: 'rename',
  DELETE: 'delete',
});

// Keep in sync with electron/main.js EDITOR_ACTIONS.
export const EDITOR_ACTIONS = Object.freeze({
  ADD_LINK: 'addLink',
  ADD_EXTERNAL_LINK: 'addExternalLink',
  INLINE_AI: 'inlineAi',
});

// Inline AI action ids dispatched to the main process. Must match
// electron/aiActions.js ACTIONS keys.
export const AI_ACTIONS = Object.freeze({
  INSERT: 'insert',
  REWRITE: 'rewrite',
});

export const SETTINGS_SECTIONS = Object.freeze({
  WORKSPACES: 'workspaces',
  APPEARANCE: 'appearance',
  AI: 'ai',
});

export const AI_PROVIDERS = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
});

export const THEME_MODES = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
});
