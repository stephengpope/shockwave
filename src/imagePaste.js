// Image paste & drop for the markdown editor.
//
// Catches image files pasted or dropped into the editor, saves them next to
// the active .md (via window.api.writeImage), and inserts a markdown image
// reference `![](filename)` at the cursor. Multiple images are concatenated.
//
// Drafts: rejected with an error — we need a saved file path to know where
// to put the image. The user has to save the file first.
//
// Filename strategy:
//   - Pasted screenshots arrive with no name → use timestamp ("Pasted image …").
//   - Dropped files arrive with a real name → use that, sans extension.
//   The main-process handler runs the chosen base through uniquePath() so
//   collisions get " 1", " 2", … appended automatically.

import { EditorView, ViewPlugin } from '@codemirror/view';

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
};

function extFor(file) {
  return MIME_TO_EXT[file.type] ?? null;
}

function dirOf(filePath) {
  const i = filePath.lastIndexOf('/');
  return i >= 0 ? filePath.slice(0, i) : '';
}

function basenameNoExt(name) {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// Markdown URL encoding. CommonMark rejects literal whitespace in `(url)`
// form, and parens break the closing `)`. encodeURI() handles every kind
// of whitespace (regular space, NBSP, tabs) plus other URL-invalid chars
// while preserving slashes, alphanumerics, dots, and dashes for readability.
function encodeMarkdownUrl(name) {
  return encodeURI(name).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

async function handleImageFiles(view, files, { getActiveFilePath, onError }) {
  const activePath = getActiveFilePath?.();
  if (!activePath) {
    onError?.('Save this file before adding images.');
    return;
  }
  const targetDir = dirOf(activePath);
  if (!targetDir) {
    onError?.('Cannot determine folder for image.');
    return;
  }

  const insertions = [];
  for (const file of files) {
    const ext = extFor(file);
    if (!ext) continue;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const baseName = file.name ? basenameNoExt(file.name) : '';
      const savedAbsPath = await window.api.writeImage(targetDir, bytes, ext, baseName);
      const filename = savedAbsPath.slice(savedAbsPath.lastIndexOf('/') + 1);
      insertions.push(`![](${encodeMarkdownUrl(filename)})`);
    } catch (err) {
      onError?.(err?.message ?? String(err));
    }
  }
  if (insertions.length === 0) return;

  const insert = insertions.join('\n');
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
  });
}

function pickImageFiles(fileList) {
  if (!fileList || fileList.length === 0) return [];
  return [...fileList].filter((f) => extFor(f));
}

// HTML5 drag-drop quirk: `drop` only fires if `dragover` has called
// preventDefault — otherwise the browser handles the drop itself (which,
// in Electron, means navigating away to the file). We claim the event
// whenever Files are being dragged so the drop reaches our handler.
function isFileDrag(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // DOMStringList in some browsers, plain Array in others — both support contains/includes via [...].
  return [...types].includes('Files');
}

// Paste is handled via CM6's domEventHandlers (no precedence issue —
// nothing else preventDefaults the clipboard paste in capture phase).
//
// Drop is NOT — it's attached directly to view.contentDOM via a ViewPlugin.
// CM6's dispatch (`runHandlers`) short-circuits on `event.defaultPrevented`,
// and react-dnd-html5-backend (used by react-arborist for the sidebar tree)
// registers a window-level capture-phase drop listener that preventDefaults
// native file drags. That fires before CM6's bubble-phase listener, so any
// `drop` registered via domEventHandlers never runs. Marijn (CM6 author)
// recommends a direct addEventListener for this exact case.
const pasteHandler = ({ getActiveFilePath, onError }) =>
  EditorView.domEventHandlers({
    paste(e, view) {
      const images = pickImageFiles(e.clipboardData?.files);
      if (images.length === 0) return false;
      e.preventDefault();
      handleImageFiles(view, images, { getActiveFilePath, onError });
      return true;
    },
  });

const dropPlugin = ({ getActiveFilePath, onError }) =>
  ViewPlugin.define((view) => {
    const onDragOver = (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e) => {
      const images = pickImageFiles(e.dataTransfer?.files);
      if (images.length === 0) return;
      // stopImmediatePropagation so CM6's internal drop handler (which would
      // try to readAsText on image bytes and insert garbage) doesn't run.
      e.preventDefault();
      e.stopImmediatePropagation();
      handleImageFiles(view, images, { getActiveFilePath, onError });
    };
    view.contentDOM.addEventListener('dragover', onDragOver);
    view.contentDOM.addEventListener('drop', onDrop);
    return {
      destroy() {
        view.contentDOM.removeEventListener('dragover', onDragOver);
        view.contentDOM.removeEventListener('drop', onDrop);
      },
    };
  });

export function imagePaste(opts) {
  return [pasteHandler(opts), dropPlugin(opts)];
}
