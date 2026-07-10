// SOUL — the per-workspace "who you are / why" that sits ABOVE the Shockwave
// helper in the assembled system prompt.
//
// A workspace can carry its own `SOUL.md` at its root; the user edits it like any
// other file (it's just markdown). When present, its contents replace
// DEFAULT_SOUL below. When absent, DEFAULT_SOUL is used in-memory — nothing is
// written to disk. New repos created via the sync "create new repo" flow get a
// physical copy of DEFAULT_SOUL plus an empty AGENTS.md (see `scaffoldNewProject`).
//
// EDITING: DEFAULT_SOUL and AGENTS_STUB are plain literals — edit freely.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const SOUL_FILENAME = 'SOUL.md';
export const AGENTS_FILENAME = 'AGENTS.md';

// The built-in identity used when a workspace has no SOUL.md. Keep it to the
// "who/why/tone" — operating mechanics belong in the helper, not here.
export const DEFAULT_SOUL = `You are the agent inside Shockwave — a markdown-based "second brain" editor. Your job is to help the user think: read and connect their files, capture what matters, and keep their workspace coherent as it grows.

You work directly in the user's workspace folder (your cwd) — reading files, running commands, editing, and writing new files on their behalf.

# Style

Direct. Skip filler, recaps, and "I'll now…" preambles. Match the user's tone. When you change files, say what changed and where, in one line.`;

// The empty AGENTS.md seeded into new projects. pi auto-discovers AGENTS.md and
// appends its contents to the system prompt, so this becomes the user's own
// per-project instruction surface — intentionally near-empty to start.
export const AGENTS_STUB = `# Project instructions

Notes and instructions specific to this project. Anything you write here is given
to the Shockwave agent at the start of every chat. Empty by default — add your own.
`;

// Read a workspace's SOUL.md, or fall back to DEFAULT_SOUL. Never throws.
export async function readSoul(workspacePath: string | null | undefined): Promise<string> {
  if (!workspacePath) return DEFAULT_SOUL;
  try {
    const text = await fs.readFile(join(workspacePath, SOUL_FILENAME), 'utf8');
    return text.trim() || DEFAULT_SOUL;
  } catch {
    return DEFAULT_SOUL;
  }
}

// Seed SOUL.md (from DEFAULT_SOUL) and an empty AGENTS.md into a new project,
// only if each is absent. Called from the sync "create new repo" flow so the two
// files are committed with the first push. Best-effort — a write failure here
// must never block repo setup.
export async function scaffoldNewProject(workspacePath: string): Promise<void> {
  await writeIfAbsent(join(workspacePath, SOUL_FILENAME), `${DEFAULT_SOUL}\n`);
  await writeIfAbsent(join(workspacePath, AGENTS_FILENAME), AGENTS_STUB);
}

async function writeIfAbsent(file: string, content: string): Promise<void> {
  try {
    // 'wx' fails if the file already exists — never clobber the user's own file.
    await fs.writeFile(file, content, { flag: 'wx' });
  } catch {
    // Already exists (or unwritable): leave it alone.
  }
}
