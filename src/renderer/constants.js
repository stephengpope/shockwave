// Cross-process constants live in src/shared/constants.js (single source of truth).
// Renderer-only constants stay here.
export {
  APP_NAME,
  FILE_ACTIONS,
  FOLDER_ACTIONS,
  EDITOR_ACTIONS,
  SUPPORTED_PROVIDER_SLUGS,
  DEFAULT_PROVIDER_SLUG,
} from '../shared/constants.js';

export const SETTINGS_SECTIONS = Object.freeze({
  APPEARANCE: 'appearance',
  WORKSPACES: 'workspaces',
  DAILY_NOTE: 'daily-note',
  TRANSCRIPTION: 'transcription',
  AGENT_LLM: 'agent-llm',
  AGENT_SKILLS: 'agent-skills',
  AGENT_WORKSPACE_SKILLS: 'agent-workspace-skills',
  AGENT_SECRETS: 'agent-secrets',
});

export const THEME_MODES = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
});

// Editor live-preview mode. 'live' renders headings, wiki-link widgets, image
// embeds, task checkboxes, etc. 'raw' shows the underlying markdown text only.
export const VIEW_MODES = Object.freeze({
  LIVE: 'live',
  RAW: 'raw',
});

// Status of the in-flight save lifecycle, surfaced on the editor status bar.
export const SAVE_STATES = Object.freeze({
  SAVED: 'saved',
  UNSAVED: 'unsaved',
});

// File-tree sort order. Folders are always pinned to the top in A→Z order;
// these values only re-order files within their folder.
export const TREE_SORT_ORDERS = Object.freeze({
  NAME_ASC: 'name-asc',
  NAME_DESC: 'name-desc',
  MODIFIED_DESC: 'modified-desc',
  MODIFIED_ASC: 'modified-asc',
  CREATED_DESC: 'created-desc',
  CREATED_ASC: 'created-asc',
});

export const TREE_SORT_LABELS = Object.freeze({
  [TREE_SORT_ORDERS.NAME_ASC]: 'Name (A → Z)',
  [TREE_SORT_ORDERS.NAME_DESC]: 'Name (Z → A)',
  [TREE_SORT_ORDERS.MODIFIED_DESC]: 'Modified (new → old)',
  [TREE_SORT_ORDERS.MODIFIED_ASC]: 'Modified (old → new)',
  [TREE_SORT_ORDERS.CREATED_DESC]: 'Created (new → old)',
  [TREE_SORT_ORDERS.CREATED_ASC]: 'Created (old → new)',
});
