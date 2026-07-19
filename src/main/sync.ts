// GitHub sync — REST helpers, git spawn wrapper, GIT_ASKPASS plumbing.
//
// Auth model: PAT lives only in safeStorage-encrypted settings. For shell git
// commands we plant the decrypted PAT in the child process env (GITHUB_PAT)
// and point GIT_ASKPASS at a tiny helper that echoes that env var. The PAT
// exists in memory only for the lifetime of the git child. Nothing PAT-bearing
// is ever written to .git/config; remote URLs stay as plain
// https://github.com/owner/repo.git.
//
// For REST calls (whoami, repo create, scope probes) we use fetch with a
// Bearer header. Same lifetime guarantee — PAT in memory only for the request.

import { spawn } from 'node:child_process';
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scaffoldNewProject } from './prompt/index.js';
// Folder classification + GitHub URL parsing live in a plain `.js` sibling with
// no electron import, so `node --test` can exercise them directly. Re-exported
// here because this module is the public face of everything sync-related.
import { classifyFolder, parseGithubUrl, cloneUrlFor, repoMismatch } from './workspaceFolder.js';

export { parseGithubUrl, cloneUrlFor, repoMismatch };

const GITHUB_API = 'https://api.github.com';
const API_HEADERS = (pat) => ({
  Authorization: `Bearer ${pat}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'shockwave-app',
});

// ─── REST helpers ──────────────────────────────────────────────────────────

/**
 * GET /user. Used as a PAT sanity check. Doesn't probe scopes — a token that
 * can't write to a given repo surfaces on the first push, with GitHub's own
 * message, rather than being guessed at up front.
 */
export async function verifyPat(pat) {
  if (!pat) return { ok: false, error: 'No token provided' };
  try {
    const res = await fetch(`${GITHUB_API}/user`, { headers: API_HEADERS(pat) });
    if (res.status === 401) return { ok: false, error: 'Invalid or expired token' };
    if (!res.ok) return { ok: false, error: `GitHub returned ${res.status}` };
    const data = await res.json();
    return { ok: true, login: data.login, id: data.id, name: data.name ?? null };
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/**
 * GET /user/repos. Paginated list of repos the PAT can see (owner +
 * collaborator + org member). Used by the renderer to populate the
 * "link to existing repo" picker so the user can pick instead of pasting
 * a URL. Returns a flat array sorted by `pushed` so most-recently-active
 * repos surface first. Caps at 5 pages (500 repos) — the listing is for
 * a UI picker, not a complete inventory.
 */
export async function listRepos(pat) {
  if (!pat) return { ok: false, error: 'No token provided' };
  const out: any[] = [];
  const perPage = 100;
  const maxPages = 5;
  try {
    for (let page = 1; page <= maxPages; page++) {
      const url = `${GITHUB_API}/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`;
      const res = await fetch(url, { headers: API_HEADERS(pat) });
      if (res.status === 401) return { ok: false, error: 'Invalid or expired token' };
      if (!res.ok) return { ok: false, error: `GitHub returned ${res.status}` };
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const r of batch) {
        out.push({
          full_name: r.full_name,
          clone_url: r.clone_url,
          private: !!r.private,
          default_branch: r.default_branch,
          pushed_at: r.pushed_at,
        });
      }
      if (batch.length < perPage) break;
    }
    return { ok: true, repos: out };
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Create a new repo under the authenticated user. Repo creation needs a wider
 * scope than read/write on existing repos (fine-grained: Administration:Write;
 * classic: `repo`); we surface the 403 cleanly so the user knows their token
 * is insufficient for create flows specifically — not all sync flows.
 */
export async function createRepo(name, pat, { private: isPrivate = true, description = '' } = {}) {
  if (!pat) return { ok: false, error: 'No token provided' };
  if (!name) return { ok: false, error: 'Repo name required' };
  try {
    const res = await fetch(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: { ...API_HEADERS(pat), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description,
        private: isPrivate,
        auto_init: false,
      }),
    });
    if (res.status === 201) {
      const data = await res.json();
      return {
        ok: true,
        full_name: data.full_name,
        clone_url: data.clone_url,
        default_branch: data.default_branch,
        html_url: data.html_url,
      };
    }
    if (res.status === 403) return { ok: false, error: 'Token lacks repo-create permission (need Administration:Write or classic `repo` scope)' };
    if (res.status === 422) {
      const data = await res.json().catch(() => null);
      return { ok: false, error: data?.errors?.[0]?.message || 'Repo name already taken or invalid' };
    }
    if (res.status === 401) return { ok: false, error: 'Invalid or expired token' };
    return { ok: false, error: `GitHub returned ${res.status}` };
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

// ─── System check ──────────────────────────────────────────────────────────

/**
 * Check whether `git` is on PATH and return its version string. `platform`
 * is included so the renderer can pick the right install instructions.
 */
export function checkGit() {
  return new Promise<any>((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      resolve({ ok: false, error: err.message, platform: process.platform });
      return;
    }
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => {
      resolve({ ok: false, error: err.message, platform: process.platform });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, version: stdout.trim(), platform: process.platform });
      } else {
        resolve({ ok: false, error: stderr.trim() || `git --version exited ${code}`, platform: process.platform });
      }
    });
  });
}

// ─── GIT_ASKPASS helper ────────────────────────────────────────────────────
//
// Git resolves credential prompts by running whatever GIT_ASKPASS points at
// and reading the first line of stdout. Our helper just echoes back the
// GITHUB_PAT env var (set fresh on every spawn). The username is supplied via
// the URL embed `https://x-access-token@github.com/...`, so the helper only
// ever has to answer the password prompt — but we handle both forms anyway
// so the prompt-shape variations across git versions don't trip us up.
//
// macOS/Linux: a posix shell script. Windows: a .cmd batch file. ensureAskpass
// writes the right one for the host platform.

let askpassPathCache: any = null;

async function askpassDir() {
  return path.join(app.getPath('userData'), 'sync');
}

async function ensureAskpass() {
  if (askpassPathCache) return askpassPathCache;
  const dir = await askpassDir();
  await fs.mkdir(dir, { recursive: true });

  if (process.platform === 'win32') {
    // Batch variant for Windows git. Git invokes the helper with one quoted
    // arg (the prompt, e.g. "Username for 'https://github.com': "); %~1 strips
    // the surrounding quotes. We answer x-access-token for the Username prompt
    // and the PAT (from the env var main set on the spawn) for everything else.
    // `if not errorlevel 1` is the batch idiom for "errorlevel == 0" (matched).
    // CRLF line endings — cmd.exe is picky about bare LF.
    const winFile = path.join(dir, 'askpass.cmd');
    const winBody = [
      '@echo off',
      'echo %~1| findstr /B /C:"Username" >nul',
      'if not errorlevel 1 (',
      '  echo x-access-token',
      ') else (',
      '  echo %GITHUB_PAT%',
      ')',
      '',
    ].join('\r\n');
    await fs.writeFile(winFile, winBody);
    askpassPathCache = winFile;
    return winFile;
  }

  const file = path.join(dir, 'askpass.sh');
  const body = '#!/bin/sh\n' +
    '# GIT_ASKPASS helper. Git invokes this with one arg like\n' +
    '#   "Username for \\"https://github.com\\":"\n' +
    '#   "Password for \\"https://x-access-token@github.com\\":"\n' +
    '# We answer the username as x-access-token and the password as the PAT\n' +
    '# from the env var that main set on the spawn.\n' +
    'case "$1" in\n' +
    '  Username*) echo "x-access-token" ;;\n' +
    '  *)         echo "$GITHUB_PAT" ;;\n' +
    'esac\n';
  await fs.writeFile(file, body, { mode: 0o700 });
  // Re-chmod in case the file pre-existed without exec bit (Write doesn't
  // change mode on an existing file in some node versions).
  await fs.chmod(file, 0o700);
  askpassPathCache = file;
  return file;
}

// ─── git spawn wrapper ─────────────────────────────────────────────────────

/**
 * Spawn `git` with optional PAT injected via GIT_ASKPASS env. Returns the
 * full {ok, code, stdout, stderr} so callers can pattern-match on git's
 * exit codes and messages.
 *
 * IMPORTANT: pass timeoutMs for any network-bound command (clone/fetch/pull/
 * push) — git can hang indefinitely on a broken connection.
 */
export async function gitSpawn(cwd, args, { pat = null, timeoutMs = 60000 } = {}) {
  const env = { ...process.env };
  if (pat) {
    env.GITHUB_PAT = pat;
    env.GIT_ASKPASS = await ensureAskpass();
    // Disable git's own terminal prompting fallback — we never want a TTY
    // prompt from a backgrounded child process.
    env.GIT_TERMINAL_PROMPT = '0';
  }
  return new Promise<any>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timer: any = null;
    let child;
    try {
      child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      resolve({ ok: false, code: -1, stdout: '', stderr: err.message });
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* child may have already exited */ }
      }, timeoutMs);
    }
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

