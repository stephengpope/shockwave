// The default file set every workspace gets — one manifest, one function.
//
// These are FILES, not settings, on purpose: the user can read, edit, diff, and
// sync them like anything else in the workspace, and the agent can too. Same
// reasoning that keeps SOUL.md a file rather than a preference.
//
// WHEN THIS RUNS
//   - `createWorkspaceRepo` only — a repo the user just created through the app.
//     It's theirs and it's empty, so seeding it is the point.
//   - On explicit user request (`workspace:ensureFiles`), to fill in files that
//     are missing — e.g. an older workspace, or a clone.
//
// NOT on clone / adopt / set-up-here (`ensureCheckout`). Cloning means adopting
// someone else's repo, and the sync engine commits and pushes on its next tick —
// so scaffolding there would push four files into a repo the user may not own
// and may share. `.gitignore` is the sharpest: adding one changes git's behavior
// for every collaborator. Clone stays untouched; the manual action is how you
// opt in.
//
// It deliberately does NOT run on workspace activation. Writing to the user's
// folder every time they switch workspaces is the wrong shape: silent, repeated,
// and surprising.
//
// NEVER CLOBBERS. Every write is `wx` (fail-if-exists), so a tuned SOUL.md or a
// hand-maintained .gitignore survives untouched. Adding a file to DEFAULT_FILES
// is therefore safe to ship: existing workspaces pick it up on the next explicit
// request, and nobody loses an edit.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SOUL, SOUL_FILENAME, AGENTS_FILENAME, AGENTS_STUB } from './soul.js';

// Ripgrep honors `.ignore` independently of .gitignore. pi's `grep` tool spawns
// ripgrep with a hardcoded `--hidden` (see createGrepToolDefinition in
// pi-coding-agent), which makes it descend into `.git/` — so a workspace-wide
// search returns binary blobs from .git/objects, burning context and skewing
// file counts. `.ignore` is the only lever we have from outside pi, and it's the
// standard ripgrep convention rather than a workaround bolted into our code.
export const IGNORE_FILENAME = '.ignore';
const DEFAULT_IGNORE = `# Search-tool ignores (ripgrep). Not a git file.
# The agent's grep searches hidden paths, so exclude git internals.
.git/
`;

// Deliberately minimal. This is a markdown workspace — syncing everything is the
// point, so only OS droppings are excluded. Notably NOT .shockwave/: it carries
// workspace.json (bookmarks, daily-note + template config) and workspace skills,
// all of which SHOULD travel between machines.
export const GITIGNORE_FILENAME = '.gitignore';
const DEFAULT_GITIGNORE = `.DS_Store
._*
Thumbs.db
`;

export interface DefaultFile {
  name: string;
  content: string;
  /** Shown in the UI when reporting what was added. */
  purpose: string;
}

export const DEFAULT_FILES: DefaultFile[] = [
  { name: SOUL_FILENAME, content: `${DEFAULT_SOUL}\n`, purpose: "The agent's identity for this workspace" },
  { name: AGENTS_FILENAME, content: AGENTS_STUB, purpose: 'Your project-specific instructions to the agent' },
  { name: IGNORE_FILENAME, content: DEFAULT_IGNORE, purpose: 'Paths the agent should skip when searching' },
  { name: GITIGNORE_FILENAME, content: DEFAULT_GITIGNORE, purpose: 'Paths git should not track' },
];

// Write the default files. Returns the names actually written, so callers can
// tell the user what landed. Best-effort throughout: a write failure must never
// block workspace setup, so failures are skipped rather than thrown.
//
// `overwrite: false` (the default) writes with 'wx' — fail-if-exists — so a
// tuned SOUL.md or hand-maintained .gitignore survives. Every automatic caller
// uses this.
//
// `overwrite: true` replaces all four with the current defaults. Only the
// explicit "Reset to defaults" action passes it, and the renderer confirms
// first: the workspace is a git repo so a reset is recoverable, but only for
// what's already COMMITTED — an edit made since the last sync tick has no git
// copy to come back from.
export async function ensureWorkspaceFiles(
  workspacePath: string,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<string[]> {
  if (!workspacePath) return [];
  const written: string[] = [];
  for (const file of DEFAULT_FILES) {
    try {
      await fs.writeFile(join(workspacePath, file.name), file.content, overwrite ? undefined : { flag: 'wx' });
      written.push(file.name);
    } catch {
      // Already exists (when not overwriting), or unwritable: leave it alone.
    }
  }
  return written;
}

// Which defaults are absent — lets the UI say what an explicit run would add
// before the user commits to it.
export async function missingWorkspaceFiles(workspacePath: string): Promise<string[]> {
  if (!workspacePath) return [];
  const missing: string[] = [];
  for (const file of DEFAULT_FILES) {
    try {
      await fs.access(join(workspacePath, file.name));
    } catch {
      missing.push(file.name);
    }
  }
  return missing;
}
