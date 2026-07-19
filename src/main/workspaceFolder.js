// What a folder IS, from the app's point of view — the question the
// add-workspace flow asks before it decides anything else.
//
// Plain `.js` with no electron import, so `node --test` can exercise it against
// real git repos in tmp dirs. Same split as `cronScheduler.js` vs `cron.ts` and
// `settingsKeys.js` vs `settingsStore.ts`: the decision is pure and testable,
// the wiring around it isn't.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

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

// Minimal git runner. `sync.ts` has a richer one (PAT via GIT_ASKPASS, timeouts,
// SIGKILL) but nothing here authenticates — these are local reads only.
function git(cwd, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, stdout: '' });
      return;
    }
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', () => resolve({ ok: false, stdout: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout }));
  });
}

/**
 * Classify a folder into one of three states:
 *
 *   empty     nothing in it → safe to clone into
 *   clone     a GitHub checkout → carries repoOwner/repoName/defaultBranch
 *   occupied  anything else → carries `error` explaining why
 *
 * Dotfiles and `.DS_Store` don't count as contents: a folder holding only those
 * is still "empty" for our purposes (a failed clone's leftovers, or a folder the
 * user just made in the picker).
 *
 * `git` is injected so tests can drive the non-git branches without one.
 */
export async function classifyFolder(workspacePath, runGit = git) {
  if (!workspacePath) return { state: 'occupied', error: 'No folder given' };

  let entries;
  try {
    entries = await fs.readdir(workspacePath);
  } catch (err) {
    return { state: 'occupied', error: `Can't read that folder: ${err.message}` };
  }
  const real = entries.filter((e) => e !== '.DS_Store' && !e.startsWith('.'));
  const hasGit = entries.includes('.git');

  if (!hasGit) {
    return real.length === 0
      ? { state: 'empty' }
      : { state: 'occupied', error: "That folder has files in it but isn't a git repo." };
  }

  const remote = await runGit(workspacePath, ['remote', 'get-url', 'origin']);
  const parsed = remote.ok ? parseGithubUrl(remote.stdout.trim()) : null;
  if (!parsed) {
    return { state: 'occupied', error: "That folder is a git repo, but its origin isn't a GitHub URL we can use." };
  }

  // What git actually checked out — the only answer that can't be stale. Read
  // ONCE here, at setup; the workspace row owns it from then on.
  const branch = await runGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    state: 'clone',
    repoOwner: parsed.owner,
    repoName: parsed.repo,
    defaultBranch: (branch.ok && branch.stdout.trim()) || 'main',
  };
}

/**
 * Does this folder's checkout match the repo a workspace row claims? The guard
 * on `setUpHere`: attaching a row to a folder holding a DIFFERENT repo would
 * make the row lie about its own contents, and the engine would then push one
 * repo's commits at another.
 *
 * Returns null when it matches, or the error string when it doesn't.
 */
export function repoMismatch(info, ws) {
  if (info.repoOwner === ws.repoOwner && info.repoName === ws.repoName) return null;
  return `That folder is a clone of ${info.repoOwner}/${info.repoName}, not ${ws.repoOwner}/${ws.repoName}.`;
}