// ─── Setup flows ───────────────────────────────────────────────────────────
//
// Two flows, because there are exactly two ways to get a repo: make one or pick
// one. Both OWN the folder — they create it and clone into it — which is what
// retired the old third flow (`setupLink`, "adopt a folder that already has
// files"). That flow existed only because a workspace could be a folder chosen
// before any repo was involved; now the repo comes first and the folder is its
// checkout, so there is never an existing folder to adopt.
//
// Both return the columns the `workspace` row needs. The caller inserts the row;
// nothing here writes to the DB, so a half-finished clone leaves no workspace
// behind.

/**
 * Set local git user.name / user.email for the repo. Without these, commits
 * fail with "Please tell me who you are". We use the noreply privacy email
 * derived from the user's GitHub id so commits are attributable on GitHub
 * but don't leak any real email.
 */
async function setLocalIdentity(workspacePath, login, ghId) {
  await gitSpawn(workspacePath, ['config', '--local', 'user.name', login], { timeoutMs: 5000 });
  await gitSpawn(workspacePath, ['config', '--local', 'user.email', `${ghId}+${login}@users.noreply.github.com`], { timeoutMs: 5000 });
}

/**
 * Classify a folder the user picked, so the add-workspace dialog knows what's
 * left to ask: `empty` (clone into it), `clone` (we already know the repo), or
 * `occupied` (refuse, with a reason).
 *
 * The decision itself is in `workspaceFolder.js` — pure enough to test against
 * real git repos without Electron. Note it reads `.git/config`, deliberately and
 * narrowly: ONCE, at setup, to learn what a folder already is. That is not the
 * per-tick re-derivation the workspace row replaced.
 */
