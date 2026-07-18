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
import { cacheWorkspaceOrigin } from './db/index.js';

const GITHUB_API = 'https://api.github.com';
const API_HEADERS = (pat) => ({
  Authorization: `Bearer ${pat}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'shockwave-app',
});

// ─── REST helpers ──────────────────────────────────────────────────────────

/**
 * GET /user. Used as a PAT sanity check. Doesn't probe scopes — that's done
 * per-repo via probeWrite when needed.
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
 * Probe whether the PAT has Contents:Write on a repo. Creates a ref pointing
 * at the null SHA — 422 means git accepted the request (we have write but
 * the SHA is invalid; nothing is created), 403 means the token lacks the
 * scope. Pattern borrowed from thepopebot/lib/tools/github.js.
 */
export async function probeWrite(owner, repo, pat) {
  if (!pat) return { ok: false, error: 'No token provided' };
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { ...API_HEADERS(pat), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: 'refs/heads/__shockwave_probe__',
        sha: '0000000000000000000000000000000000000000',
      }),
    });
    if (res.status === 422) return { ok: true };
    if (res.status === 403) return { ok: false, error: 'Token lacks Contents:Write on this repo' };
    if (res.status === 404) return { ok: false, error: 'Repo not found or token can\'t see it' };
    if (res.status === 401) return { ok: false, error: 'Invalid or expired token' };
    return { ok: false, error: `GitHub returned ${res.status}` };
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

// ─── URL parsing ───────────────────────────────────────────────────────────

/**
 * Extract { owner, repo } from a GitHub URL. Accepts:
 *   https://github.com/owner/repo(.git)?
 *   git@github.com:owner/repo(.git)?
 *   github.com/owner/repo
 * Returns null on anything else (gitlab, gitea, raw paths, etc.).
 */
export function parseGithubUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  // SSH-style: git@github.com:owner/repo.git
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // HTTPS / bare host
  const https = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

/** Return canonical HTTPS clone URL for a (owner, repo) pair. */
export function cloneUrlFor(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
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

// ─── Per-workspace status ──────────────────────────────────────────────────

/**
 * Inspect a workspace folder for sync-relevant state. Used by the UI to
 * decide which setup buttons to show.
 */
export async function workspaceStatus(workspacePath) {
  if (!workspacePath) return { hasGit: false, hasOrigin: false, originUrl: null };
  try {
    await fs.access(path.join(workspacePath, '.git'));
  } catch {
    return { hasGit: false, hasOrigin: false, originUrl: null };
  }
  const remote = await gitSpawn(workspacePath, ['remote', 'get-url', 'origin'], { timeoutMs: 5000 });
  if (!remote.ok) {
    cacheOrigin(workspacePath, null);
    return { hasGit: true, hasOrigin: false, originUrl: null };
  }
  const originUrl = remote.stdout.trim();
  cacheOrigin(workspacePath, originUrl);
  return { hasGit: true, hasOrigin: true, originUrl };
}

// Write-through cache of what git just told us, so UI that wants to show a repo
// for every workspace doesn't have to spawn a git per workspace. Display only —
// the live value above is what every caller actually acts on, so an out-of-app
// `git remote set-url` can never route a push using a stale cache. Best-effort:
// a failure here must not break the status read.
function cacheOrigin(workspacePath: string, originUrl: string | null) {
  try {
    cacheWorkspaceOrigin(workspacePath, originUrl, Date.now());
  } catch (err: any) {
    console.warn('[sync] could not cache origin url:', err?.message ?? err);
  }
}

// ─── Setup flows ───────────────────────────────────────────────────────────
//
// All three setup flows leave the workspace with `.git/` initialized and
// `origin` pointing at the GitHub repo. No content syncs yet — the sync
// engine's first tick picks up from there.

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
 * Clone an existing GitHub repo into an empty workspace folder. Fails if the
 * folder isn't empty (we don't want to clobber a populated workspace).
 */
export async function setupClone({ workspacePath, remoteUrl, pat }) {
  const parsed = parseGithubUrl(remoteUrl);
  if (!parsed) return { ok: false, error: 'Not a valid GitHub URL' };
  const url = cloneUrlFor(parsed.owner, parsed.repo);

  // Refuse to clone into a non-empty folder. We clone INTO it (--separate-git-dir
  // would let us merge, but the simple rule "must be empty" avoids data loss).
  let entries;
  try {
    entries = await fs.readdir(workspacePath);
  } catch (err: any) {
    return { ok: false, error: `Workspace folder unreadable: ${err.message}` };
  }
  // Allow .DS_Store and hidden-only state but no real files.
  const real = entries.filter((e) => e !== '.DS_Store' && !e.startsWith('.'));
  if (real.length > 0) {
    return { ok: false, error: 'Workspace folder must be empty to clone into. Move/remove existing files first or use "Init new repo" instead.' };
  }

  // `git clone <url> .` clones into the current directory.
  const cloned = await gitSpawn(workspacePath, ['clone', url, '.'], { pat, timeoutMs: 120000 });
  if (!cloned.ok) {
    return { ok: false, error: cloned.stderr.trim() || `git clone exited ${cloned.code}` };
  }

  // Set local identity so subsequent commits don't fail.
  const who = await verifyPat(pat);
  if (who.ok) await setLocalIdentity(workspacePath, who.login, who.id);

  return { ok: true, remoteUrl: url };
}

/**
 * Create a brand-new repo on GitHub and wire the workspace folder up to push
 * to it. The workspace can already have files — they'll be picked up by the
 * sync engine's first tick (status → commit → push).
 */
export async function setupInitAndCreate({ workspacePath, repoName, pat, private: isPrivate = true }) {
  const created = await createRepo(repoName, pat, { private: isPrivate });
  if (!created.ok) return created;

  // Idempotent init — safe even if .git/ already exists.
  const init = await gitSpawn(workspacePath, ['init', '-b', 'main'], { timeoutMs: 5000 });
  if (!init.ok) {
    return { ok: false, error: init.stderr.trim() || 'git init failed' };
  }

  // Seed a new project with SOUL.md (agent identity) + an empty AGENTS.md
  // (per-project instructions). Only writes files that don't already exist; the
  // first sync tick commits + pushes them. Best-effort.
  await scaffoldNewProject(workspacePath);

  // Set origin. `remote add` fails if origin exists; use `set-url` to be
  // idempotent against partial setups.
  const setUrl = await gitSpawn(workspacePath, ['remote', 'add', 'origin', cloneUrlFor(...(created.full_name.split('/') as [string, string]))], { timeoutMs: 5000 });
  if (!setUrl.ok && !/exists/.test(setUrl.stderr)) {
    return { ok: false, error: setUrl.stderr.trim() };
  }
  if (!setUrl.ok) {
    const reset = await gitSpawn(workspacePath, ['remote', 'set-url', 'origin', cloneUrlFor(...(created.full_name.split('/') as [string, string]))], { timeoutMs: 5000 });
    if (!reset.ok) return { ok: false, error: reset.stderr.trim() };
  }

  const who = await verifyPat(pat);
  if (who.ok) await setLocalIdentity(workspacePath, who.login, who.id);

  return { ok: true, remoteUrl: cloneUrlFor(...(created.full_name.split('/') as [string, string])), full_name: created.full_name, html_url: created.html_url };
}

/**
 * Link this workspace to an existing GitHub repo without cloning. Use when
 * the workspace folder already has files (or even already has a .git/) and
 * you just want to attach it to a remote. The first sync tick handles the
 * commit + pull --rebase + push dance. Idempotent across:
 *   - no .git/ → `git init` creates it
 *   - .git/ with no origin → `git remote add origin`
 *   - .git/ with a different origin → `git remote set-url origin`
 */
export async function setupLink({ workspacePath, remoteUrl, pat }) {
  const parsed = parseGithubUrl(remoteUrl);
  if (!parsed) return { ok: false, error: 'Not a valid GitHub URL' };
  const url = cloneUrlFor(parsed.owner, parsed.repo);

  // Verify we can write to the chosen repo before we touch git config.
  const probe = await probeWrite(parsed.owner, parsed.repo, pat);
  if (!probe.ok) return probe;

  const status = await workspaceStatus(workspacePath);
  if (!status.hasGit) {
    const init = await gitSpawn(workspacePath, ['init', '-b', 'main'], { timeoutMs: 5000 });
    if (!init.ok) return { ok: false, error: init.stderr.trim() || 'git init failed' };
  }
  if (status.hasOrigin) {
    const reset = await gitSpawn(workspacePath, ['remote', 'set-url', 'origin', url], { timeoutMs: 5000 });
    if (!reset.ok) return { ok: false, error: reset.stderr.trim() };
  } else {
    const add = await gitSpawn(workspacePath, ['remote', 'add', 'origin', url], { timeoutMs: 5000 });
    if (!add.ok) return { ok: false, error: add.stderr.trim() };
  }

  const who = await verifyPat(pat);
  if (who.ok) await setLocalIdentity(workspacePath, who.login, who.id);

  return { ok: true, remoteUrl: url };
}

/**
 * Detach a workspace from its remote. Leaves `.git/` in place (cheap to
 * resume) but removes origin so the sync engine won't try to push.
 */
export async function teardown({ workspacePath }) {
  const status = await workspaceStatus(workspacePath);
  if (!status.hasOrigin) return { ok: true };
  const res = await gitSpawn(workspacePath, ['remote', 'remove', 'origin'], { timeoutMs: 5000 });
  if (!res.ok) return { ok: false, error: res.stderr.trim() };
  return { ok: true };
}
