// Assembles the coding-agent system prompt from its parts and re-exports the
// pieces the rest of main needs.
//
// Final prompt handed to pi as the custom system-prompt override:
//
//     <SOUL (workspace SOUL.md, else DEFAULT_SOUL)>
//
//     <SHOCKWAVE_HELPER (app mechanics + dynamic tool list)>
//
// pi then appends, on its own, at session boot:
//     → discovered AGENTS.md contents (CLAUDE.md filtered out — see codingAgent.ts)
//     → the enabled skills list
//     → "Current date: YYYY-MM-DD"   (date only, no time)
//
// So we do NOT add date, skills, or AGENTS.md here — pi owns those. This is baked
// once per session (the assembled string is part of the session cache key), so it
// never changes mid-conversation.

import { buildShockwaveHelper } from './helper.js';
import { readSoul } from './soul.js';
import { TOOL_CATALOG } from './tools.js';

export { readSoul, scaffoldNewProject, SOUL_FILENAME, AGENTS_FILENAME, DEFAULT_SOUL } from './soul.js';
export { buildShockwaveHelper } from './helper.js';
export { TOOL_CATALOG, formatToolList } from './tools.js';

// Build the full system prompt for the given workspace. Reads that workspace's
// SOUL.md (or the built-in default) and joins it above the Shockwave helper.
export async function assembleSystemPrompt(workspacePath: string | null | undefined): Promise<string> {
  const soul = await readSoul(workspacePath);
  const helper = buildShockwaveHelper({ tools: TOOL_CATALOG });
  return `${soul}\n\n${helper}`;
}
