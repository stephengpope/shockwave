// ESM mirror of src/renderer/linkIndex.js's parser pieces.
// Keep LINK_RE / parseTarget / normalizeTarget / parseLinks in sync if either
// file changes (tests/parserParity.test.js enforces byte-identical output).

const LINK_RE = /\[\[([^\]\n]+?)\]\]/g;

// Parse a raw [[…]] body into path segments + basename. Drops a |alias and a
// #heading, strips a trailing .md, lowercases. "folder/Foo" → {segments:
// ['folder'], basename:'foo'}; "Foo" → {segments:[], basename:'foo'}.
function parseTarget(raw) {
  const beforePipe = raw.split('|')[0];
  const beforeHash = beforePipe.split('#')[0];
  const cleaned = beforeHash.trim().replace(/\.md$/i, '');
  const parts = cleaned.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) return { segments: [], basename: '' };
  return {
    segments: parts.slice(0, -1).map((s) => s.toLowerCase()),
    basename: parts[parts.length - 1].toLowerCase(),
  };
}

function normalizeTarget(raw) {
  return parseTarget(raw).basename;
}

function leadingWidth(line) {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4;
    else break;
  }
  return w;
}

function collectContext(lines, startIdx, max = 20) {
  const baseIndent = leadingWidth(lines[startIdx]);
  const ctx = [];
  const pendingBlanks = [];
  for (let j = startIdx + 1; j < lines.length && ctx.length < max; j++) {
    const line = lines[j];
    if (line.trim() === '') {
      pendingBlanks.push(line);
      continue;
    }
    if (leadingWidth(line) <= baseIndent) break;
    ctx.push(...pendingBlanks, line);
    pendingBlanks.length = 0;
  }
  return ctx;
}

function parseLinks(content) {
  const out = [];
  if (!content) return out;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    LINK_RE.lastIndex = 0;
    let m;
    let foundOnThisLine = false;
    let contextForThisLine = null;
    while ((m = LINK_RE.exec(line)) !== null) {
      const parsed = parseTarget(m[1]);
      if (!parsed.basename) continue;
      if (!foundOnThisLine) {
        contextForThisLine = collectContext(lines, i);
        foundOnThisLine = true;
      }
      out.push({
        target: parsed.basename,
        targetParsed: parsed,
        lineNumber: i + 1,
        lineText: line,
        contextLines: contextForThisLine,
      });
    }
  }
  return out;
}

export { parseLinks, parseTarget, normalizeTarget };
