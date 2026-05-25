// Chat-sidebar attachment helpers. Pure browser-side: no Node, no IPC.
//
// Pi accepts images natively (ImageContent[]) but has no file primitive, so
// text files are inlined into the prompt at send time. We classify, read, and
// label files here; ChatSidebar owns the state + UI.

const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const ALLOWED_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown',
  'py', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'json', 'jsonc', 'yaml', 'yml', 'toml',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg',
  'csv', 'tsv', 'log',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cpp', 'cc', 'h', 'hpp', 'm', 'mm',
  'sql', 'ini', 'conf', 'env',
  'gitignore', 'gitattributes', 'dockerfile', 'lock',
  'properties', 'gradle', 'cmake',
]);

const ALLOWED_EXTENSIONLESS = new Set([
  'Makefile', 'Dockerfile', 'README', 'LICENSE', 'NOTICE', 'CHANGELOG',
  'CODEOWNERS', 'Gemfile', 'Rakefile', 'Procfile',
]);

function lowerExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function classify(file) {
  if (ALLOWED_IMAGE_MIMES.has(file.type)) return 'image';
  const ext = lowerExt(file.name);
  if (ext && ALLOWED_TEXT_EXTS.has(ext)) return 'text';
  if (!ext && ALLOWED_EXTENSIONLESS.has(file.name)) return 'text';
  return null;
}

export async function readAsBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  // btoa wants a binary string. Chunk to avoid stack overflow on large images.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function readAsText(file) {
  return await file.text();
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

let idCounter = 0;
export const nextAttachmentId = () => `att${++idCounter}`;

// Build the prompt text sent to pi: prepend any text-file blocks before the
// user's typed message so the model sees them as context.
export function composePromptText(userText, textAttachments) {
  if (!textAttachments || textAttachments.length === 0) return userText;
  const blocks = textAttachments
    .map((a) => `<file name="${a.name}">\n${a.content}\n</file>`)
    .join('\n\n');
  return userText ? `${blocks}\n\n${userText}` : blocks;
}

// Map image attachments to pi's ImageContent shape.
export function toImageContents(imageAttachments) {
  return imageAttachments.map((a) => ({
    type: 'image',
    data: a.base64,
    mimeType: a.mimeType,
  }));
}