export async function inspectWorkspaceFolder(workspacePath) {
  return classifyFolder(workspacePath);
}

/**
 * Adopt a folder that is ALREADY a clone. Nothing is written — not git config,
 * not the working tree; the caller just records the row. Deliberately far
 * narrower than the `setupLink` flow this descends from, which would `git init`
 * an arbitrary folder and force a remote onto it. Here the remote must already
 * be there and is taken as given.
 */
export async function adoptWorkspaceClone({ workspacePath, pat }) {
  const info = await inspectWorkspaceFolder(workspacePath);
  if (info.state !== 'clone') {
    return { ok: false, error: info.error ?? 'That folder isn\'t a git clone.' };
  }
  // Commits need an identity; a folder cloned outside the app may not have one
  // set locally. Best-effort, same as the other two flows.
  const who = await verifyPat(pat);
  if (who.ok) await setLocalIdentity(workspacePath, who.login, who.id);

  return {
    ok: true,
    path: workspacePath,
    repoOwner: info.repoOwner,
    repoName: info.repoName,
    defaultBranch: info.defaultBranch,
  };
}

/**
 * The chosen folder must be empty before we clone into it.
 *
 * The user picks this folder directly (the OS picker can create one on the
 * spot), so it always exists by the time we get here — there is no parent-plus-
 * name to join, and nothing to mkdir. Anything with contents is refused rather
 * than merged into: cloning over a populated folder is how you lose files.
 */
