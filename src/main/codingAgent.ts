// Coding-agent integration via @earendil-works/pi-coding-agent.
//
// One pi AgentSession at a time. Sessions are PERSISTED (pi writes a JSONL under
// <agentDir>/sessions) so chats survive reload. The DB (src/main/db) is the source
// of truth for DISPLAY + SEARCH; pi's JSONL is the source of truth for CONTINUATION.
//
// On session create we capture the exact assembled system prompt and store it in
// the DB; on RESUME we hand that stored string back to pi via `systemPromptOverride`
// so the chat continues with the same prompt it was created with (pi would
// otherwise re-derive today's). After each successful turn we persist the new
// messages to the DB; after the first exchange we fire-and-forget an auto-title.
//
// Skills: before each session create, we compute the effective skill list for the
// active workspace and write it to <agentDir>/settings.json `skills: []`.

import { createAgentSession, AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { getModel, completeSimple } from '@earendil-works/pi-ai/compat';
import { agentDirFor, ensureDirs, listBuiltinSkills, listWorkspaceSkills, computeEffectivePaths, writePiSettings } from './skillLibrary.js';
import { ensureAgentTokensExtension } from './agentTokensExtension.js';
import { ensureOpenFileExtension } from './openFileExtension.js';
import { assembleSystemPrompt } from './prompt/index.js';
import { upsertSession, persistMessages, setSessionTitle, getSession } from './db/index.js';

const state: any = {
  session: null,
  unsubscribe: null,
  key: null,
  // Identity of the live chat.
  sessionId: null,
  jsonlPath: null,
  workspacePath: null,
  // Model handles stashed for the fire-and-forget title call.
  modelObj: null,
  modelRegistry: null,
  // Pending lifecycle request applied on the next ensureSession:
  //   { type: 'new' }                              → fresh persisted session
  //   { type: 'open', jsonlPath, systemPrompt }    → resume an existing chat
  request: null,
};

// Prompt for the fire-and-forget title generation (hermes' wording).
const TITLE_PROMPT = 'Generate a short, descriptive title (3-7 words) for a conversation that starts with the following exchange. The title should capture the main topic or intent. Return ONLY the title text, nothing else. No quotes, no punctuation at the end, no prefixes.';

function makeKey({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel }) {
  // Config-only key. The chat identity (sessionId/jsonlPath) is tracked
  // separately in state, so a config change reboots pi but CONTINUES the same
  // chat (re-opening its JSONL) rather than starting a new conversation.
  return [workspacePath, provider, model, apiKey, baseUrl ?? '', contextWindow ?? '', thinkingLevel ?? ''].join(' ');
}

// Flatten a pi message's content to plain text (for the title exchange).
function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
  }
  return '';
}

export function listThinkingLevels(provider, model) {
  if (!provider) return ['off'];
  if (provider === 'openai-compatible') return ['off', 'minimal', 'low', 'medium', 'high'];
  if (!model) return ['off'];
  try {
    const m = getModel(provider, model);
    if (!m) return ['off'];
    return getSupportedThinkingLevels(m);
  } catch {
    return ['off'];
  }
}

async function teardown() {
  if (state.unsubscribe) {
    try { state.unsubscribe(); } catch { /* already unsubscribed */ }
    state.unsubscribe = null;
  }
  if (state.session) {
    try { await state.session.abort(); } catch { /* best-effort */ }
    state.session = null;
    state.key = null;
    state.sessionId = null;
    state.jsonlPath = null;
    state.modelObj = null;
    state.modelRegistry = null;
  }
}

