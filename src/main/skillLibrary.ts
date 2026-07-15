// Skill sources for the pi coding agent.
//
// Two kinds of skill, both fed to pi as explicit paths at session boot:
//   • Built-in — bundled with the app (read from `builtinDir`). Always present;
//     enabled/disabled PER WORKSPACE via the workspace's `.shockwave/workspace.json`
//     `builtinSkills` map (absent ⇒ enabled).
//   • Uploaded — user-dropped folders under `<workspace>/.shockwave/skills/`.
//     Per-workspace, git-synced with the workspace. Presence ⇒ enabled.
//
// Pi ALSO auto-discovers `<workspace>/.agents/skills` (and `~/.agents/skills`)
// on its own — those are the agent's own scratch skills and need no wiring here.

import path from 'node:path';
import fs from 'node:fs/promises';

export function agentDirFor(userDataDir) {
  return path.join(userDataDir, 'pi-agent');
}

// User-uploaded skills live inside each workspace, under our `.shockwave/`
// config area: `<workspace>/.shockwave/skills/<skill>/SKILL.md`.
export function workspaceSkillsDir(workspacePath) {
  return path.join(workspacePath, '.shockwave', 'skills');
}

function piSettingsPath(userDataDir) {
  return path.join(agentDirFor(userDataDir), 'settings.json');
}

export async function ensureDirs(userDataDir) {
  await fs.mkdir(agentDirFor(userDataDir), { recursive: true });
}

// Pull `name` and `description` out of `--- … ---` YAML frontmatter. Handles
// inline values and block scalars (`description: |` / `: >` with the text on the
// following indented lines) — common in SKILL.md files.
function parseFrontmatter(text): any {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (/^[|>][+-]?$/.test(val)) {
      // Block scalar: gather the following more-indented lines. `>` folds onto
      // one line (spaces); `|` keeps newlines.
      const fold = val[0] === '>';
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '') { collected.push(''); continue; }
        if (/^\s/.test(lines[j])) collected.push(lines[j].replace(/^\s+/, ''));
        else break;
      }
      i = j - 1;
      val = collected.join(fold ? ' ' : '\n').trim();
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function readSkillFolder(folderPath, source) {
  const skillFile = path.join(folderPath, 'SKILL.md');
  let text;
  try {
    text = await fs.readFile(skillFile, 'utf8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  // `required-secrets` (comma-separated) declares agent-secret names the skill
  // needs. Shockwave auto-provisions an empty slot per name (see
  // ensureBuiltinSecretSlots in main).
  const requiredSecrets = String(fm['required-secrets'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    folderName: path.basename(folderPath),
    path: folderPath,
    name: fm.name || path.basename(folderPath),
    description: fm.description || '',
    hasSkillMd: true,
    source,
    requiredSecrets,
  };
}

// Scan one skill dir; one entry per direct child folder, tagged with `source`.
// Missing dir → []. Folders without SKILL.md surface with hasSkillMd:false.
async function scanSkillDir(dir, source) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const parsed = await readSkillFolder(full, source);
    if (parsed) out.push(parsed);
    else out.push({ folderName: e.name, path: full, name: e.name, description: '', hasSkillMd: false, source });
  }
  return out;
}

// Bundled built-in skills (shipped with the app).
export async function listBuiltinSkills(builtinDir?) {
  const out = builtinDir ? await scanSkillDir(builtinDir, 'builtin') : [];
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// User-uploaded skills inside a workspace's `.shockwave/skills/`.
export async function listWorkspaceSkills(workspacePath?) {
  if (!workspacePath) return [];
  const out = await scanSkillDir(workspaceSkillsDir(workspacePath), 'workspace');
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Copy a skill folder into the active workspace's `.shockwave/skills/`.
// Validates a root SKILL.md and rejects name collisions.
export async function importSkillToWorkspace(workspacePath, srcPath) {
  if (!workspacePath) throw new Error('No workspace open.');
  let stat;
  try { stat = await fs.stat(srcPath); }
  catch { throw new Error(`Source folder not found: ${srcPath}`); }
  if (!stat.isDirectory()) throw new Error('Drop a folder, not a file.');

  const skillFile = path.join(srcPath, 'SKILL.md');
  try { await fs.access(skillFile); }
  catch { throw new Error(`"${path.basename(srcPath)}" has no SKILL.md at its root.`); }

  const dir = workspaceSkillsDir(workspacePath);
  await fs.mkdir(dir, { recursive: true });
  const destName = path.basename(srcPath);
  const destPath = path.join(dir, destName);
  try {
    await fs.access(destPath);
    throw new Error(`A skill named "${destName}" already exists in this workspace. Delete it first to replace.`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.cp(srcPath, destPath, { recursive: true, errorOnExist: true });
  return destPath;
}

export async function removeWorkspaceSkill(workspacePath, folderName) {
  if (!workspacePath) return;
  await fs.rm(path.join(workspaceSkillsDir(workspacePath), folderName), { recursive: true, force: true });
}

// The absolute skill-folder paths pi should load for a workspace:
//   • each built-in that resolves ON — the workspace toggle decides; an absent
//     key means enabled (default-on). There is no global tier.
//   • every uploaded workspace skill
// Uploaded skills win a folder-name collision (a user copy can shadow a built-in).
export function computeEffectivePaths(builtins, wsToggles, workspaceSkills) {
  const w = wsToggles ?? {};
  const byName = new Map<string, any>(); // folderName(lower) → { path, source }
  for (const sk of builtins) {
    if (!sk.hasSkillMd) continue;
    const state = w[sk.folderName]; // workspace toggle; absent ⇒ enabled (default-on)
    if (state === 'disabled') continue;
    byName.set(sk.folderName.toLowerCase(), { path: sk.path, source: 'builtin' });
  }
  for (const sk of workspaceSkills) {
    if (!sk.hasSkillMd) continue;
    byName.set(sk.folderName.toLowerCase(), { path: sk.path, source: 'workspace' });
  }
  return [...byName.values()].map((v) => v.path);
}

// Write `skills: []` and `extensions: []` to <agentDir>/settings.json so pi
// loads exactly that set on next session boot. Merges into any existing pi
// settings file. Either field may be omitted; the existing value is kept.
export async function writePiSettings(userDataDir, { skills, extensions }: any = {}) {
  await ensureDirs(userDataDir);
  const file = piSettingsPath(userDataDir);
  let current: any = {};
  try {
    const raw = await fs.readFile(file, 'utf8');
    current = JSON.parse(raw);
    if (typeof current !== 'object' || current === null) current = {};
  } catch {
    current = {};
  }
  const next: any = { ...current };
  if (Array.isArray(skills)) next.skills = skills;
  if (Array.isArray(extensions)) next.extensions = extensions;
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
