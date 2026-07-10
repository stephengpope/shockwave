import React from 'react';
import { toRelPath } from './pathUtils';

// File extensions we render inline instead of loading into the text editor.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv|ogg)$/i;
const DRAWING_RE = /\.excalidraw$/i;

// Text/code files we open in the editor. `.md` is the default, but any of these
// opens too (rename a file to `.txt` in the tree and it's editable). Kept broad
// on purpose; binaries (pdf/zip/…) stay inert. Mirror in main's `OPENABLE_RE`.
const TEXT_RE = /\.(md|markdown|mdx|txt|text|log|org|rst|tex|bib|csv|tsv|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|properties|xml|html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|c|h|cpp|hpp|cc|hh|cs|php|swift|m|mm|sh|bash|zsh|fish|ps1|bat|sql|graphql|gql|lua|pl|pm|r|dart|vue|svelte|astro|clj|cljs|ex|exs|erl|hs|ml|scala|groovy|gradle|proto|diff|patch)$/i;

/** 'image' | 'video' | null — null means open it in the text editor. */
export function mediaKind(path: string | null): 'image' | 'video' | null {
  if (!path) return null;
  if (IMAGE_RE.test(path)) return 'image';
  if (VIDEO_RE.test(path)) return 'video';
  return null;
}

/** True for `.excalidraw` drawings, which open in the editable DrawingView. */
export function isDrawing(path: string | null): boolean {
  return !!path && DRAWING_RE.test(path);
}

// The file types the app will open: markdown + other text/code files (text
// editor), image/video (MediaView), and `.excalidraw` drawings (DrawingView).
// Binaries (pdf, zip, …) are inert in the tree and filtered out of quick search.
// Conflict view bypasses this so any conflicted file can still be opened.
export function isOpenable(path: string | null): boolean {
  if (!path) return false;
  return TEXT_RE.test(path) || mediaKind(path) !== null || isDrawing(path);
}

// True for a text/code file that opens in the editor (not media, not a drawing).
// Drives the editor-vs-MediaView decision and "does this join the link index".
export function isTextFile(path: string | null): boolean {
  return !!path && TEXT_RE.test(path) && mediaKind(path) === null && !isDrawing(path);
}

// View-only preview for image/video files. Resolves the workspace-relative
// path through the existing `app://media/<rel>` protocol (served by main from
// the workspace root), so no new plumbing — the same channel image embeds use.
export default function MediaView({ path, workspacePath, kind }: {
  path: string;
  workspacePath: string | null;
  kind: 'image' | 'video';
}) {
  const rel = toRelPath(path, workspacePath);
  if (!rel) {
    return <div className="media-view media-view-empty">Can't preview this file — it's outside the workspace.</div>;
  }
  // Encode each segment so spaces / unicode survive the URL round-trip.
  const src = 'app://media/' + rel.split('/').map(encodeURIComponent).join('/');
  return (
    <div className="media-view">
      {kind === 'video'
        ? <video className="media-view-el" src={src} controls />
        : <img className="media-view-el" src={src} alt={rel} />}
    </div>
  );
}