async function requireEmptyFolder(workspacePath) {
  const info = await classifyFolder(workspacePath);
  if (info.state === 'empty') return { ok: true, path: workspacePath };
  return {
    ok: false,
    error: info.state === 'clone'
      ? `That folder is already a clone of ${info.repoOwner}/${info.repoName}.`
      : (info.error ?? "That folder can't be used."),
  };
}

/**
 * Read the checked-out branch. Called ONCE at setup to record `defaultBranch`
 * on the row — thereafter the row is what the engine reads. Deliberately not
 * taken from the caller or the repo listing: what git actually checked out is
 * the only answer that can't be stale.
 */
async function currentBranch(workspacePath: string) {
  const res = await gitSpawn(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
  return (res.ok && res.stdout.trim()) || 'main';
}

/**
 * Create a new GitHub repo and a local checkout of it. Seeds SOUL.md +
 * AGENTS.md; the engine's first tick commits and pushes them.
 */
export async function createWorkspaceRepo({ workspacePath, repoName, pat, private: isPrivate = true }) {
  const folder = await requireEmptyFolder(workspacePath);
  if (!folder.ok) return folder;

  const created = await createRepo(repoName, pat, { private: isPrivate });
  if (!created.ok) return created;
  const [owner, repo] = created.full_name.split('/') as [string, string];

  const init = await gitSpawn(folder.path, ['init', '-b', 'main'], { timeoutMs: 5000 });
  if (!init.ok) return { ok: false, error: init.stderr.trim() || 'git init failed' };

  // Agent identity + per-project instructions. Best-effort; the first tick
  // commits whatever landed.
  await scaffoldNewProject(folder.path);

  const add = await gitSpawn(folder.path, ['remote', 'add', 'origin', cloneUrlFor(owner, repo)], { timeoutMs: 5000 });
  if (!add.ok) return { ok: false, error: add.stderr.trim() || 'could not set origin' };

  const who = await verifyPat(pat);
  if (who.ok) await setLocalIdentity(folder.path, who.login, who.id);

  return {
    ok: true,
    path: folder.path,
    repoOwner: owner,
    repoName: repo,
    defaultBranch: await currentBranch(folder.path),
    htmlUrl: created.html_url,
  };
}

/**
 * Clone an existing GitHub repo into a new local folder.
 */
export async function cloneWorkspaceRepo({ workspacePath, owner, repo, pat }) {
  // No write-probe before cloning. `probeWrite` POSTs to `git/refs`, which a
  // fine-grained token can be denied even when it holds Contents: Read and
  // write — so probing rejected tokens that clone and push perfectly well. The
  // old clone flow never probed; a genuine permission failure surfaces on the
  // first push, where `isTerminalGitError` already routes it to `disabled` with
  // GitHub's own message.
  const folder = await requireEmptyFolder(workspacePath);
  if (!folder.ok) return folder;

  const cloned = await gitSpawn(folder.path, ['clone', cloneUrlFor(owner, repo), '.'], { pat, timeoutMs: 120000 });
  if (!cloned.ok) {
    return { ok: false, error: cloned.stderr.trim() || `git clone exited ${cloned.code}` };
  }

  const who = await verifyPat(pat);
  if (who.ok) await setLocalIdentity(folder.path, who.login, who.id);

  return {
    ok: true,
    path: folder.path,
    repoOwner: owner,
    repoName: repo,
    defaultBranch: await currentBranch(folder.path),
  };
}
