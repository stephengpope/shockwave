export const LINK_RE = /\[\[([^\]\n]+?)\]\]/g;

export function normalizeTarget(raw) {
  const beforePipe = raw.split('|')[0];
  const beforeHash = beforePipe.split('#')[0];
  const name = beforeHash.trim().replace(/\.md$/i, '');
  return name.toLowerCase();
}

export function prettyName(fullPath, vaultPath) {
  let p = fullPath;
  if (vaultPath && p.startsWith(vaultPath + '/')) {
    p = p.slice(vaultPath.length + 1);
  }
  return p.replace(/\.md$/i, '');
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

export function parseLinks(content) {
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
      const target = normalizeTarget(m[1]);
      if (!target) continue;
      if (!foundOnThisLine) {
        contextForThisLine = collectContext(lines, i);
        foundOnThisLine = true;
      }
      out.push({
        target,
        lineNumber: i + 1,
        lineText: line,
        contextLines: contextForThisLine,
      });
    }
  }
  return out;
}

export function createLinkIndex() {
  const outgoingByFile = new Map();
  const backlinks = new Map();
  const mtimes = new Map();

  function addEntry(target, fromPath, lineNumber, lineText, contextLines) {
    let arr = backlinks.get(target);
    if (!arr) {
      arr = [];
      backlinks.set(target, arr);
    }
    arr.push({ fromPath, lineNumber, lineText, contextLines });
  }

  function removeEntries(fromPath, targets) {
    for (const target of targets) {
      const arr = backlinks.get(target);
      if (!arr) continue;
      const filtered = arr.filter((e) => e.fromPath !== fromPath);
      if (filtered.length === 0) backlinks.delete(target);
      else backlinks.set(target, filtered);
    }
  }

  function updateFile(path, content, mtime) {
    const oldTargets = outgoingByFile.get(path);
    if (oldTargets && oldTargets.length > 0) {
      removeEntries(path, oldTargets);
    }
    const parsed = parseLinks(content);
    const newTargets = [];
    for (const { target, lineNumber, lineText, contextLines } of parsed) {
      newTargets.push(target);
      addEntry(target, path, lineNumber, lineText, contextLines);
    }
    outgoingByFile.set(path, newTargets);
    mtimes.set(path, mtime ?? Date.now());
  }

  function removeFile(path) {
    const targets = outgoingByFile.get(path);
    if (targets && targets.length > 0) removeEntries(path, targets);
    outgoingByFile.delete(path);
    mtimes.delete(path);
  }

  function renameFile(oldPath, newPath) {
    const targets = outgoingByFile.get(oldPath);
    if (targets !== undefined) {
      outgoingByFile.set(newPath, targets);
      outgoingByFile.delete(oldPath);
      for (const target of targets) {
        const arr = backlinks.get(target);
        if (!arr) continue;
        for (const entry of arr) {
          if (entry.fromPath === oldPath) entry.fromPath = newPath;
        }
      }
    }
    if (mtimes.has(oldPath)) {
      mtimes.set(newPath, mtimes.get(oldPath));
      mtimes.delete(oldPath);
    }
  }

  function applyParsedLinks(path, parsed, mtime) {
    const oldTargets = outgoingByFile.get(path);
    if (oldTargets && oldTargets.length > 0) removeEntries(path, oldTargets);
    const newTargets = [];
    for (const { target, lineNumber, lineText, contextLines } of parsed) {
      newTargets.push(target);
      addEntry(target, path, lineNumber, lineText, contextLines);
    }
    outgoingByFile.set(path, newTargets);
    mtimes.set(path, mtime ?? Date.now());
  }

  function rebuild(files) {
    outgoingByFile.clear();
    backlinks.clear();
    mtimes.clear();
    for (const file of files) {
      // Accept either pre-parsed {path, outgoingLinks, mtime} (from main)
      // or raw {path, content, mtime} (from renderer-side rebuilds).
      if (Array.isArray(file.outgoingLinks)) {
        applyParsedLinks(file.path, file.outgoingLinks, file.mtime);
      } else {
        updateFile(file.path, file.content, file.mtime);
      }
    }
  }

  function getBacklinks(targetLower) {
    return backlinks.get(targetLower) ?? [];
  }

  function getOutgoing(path) {
    return outgoingByFile.get(path) ?? [];
  }

  function getOutgoingMap() {
    return outgoingByFile;
  }

  function getMtime(path) {
    return mtimes.get(path);
  }

  function getEntriesGroupedBySource(targetLower) {
    const entries = backlinks.get(targetLower);
    if (!entries || entries.length === 0) return [];
    const byPath = new Map();
    for (const e of entries) {
      let group = byPath.get(e.fromPath);
      if (!group) {
        group = {
          fromPath: e.fromPath,
          mtime: mtimes.get(e.fromPath) ?? 0,
          matches: [],
        };
        byPath.set(e.fromPath, group);
      }
      group.matches.push({
        lineNumber: e.lineNumber,
        lineText: e.lineText,
        contextLines: e.contextLines,
      });
    }
    const groups = Array.from(byPath.values());
    for (const g of groups) {
      g.matches.sort((a, b) => a.lineNumber - b.lineNumber);
    }
    groups.sort((a, b) => {
      if (b.mtime !== a.mtime) return b.mtime - a.mtime;
      return a.fromPath.localeCompare(b.fromPath);
    });
    return groups;
  }

  return {
    rebuild,
    updateFile,
    applyParsedLinks,
    removeFile,
    renameFile,
    getBacklinks,
    getOutgoing,
    getOutgoingMap,
    getMtime,
    getEntriesGroupedBySource,
  };
}
