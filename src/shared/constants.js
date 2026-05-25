// Shared across main + renderer. Single source of truth.
// Keep `productName` in package.json in sync (electron-builder uses it for .app/.dmg names at build time).
export const APP_NAME = 'Shockwave';

export const FILE_ACTIONS = Object.freeze({
  NEW_TAB: 'newTab',
  DUPLICATE: 'duplicate',
  REVEAL: 'reveal',
  RENAME: 'rename',
  DELETE: 'delete',
  TOGGLE_BOOKMARK: 'toggleBookmark',
});

export const FOLDER_ACTIONS = Object.freeze({
  NEW_FILE: 'newFile',
  NEW_FOLDER: 'newFolder',
  REVEAL: 'reveal',
  RENAME: 'rename',
  DELETE: 'delete',
});

export const EDITOR_ACTIONS = Object.freeze({
  ADD_LINK: 'addLink',
  ADD_EXTERNAL_LINK: 'addExternalLink',
  EDIT_EXTERNAL_LINK: 'editExternalLink',
  REMOVE_EXTERNAL_LINK: 'removeExternalLink',
  SEND_TO_AGENT: 'sendToAgent',
});

// Pi-ai providers that authenticate via a single bearer API key. Cloud/OAuth
// providers (bedrock, vertex, azure, cloudflare, github-copilot, openai-codex)
// are filtered out — our settings schema only carries a single API key.
export const SUPPORTED_PROVIDER_SLUGS = Object.freeze([
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'groq',
  'cerebras',
  'deepseek',
  'xai',
  'mistral',
  'fireworks',
  'together',
  'huggingface',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'moonshotai',
  'moonshotai-cn',
  'opencode',
  'opencode-go',
  'vercel-ai-gateway',
  'zai',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp',
]);

export const DEFAULT_PROVIDER_SLUG = 'anthropic';