async function ensureSession(opts, emitEvent) {
  const { workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel, userDataDir, builtinDir, globalBuiltinSkills, wsBuiltinSkills } = opts;
  const level = thinkingLevel || 'off';
  const key = makeKey({ workspacePath, provider, model, apiKey, baseUrl, contextWindow, thinkingLevel: level });

  const req = state.request;
  // Reuse the live session only for a plain send (no pending request) whose
  // config + workspace are unchanged.
  if (!req && state.session && state.key === key && state.workspacePath === workspacePath) {
    return state.session;
  }

  // Decide the SessionManager + the prompt to use.
  //   open  → resume that JSONL, re-inject its stored prompt.
  //   new   → let pi create a fresh persisted session (omit sessionManager).
  //   config change on a live chat → re-open the current JSONL to continue it.
  let sessionManager: any;
  let promptOverride: string;
  if (req?.type === 'open') {
    sessionManager = SessionManager.open(req.jsonlPath);
    promptOverride = req.systemPrompt ?? await assembleSystemPrompt(workspacePath);
  } else if (req?.type === 'new' || !state.jsonlPath) {
    sessionManager = undefined; // pi creates a persisted session under agentDir
    promptOverride = await assembleSystemPrompt(workspacePath);
  } else {
    // Config changed mid-chat: continue the same chat with the new config,
    // re-using the chat's stored prompt so its context stays stable.
    sessionManager = SessionManager.open(state.jsonlPath);
    const row = getSession(state.sessionId);
    promptOverride = row?.systemPrompt ?? await assembleSystemPrompt(workspacePath);
  }
  state.request = null;

  // Recompute the effective skill list + materialize extensions before boot.
  await ensureDirs(userDataDir);
  const builtins = await listBuiltinSkills(builtinDir);
  const wsSkills = await listWorkspaceSkills(workspacePath);
  const effectivePaths = computeEffectivePaths(builtins, globalBuiltinSkills, wsBuiltinSkills, wsSkills);
  const agentTokensPath = await ensureAgentTokensExtension(userDataDir);
  const openFilePath = await ensureOpenFileExtension(userDataDir);
  await writePiSettings(userDataDir, { skills: effectivePaths, extensions: [agentTokensPath, openFilePath] });

  await teardown();

  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.create(authStorage);

  let modelObj;
  if (provider === 'openai-compatible') {
    modelRegistry.registerProvider('openai-compatible', {
      baseUrl,
      apiKey: apiKey || 'local',
      api: 'openai-completions',
      models: [{
        id: model,
        name: model,
        reasoning: level !== 'off',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: contextWindow || 128000,
        maxTokens: 16384,
      }],
    });
    modelObj = modelRegistry.find('openai-compatible', model);
  } else {
    authStorage.setRuntimeApiKey(provider, apiKey);
    modelObj = getModel(provider, model);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir: agentDirFor(userDataDir),
    // Re-use the (possibly stored) assembled prompt verbatim. pi appends
    // AGENTS.md + skills + date on top, as always.
    systemPromptOverride: () => promptOverride,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: workspacePath,
    agentDir: agentDirFor(userDataDir),
    model: modelObj,
    thinkingLevel: level as any,
    authStorage,
    modelRegistry,
    // Omit sessionManager → pi creates a persisted session under agentDir.
    ...(sessionManager ? { sessionManager } : {}),
    resourceLoader,
  });

  state.unsubscribe = session.subscribe(emitEvent);
  state.session = session;
  state.key = key;
  state.workspacePath = workspacePath;
  state.sessionId = session.sessionId;
  state.jsonlPath = session.sessionFile;
  state.modelObj = modelObj;
  state.modelRegistry = modelRegistry;

  // Record the chat in the DB. For a brand-new chat this stores the exact
  // assembled prompt we just used (frozen); for a resume/continue the insert
  // conflicts and only refreshes the path + recency, preserving the frozen
  // prompt + title.
  upsertSession({
    sessionId: state.sessionId,
    workspace: workspacePath,
    jsonlPath: state.jsonlPath,
    systemPrompt: promptOverride,
    model: model ?? null,
    now: Date.now(),
  });

  // Tell the renderer which chat is now active (title + star from the DB).
  const row = getSession(state.sessionId);
  emitEvent({ type: 'shockwave_session', sessionId: state.sessionId, title: row?.title ?? null, starred: !!row?.starred });

  return session;
}

// Fire-and-forget: after the first exchange, ask pi's own LLM for a short title.
// A single completeSimple call — NOT the agent loop — so it never touches the
// transcript or runs tools.
function maybeGenerateTitle(sessionId: string, messages: any[], emitEvent) {
  const row = getSession(sessionId);
  if (!row || row.title) return;
  const firstUser = messages.find((m) => m?.role === 'user');
  const firstAsst = messages.find((m) => m?.role === 'assistant');
  if (!firstUser) return;
  const modelObj = state.modelObj;
  const modelRegistry = state.modelRegistry;
  if (!modelObj || !modelRegistry) return;

  const exchange = `User: ${textOf(firstUser.content)}\n\nAssistant: ${textOf(firstAsst?.content)}`.slice(0, 2000);
  (async () => {
    try {
      const auth = await modelRegistry.getApiKeyAndHeaders(modelObj);
      if (!auth?.ok) return;
      const res = await completeSimple(
        modelObj,
        { messages: [{ role: 'user', content: `${TITLE_PROMPT}\n\n${exchange}`, timestamp: Date.now() }] },
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 32 },
      );
      const title = (res?.content ?? [])
        .filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim()
        .replace(/^["']|["']$/g, '')
        .slice(0, 100);
      if (title) {
        setSessionTitle(sessionId, title);
        emitEvent({ type: 'shockwave_session_titled', sessionId, title });
      }
    } catch { /* title is best-effort */ }
  })();
}

export async function agentSend(opts, emitEvent) {
  const { text, images, workspacePath, provider, model, apiKey } = opts;
  if (!workspacePath) throw new Error('Open a workspace first.');
  if (!provider) throw new Error('Coding agent provider not configured.');
  if (!model) throw new Error('Coding agent model not configured.');
  if (provider !== 'openai-compatible' && !apiKey) throw new Error('Coding agent API key not configured. Open Settings → LLM / Agent.');

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
    const msgs = session.state?.messages;
    if (Array.isArray(msgs) && msgs.length >= 2) {
      const last = msgs[msgs.length - 1];
      const prev = msgs[msgs.length - 2];
      if (last?.role === 'assistant' && last?.stopReason === 'error' && prev?.role === 'user') {
        msgs.splice(msgs.length - 2, 2);
      }
    }
    emitEvent({ type: 'agent_send_failed', errorMessage: lastFailureError });
    return;
  }

  // Turn succeeded: persist the new complete messages, then maybe title.
  const msgs = session.state?.messages ?? [];
  if (state.sessionId) {
    try { persistMessages(state.sessionId, msgs, Date.now()); } catch { /* persistence is best-effort */ }
    maybeGenerateTitle(state.sessionId, msgs, emitEvent);
  }
}

export async function agentAbort() {
  if (state.session) {
    try { await state.session.abort(); } catch { /* best-effort */ }
  }
}

// "New chat" — tear down the live session and mark the next send to create a
// fresh persisted one.
export async function agentReset() {
  await teardown();
  state.request = { type: 'new' };
}

// Resume a saved chat: the next send re-opens its JSONL and re-injects the stored
// prompt. UI hydration is separate (renderer reads the DB via chat:getMessages).
export async function agentOpenSession({ jsonlPath, systemPrompt }) {
  await teardown();
  state.request = { type: 'open', jsonlPath, systemPrompt };
}
