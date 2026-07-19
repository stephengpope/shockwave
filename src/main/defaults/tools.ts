// Single source of truth for the agent's tool set.
//
// `TOOL_CATALOG` is BOTH the allowlist passed to pi (`tools:` in
// createAgentSession) and the list rendered into the prompt's "Available tools"
// section. One list, so the prompt can't claim a tool pi doesn't have — or miss
// one it does.
//
// That drift was real: the catalog listed 7 while pi ran 8. pi discovers
// extensions by SCANNING <userDataDir>/pi-agent/extensions/ (unconditional —
// see discoverAndLoadExtensions in pi's loader), so a `resolve_link` extension
// file written by a build we'd since deleted the source for kept registering
// itself. The allowlist is what bounds the set now: a stray extension can still
// load, but its tool is filtered out unless it's named here.
//
// `origin` says where each tool comes from:
//   'builtin' → pi's own (createAllToolDefinitions instantiates all 7; the
//               allowlist selects. pi's own default is only read/bash/edit/write)
//   'custom'  → ours, passed in-process as `customTools` from codingAgent.ts

export interface ToolDescriptor {
  name: string;
  desc: string;
  origin: 'builtin' | 'custom';
}

export const TOOL_CATALOG: ToolDescriptor[] = [
  { name: 'read', origin: 'builtin', desc: 'Read file contents.' },
  { name: 'bash', origin: 'builtin', desc: 'Execute bash commands. Use for running programs and git — prefer grep/find/ls for searching.' },
  { name: 'edit', origin: 'builtin', desc: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call.' },
  { name: 'write', origin: 'builtin', desc: 'Create or overwrite files.' },
  { name: 'grep', origin: 'builtin', desc: 'Search file contents for a pattern (regex or literal), with optional glob filter and context lines. Respects .gitignore. Use this instead of shelling out to grep.' },
  { name: 'find', origin: 'builtin', desc: 'Find files by glob pattern (e.g. `**/*.md`). Respects .gitignore.' },
  { name: 'ls', origin: 'builtin', desc: 'List directory contents.' },
  { name: 'list_agent_secrets', origin: 'custom', desc: 'List available API tokens by name and purpose.' },
  { name: 'get_agent_secret', origin: 'custom', desc: 'Read one API token by name.' },
  { name: 'open_file', origin: 'custom', desc: 'Open a file in the app UI (a new tab) so the user can see it. Use when the user asks you to open, show, or display a file. The path is workspace-relative; only files the app can display (.md, images, video, .excalidraw) can be opened.' },
];

// The allowlist handed to pi as `tools:`. Covers builtin AND custom names —
// pi filters both against it (see _refreshToolRegistry in agent-session.js).
export const ACTIVE_TOOL_NAMES: string[] = TOOL_CATALOG.map((t) => t.name);

// Render the catalog as the markdown bullet list used in the "Available tools"
// section of the helper prompt.
export function formatToolList(tools: ToolDescriptor[] = TOOL_CATALOG): string {
  return tools.map((t) => `- \`${t.name}\`: ${t.desc}`).join('\n');
}
