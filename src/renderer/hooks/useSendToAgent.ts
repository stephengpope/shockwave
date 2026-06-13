import { useState, useRef, useEffect, useCallback } from 'react';
import type { MutableRefObject } from 'react';

// The imperative surface ChatSidebar exposes via useImperativeHandle.
interface ChatSidebarHandle {
  setComposerText: (text: string, opts: { append: boolean }) => void;
  getComposerText?: () => string;
  focusComposer: () => void;
}

interface SendToAgentInfo {
  hasSelection?: boolean;
  selection?: string;
  fromLine?: number;
  fromCol?: number;
  toLine?: number;
  toCol?: number;
  line?: number;
  col?: number;
}

// One selected Excalidraw element, summarized for the agent.
export interface DrawingSelectionItem {
  id: string;
  type: string;
  text?: string;
}

interface UseSendToAgentOpts {
  workspacePath: string | null;
  activeFile: string | null;
  // Chat-sidebar open state lives in App (resize feature); we read/flip it to
  // expand the sidebar before injecting.
  chatSidebarOpenRef: MutableRefObject<boolean>;
  setChatSidebarOpen: (open: boolean) => void;
  persistChatSidebar: () => void;
}

// "Send to Agent": builds a framing snippet for the active file's selection or
// cursor and injects it into the chat composer, expanding the sidebar first if
// needed and draining the injection once the sidebar's imperative ref attaches.
export function useSendToAgent({
  workspacePath,
  activeFile,
  chatSidebarOpenRef,
  setChatSidebarOpen,
  persistChatSidebar,
}: UseSendToAgentOpts) {
  // Snippet awaiting a Replace/Append decision (non-null while that dialog is open).
  const [sendToAgentPending, setSendToAgentPending] = useState<string | null>(null);

  // Callback ref + ready flag so the pending-injection effect re-runs when
  // ChatSidebar mounts (it's unmounted while the sidebar is collapsed).
  const chatSidebarRef = useRef<ChatSidebarHandle | null>(null);
  const [chatSidebarReady, setChatSidebarReady] = useState(false);
  const setChatSidebarRef = useCallback((handle: ChatSidebarHandle | null) => {
    chatSidebarRef.current = handle;
    setChatSidebarReady(!!handle);
  }, []);

  // { text, append } waiting for the sidebar's imperative ref to attach.
  const [pendingComposerInjection, setPendingComposerInjection] = useState<{ text: string; append: boolean } | null>(null);

  const buildSendToAgentSnippet = useCallback((payload: SendToAgentInfo & { relPath?: string }) => {
    if (!workspacePath || !payload?.relPath) return '';
    const { relPath } = payload;
    if (payload.hasSelection) {
      return (
        `I've copied the selected text below from ${relPath} at line ${payload.fromLine}, column ${payload.fromCol} to line ${payload.toLine}, column ${payload.toCol}:\n\n` +
        `~~~\n${payload.selection}\n~~~\n\n`
      );
    }
    return `My cursor is at line ${payload.line}, column ${payload.col} in ${relPath}.\n\n`;
  }, [workspacePath]);

  // Framing snippet for an Excalidraw drawing: the cwd-relative file path plus a
  // summary of the selected elements (the agent reads the .excalidraw JSON
  // itself; the ids/types just tell it which elements the user means).
  const buildDrawingSnippet = useCallback((relPath: string, selected: DrawingSelectionItem[]) => {
    if (!relPath) return '';
    if (selected && selected.length) {
      const lines = selected
        .map((e) => `- ${e.type}${e.text ? ` "${e.text}"` : ''} (id: ${e.id})`)
        .join('\n');
      return (
        `I'm working on the Excalidraw drawing ${relPath}. ` +
        `These ${selected.length} element(s) are selected — read the file for their full data:\n${lines}\n\n`
      );
    }
    return `I'm working on the Excalidraw drawing ${relPath} (no elements selected). Read the file to see its contents.\n\n`;
  }, []);

  const applySendToAgent = useCallback((snippet: string, { append }: { append: boolean }) => {
    if (!chatSidebarOpenRef.current) {
      chatSidebarOpenRef.current = true;
      setChatSidebarOpen(true);
      persistChatSidebar();
    }
    // Either fires immediately (sidebar already open + ref attached) or once
    // the mount completes and the callback ref flips chatSidebarReady to true.
    setPendingComposerInjection({ text: snippet, append });
  }, [chatSidebarOpenRef, setChatSidebarOpen, persistChatSidebar]);

  // Drain a pending composer injection once the sidebar's ref is attached.
  useEffect(() => {
    if (!chatSidebarReady || !pendingComposerInjection) return;
    const { text, append } = pendingComposerInjection;
    chatSidebarRef.current?.setComposerText(text, { append });
    requestAnimationFrame(() => chatSidebarRef.current?.focusComposer());
    setPendingComposerInjection(null);
  }, [chatSidebarReady, pendingComposerInjection]);

  // Prefix the workspace-relative path with `[cwd]/` so the agent reads it as
  // "relative to your cwd" (which pi sets to the active workspace).
  const cwdRelPath = useCallback(() => {
    if (!activeFile) return '';
    let rel = activeFile;
    if (workspacePath && activeFile.startsWith(workspacePath)) {
      rel = activeFile.slice(workspacePath.length).replace(/^\/+/, '');
    }
    return `[cwd]/${rel}`;
  }, [workspacePath, activeFile]);

  // Inject a built snippet: expand the sidebar and drop it in, but if the
  // composer already has text, ask Replace/Append first.
  const injectOrAsk = useCallback((snippet: string) => {
    if (!snippet) return;
    // Sidebar closed → composer guaranteed empty (component unmounted). Sidebar
    // open → ask before clobbering existing text.
    if (chatSidebarOpenRef.current) {
      const existing = chatSidebarRef.current?.getComposerText?.() ?? '';
      if (existing.trim()) {
        setSendToAgentPending(snippet);
        return;
      }
    }
    applySendToAgent(snippet, { append: false });
  }, [chatSidebarOpenRef, applySendToAgent]);

  const onSendToAgent = useCallback((info: SendToAgentInfo) => {
    if (!workspacePath || !activeFile) return;
    injectOrAsk(buildSendToAgentSnippet({ ...info, relPath: cwdRelPath() }));
  }, [workspacePath, activeFile, cwdRelPath, buildSendToAgentSnippet, injectOrAsk]);

  // Drawing equivalent: send the file path + selected-element summary.
  const onSendDrawingToAgent = useCallback((selected: DrawingSelectionItem[]) => {
    if (!workspacePath || !activeFile) return;
    injectOrAsk(buildDrawingSnippet(cwdRelPath(), selected));
  }, [workspacePath, activeFile, cwdRelPath, buildDrawingSnippet, injectOrAsk]);

  return { onSendToAgent, onSendDrawingToAgent, setChatSidebarRef, sendToAgentPending, setSendToAgentPending, applySendToAgent };
}
