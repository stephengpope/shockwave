// The agent-tokens tools, registered IN-PROCESS via createAgentSession's
// `customTools`. No file is written to disk and no `global` is touched.
//
// This used to materialize a plain-JS extension under <userDataDir>/pi-agent/
// extensions/ and reach back into main through `global.__SHOCKWAVE_AGENT_TOKENS`.
// That shape had a failure mode: pi discovers extensions by SCANNING that
// directory (see discoverAndLoadExtensions in pi's loader), so a file written by
// an older build outlives the source that created it and keeps registering its
// tool against a bridge that no longer exists. A retired `resolve_link`
// extension did exactly that. Passing ToolDefinitions directly means the tool
// set is whatever `codingAgent.ts` names — nothing more.
//
// The secret getters are still injected (from main.ts, at startup) rather than
// imported, to keep this module free of a circular import back into main. They
// live in module scope now instead of on `global`.

let getSecretsFn: (() => Promise<any[]>) | null = null;
let getTokenFn: ((name: string) => Promise<string>) | null = null;

// getSecrets — returns the full decrypted secrets array (used for metadata only;
//   token values are never surfaced from it).
// getToken(name) — returns a USABLE credential string: the static token, or a
//   freshly-refreshed OAuth access token. Throws with a user-facing message when
//   the name is unknown or an OAuth connection needs reconnecting.
export function installAgentTokensBridge(getSecrets, getToken) {
  getSecretsFn = getSecrets;
  getTokenFn = getToken;
}

// Metadata only — never token values.
async function readMeta() {
  if (!getSecretsFn) return [];
  try {
    const secrets = (await getSecretsFn()) || [];
    return secrets.map((s) => ({
      name: s.name,
      description: s.description || '',
      kind: s.oauth ? 'oauth' : 'static',
      provider: s.oauth ? s.oauth.provider : undefined,
      scopes: s.oauth ? (s.oauth.scopes || []) : undefined,
      status: s.oauth ? s.oauth.status : undefined,
    }));
  } catch {
    return [];
  }
}

const listAgentSecrets: any = {
  name: 'list_agent_secrets',
  label: 'List Agent Secrets',
  description: "Lists credentials available to you. For each: its name, a short description, its kind ('static' API token or 'oauth' connection), and for OAuth connections the provider, granted scopes, and connection status. Never returns the value — call get_agent_secret for a usable credential. Use this to check whether a credential you need is already on file before asking the user for one.",
  promptSnippet: 'List available credentials by name, kind, and purpose.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    const items = await readMeta();
    if (items.length === 0) {
      return { content: [{ type: 'text', text: 'No credentials are currently stored.' }], details: { count: 0, names: [] } };
    }
    const text = items.map((s) => {
      let line = '- ' + s.name + ' [' + s.kind + ']';
      if (s.description) line += ': ' + s.description;
      if (s.kind === 'oauth') {
        line += ' (provider: ' + s.provider + ', status: ' + s.status;
        if (s.scopes && s.scopes.length) line += ', scopes: ' + s.scopes.join(' ');
        line += ')';
      }
      return line;
    }).join('\n');
    return { content: [{ type: 'text', text }], details: { count: items.length, names: items.map((s) => s.name) } };
  },
};

const getAgentSecret: any = {
  name: 'get_agent_secret',
  label: 'Get Agent Secret',
  description: 'Returns a usable credential for one secret by name. For a static secret this is the stored API token; for an OAuth connection this is a fresh access token (refreshed automatically if expired). Use the exact name from list_agent_secrets. Errors if no secret by that name exists, or if an OAuth connection needs to be reconnected by the user.',
  promptSnippet: 'Get a usable credential (API token or fresh OAuth access token) by name.',
  promptGuidelines: [
    'Do not echo a credential returned by get_agent_secret in your reply, into a file, or into a shell command that prints it. Prefer passing it via env vars to the subprocess that needs it.',
    'If get_agent_secret reports an OAuth connection is expired or disconnected, tell the user to reconnect it in Settings — you cannot re-authorize it yourself.',
  ],
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Exact name of the secret (from list_agent_secrets).' } },
    required: ['name'],
    additionalProperties: false,
  },
  async execute(_id: string, params: any) {
    if (!getTokenFn) {
      return { content: [{ type: 'text', text: 'Credential access is unavailable.' }], isError: true };
    }
    try {
      const value = await getTokenFn(params.name);
      return { content: [{ type: 'text', text: value }], details: { name: params.name } };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: e?.message || ('No secret named "' + params.name + '". Call list_agent_secrets to see available names.') }],
        isError: true,
      };
    }
  },
};

export const AGENT_TOKEN_TOOLS: any[] = [listAgentSecrets, getAgentSecret];
