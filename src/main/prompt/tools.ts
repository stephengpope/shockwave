// Single source of truth for the tool list rendered into the Shockwave helper
// prompt. These MIRROR the tools actually wired into the pi session in
// `codingAgent.ts`:
//   - read / bash / edit / write  → pi built-ins
//   - list_agent_secrets / get_agent_secret → agentTokensExtension
//   - open_file → openFileExtension
// When you add or remove a wired extension/tool over there, update this list so
// the prompt's "Available tools" section stays truthful. Pi does NOT auto-inject
// a tool list when a custom system prompt is supplied, which is why we render it
// ourselves from this catalog.

export interface ToolDescriptor {
  name: string;
  desc: string;
}

export const TOOL_CATALOG: ToolDescriptor[] = [
  { name: 'read', desc: 'Read file contents.' },
  { name: 'bash', desc: 'Execute bash commands (ls, grep, find, etc.).' },
  { name: 'edit', desc: 'Make precise file edits with exact text replacement, including multiple disjoint edits in one call.' },
  { name: 'write', desc: 'Create or overwrite files.' },
  { name: 'list_agent_secrets', desc: 'List available API tokens by name and purpose.' },
  { name: 'get_agent_secret', desc: 'Read one API token by name.' },
  { name: 'open_file', desc: 'Open a file in the app UI (a new tab) so the user can see it. Use when the user asks you to open, show, or display a file. The path is workspace-relative; only files the app can display (.md, images, video, .excalidraw) can be opened.' },
];

// Render the catalog as the markdown bullet list used in the "Available tools"
// section of the helper prompt.
export function formatToolList(tools: ToolDescriptor[] = TOOL_CATALOG): string {
  return tools.map((t) => `- \`${t.name}\`: ${t.desc}`).join('\n');
}
