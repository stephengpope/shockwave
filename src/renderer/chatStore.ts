// Per-chat state for the coding-agent sidebar, kept OUTSIDE the React tree.
//
// Why a module store: chats can run concurrently in main, and their events
// keep streaming whether or not the chat is on screen. Component state can't
// hold that — ChatSidebar remounts on workspace switch (key={workspacePath})
// and only ever shows one chat. So every chat's transcript, running flag,
// counters, and composer draft live here, keyed by sessionId; the component
// renders the active entry via useSyncExternalStore and stays a pure view.
//
// Event flow: ONE window.api.agent.onEvent subscription (module-level, made on
// first use, never torn down). Main stamps every event with the sessionId of
// the chat it came from; the reducer below routes it into that chat's entry —
// visible or not. Because the store receives every delta for every chat, the
// on-screen transcript is always just `chats[activeId].messages`: there is no
// merge with the DB on switch. The DB is only for cold loads (a chat not yet
// touched this app run) via openChat().
//
// Chat identity: NEW chats mint their sessionId here (crypto.randomUUID) and
// main hands it to pi, so events are routable from the first millisecond.
//
// Immutability: state is replaced wholesale on every update (new object refs
// down the changed path) so useSyncExternalStore snapshots compare correctly
// and MessageRow's memo keeps untouched rows referentially stable.

type ChatEntry = {
  workspace: string | null;
  messages: any[];
  running: boolean;
  /** Steer messages queued into the running turn (from pi's queue_update). */
  queuedCount: number;
  tokens: number;
  /** Final elapsed of the last run; while running, derive from runStartAt. */
  elapsedMs: number;
  runStartAt: number; // 0 = not running
  error: string | null;
  title: string | null;
  starred: boolean;
  /** Chat exists in the DB (set on first send's shockwave_session / on open).
   *  Gates star + rename, which need a stored row. */
  persisted: boolean;
  /** DB rows loaded (new chats are born hydrated — nothing stored yet). */
  hydrated: boolean;
  draft: string;
  attachments: any[];
  // Streaming cursors (formerly refs in ChatSidebar).
  currentAssistantId: string | null;
  currentThinkingId: string | null;
  lastSentUserId: string | null;
};

type ChatStoreState = {
  chats: Record<string, ChatEntry>;
  /** Active chat per workspace — survives the sidebar's workspace-switch remount. */
  activeByWorkspace: Record<string, string>;
};

export const EMPTY_CHAT: ChatEntry = {
  workspace: null,
  messages: [],
  running: false,
  queuedCount: 0,
  tokens: 0,
  elapsedMs: 0,
  runStartAt: 0,
  error: null,
  title: null,
  starred: false,
  persisted: false,
  hydrated: false,
  draft: '',
  attachments: [],
  currentAssistantId: null,
  currentThinkingId: null,
  lastSentUserId: null,
};

let state: ChatStoreState = { chats: {}, activeByWorkspace: {} };
const listeners = new Set<() => void>();
let idCounter = 0;
const nextId = () => `m${++idCounter}`;

