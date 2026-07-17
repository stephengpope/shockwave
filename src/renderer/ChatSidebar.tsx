import React, { createContext, forwardRef, memo, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronRight, Sparkles, KeyRound } from 'lucide-react';
import { PaperclipIcon, PlayIcon, StopIcon, XIcon, FileTextIcon, MicIcon, PanelRightCloseIcon, CopyIcon, CheckIcon, SearchIcon, PlusIcon, TrashIcon } from './Icons.jsx';
import { cn } from '@/lib/utils';
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
import * as chatStore from './chatStore.js';
import { EMPTY_CHAT } from './chatStore.js';
import ConfirmDialog from './ConfirmDialog.jsx';

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
function MarkdownLink({ href, children, ...rest }: any) {
  return (
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
  );
}

// Proper component (not an inline arrow in the map) so the useContext call
// satisfies the rules-of-hooks.
function MarkdownImg({ src, alt, ...rest }: any) {
  const ws = useContext(ChatWorkspaceContext);
  const resolved = typeof src === 'string' ? resolveImageUrl(src, ws, ws) : null;
  if (!resolved) return <>{alt || ''}</>;
  return <img {...rest} src={resolved} alt={alt || ''} loading="lazy" />;
}

const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImg,
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

// Per-tool detail rendering for the expanded view header (above the output).
// Keep these terse — the collapsed-summary line already shows the headline arg.
// Shared styling for the expanded tool-args area (JetBrains Mono, quiet).
const toolArgsClass = 'mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground';
const toolArgPathClass = 'font-mono text-[11px] text-muted-foreground break-all';

