// Coding-agent integration via @earendil-works/pi-coding-agent.
//
// One pi AgentSession at a time, keyed by (workspacePath, provider, model, apiKey).
// When any of those change, the previous session is aborted and a new one is created.
// All pi events are forwarded to the renderer over the supplied emitter so the chat
// sidebar can render assistant text deltas, tool calls, turn boundaries, etc.
//
// Skills: before each session create, we compute the effective skill list for the
// active workspace (global enable/disable + workspace overrides) and write it to
// <agentDir>/settings.json `skills: []`, which pi reads when constructing the
// system prompt. Pi never auto-scans our skill-library folder.

import { createAgentSession, AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai';
import { agentDirFor, ensureDirs, listInstalled, computeEffectivePaths, writePiSettings } from './skillLibrary.js';
import { ensureAgentTokensExtension } from './agentTokensExtension.js';
import { DEFAULT_AGENT_SYSTEM_PROMPT } from './agentSystemPrompt.js';

const LOCAL_PROVIDERS = new Set(['ollama', 'lm-studio', 'openai-compatible']);

const state: any = {
  session: null,
  unsubscribe: null,
  key: null,
};

function makeKey({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, systemPrompt }) {
  return [workspacePath, provider, model, apiKey, baseUrl ?? '', contextWindow ?? '', systemPrompt ?? ''].join(' ');
}
async function teardown() {
  if (state.unsubscribe) {
    try { state.unsubscribe(); } catch { /* already unsubscribed */ }
    state.unsubscribe = null;
  }
  if (state.session) {
    try { await state.session.abort(); } catch { /* best-effort; session may already be stopped */ }
    state.session = null;
    state.key = null;
  }
}

async function ensureSession({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, systemPrompt, userDataDir, skillsState, workspaceId }, emitEvent) {
  const effectiveSystemPrompt = (systemPrompt ?? '').trim() || DEFAULT_AGENT_SYSTEM_PROMPT;
  const key = makeKey({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, systemPrompt: effectiveSystemPrompt });
  // We always recompute the effective skill list before session create so the
  // skills array reflects the current global+workspace state. If the session
  // is already up but the skill set has changed, the user can hit Clear in the
  // chat sidebar to tear it down — pi reads `skills` only at session boot.
  await ensureDirs(userDataDir);
  const installed = await listInstalled(userDataDir);
  const effectivePaths = computeEffectivePaths(installed, skillsState, workspaceId);
  // Materialize the agent-tokens extension every boot so it always reflects
  // the current source. Pi reads `extensions: []` from <agentDir>/settings.json
  // to discover it.
  const agentTokensPath = await ensureAgentTokensExtension(userDataDir);
  await writePiSettings(userDataDir, {
    skills: effectivePaths,
    extensions: [agentTokensPath],
  });

  if (state.session && state.key === key) return state.session;
  await teardown();

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(provider, apiKey);
  const modelRegistry = ModelRegistry.create(authStorage);
let modelObj;
  if (LOCAL_PROVIDERS.has(provider)) {
    modelRegistry.registerProvider(provider, {
      baseUrl,
      apiKey: apiKey || 'local',
      api: 'openai-completions',
      models: [{
        id: model,
        name: model,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: contextWindow || 128000,
        maxTokens: 16384,
      }],
    });
    modelObj = modelRegistry.find(provider, model);
  } else {
    authStorage.setRuntimeApiKey(provider, apiKey);
    modelObj = getModel(provider, model);
  }

  // Custom resource loader so we can override pi's default coding-agent system
  // prompt with ours (see DEFAULT_AGENT_SYSTEM_PROMPT). Still uses the standard
  // discovery for skills/extensions/prompts/themes under agentDir + cwd.
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir: agentDirFor(userDataDir),
    systemPromptOverride: () => effectiveSystemPrompt,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: workspacePath,
    agentDir: agentDirFor(userDataDir),
    model: modelObj,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(workspacePath),
    resourceLoader,
  });

  state.unsubscribe = session.subscribe(emitEvent);
  state.session = session;
  state.key = key;
  return session;
}

export async function agentSend(opts, emitEvent) {
  const { text, images, workspacePath, provider, model, apiKey, baseUrl, contextWindow } = opts;
  if (!workspacePath) throw new Error('Open a workspace first.');
  if (!provider) throw new Error('Coding agent provider not configured.');
  if (!model) throw new Error('Coding agent model not configured.');
  // Local providers don't require an API key.
  if (!LOCAL_PROVIDERS.has(provider) && !apiKey) throw new Error('Coding agent API key not configured. Open Settings → LLM / Agent.');

  // Wrap the renderer's event listener so we can intercept the failure
  // assistant message that pi emits on any provider-side error (bad API key,
  // image too large, rate limit, etc). Pi pushes the failed user msg into
  // state.messages BEFORE the API call (see pi-agent-core/dist/agent-loop.js:42-52)
  // and pushes the failure assistant after; both stay in context and re-poison
  // every subsequent turn. session.prompt() resolves normally in this case —
  // pi does not throw — so without this we'd never surface the error.
  let lastFailureError: any = null;
  const wrappedEmit = (event) => {
    if (event?.type === 'agent_end' && Array.isArray(event.messages)) {
      const failure = event.messages.find(
        (m) => m?.role === 'assistant' && m?.stopReason === 'error' && m?.errorMessage,
      );
      if (failure) lastFailureError = failure.errorMessage;
    }
    emitEvent(event);
  };

  const session = await ensureSession(opts, wrappedEmit);
  const hasImages = Array.isArray(images) && images.length > 0;
  await session.prompt(text, hasImages ? { images } : undefined);

  if (lastFailureError) {
    // Drop the failure assistant + the user message we just sent so pi's
    // context isn't poisoned for the next turn.
    const msgs = session.state?.messages;
    if (Array.isArray(msgs) && msgs.length >= 2) {
      const last = msgs[msgs.length - 1];
      const prev = msgs[msgs.length - 2];
      if (
        last?.role === 'assistant'
        && last?.stopReason === 'error'
        && prev?.role === 'user'
      ) {
        msgs.splice(msgs.length - 2, 2);
      }
    }
    // Tell the renderer to drop the corresponding transcript entries and
    // surface the provider error in the chat banner.
    emitEvent({ type: 'agent_send_failed', errorMessage: lastFailureError });
  }
}

export async function agentAbort() {
  if (state.session) {
    try { await state.session.abort(); } catch { /* best-effort; session may already be stopped */ }
  }
}

export async function agentReset() {
  await teardown();
}
