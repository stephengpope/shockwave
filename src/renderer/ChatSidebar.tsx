import React, { createContext, forwardRef, memo, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PaperclipIcon, PlayIcon, StopIcon, XIcon, FileTextIcon, MicIcon, PanelRightCloseIcon, CopyIcon, CheckIcon, SearchIcon, PlusIcon, TrashIcon } from './Icons.jsx';
import { resolveImageUrl } from './imageWidgets.js';
import {
  classify,
  readAsBase64,
  readAsText,
  formatBytes,
  nextAttachmentId,
  composePromptText,
  toImageContents,
} from './chatAttachments.js';
import { useVoiceInput } from './voice/useVoiceInput.js';
import { VoiceBars } from './voice/VoiceBars.jsx';

// Workspace path available to MARKDOWN_COMPONENTS' `img` override via context,
// so the module-level components object stays referentially stable (preserving
// MessageRow's memo) while still resolving image src against the current
// workspace.
const ChatWorkspaceContext = createContext<string | null>(null);

// Override link and image rendering in react-markdown:
//
// - <a>: left-click opens https? in the system browser instead of navigating
//   the renderer (which would blank the app — no chrome to navigate back).
//   Main also installs a will-navigate guard as a safety net, but this is the
//   UX-correct path.
//
// - <img>: agents (playwright-cli screenshots, firecrawl page captures, etc.)
//   emit markdown like `![alt](./example.png)` whose src is a workspace-relative
//   path. React-markdown's default <img> would resolve that against the
//   renderer URL (http://localhost:5173/example.png in dev, file:// in prod)
//   and 404. Rewrite through `app://media/<rel>` — the same protocol the
//   editor's image widgets use — by passing the workspace path as `activeDir`
//   AND `vault` (the agent's cwd IS the workspace root, so plain relative
//   paths and absolute paths under the workspace both resolve correctly).
//   Outside-workspace or unresolvable paths fall back to alt text instead of
//   a broken-image icon.
//
// Exported as a module-level constant so the prop reference is stable and
// MessageRow's memo isn't invalidated.
const MARKDOWN_COMPONENTS = {
  a: ({ href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
          window.api.openExternal(href);
        }
      }}
    >
      {children}
    </a>
  ),
  img: ({ src, alt, ...rest }) => {
    const ws = useContext(ChatWorkspaceContext);
    const resolved = typeof src === 'string' ? resolveImageUrl(src, ws, ws) : null;
    if (!resolved) return <>{alt || ''}</>;
    return <img {...rest} src={resolved} alt={alt || ''} loading="lazy" />;
  },
};

// Build a short, human-readable summary line for a tool call.
function toolSummary(toolName, args) {
  const a = args ?? {};
  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
      return a.file_path ?? a.path ?? '';
    case 'bash':
      return typeof a.command === 'string' ? a.command.split('\n')[0].slice(0, 120) : '';
    case 'grep':
      return a.pattern ?? '';
    case 'find':
      return a.pattern ?? a.path ?? '';
    case 'ls':
      return a.path ?? '';
    default:
      try { return JSON.stringify(a).slice(0, 120); } catch { return ''; }
  }
}

