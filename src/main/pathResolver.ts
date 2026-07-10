// Path + collision helpers used by the IPC layer in main.js. Pulled out so
// main.js doesn't carry ~100 lines of name-uniqueness machinery on top of
// everything else it owns.
//
// All functions are pure-ish: they only touch the filesystem (fs.access,
// fs.readdir, fs.stat) and never reach back into main.js. Import them from
// main.js wherever a path needs disambiguating or a workspace needs walking.

import fs from 'node:fs/promises';
import path from 'node:path';

// Case-insensitive markdown extension check. Single source of truth across
// the watcher, tree walks, IPC handlers, and rename logic.
export function isMdFile(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.md');
}

// Directory names we never descend into, display, or watch — the heavy
// non-dotfile dirs. Dotfiles (.git/.obsidian/.shockwave/…) are skipped
// separately by the leading-dot rule; these are the extras.
export const IGNORED_DIR_NAMES = new Set(['node_modules']);

// True for any path segment the tree builder and watcher skip: a dotfile
// segment, or a name in IGNORED_DIR_NAMES. Single source of truth so buildTree,
// the walks below, and isIgnoredWatchPath stay consistent.
export function isIgnoredSegment(name) {
  return typeof name === 'string' && (name.startsWith('.') || IGNORED_DIR_NAMES.has(name));
}

// Same-directory uniqueness: returns a path that doesn't exist on disk.
// Appends " 1", " 2", ... until it finds an open slot. Doesn't check anything
// beyond the destination directory — use uniqueInWorkspace for workspace-wide
// basename uniqueness on .md files.
export async function uniquePath(dirPath, base, ext) {
  let candidate = path.join(dirPath, `${base}${ext}`);
  let i = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dirPath, `${base} ${i}${ext}`);
      i++;
    } catch {
      return candidate;
    }
  }
}

// Walk the workspace and collect lowercased basenames (without .md) for every
// .md file, excluding any paths in `excludePaths`. Used to enforce workspace-
// wide name uniqueness for files (case-insensitive), since the link index is
// keyed by basename and two files sharing a name break it.
export async function collectMarkdownBasenamesLower(root, excludePaths = new Set()) {
  const out = new Set();
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isIgnoredSegment(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (excludePaths.has(full)) continue;
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && isMdFile(e.name)) {
        out.add(e.name.slice(0, -3).toLowerCase());
      }
    }
  }
  await walk(root);
  return out;
}

// Auto-disambiguate a target path within a workspace. Appends " 1", " 2", ...
// to the basename until the resulting file is:
//   - not present at the literal destination path, AND
//   - its basename (case-insensitive) is not used by any other .md file in
//     the workspace (so the link index doesn't collapse two files into one key).
// `excludePaths` lets the caller exempt files that are about to be renamed
// out of the way (otherwise renaming Foo.md -> Foo.md would collide with itself).
export async function uniqueInWorkspace({ workspaceRoot, destDir, base, ext, excludePaths = [] }: any) {
  const exclude = new Set(excludePaths);
  // For folders or files outside a workspace, fall back to same-dir uniqueness.
  if (!workspaceRoot || ext !== '.md') {
    return uniquePath(destDir, base, ext);
  }
  const taken = await collectMarkdownBasenamesLower(workspaceRoot, exclude);
  let candidateName = base;
  let i = 1;
  while (true) {
    const candidatePath = path.join(destDir, `${candidateName}${ext}`);
    let onDisk = false;
    try {
      await fs.access(candidatePath);
      onDisk = !exclude.has(candidatePath);
    } catch {
      onDisk = false;
    }
    if (!onDisk && !taken.has(candidateName.toLowerCase())) {
      return candidatePath;
    }
    candidateName = `${base} ${i}`;
    i++;
  }
}

// Recursively collect absolute paths of every .md file under `root`. If
// `root` is itself a .md file, returns [root]. Errors (missing dir, EACCES)
// resolve to []. Dotfiles (.git, .obsidian, .shockwave, etc.) are skipped.
//
// Single helper for all "find me the markdown files under X" callers:
// collision-check exclusion (move/rename) and correlator seeding.
export async function walkMarkdownPaths(root, { skipSymlinks = true } = {}) {
  const out: any[] = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (isIgnoredSegment(e.name)) continue;
      if (skipSymlinks && e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && isMdFile(e.name)) out.push(full);
    }
  }
  try {
    const st = await fs.stat(root);
    if (st.isDirectory()) await walk(root);
    else if (isMdFile(root)) out.push(root);
  } catch { /* unreadable/missing root → return what we collected */ }
  return out;
}