function ToolArgsDetail({ toolName, args }) {
  const a = args ?? {};
  if (toolName === 'bash') {
    return (
      <pre className={toolArgsClass}>
        <span className="select-none text-muted-2">$ </span>{a.command ?? ''}
      </pre>
    );
  }
  if (toolName === 'edit' && Array.isArray(a.edits)) {
    return (
      <div className={toolArgsClass}>
        <div className={toolArgPathClass}>{a.path ?? ''}</div>
        {a.edits.map((e, i) => (
          <div key={i} className="mt-1">
            {String(e?.oldText ?? '').split('\n').map((ln, j) => (
              <div key={`o${j}`} className="text-destructive/80">- {ln}</div>
            ))}
            {String(e?.newText ?? '').split('\n').map((ln, j) => (
              <div key={`n${j}`} className="text-success">+ {ln}</div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (toolName === 'write') {
    return <div className={`${toolArgsClass} ${toolArgPathClass}`}>{a.path ?? ''}</div>;
  }
  if (toolName === 'read' || toolName === 'ls') {
    return <div className={`${toolArgsClass} ${toolArgPathClass}`}>{a.path ?? ''}</div>;
  }
  if (toolName === 'grep' || toolName === 'find') {
    return (
      <div className={toolArgsClass}>
        <div><span className="font-semibold text-muted-2">pattern</span> {a.pattern ?? ''}</div>
        {a.path && <div><span className="font-semibold text-muted-2">path</span> {a.path}</div>}
      </div>
    );
  }
  let block = '';
  try { block = JSON.stringify(a, null, 2); } catch { block = String(a); }
  return <pre className={toolArgsClass}>{block}</pre>;
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
    <div className="group relative">
      {att.kind === 'image' ? (
        <button
          type="button"
          className="block size-12 rounded-lg border border-border bg-cover bg-center"
          onClick={handleClick}
          title={att.name}
          style={{ backgroundImage: `url("${att.dataUrl}")` }}
          aria-label={att.name}
        />
      ) : (
        <div
          className="flex max-w-40 items-center gap-1.5 rounded-lg border border-border bg-raise px-2 py-1.5"
          title={`${att.name} · ${formatBytes(att.bytes)}`}
        >
          <span className="shrink-0 text-muted-foreground"><FileTextIcon size={16} /></span>
          <span className="truncate text-[11px] text-foreground/85">{att.name}</span>
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm hover:text-foreground group-hover:opacity-100"
          onClick={() => onRemove(att.id)}
          aria-label={`Remove ${att.name}`}
        ><XIcon size={10} /></button>
      )}
    </div>
  );
}

function AttachmentRow({ attachments, onRemove }: any) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <AttachmentChip key={a.id} att={a} onRemove={onRemove ?? null} />
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
      className="mt-1 flex size-5 items-center justify-center rounded-sm text-muted-2 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/message:opacity-100"
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
    // Right-aligned indigo bubble with an asymmetric radius "tail" (spec §6).
    return (
      <div className="group/message flex flex-col items-end">
        <div className="max-w-[82%] rounded-[16px_16px_5px_16px] bg-primary px-[13px] py-[9px] text-[13px] leading-[1.45] text-primary-foreground">
          {m.attachments && m.attachments.length > 0 && (
            <div className="mb-1.5"><AttachmentRow attachments={m.attachments} /></div>
          )}
          {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
        </div>
        {m.text && <CopyButton text={m.text} />}
      </div>
    );
  }
  if (m.kind === 'assistant') {
    // No bubble — full-width flowing text. The asymmetry IS the hierarchy.
    return (
      <div className="group/message flex flex-col items-start">
        <div className="chat-markdown w-full max-w-full text-[13.5px] leading-[1.6] text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS as any}>{m.text}</ReactMarkdown>
        </div>
        {m.text && <CopyButton text={m.text} />}
      </div>
    );
  }
  if (m.kind === 'thinking') {
    return <ThinkingEntry entry={m} />;
  }
  if (m.kind === 'tool') {
    return <ToolEntry entry={m} />;
  }
  return null;
});

// Rotating loader ring — the same mark as the "Working" indicator (below).
function SpinnerIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="animate-spin"
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
    // Demoted aside (spec §6): small caption + chevron, body behind a 2px rule.
    <div className="flex flex-col gap-[5px]">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-2 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {collapsedDone
          ? <ChevronRight className="size-3" strokeWidth={2.2} />
          : <ChevronDown className="size-3" strokeWidth={2.2} />}
        {streaming
          ? (<><SpinnerIcon /><span className="thinking-shimmer">Thinking</span></>)
          : (<span>Thought</span>)}
      </button>
      {(!entry.done || open) && entry.text && (
        <div className="whitespace-pre-wrap border-l-2 border-border pl-[11px] text-[13px] leading-[1.55] text-muted-foreground">{entry.text}</div>
      )}
    </div>
  );
}

function ToolEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const running = !entry.done;
  return (
    // One-line quiet card (spec §6): chevron + status + mono command, truncated.
    <div
      className={cn(
        'rounded-[10px] border border-border bg-raise px-2.5 py-[7px]',
        entry.isError && 'border-destructive/30',
      )}
    >
      <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        {open
          ? <ChevronDown className="size-[13px] shrink-0 text-muted-2" strokeWidth={2.2} />
          : <ChevronRight className="size-[13px] shrink-0 text-muted-2" strokeWidth={2.2} />}
        <span className={cn('w-3 shrink-0 text-[11px] leading-none', entry.isError ? 'text-destructive' : 'text-success')}>
          {running ? <SpinnerIcon size={11} /> : entry.isError ? '✗' : '✓'}
        </span>
        <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground">{entry.toolName}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">{toolSummary(entry.toolName, entry.args)}</span>
      </button>
      {open && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <ToolArgsDetail toolName={entry.toolName} args={entry.args} />
          {(entry.output || running) && (
            <div className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground/90">
              <span>{entry.output}</span>
              {running && <span className="animate-pulse" aria-hidden="true">▌</span>}
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
function HistoryPopover({ currentSessionId, onSelect, onClose, runningIds, onDeleted }: any) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  // Pending delete confirmation: { sessionId, title } | null.
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const confirmDeleteRef = useRef<any>(null);
  confirmDeleteRef.current = confirmDelete;
  const rootRef = useRef<any>(null);
  const searching = query.trim().length > 0;

  // Dismiss on any click/focus outside the popover (ignoring the header toggle,
  // which owns its own open/close), or on Escape. Suspended while the delete
  // confirmation is up — its portal renders outside the popover, and Escape
  // there should close the dialog, not the popover.
  useEffect(() => {
    const onDown = (e) => {
      if (confirmDeleteRef.current) return;
      const t = e.target;
      if (rootRef.current?.contains(t)) return;
      if (t?.closest?.('.chat-history-toggle')) return; // let the toggle handle itself
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape' && !confirmDeleteRef.current) onClose(); };
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

  const onDelete = useCallback((e, it) => {
    e.stopPropagation();
    setConfirmDelete({ sessionId: it.sessionId, title: it.title });
  }, []);

  const performDelete = useCallback(async (sessionId) => {
    await window.api.chat.deleteSession(sessionId);
    setItems((prev) => prev.filter((x) => x.sessionId !== sessionId));
    setStarredList((prev) => prev.filter((x) => x.sessionId !== sessionId));
    onDeleted?.(sessionId);
  }, [onDeleted]);

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
      className={cn(
        'group/row flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent',
        it.sessionId === currentSessionId && 'bg-selected hover:bg-selected',
      )}
      onClick={() => onSelect(it.sessionId)}
    >
      <span
        role="button"
        tabIndex={0}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-2 hover:text-foreground',
          isStarred && 'text-amber-500 hover:text-amber-500',
        )}
        onClick={(e) => onToggleStar(e, it.sessionId, isStarred)}
        aria-label={isStarred ? 'Unstar chat' : 'Star chat'}
        title={isStarred ? 'Unstar' : 'Star'}
      ><StarIcon size={13} filled={isStarred} /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12.5px] text-foreground">{it.title || 'Untitled chat'}</span>
        {searching && it.snippet && <span className="truncate text-[11px] text-muted-2">{it.snippet}</span>}
      </span>
      {runningIds?.has(it.sessionId) ? (
        <span className="shrink-0 text-primary" title="Responding…" aria-label="Responding"><SpinnerIcon size={12} /></span>
      ) : (
        !searching && <span className="shrink-0 text-[11px] text-muted-2">{formatAgo(it.updatedAt)}</span>
      )}
      <span
        role="button"
        tabIndex={0}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-2 opacity-0 hover:text-destructive group-hover/row:opacity-100"
        onClick={(e) => onDelete(e, it)}
        aria-label="Delete chat"
        title="Delete chat"
      ><TrashIcon size={12} /></span>
    </button>
  );

  const showStarred = !searching && starred.length > 0;
  const empty = items.length === 0 && !showStarred && !loading;

  return (
    <div
      className="absolute left-2 right-2 top-12 z-30 flex max-h-96 flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-md"
      role="dialog"
      aria-label="Chat history"
      ref={rootRef}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-muted-2">
        <SearchIcon size={13} />
        <input
          type="text"
          className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-2"
          placeholder="Search chats…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-1" onScroll={onScroll}>
        {empty && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">{searching ? 'No matches' : 'No saved chats yet'}</div>
        )}
        {showStarred && (
          <>
            <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-2">Starred</div>
            {starred.map((it) => renderRow(it, true))}
            {items.length > 0 && <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-2">Recent</div>}
          </>
        )}
        {items.map((it) => renderRow(it, false))}
      </div>
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          const pending = confirmDelete;
          setConfirmDelete(null);
          if (pending) performDelete(pending.sessionId);
        }}
        title="Delete chat?"
        message={
          `"${confirmDelete?.title || 'Untitled chat'}" and its messages will be permanently deleted.` +
          (runningIds?.has(confirmDelete?.sessionId) ? ' This chat is currently responding — the response will be stopped.' : '')
        }
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}

const ChatSidebar = forwardRef<any, any>(function ChatSidebar({ onClose, workspacePath, onOpenSecrets }, ref) {
  // All chat state (transcripts, running flags, drafts, counters) lives in
  // chatStore — OUTSIDE this component — so background chats keep streaming
  // and nothing is lost when the sidebar collapses (unmount) or the workspace
  // switches (remount). This component is a view over the active chat's entry.
  // The store owns the single agent-event subscription; there is none here.
  const snap = useSyncExternalStore(chatStore.subscribe, chatStore.getState);
  const currentSessionId = workspacePath ? snap.activeByWorkspace[workspacePath] ?? null : null;
  const chat = (currentSessionId && snap.chats[currentSessionId]) || EMPTY_CHAT;
  const chatIdRef = useRef<string | null>(currentSessionId);
  chatIdRef.current = currentSessionId;

  // Mint the workspace's active chat on mount / workspace switch.
  useEffect(() => {
    if (workspacePath) chatStore.ensureActiveChat(workspacePath);
  }, [workspacePath]);

  const { messages, running, error, tokens, queuedCount, attachments } = chat;
  const input = chat.draft;
  const sessionTitle = chat.title;
  const sessionStarred = chat.starred;

  // Chats with a turn in flight (any workspace) — drives the history spinner.
  const runningIds = useMemo(
    () => new Set(Object.keys(snap.chats).filter((id) => snap.chats[id].running)),
    [snap.chats],
  );

  // Local view-only state.
  const [rejected, setRejected] = useState<any>(null); // { name, reason }
  const [dragOver, setDragOver] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // Voice input — partialText is the in-flight AssemblyAI partial transcript
  // (replaced as the model refines, then committed into `input` on end_of_turn).
  const [partialText, setPartialText] = useState('');
  const voiceVolumeRef = useRef(0);
  const scrollRef = useRef<any>(null);
  const textareaRef = useRef<any>(null);
  const fileInputRef = useRef<any>(null);
  const sidebarRootRef = useRef<any>(null);
  const dragCounterRef = useRef(0);

  // Elapsed ticker — display-only, derived from the store's runStartAt so the
  // store isn't churned 5×/sec. Just re-renders this component while running.
  const [, forceTick] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    if (!running || !chat.runStartAt) return;
    const t = setInterval(forceTick, 200);
    return () => clearInterval(t);
  }, [running, chat.runStartAt]);
  const elapsedMs = running && chat.runStartAt ? Date.now() - chat.runStartAt : chat.elapsedMs;

  // Store-backed setters with the local-state call shapes the handlers below
  // (and the voice hook) expect. Each resolves the chat id at call time via
  // chatIdRef so stable closures always hit the active chat.
  const setInput = useCallback((value: any) => {
    const id = chatIdRef.current ?? (workspacePath ? chatStore.ensureActiveChat(workspacePath) : null);
    if (!id) return;
    const next = typeof value === 'function' ? value(chatStore.getState().chats[id]?.draft ?? '') : value;
    chatStore.setDraft(id, next);
  }, [workspacePath]);

  const setAttachments = useCallback((updater: any) => {
    const id = chatIdRef.current ?? (workspacePath ? chatStore.ensureActiveChat(workspacePath) : null);
    if (!id) return;
    chatStore.setAttachments(id, typeof updater === 'function' ? updater : () => updater);
  }, [workspacePath]);

  const setError = useCallback((message: any) => {
    const id = chatIdRef.current;
    if (id) chatStore.setError(id, message);
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

  const onSend = useCallback(async () => {
    // Commit any in-flight partial transcript before submitting. The textarea
    // displays input+partial as one string, so the user expects the partial
    // they just said to be part of what gets sent.
    let typed = input.trim();
    if (partialText) {
      const sep = input && !input.endsWith(' ') ? ' ' : '';
      typed = (input + sep + partialText).trim();
      setPartialText('');
    }
    if (!typed && attachments.length === 0) return;
    if (!workspacePath) return; // composer is disabled without a workspace
    const id = chatIdRef.current ?? chatStore.ensureActiveChat(workspacePath);
    setRejected(null);

    const imageAttachments = attachments.filter((a) => a.kind === 'image');
    const textAttachments = attachments.filter((a) => a.kind === 'text');
    const promptText = composePromptText(typed, textAttachments);
    const images = toImageContents(imageAttachments);

    chatStore.setDraft(id, '');
    chatStore.setAttachments(id, () => []);
    // If this chat is mid-turn, main steers the message into the running turn.
    await chatStore.sendToChat(id, {
      text: typed,
      promptText,
      images,
      attachments: attachments.map((a) => ({ ...a })),
    });
  }, [input, partialText, attachments, workspacePath]);

  const onStop = useCallback(async () => {
    const id = chatIdRef.current;
    if (id) await chatStore.abortChat(id);
  }, []);

  // "New chat": mint a fresh entry and switch to it. The previous chat is
  // untouched — if it's mid-turn it keeps running in the background (spinner
  // in the history popover; its transcript keeps accumulating in the store).
  const onClear = useCallback(() => {
    if (!workspacePath) return;
    chatStore.newChat(workspacePath);
    setRejected(null);
    setRenamingTitle(false);
    setPartialText('');
  }, [workspacePath]);

  // Star / unstar the active chat (header star button).
  const onToggleHeaderStar = useCallback(async () => {
    const id = chatIdRef.current;
    if (!id || !chat.persisted) return;
    const next = !sessionStarred;
    chatStore.setStarred(id, next);
    try { await window.api.chat.setStarred({ sessionId: id, starred: next }); }
    catch { chatStore.setStarred(id, !next); }
  }, [chat.persisted, sessionStarred]);

  // Inline rename of the active chat's title (double-click the header title).
  const startRename = useCallback(() => {
    if (!chatIdRef.current || !chat.persisted) return;
    setTitleDraft(sessionTitle ?? '');
    setRenamingTitle(true);
  }, [chat.persisted, sessionTitle]);

  const commitRename = useCallback(async () => {
    const id = chatIdRef.current;
    const title = titleDraft.trim();
    setRenamingTitle(false);
    if (!id || !title || title === sessionTitle) return;
    chatStore.setTitle(id, title);
    try { await window.api.chat.renameSession({ sessionId: id, title }); }
    catch { /* rename is best-effort */ }
  }, [titleDraft, sessionTitle]);

  // Open a saved chat from the history popover. Cold chats hydrate from the
  // DB; chats already in the store (e.g. running in the background) switch
  // instantly with their live transcript intact.
  const onOpenSession = useCallback(async (sessionId) => {
    setShowHistory(false);
    if (sessionId === chatIdRef.current) return;
    try {
      await chatStore.openChat(sessionId, workspacePath);
      setRenamingTitle(false);
      setRejected(null);
      setPartialText('');
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  }, [workspacePath, setError]);

  // A chat was deleted from the history popover (main already aborted +
  // disposed its live session). Drop it from the store; if it was the one on
  // screen, move to a fresh chat.
  const onDeletedSession = useCallback((sessionId) => {
    const wasActive = sessionId === chatIdRef.current;
    chatStore.removeChat(sessionId);
    if (wasActive && workspacePath) chatStore.newChat(workspacePath);
  }, [workspacePath]);

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
  }, [setAttachments]);

  const removeAttachment = useCallback((id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, [setAttachments]);

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
  }), [input, setInput]);

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

  const headerBtn = 'flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground';

  return (
    <div
      className="relative flex h-full min-h-0 flex-col border-l border-border bg-chat"
      role="region"
      aria-label="Coding agent chat"
      ref={sidebarRootRef}
      onClick={onSidebarClick}
    >
      {dragOver && (
        <div className="absolute inset-0 z-40 flex items-center justify-center rounded-none border-2 border-dashed border-primary bg-primary/5" aria-hidden="true">
          <div className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground">Drop to attach</div>
        </div>
      )}
      {/* 44px header: history left, avatar+title centered, collapse right (spec §6).
          No hairline — the gradient shim below softens the scroll joint instead. */}
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <button
          type="button"
          className={headerBtn}
          onClick={onClear}
          title="Start a new chat"
          aria-label="New chat"
        ><PlusIcon size={15} /></button>
        <button
          type="button"
          // 'chat-history-toggle' is an unstyled marker — HistoryPopover's
          // outside-click guard ignores clicks on it.
          className={cn('chat-history-toggle', headerBtn, showHistory && 'bg-selected text-primary hover:bg-selected hover:text-primary')}
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
        <span className="flex min-w-0 flex-1 items-center justify-center gap-[7px]">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="size-[13px]" strokeWidth={1.7} />
          </span>
          {renamingTitle ? (
            <input
              className="w-full max-w-48 rounded-sm border border-input bg-background px-1.5 py-0.5 text-[13px] font-semibold outline-none focus:border-ring"
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
              className="truncate text-[13px] font-semibold text-foreground"
              onDoubleClick={startRename}
              title={chat.persisted ? 'Double-click to rename' : undefined}
            >{sessionTitle || 'Agent Chat'}</span>
          )}
        </span>
        {chat.persisted && (
          <button
            type="button"
            className={cn(headerBtn, sessionStarred && 'text-amber-500 hover:text-amber-500')}
            onClick={onToggleHeaderStar}
            title={sessionStarred ? 'Unstar chat' : 'Star chat'}
            aria-label={sessionStarred ? 'Unstar chat' : 'Star chat'}
            aria-pressed={sessionStarred}
          ><StarIcon size={15} filled={sessionStarred} /></button>
        )}
        <button
          type="button"
          className={headerBtn}
          onClick={onClose}
          title="Collapse coding agent"
          aria-label="Collapse coding agent"
        ><PanelRightCloseIcon size={14} /></button>
      </div>
      {/* Soft fade over the transcript's top edge so scrolled text slides under the header. */}
      <div className="pointer-events-none absolute inset-x-0 top-11 z-10 h-5 bg-gradient-to-b from-chat to-transparent" aria-hidden="true" />
      {showHistory && (
        <HistoryPopover
          currentSessionId={currentSessionId}
          onSelect={onOpenSession}
          onClose={() => setShowHistory(false)}
          runningIds={runningIds}
          onDeleted={onDeletedSession}
        />
      )}

      {/* Conversation flows in Instrument Sans (spec §3/§6). */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-4 font-chat">
        <ChatWorkspaceContext.Provider value={workspacePath}>
          {messages.map((m) => <MessageRow key={m.id} message={m} />)}
        </ChatWorkspaceContext.Provider>
        {running && (
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-2">
            <SpinnerIcon />
            <span className="thinking-shimmer">Working</span>
            <span className="font-normal">
              {formatElapsed(elapsedMs)}
              {tokens > 0 && ` · ${formatTokens(tokens)} tokens`}
              {queuedCount > 0 && ` · ${queuedCount} queued`}
            </span>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{error}</div>
        )}
      </div>

      {/* Composer card: rounded 14px, lifted off the panel (spec §6). */}
      <div className="shrink-0 px-3 pb-3 pt-2.5">
        <div className="flex flex-col gap-2 rounded-[14px] border border-input bg-background px-3 py-2.5 shadow-(--shadow-raise)">
          {attachments.length > 0 && (
            <AttachmentRow attachments={attachments} onRemove={removeAttachment} />
          )}
          {rejected && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              <span className="min-w-0 truncate">{rejected.name}: {rejected.reason}</span>
              <button type="button" className="shrink-0 hover:opacity-70" onClick={() => setRejected(null)} aria-label="Dismiss"><XIcon size={12} /></button>
            </div>
          )}
        <textarea
          ref={textareaRef}
          className="max-h-44 w-full resize-none bg-transparent font-chat text-[13px] leading-normal text-foreground outline-none placeholder:text-muted-2"
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
        {/* Attach + API keys left, mic + square accent send right (spec §6). */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              onClick={onPickFiles}
              title="Attach images or text files"
              aria-label="Attach files"
            ><PaperclipIcon size={15} /></button>
            <button
              type="button"
              className="flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              onClick={onOpenSecrets}
              title="API secrets"
              aria-label="API secrets"
            ><KeyRound size={15} /></button>
          </div>
          {/* While running, Stop and Send coexist: Enter/Send steers the
              message into the running turn (pi queues it and delivers at the
              next step boundary). */}
          <div className="flex items-center gap-1.5">
            {voiceAvailable && (
              <button
                type="button"
                className={cn(
                  'flex h-[26px] min-w-[26px] items-center justify-center rounded-[7px] px-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
                  voiceRecording && 'bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive',
                )}
                onClick={voiceRecording ? stopVoice : startVoice}
                disabled={voiceConnecting}
                title={voiceRecording ? 'Stop recording' : voiceConnecting ? 'Connecting…' : 'Voice input'}
                aria-label={voiceRecording ? 'Stop recording' : 'Start voice input'}
              >
                {voiceRecording
                  ? <VoiceBars volumeRef={voiceVolumeRef} isRecording={voiceRecording} />
                  : <MicIcon size={15} />}
              </button>
            )}
            {running && (
              <button
                type="button"
                className="flex size-[29px] items-center justify-center rounded-[9px] bg-foreground/80 text-background hover:bg-foreground"
                onClick={onStop}
                title="Stop"
                aria-label="Stop"
              ><StopIcon size={14} /></button>
            )}
            <button
              type="button"
              className="flex size-[29px] items-center justify-center rounded-[9px] bg-primary text-primary-foreground hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-40"
              onClick={onSend}
              disabled={(!input.trim() && !partialText.trim() && attachments.length === 0) || !workspacePath}
              title={running ? 'Send (steers the running response)' : 'Send'}
              aria-label="Send"
            ><PlayIcon size={14} /></button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
});

export default ChatSidebar;