function emitChange() {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void) {
  ensureSubscribed();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getState(): ChatStoreState {
  return state;
}

function patchChat(sessionId: string, patch: Partial<ChatEntry> | ((c: ChatEntry) => Partial<ChatEntry>)) {
  const cur = state.chats[sessionId] ?? EMPTY_CHAT;
  const p = typeof patch === 'function' ? patch(cur) : patch;
  state = { ...state, chats: { ...state.chats, [sessionId]: { ...cur, ...p } } };
  emitChange();
}

// Append one message to a chat's transcript.
function appendMessage(sessionId: string, message: any) {
  patchChat(sessionId, (c) => ({ messages: [...c.messages, message] }));
}

// Replace the message with the given id (referentially — untouched rows keep
// their identity so MessageRow's memo holds).
function mapMessage(sessionId: string, id: string, fn: (m: any) => any) {
  patchChat(sessionId, (c) => ({ messages: c.messages.map((m) => (m.id === id ? fn(m) : m)) }));
}

// ---- Event routing (the old ChatSidebar.handleAgentEvent, per-chat) --------

function handleAgentEvent(evt: any) {
  const sessionId = evt?.sessionId;
  if (!evt?.type || !sessionId) return;

  if (evt.type === 'agent_start') {
    patchChat(sessionId, { running: true, error: null, tokens: 0, elapsedMs: 0, runStartAt: Date.now(), currentThinkingId: null });
    return;
  }
  if (evt.type === 'agent_end') {
    patchChat(sessionId, (c) => ({
      running: false,
      queuedCount: 0,
      currentAssistantId: null,
      currentThinkingId: null,
      elapsedMs: c.runStartAt ? Date.now() - c.runStartAt : c.elapsedMs,
      runStartAt: 0,
      // Freeze any still-open thinking block (guards a missing thinking_end).
      messages: c.messages.map((m) => (m.kind === 'thinking' && !m.done ? { ...m, done: true } : m)),
    }));
    return;
  }
  if (evt.type === 'turn_end') {
    // Pi's normalized Usage — sum totalTokens across turns; each turn re-pays
    // for the context, so the sum matches actual billed usage for the run.
    const total = evt.message?.usage?.totalTokens;
    if (typeof total === 'number') patchChat(sessionId, (c) => ({ tokens: c.tokens + total }));
    return;
  }
  if (evt.type === 'queue_update') {
    const queued = (evt.steering?.length ?? 0) + (evt.followUp?.length ?? 0);
    patchChat(sessionId, { queuedCount: queued });
    return;
  }
  if (evt.type === 'message_update') {
    const inner = evt.assistantMessageEvent;
    if (!inner) return;
    const chat = state.chats[sessionId] ?? EMPTY_CHAT;
    if (inner.type === 'thinking_start') {
      const id = nextId();
      patchChat(sessionId, (c) => ({
        currentThinkingId: id,
        currentAssistantId: null,
        messages: [...c.messages, { id, kind: 'thinking', text: '', done: false }],
      }));
      return;
    }
    if (inner.type === 'thinking_delta') {
      const delta = inner.delta ?? '';
      const id = chat.currentThinkingId;
      if (!id) {
        const newId = nextId();
        patchChat(sessionId, (c) => ({
          currentThinkingId: newId,
          messages: [...c.messages, { id: newId, kind: 'thinking', text: delta, done: false }],
        }));
        return;
      }
      mapMessage(sessionId, id, (m) => ({ ...m, text: m.text + delta }));
      return;
    }
    if (inner.type === 'thinking_end') {
      const id = chat.currentThinkingId;
      patchChat(sessionId, { currentThinkingId: null });
      if (id) mapMessage(sessionId, id, (m) => ({ ...m, done: true }));
      return;
    }
    if (inner.type === 'text_start') {
      const id = nextId();
      patchChat(sessionId, (c) => ({
        currentAssistantId: id,
        messages: [...c.messages, { id, kind: 'assistant', text: '' }],
      }));
      return;
    }
    if (inner.type === 'text_delta') {
      const id = chat.currentAssistantId;
      if (!id) {
        const newId = nextId();
        patchChat(sessionId, (c) => ({
          currentAssistantId: newId,
          messages: [...c.messages, { id: newId, kind: 'assistant', text: inner.delta ?? '' }],
        }));
        return;
      }
      mapMessage(sessionId, id, (m) => ({ ...m, text: m.text + (inner.delta ?? '') }));
      return;
    }
    return;
  }
  if (evt.type === 'tool_execution_start') {
    patchChat(sessionId, (c) => ({
      currentAssistantId: null,
      currentThinkingId: null,
      messages: [...c.messages, {
        id: nextId(),
        kind: 'tool',
        toolCallId: evt.toolCallId,
        toolName: evt.toolName,
        args: evt.args,
        output: '',
        isError: false,
        done: false,
      }],
    }));
    return;
  }
  if (evt.type === 'tool_execution_update') {
    patchChat(sessionId, (c) => ({
      messages: c.messages.map((m) => (
        m.kind === 'tool' && m.toolCallId === evt.toolCallId
          ? { ...m, output: formatToolResult(evt.partialResult) }
          : m
      )),
    }));
    return;
  }
  if (evt.type === 'tool_execution_end') {
    patchChat(sessionId, (c) => ({
      messages: c.messages.map((m) => (
        m.kind === 'tool' && m.toolCallId === evt.toolCallId
          ? { ...m, output: formatToolResult(evt.result), isError: !!evt.isError, done: true }
          : m
      )),
    }));
    return;
  }
  if (evt.type === 'shockwave_session') {
    // Main confirms this chat's session is live; carries title + star from the DB.
    patchChat(sessionId, { persisted: true, title: evt.title ?? null, starred: !!evt.starred });
    return;
  }
  if (evt.type === 'shockwave_session_titled') {
    patchChat(sessionId, { title: evt.title ?? null });
    return;
  }
  if (evt.type === 'agent_send_failed') {
    // Main popped the bad user+failure pair from pi state; mirror by removing
    // the matching user message and surfacing the provider error.
    patchChat(sessionId, (c) => ({
      messages: c.lastSentUserId ? c.messages.filter((m) => m.id !== c.lastSentUserId) : c.messages,
      lastSentUserId: null,
      error: evt.errorMessage ?? 'Send failed.',
    }));
    return;
  }
}

let subscribed = false;
function ensureSubscribed() {
  if (subscribed || typeof window === 'undefined' || !(window as any).api?.agent) return;
  subscribed = true;
  window.api.agent.onEvent((evt: any) => handleAgentEvent(evt));
  window.api.agent.onError(({ sessionId, message }: any) => {
    if (!sessionId) return;
    patchChat(sessionId, { running: false, runStartAt: 0, error: message });
  });
  // After a window reload, chats may still be mid-turn in main — reseed their
  // running flags so the dropdown spinner and Working indicator are truthful.
  window.api.agent.runningSessions?.().then((ids: string[]) => {
    for (const id of ids ?? []) patchChat(id, { running: true, runStartAt: Date.now() });
  }).catch(() => { /* best-effort */ });
}

// ---- Pi tool-result flattening (shared with ChatSidebar's rendering) --------

// Pi tool results are shaped { content: [{type:'text', text}, ...], details? }.
// Concat text items; ignore non-text (images). Fall back to JSON for unknowns.
export function formatToolResult(result: any): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    if (Array.isArray(result.content)) {
      return result.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
    }
    if (typeof result.output === 'string') return result.output;
    if (typeof result.text === 'string') return result.text;
    try { return JSON.stringify(result, null, 2); } catch { return String(result); }
  }
  return String(result);
}