// Pi tool results are shaped { content: [{type:'text', text}, ...], details? }.
// Concat text items; ignore non-text (images). Fall back to JSON for unknowns.
function formatToolResult(result) {
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

// Per-tool detail rendering for the expanded view header (above the output).
// Keep these terse — the collapsed-summary line already shows the headline arg.
function ToolArgsDetail({ toolName, args }) {
  const a = args ?? {};
  if (toolName === 'bash') {
    return (
      <pre className="chat-tool-args chat-tool-args-shell">
        <span className="chat-tool-shell-prompt">$ </span>{a.command ?? ''}
      </pre>
    );
  }
  if (toolName === 'edit' && Array.isArray(a.edits)) {
    return (
      <div className="chat-tool-args chat-tool-args-edit">
        <div className="chat-tool-arg-path">{a.path ?? ''}</div>
        {a.edits.map((e, i) => (
          <div key={i} className="chat-tool-edit-block">
            {String(e?.oldText ?? '').split('\n').map((ln, j) => (
              <div key={`o${j}`} className="chat-tool-edit-del">- {ln}</div>
            ))}
            {String(e?.newText ?? '').split('\n').map((ln, j) => (
              <div key={`n${j}`} className="chat-tool-edit-add">+ {ln}</div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (toolName === 'write') {
    return <div className="chat-tool-args chat-tool-arg-path">{a.path ?? ''}</div>;
  }
  if (toolName === 'read' || toolName === 'ls') {
    return <div className="chat-tool-args chat-tool-arg-path">{a.path ?? ''}</div>;
  }
  if (toolName === 'grep' || toolName === 'find') {
    return (
      <div className="chat-tool-args">
        <div className="chat-tool-arg-row"><span className="chat-tool-arg-key">pattern</span> {a.pattern ?? ''}</div>
        {a.path && <div className="chat-tool-arg-row"><span className="chat-tool-arg-key">path</span> {a.path}</div>}
      </div>
    );
  }
  let block = '';
  try { block = JSON.stringify(a, null, 2); } catch { block = String(a); }
  return <pre className="chat-tool-args">{block}</pre>;
}

// Xs under 60s, Ym Xs over.
function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(k)}k`;
}

function AttachmentChip({ att, onRemove }: any) {
  const handleClick = () => {
    if (att.kind === 'image' && att.dataUrl) {
      window.api.openExternal(att.dataUrl);
    }
  };
  return (
    <div className={`chat-attachment chat-attachment-${att.kind}`}>
      {att.kind === 'image' ? (
        <button
          type="button"
          className="chat-attachment-thumb"
          onClick={handleClick}
          title={att.name}
          style={{ backgroundImage: `url("${att.dataUrl}")` }}
          aria-label={att.name}
        />
      ) : (
        <div className="chat-attachment-text" title={`${att.name} · ${formatBytes(att.bytes)}`}>
          <span className="chat-attachment-icon"><FileTextIcon size={18} /></span>
          <span className="chat-attachment-name">{att.name}</span>
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          className="chat-attachment-remove"
          onClick={() => onRemove(att.id)}
          aria-label={`Remove ${att.name}`}
        ><XIcon size={10} /></button>
      )}
    </div>
  );
}

function AttachmentRow({ attachments, onRemove, readOnly }: any) {
  return (
    <div className={`chat-attachments ${readOnly ? 'chat-attachments-readonly' : ''}`}>
      {attachments.map((a) => (
        <AttachmentChip key={a.id} att={a} onRemove={readOnly ? null : onRemove} />
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<any>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const onClick = useCallback(async (e: any) => {
    e.stopPropagation();
    const value = text ?? '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard write is best-effort */ }
  }, [text]);
  return (
    <button
      type="button"
      className="chat-copy-btn"
      onClick={onClick}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy message'}
    >{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}</button>
  );
}

// One rendered chat row. Memoized so typing in the composer (which re-renders
// the parent ChatSidebar) does NOT walk every message and call ReactMarkdown
// again. Every message object is referentially stable across non-mutating
// updates (see setMessages callers), so the default shallow-prop compare
// returns true for un-touched rows. Only the actively-streaming message gets a
// new reference and re-renders.
const MessageRow = memo(function MessageRow({ message: m }: any) {
  if (m.kind === 'user') {
    return (
      <div className="chat-message chat-user">
        <div className="chat-bubble">
          {m.attachments && m.attachments.length > 0 && (
            <AttachmentRow attachments={m.attachments} readOnly />
          )}
          {m.text && <div className="chat-user-text">{m.text}</div>}
        </div>
        {m.text && <CopyButton text={m.text} />}
      </div>
    );
  }
  if (m.kind === 'assistant') {
    return (
      <div className="chat-message chat-assistant">
        <div className="chat-bubble chat-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS as any}>{m.text}</ReactMarkdown>
        </div>
        {m.text && <CopyButton text={m.text} />}
      </div>
    );
  }
  if (m.kind === 'thinking') {
    return <div className="chat-message chat-tool-row"><ThinkingEntry entry={m} /></div>;
  }
  if (m.kind === 'tool') {
    return <div className="chat-message chat-tool-row"><ToolEntry entry={m} /></div>;
  }
  return null;
});

// Rotating loader ring — the same mark as the "Working" indicator (below).
function SpinnerIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="chat-spinner"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

// Collapsible extended-thinking block. While streaming it shows the same
// spinner + shimmering label as the "Working" indicator ("Thinking"); once
// thinking_end fires it freezes to a static "Thought" summary, collapsed by
// default. Body is the raw reasoning text.
function ThinkingEntry({ entry }) {
  const streaming = !entry.done;
  // Auto-expand while streaming so the reasoning is visible live; collapse once
  // done (unless the user has toggled it open).
  const [open, setOpen] = useState(true);
  const collapsedDone = entry.done && !open;
  return (
    <div className="chat-thinking-block">
      <button
        type="button"
        className="chat-thinking-summary"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-tool-caret">{collapsedDone ? '▸' : '▾'}</span>
        {streaming
          ? (<><SpinnerIcon /><span className="thinking-shimmer">Thinking</span></>)
          : (<span className="chat-thinking-label">Thought</span>)}
      </button>
      {(!entry.done || open) && entry.text && (
        <div className="chat-thinking-body">{entry.text}</div>
      )}
    </div>
  );
}

function ToolEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const running = !entry.done;
  const statusClass = entry.isError ? 'chat-tool-status-error' : 'chat-tool-status-ok';
  return (
    <div className={`chat-tool ${entry.isError ? 'chat-tool-error' : ''}`}>
      <button type="button" className="chat-tool-summary" onClick={() => setOpen((v) => !v)}>
        <span className="chat-tool-caret">{open ? '▾' : '▸'}</span>
        <span className={`chat-tool-status ${statusClass}`}>
          {running ? '' : entry.isError ? '✗' : '✓'}
        </span>
        <span className="chat-tool-name">{entry.toolName}</span>
        <span className="chat-tool-arg">{toolSummary(entry.toolName, entry.args)}</span>
      </button>
      {open && (
        <div className="chat-tool-detail">
          <ToolArgsDetail toolName={entry.toolName} args={entry.args} />
          {(entry.output || running) && (
            <div className="chat-tool-output">
              <span className="chat-tool-output-text">{entry.output}</span>
              {running && <span className="chat-tool-cursor" aria-hidden="true">▌</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Star (filled when active). Used in the header + each history row.
function StarIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

// Rebuild the UI transcript from stored DB message rows (chat:getMessages).
// The DB keeps one row per pi message: an assistant turn carries its text +
// thinking + tool CALLS (tool_calls JSON); each tool RESULT is its own role='tool'
// row. We re-pair them here into the sidebar's flat kind-tagged model, absorbing
// each result into the tool row created from the matching call (by tool_call_id).
// Order within an assistant turn: thinking → text → tool calls. (isError isn't
// persisted, so hydrated tool rows render as non-error; images degrade to text.)
function hydrateMessages(rows) {
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

// "3m", "2h", "5d", or a date past a week — for the history list.
function formatAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return `${d}d`; }
}

// Popover of recent + searchable chats. Anchored under the header history button.
// Recents paginate on scroll (keyset via the last row's updatedAt); a non-empty
// query switches to full-text search across the workspace's chats.
function HistoryPopover({ currentSessionId, onSelect, onClose }: any) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<any>(null);
  const searching = query.trim().length > 0;

  // Dismiss on any click/focus outside the popover (ignoring the header toggle,
  // which owns its own open/close), or on Escape.
  useEffect(() => {
    const onDown = (e) => {
      const t = e.target;
      if (rootRef.current?.contains(t)) return;
      if (t?.closest?.('.chat-sidebar-history')) return; // let the toggle handle itself
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('focusin', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('focusin', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const [starred, setStarredList] = useState<any[]>([]);

  const loadRecents = useCallback(async (before?: number) => {
    setLoading(true);
    try {
      const rows = await window.api.chat.listSessions(before ? { before } : {});
      setItems((prev) => (before ? [...prev, ...rows] : rows));
      setHasMore(rows.length >= 30);
    } finally { setLoading(false); }
  }, []);

  const loadStarred = useCallback(async () => {
    try { setStarredList(await window.api.chat.listStarred()); } catch { /* best-effort */ }
  }, []);

  // Debounced search / initial recents + starred.
  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    if (!q) { loadRecents(); loadStarred(); return () => { cancelled = true; }; }
    const t = setTimeout(async () => {
      const rows = await window.api.chat.searchSessions({ query: q });
      if (!cancelled) { setItems(rows); setHasMore(false); }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, loadRecents, loadStarred]);

  const onScroll = useCallback((e) => {
    if (searching || loading || !hasMore) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      const last = items[items.length - 1];
      if (last) loadRecents(last.updatedAt);
    }
  }, [searching, loading, hasMore, items, loadRecents]);

  const onDelete = useCallback(async (e, sessionId) => {
    e.stopPropagation();
    await window.api.chat.deleteSession(sessionId);
    setItems((prev) => prev.filter((x) => x.sessionId !== sessionId));
    setStarredList((prev) => prev.filter((x) => x.sessionId !== sessionId));
  }, []);

  const onToggleStar = useCallback(async (e, sessionId, currentlyStarred) => {
    e.stopPropagation();
    await window.api.chat.setStarred({ sessionId, starred: !currentlyStarred });
    loadRecents();
    loadStarred();
  }, [loadRecents, loadStarred]);

  const renderRow = (it, isStarred) => (
    <button
      key={it.sessionId}
      type="button"
      className={`chat-history-row ${it.sessionId === currentSessionId ? 'chat-history-row-active' : ''}`}
      onClick={() => onSelect(it.sessionId)}
    >
      <span
        role="button"
        tabIndex={0}
        className={`chat-history-row-star ${isStarred ? 'chat-history-row-star-on' : ''}`}
        onClick={(e) => onToggleStar(e, it.sessionId, isStarred)}
        aria-label={isStarred ? 'Unstar chat' : 'Star chat'}
        title={isStarred ? 'Unstar' : 'Star'}
      ><StarIcon size={13} filled={isStarred} /></span>
      <span className="chat-history-row-main">
        <span className="chat-history-row-title">{it.title || 'Untitled chat'}</span>
        {searching && it.snippet && <span className="chat-history-row-snippet">{it.snippet}</span>}
      </span>
      {!searching && <span className="chat-history-row-time">{formatAgo(it.updatedAt)}</span>}
      <span
        role="button"
        tabIndex={0}
        className="chat-history-row-delete"
        onClick={(e) => onDelete(e, it.sessionId)}
        aria-label="Delete chat"
        title="Delete chat"
      ><TrashIcon size={12} /></span>
    </button>
  );

  const showStarred = !searching && starred.length > 0;
  const empty = items.length === 0 && !showStarred && !loading;

  return (
    <div className="chat-history-popover" role="dialog" aria-label="Chat history" ref={rootRef}>
      <div className="chat-history-search">
        <SearchIcon size={13} />
        <input
          type="text"
          className="chat-history-input"
          placeholder="Search chats…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="chat-history-list" onScroll={onScroll}>
        {empty && (
          <div className="chat-history-empty">{searching ? 'No matches' : 'No saved chats yet'}</div>
        )}
        {showStarred && (
          <>
            <div className="chat-history-section">Starred</div>
            {starred.map((it) => renderRow(it, true))}
            {items.length > 0 && <div className="chat-history-section">Recent</div>}
          </>
        )}
        {items.map((it) => renderRow(it, false))}
      </div>
    </div>
  );
}

const ChatSidebar = forwardRef<any, any>(function ChatSidebar({ onClose, workspacePath }, ref) {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<any>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [rejected, setRejected] = useState<any>(null); // { name, reason }
  const [dragOver, setDragOver] = useState(false);
  // Saved-chat identity + the history popover.
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [sessionStarred, setSessionStarred] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // Voice input — partialText is the in-flight AssemblyAI partial transcript
  // (replaced as the model refines, then committed into `input` on end_of_turn).
  const [partialText, setPartialText] = useState('');
  const voiceVolumeRef = useRef(0);
  const currentAssistantIdRef = useRef<any>(null);
  const currentThinkingIdRef = useRef<any>(null);
  const idCounterRef = useRef(0);
  const scrollRef = useRef<any>(null);
  const textareaRef = useRef<any>(null);
  const fileInputRef = useRef<any>(null);
  const sidebarRootRef = useRef<any>(null);
  const lastSentUserIdRef = useRef<any>(null);
  const runStartRef = useRef(0);
  const tickerRef = useRef<any>(null);
  const dragCounterRef = useRef(0);

  const nextId = () => `m${++idCounterRef.current}`;

  // Subscribe to agent events from main.
  useEffect(() => {
    const offEvent = window.api.agent.onEvent((evt) => {
      handleAgentEvent(evt);
    });
    const offError = window.api.agent.onError(({ message }) => {
      setRunning(false);
      setError(message);
      if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null; }
    });
    return () => {
      offEvent?.();
      offError?.();
      if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  // Auto-grow the textarea up to ~7 lines, then internal scrolling.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Voice input hook. Mounts on sidebar mount (always, even while the sidebar
  // is collapsed to a 28px strip) so the token prefetch runs early — every
  // mic click after the first ~200ms uses the cached token, zero round-trip.
  const { voiceAvailable, isConnecting: voiceConnecting, isRecording: voiceRecording, startRecording: startVoice, stopRecording: stopVoice } = useVoiceInput({
    getToken: () => window.api.voice.getToken(),
    onTranscript: (finalText) => {
      setInput((prev) => {
        const sep = prev && !prev.endsWith(' ') ? ' ' : '';
        return prev + sep + finalText;
      });
    },
    onPartialTranscript: setPartialText,
    onError: (msg) => setError(msg),
    onVolumeChange: (rms) => { voiceVolumeRef.current = rms; },
  });

  const handleAgentEvent = useCallback((evt) => {
    if (!evt || !evt.type) return;
    if (evt.type === 'agent_start') {
      setRunning(true);
      currentThinkingIdRef.current = null;
      setError(null);
      setTokens(0);
      setElapsedMs(0);
      runStartRef.current = Date.now();
      if (tickerRef.current) clearInterval(tickerRef.current);
      tickerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - runStartRef.current);
      }, 200);
      return;
    }
    if (evt.type === 'agent_end') {
      setRunning(false);
      currentAssistantIdRef.current = null;
      // Freeze any still-open thinking block (guards a missing thinking_end).
      currentThinkingIdRef.current = null;
      setMessages((prev) => prev.map((m) => (m.kind === 'thinking' && !m.done ? { ...m, done: true } : m)));
      if (runStartRef.current) setElapsedMs(Date.now() - runStartRef.current);
      if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null; }
      return;
    }
    if (evt.type === 'turn_end') {
      // Pi's normalized Usage: { input, output, cacheRead, cacheWrite, totalTokens, cost }.
      // Sum totalTokens across turns — each turn re-pays for the context, so this
      // matches actual billed usage for the run.
      const total = evt.message?.usage?.totalTokens;
      if (typeof total === 'number') setTokens((prev) => prev + total);
      return;
    }
    if (evt.type === 'message_update') {
      const inner = evt.assistantMessageEvent;
      if (!inner) return;
      // Extended-thinking stream. Rendered as a collapsible block above the
      // assistant text — live "Thinking" (shimmer + spinner) while streaming,
      // frozen to a static "Thought" block on thinking_end.
      if (inner.type === 'thinking_start') {
        const id = nextId();
        currentThinkingIdRef.current = id;
        currentAssistantIdRef.current = null;
        setMessages((prev) => [...prev, { id, kind: 'thinking', text: '', done: false }]);
        return;
      }
      if (inner.type === 'thinking_delta') {
        const id = currentThinkingIdRef.current;
        const delta = inner.delta ?? '';
        if (!id) {
          const newId = nextId();
          currentThinkingIdRef.current = newId;
          setMessages((prev) => [...prev, { id: newId, kind: 'thinking', text: delta, done: false }]);
          return;
        }
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)));
        return;
      }
      if (inner.type === 'thinking_end') {
        const id = currentThinkingIdRef.current;
        currentThinkingIdRef.current = null;
        if (id) setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, done: true } : m)));
        return;
      }
      if (inner.type === 'text_start') {
        const id = nextId();
        currentAssistantIdRef.current = id;
        setMessages((prev) => [...prev, { id, kind: 'assistant', text: '' }]);
        return;
      }
      if (inner.type === 'text_delta') {
        const id = currentAssistantIdRef.current;
        if (!id) {
          const newId = nextId();
          currentAssistantIdRef.current = newId;
          setMessages((prev) => [...prev, { id: newId, kind: 'assistant', text: inner.delta ?? '' }]);
          return;
        }
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + (inner.delta ?? '') } : m)));
        return;
      }
      return;
    }
    if (evt.type === 'tool_execution_start') {
      currentAssistantIdRef.current = null;
      currentThinkingIdRef.current = null;
      const id = nextId();
      setMessages((prev) => [...prev, {
        id,
        kind: 'tool',
        toolCallId: evt.toolCallId,
        toolName: evt.toolName,
        args: evt.args,
        output: '',
        isError: false,
        done: false,
      }]);
      return;
    }
    if (evt.type === 'tool_execution_update') {
      setMessages((prev) => prev.map((m) => (
        m.kind === 'tool' && m.toolCallId === evt.toolCallId
          ? { ...m, output: formatToolResult(evt.partialResult) }
          : m
      )));
      return;
    }
    if (evt.type === 'tool_execution_end') {
      setMessages((prev) => prev.map((m) => (
        m.kind === 'tool' && m.toolCallId === evt.toolCallId
          ? { ...m, output: formatToolResult(evt.result), isError: !!evt.isError, done: true }
          : m
      )));
      return;
    }
    if (evt.type === 'shockwave_session') {
      // Main tells us which saved chat is now active (on create/open/continue).
      setCurrentSessionId(evt.sessionId ?? null);
      setSessionTitle(evt.title ?? null);
      setSessionStarred(!!evt.starred);
      return;
    }
    if (evt.type === 'shockwave_session_titled') {
      // Auto-title landed (fire-and-forget) — reflect it if it's the live chat.
      setCurrentSessionId((cur) => {
        if (cur === evt.sessionId) setSessionTitle(evt.title ?? null);
        return cur;
      });
      return;
    }
    if (evt.type === 'agent_send_failed') {
      // Main popped the bad user+failure messages from pi state. Mirror by
      // removing the matching user message from our transcript and surfacing
      // the provider error in the banner.
      const badId = lastSentUserIdRef.current;
      lastSentUserIdRef.current = null;
      setMessages((prev) => prev.filter((m) => m.id !== badId));
      setError(evt.errorMessage ?? 'Send failed.');
      return;
    }
  }, []);

  const onSend = useCallback(async () => {
    // Commit any in-flight partial transcript before submitting. The textarea
    // displays input+partial as one string, so the user expects the partial
    // they just said to be part of what gets sent.
    let typed = input.trim();
    if (partialText) {
      const sep = input && !input.endsWith(' ') ? ' ' : '';
      typed = (input + sep + partialText).trim();
      setInput(input + sep + partialText);
      setPartialText('');
    }
    if (!typed && attachments.length === 0) return;
    if (running) return;
    if (!workspacePath) {
      setError('Open a workspace first.');
      return;
    }
    setError(null);
    setRejected(null);

    const imageAttachments = attachments.filter((a) => a.kind === 'image');
    const textAttachments = attachments.filter((a) => a.kind === 'text');
    const promptText = composePromptText(typed, textAttachments);
    const images = toImageContents(imageAttachments);

    const userId = nextId();
    lastSentUserIdRef.current = userId;
    setMessages((prev) => [...prev, {
      id: userId,
      kind: 'user',
      text: typed,
      attachments: attachments.map((a) => ({ ...a })),
    }]);
    setInput('');
    setAttachments([]);
    setRunning(true);
    try {
      await window.api.agent.send(promptText, images);
    } catch (err: any) {
      setRunning(false);
      setError(err?.message ?? String(err));
    }
  }, [input, partialText, attachments, running, workspacePath]);

  const onStop = useCallback(async () => {
    try { await window.api.agent.abort(); } catch { /* abort is best-effort */ }
  }, []);

  const onClear = useCallback(async () => {
    try { await window.api.agent.reset(); } catch { /* reset is best-effort */ }
    if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null; }
    currentAssistantIdRef.current = null;
    lastSentUserIdRef.current = null;
    setMessages([]);
    setError(null);
    setRunning(false);
    setTokens(0);
    setElapsedMs(0);
    setAttachments([]);
    setRejected(null);
    setCurrentSessionId(null);
    setSessionTitle(null);
    setSessionStarred(false);
    setRenamingTitle(false);
  }, []);

  // Star / unstar the active chat (header star button).
  const onToggleHeaderStar = useCallback(async () => {
    if (!currentSessionId) return;
    const next = !sessionStarred;
    setSessionStarred(next);
    try { await window.api.chat.setStarred({ sessionId: currentSessionId, starred: next }); }
    catch { setSessionStarred(!next); }
  }, [currentSessionId, sessionStarred]);

  // Inline rename of the active chat's title (double-click the header title).
  const startRename = useCallback(() => {
    if (!currentSessionId) return;
    setTitleDraft(sessionTitle ?? '');
    setRenamingTitle(true);
  }, [currentSessionId, sessionTitle]);

  const commitRename = useCallback(async () => {
    const title = titleDraft.trim();
    setRenamingTitle(false);
    if (!currentSessionId || !title || title === sessionTitle) return;
    setSessionTitle(title);
    try { await window.api.chat.renameSession({ sessionId: currentSessionId, title }); }
    catch { /* rename is best-effort */ }
  }, [currentSessionId, titleDraft, sessionTitle]);

  // Open a saved chat from the history popover: hydrate the transcript from the
  // DB and hand pi the session so the next send continues it.
  const onOpenSession = useCallback(async (sessionId) => {
    setShowHistory(false);
    if (sessionId === currentSessionId) return;
    try {
      const { session, messages: rows } = await window.api.chat.openSession(sessionId);
      if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null; }
      currentAssistantIdRef.current = null;
      currentThinkingIdRef.current = null;
      lastSentUserIdRef.current = null;
      setMessages(hydrateMessages(rows || []));
      setCurrentSessionId(sessionId);
      setSessionTitle(session?.title ?? null);
      setSessionStarred(!!session?.starred);
      setRenamingTitle(false);
      setError(null);
      setRunning(false);
      setTokens(0);
      setElapsedMs(0);
      setAttachments([]);
      setRejected(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  }, [currentSessionId]);

  const ingestFiles = useCallback(async (fileList) => {
    const files = [...(fileList ?? [])];
    if (files.length === 0) return;
    const added: any[] = [];
    const failures: any[] = [];
    for (const file of files) {
      const kind = classify(file);
      if (!kind) {
        failures.push({ name: file.name, reason: 'unsupported format' });
        continue;
      }
      try {
        if (kind === 'image') {
          const base64 = await readAsBase64(file);
          const mimeType = file.type;
          const dataUrl = `data:${mimeType};base64,${base64}`;
          added.push({
            id: nextAttachmentId(),
            kind: 'image',
            name: file.name || 'image',
            mimeType,
            bytes: file.size,
            base64,
            dataUrl,
          });
        } else {
          const content = await readAsText(file);
          added.push({
            id: nextAttachmentId(),
            kind: 'text',
            name: file.name,
            bytes: file.size,
            content,
          });
        }
      } catch (err: any) {
        failures.push({ name: file.name, reason: err?.message ?? String(err) });
      }
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    if (failures.length === 1) {
      setRejected(failures[0]);
    } else if (failures.length > 1) {
      const first = failures[0];
      setRejected({
        name: `${failures.length} files`,
        reason: `${first.name}: ${first.reason} (+${failures.length - 1} more)`,
      });
    }
  }, []);

  const removeAttachment = useCallback((id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileInputChange = useCallback(async (e) => {
    await ingestFiles(e.target.files);
    e.target.value = '';
  }, [ingestFiles]);

  const onPaste = useCallback(async (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const anyImage = [...files].some((f) => f.type.startsWith('image/'));
      if (anyImage) {
        e.preventDefault();
        await ingestFiles(files);
      }
    }
  }, [ingestFiles]);

  // Direct addEventListener — react-dnd-html5-backend registers a window-level
  // capture-phase drop handler that pre-empts React's synthetic onDrop. Same
  // pattern as src/imagePaste.js. Drag enter/leave use a counter so child
  // elements don't flicker the overlay.
  useEffect(() => {
    const el = sidebarRootRef.current;
    if (!el) return;
    const hasFiles = (e) => {
      const types = e.dataTransfer?.types;
      return types && [...types].includes('Files');
    };
    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setDragOver(true);
    };
    const onOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setDragOver(false);
    };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dragCounterRef.current = 0;
      setDragOver(false);
      ingestFiles(e.dataTransfer.files);
    };
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragover', onOver);
    el.addEventListener('dragleave', onLeave);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragenter', onEnter);
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('dragleave', onLeave);
      el.removeEventListener('drop', onDrop);
    };
  }, [ingestFiles]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  // Imperative surface for the "Send to Agent" right-click flow in App.jsx.
  // setComposerText replaces or appends; focusComposer moves caret to end and
  // gives the textarea focus. Append uses a blank-line separator.
  useImperativeHandle(ref, () => ({
    setComposerText(text, { append = false } = {}) {
      setInput((prev) => (append && prev ? `${prev}\n\n${text}` : text));
    },
    getComposerText() {
      return input;
    },
    focusComposer() {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch { /* selection is cosmetic */ }
    },
  }), [input]);

  // Click anywhere in the sidebar that isn't an interactive element or active
  // text selection -> focus the composer textarea and put the caret at the end.
  // Matches the common chat-UI pattern (Slack, Discord, etc.).
  const onSidebarClick = useCallback((e) => {
    if (e.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try { el.setSelectionRange(len, len); } catch { /* selection is cosmetic */ }
  }, []);

  return (
    <div className="chat-sidebar" role="region" aria-label="Coding agent chat" ref={sidebarRootRef} onClick={onSidebarClick}>
      {dragOver && (
        <div className="chat-dropzone-overlay" aria-hidden="true">
          <div className="chat-dropzone-message">Drop to attach</div>
        </div>
      )}
      <div className="chat-sidebar-header">
        <button
          type="button"
          className="chat-sidebar-clear"
          onClick={onClear}
          title="Start a new chat"
          aria-label="New chat"
        ><PlusIcon size={15} /></button>
        <button
          type="button"
          className={`chat-sidebar-history ${showHistory ? 'chat-sidebar-history-active' : ''}`}
          onClick={() => setShowHistory((v) => !v)}
          title="Chat history"
          aria-label="Chat history"
          aria-expanded={showHistory}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width={15}
            height={15}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 3v5h5" />
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
            <path d="M12 7v5l4 2" />
          </svg>
        </button>
        <span className="chat-sidebar-title">
          {renamingTitle ? (
            <input
              className="chat-sidebar-title-input"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                else if (e.key === 'Escape') { e.preventDefault(); setRenamingTitle(false); }
              }}
            />
          ) : (
            <span
              className="chat-sidebar-title-text"
              onDoubleClick={startRename}
              title={currentSessionId ? 'Double-click to rename' : undefined}
            >{sessionTitle || 'Agent Chat'}</span>
          )}
        </span>
        {currentSessionId && (
          <button
            type="button"
            className={`chat-sidebar-star ${sessionStarred ? 'chat-sidebar-star-on' : ''}`}
            onClick={onToggleHeaderStar}
            title={sessionStarred ? 'Unstar chat' : 'Star chat'}
            aria-label={sessionStarred ? 'Unstar chat' : 'Star chat'}
            aria-pressed={sessionStarred}
          ><StarIcon size={15} filled={sessionStarred} /></button>
        )}
        <button
          type="button"
          className="chat-sidebar-close"
          onClick={onClose}
          title="Collapse coding agent"
          aria-label="Collapse coding agent"
        ><PanelRightCloseIcon size={14} /></button>
      </div>
      {showHistory && (
        <HistoryPopover
          currentSessionId={currentSessionId}
          onSelect={onOpenSession}
          onClose={() => setShowHistory(false)}
        />
      )}

      <div ref={scrollRef} className="chat-messages">
        <ChatWorkspaceContext.Provider value={workspacePath}>
          {messages.map((m) => <MessageRow key={m.id} message={m} />)}
        </ChatWorkspaceContext.Provider>
        {running && (
          <div className="chat-thinking">
            <SpinnerIcon />
            <span className="thinking-shimmer">Working</span>
            <span className="chat-thinking-stats">
              {formatElapsed(elapsedMs)}
              {tokens > 0 && ` · ${formatTokens(tokens)} tokens`}
            </span>
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}
      </div>

      <div className="chat-composer">
        {attachments.length > 0 && (
          <AttachmentRow attachments={attachments} onRemove={removeAttachment} />
        )}
        {rejected && (
          <div className="chat-attachment-error">
            <span>{rejected.name}: {rejected.reason}</span>
            <button type="button" onClick={() => setRejected(null)} aria-label="Dismiss"><XIcon size={12} /></button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="chat-input"
          value={input + (partialText ? (input && !input.endsWith(' ') ? ' ' : '') + partialText : '')}
          placeholder="Ask the agent…"
          onChange={(e) => { setInput(e.target.value); setPartialText(''); }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,.txt,.md,.markdown,.py,.js,.jsx,.ts,.tsx,.mjs,.cjs,.json,.jsonc,.yaml,.yml,.toml,.html,.htm,.css,.scss,.sass,.less,.xml,.svg,.csv,.tsv,.log,.sh,.bash,.zsh,.fish,.ps1,.rb,.go,.rs,.java,.kt,.swift,.c,.cpp,.cc,.h,.hpp,.m,.mm,.sql,.ini,.conf,.env,.gitignore,.gitattributes,.dockerfile,.lock,.properties,.gradle,.cmake"
          style={{ display: 'none' }}
          onChange={onFileInputChange}
        />
        <div className="chat-composer-actions">
          <button
            type="button"
            className="chat-attach-btn"
            onClick={onPickFiles}
            disabled={running}
            title="Attach images or text files"
            aria-label="Attach files"
          ><PaperclipIcon size={14} /></button>
          {voiceAvailable && (
            <button
              type="button"
              className="chat-voice-btn"
              data-state={voiceRecording ? 'recording' : voiceConnecting ? 'connecting' : 'idle'}
              onClick={voiceRecording ? stopVoice : startVoice}
              disabled={running || voiceConnecting}
              title={voiceRecording ? 'Stop recording' : voiceConnecting ? 'Connecting…' : 'Voice input'}
              aria-label={voiceRecording ? 'Stop recording' : 'Start voice input'}
            >
              {voiceRecording
                ? <VoiceBars volumeRef={voiceVolumeRef} isRecording={voiceRecording} />
                : <MicIcon size={14} />}
            </button>
          )}
          {running ? (
            <button
              type="button"
              className="chat-stop-btn"
              onClick={onStop}
              title="Stop"
              aria-label="Stop"
            ><StopIcon size={14} /></button>
          ) : (
            <button
              type="button"
              className="chat-send-btn"
              onClick={onSend}
              disabled={(!input.trim() && !partialText.trim() && attachments.length === 0) || !workspacePath}
              title="Send"
              aria-label="Send"
            ><PlayIcon size={14} /></button>
          )}
        </div>
      </div>
    </div>
  );
});

export default ChatSidebar;
