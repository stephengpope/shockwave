// The open-file tool, registered IN-PROCESS via createAgentSession's
// `customTools`. Same rationale as agentTokensExtension.ts: pi SCANS
// <userDataDir>/pi-agent/extensions/ and loads whatever it finds, so a
// materialized extension file outlives the source that wrote it. Passing a
// ToolDefinition directly keeps the tool set equal to what codingAgent.ts names.
//
// The handler is injected from main.ts at startup (module scope, not `global`)
// so this module doesn't import back into main. It validates the path against
// the active workspace and pushes `agent:openFile` to the renderer.

let openFileHandler: ((relPath: string) => Promise<any>) | null = null;

// handler(relPath) → Promise<{ ok: true } | { ok: false, error: string }>.
export function installOpenFileBridge(handler) {
  openFileHandler = handler;
}

export const OPEN_FILE_TOOL: any = {
  name: 'open_file',
  label: 'Open File',
  description: "Opens a file in the Shockwave app UI in a new tab so the user can see it. Call this when the user asks you to open, show, or display a file. The path is relative to your working directory (the workspace root). Only files inside the workspace that the app can display (.md, images, video, .excalidraw) can be opened; opening does not modify the file.",
  promptSnippet: 'Open a file in the app UI (new tab) when the user asks to see it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path to the file to open, e.g. "Diagrams/Flow.excalidraw".' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    if (!openFileHandler) {
      return { content: [{ type: 'text', text: 'Open-file is unavailable.' }], isError: true };
    }
    try {
      const res = await openFileHandler(params.path);
      if (res?.ok) {
        return { content: [{ type: 'text', text: 'Opened ' + params.path + ' in the app.' }], details: { path: params.path } };
      }
      return { content: [{ type: 'text', text: res?.error || 'Could not open the file.' }], isError: true };
    } catch (e: any) {
      return { content: [{ type: 'text', text: 'Could not open the file: ' + (e?.message || e) }], isError: true };
    }
  },
};