// Rebuild the UI transcript from stored DB message rows (chat:openSession).
// The DB keeps one row per pi message: an assistant turn carries its text +
// thinking + tool CALLS (tool_calls JSON); each tool RESULT is its own role='tool'
// row. We re-pair them here into the sidebar's flat kind-tagged model, absorbing
// each result into the tool row created from the matching call (by tool_call_id).
// Order within an assistant turn: thinking → text → tool calls. (isError isn't
// persisted, so hydrated tool rows render as non-error; images degrade to text.)
function hydrateMessages(rows: any[]) {
  const results = new Map();
  for (const r of rows) {
    if (r.role === 'tool' && r.toolCallId) results.set(r.toolCallId, r.content ?? '');
  }
  const out: any[] = [];
  for (const r of rows) {
    if (r.role === 'user') {
      out.push({ id: `h${r.seq}`, kind: 'user', text: r.content ?? '' });
    } else if (r.role === 'assistant') {
      if (r.reasoning) out.push({ id: `h${r.seq}-k`, kind: 'thinking', text: r.reasoning, done: true });
      if (r.content) out.push({ id: `h${r.seq}-t`, kind: 'assistant', text: r.content });
      if (r.toolCalls) {
        let calls: any[] = [];
        try { calls = JSON.parse(r.toolCalls) || []; } catch { /* corrupt row → skip its tools */ }
        calls.forEach((c, i) => {
          out.push({
            id: `h${r.seq}-c${i}`,
            kind: 'tool',
            toolCallId: c.id,
            toolName: c.name,
            args: c.arguments,
            output: results.get(c.id) ?? '',
            isError: false,
            done: true,
          });
        });
      }
    }
  }
  return out;
}

// ---- Actions (called by ChatSidebar) ----------------------------------------

/** Mint a fresh chat for the workspace and make it active. */
export function newChat(workspace: string | null): string {
  const id = crypto.randomUUID();
  state = {
    chats: { ...state.chats, [id]: { ...EMPTY_CHAT, workspace, hydrated: true } },
    activeByWorkspace: workspace ? { ...state.activeByWorkspace, [workspace]: id } : state.activeByWorkspace,
  };
  emitChange();
  return id;
}

/** Active chat for a workspace, creating a fresh one if none. */
export function ensureActiveChat(workspace: string | null): string {
  const existing = workspace ? state.activeByWorkspace[workspace] : null;
  if (existing && state.chats[existing]) return existing;
  return newChat(workspace);
}

/** Open a saved chat: cold-load its transcript from the DB (once), set active.
 *  If the chat streamed events this app run (e.g. running in background), the
 *  DB rows are prepended before the streamed tail — the seam is a turn
 *  boundary, since streaming starts fresh after a reload. */
export async function openChat(sessionId: string, workspace: string | null) {
  const existing = state.chats[sessionId];
  let ws = workspace ?? existing?.workspace ?? null;
  if (!existing?.hydrated) {
    const { session, messages: rows } = await window.api.chat.openSession(sessionId);
    // Right after app start the sidebar's workspacePath prop can still be null;
    // the chat's own DB row knows its workspace (chats are workspace-scoped).
    ws = ws ?? session?.workspace ?? null;
    patchChat(sessionId, (c) => ({
      workspace: ws,
      hydrated: true,
      persisted: !!session || c.persisted,
      title: session?.title ?? c.title,
      starred: !!(session?.starred ?? c.starred),
      messages: [...hydrateMessages(rows || []), ...c.messages],
    }));
  }
  if (ws) {
    state = { ...state, activeByWorkspace: { ...state.activeByWorkspace, [ws]: sessionId } };
    emitChange();
  }
}

/** Send (or steer, if the chat is mid-turn — main decides) a message. */
export async function sendToChat(sessionId: string, { text, promptText, images, attachments }: {
  text: string; promptText: string; images: any[]; attachments: any[];
}) {
  const userId = nextId();
  patchChat(sessionId, (c) => ({
    error: null,
    lastSentUserId: userId,
    // Optimistic running — agent_start confirms ~immediately; for a steer the
    // chat is already running.
    running: true,
    runStartAt: c.runStartAt || Date.now(),
    messages: [...c.messages, { id: userId, kind: 'user', text, attachments }],
  }));
  try {
    await window.api.agent.send({ sessionId, text: promptText, images: images.length ? images : undefined });
  } catch (err: any) {
    patchChat(sessionId, { running: false, runStartAt: 0, error: err?.message ?? String(err) });
  }
}

export async function abortChat(sessionId: string) {
  try { await window.api.agent.abort(sessionId); } catch { /* abort is best-effort */ }
}

/** Chat deleted (history popover) — drop local state; main already disposed. */
export function removeChat(sessionId: string) {
  if (!state.chats[sessionId]) return;
  const chats = { ...state.chats };
  delete chats[sessionId];
  const activeByWorkspace = { ...state.activeByWorkspace };
  for (const [ws, id] of Object.entries(activeByWorkspace)) {
    if (id === sessionId) delete activeByWorkspace[ws];
  }
  state = { chats, activeByWorkspace };
  emitChange();
}

export function setDraft(sessionId: string, draft: string) {
  patchChat(sessionId, { draft });
}

export function setAttachments(sessionId: string, updater: (prev: any[]) => any[]) {
  patchChat(sessionId, (c) => ({ attachments: updater(c.attachments) }));
}

export function setError(sessionId: string, error: string | null) {
  patchChat(sessionId, { error });
}

export function setTitle(sessionId: string, title: string | null) {
  patchChat(sessionId, { title });
}

export function setStarred(sessionId: string, starred: boolean) {
  patchChat(sessionId, { starred });
}

// Dev-only introspection for CDP-driven debugging (see electron-dev skill).
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  (window as any).__chatStore = { getState, openChat, newChat, ensureActiveChat };
}
