// Skill library: shockwave-managed folder of pi skills.
//
// Layout: <userData>/pi-agent/skill-library/<skill-name>/SKILL.md
//
// Pi never auto-discovers this directory. At session boot we compute the
// effective list of enabled skills (global + workspace overrides) and write
// it as `skills: []` to <userData>/pi-agent/settings.json, which pi reads.

import path from 'node:path';
import fs from 'node:fs/promises';

export function agentDirFor(userDataDir) {
  return path.join(userDataDir, 'pi-agent');
}

export function libraryDirFor(userDataDir) {
  return path.join(agentDirFor(userDataDir), 'skill-library');
}

function piSettingsPath(userDataDir) {
  return path.join(agentDirFor(userDataDir), 'settings.json');
}

export async function ensureDirs(userDataDir) {
  await fs.mkdir(libraryDirFor(userDataDir), { recursive: true });
}

// Pull `name` and `description` out of `--- … ---` YAML frontmatter.
// Pi already validates these — we just need them to display in the UI.
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[kv[1]] = val;
  }
  return out;
}

async function readSkillFolder(folderPath) {
  const skillFile = path.join(folderPath, 'SKILL.md');
  let text;
  try {
    text = await fs.readFile(skillFile, 'utf8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  return {
    folderName: path.basename(folderPath),
    path: folderPath,
    name: fm.name || path.basename(folderPath),
    description: fm.description || '',
    hasSkillMd: true,
  };
}

// Read the skill library; one entry per direct child folder. Folders without
// a SKILL.md are surfaced with hasSkillMd:false so the UI can flag them.
export async function listInstalled(userDataDir) {
  const dir = libraryDirFor(userDataDir);
  await ensureDirs(userDataDir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const parsed = await readSkillFolder(full);
    if (parsed) {
      out.push(parsed);
    } else {
      out.push({ folderName: e.name, path: full, name: e.name, description: '', hasSkillMd: false });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Copy a folder from `srcPath` into the skill library. Validates that a
// SKILL.md exists at the root and rejects on folder-name collision.
export async function importFromPath(userDataDir, srcPath) {
  let stat;
  try { stat = await fs.stat(srcPath); }
  catch { throw new Error(`Source folder not found: ${srcPath}`); }
  if (!stat.isDirectory()) throw new Error('Drop a folder, not a file.');

  const skillFile = path.join(srcPath, 'SKILL.md');
  try { await fs.access(skillFile); }
  catch { throw new Error(`"${path.basename(srcPath)}" has no SKILL.md at its root.`); }

  await ensureDirs(userDataDir);
  const destName = path.basename(srcPath);
  const destPath = path.join(libraryDirFor(userDataDir), destName);
  try {
    await fs.access(destPath);
    throw new Error(`A skill named "${destName}" already exists. Delete it first to replace.`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.cp(srcPath, destPath, { recursive: true, errorOnExist: true });
  return destPath;
}

// Delete the skill folder. Caller is responsible for clearing the skill's
// entries out of `global[name]` and `workspaces[*][name]` in settings.
export async function removeSkill(userDataDir, folderName) {
  const dir = path.join(libraryDirFor(userDataDir), folderName);
  await fs.rm(dir, { recursive: true, force: true });
}

// Compute the absolute paths pi should load for a given workspace.
//   global[name]            = 'enabled' | 'disabled'
//   workspaces[wsId][name]  = 'inherit' | 'enabled' | 'disabled'
// Workspace override wins; 'inherit' (or missing) falls back to global.
export function computeEffectivePaths(installed, skillsState, workspaceId) {
  const globalState = skillsState?.global ?? {};
  const wsState = (workspaceId && skillsState?.workspaces?.[workspaceId]) || {};
  const enabled = [];
  for (const skill of installed) {
    if (!skill.hasSkillMd) continue;
    const wsValue = wsState[skill.folderName];
    let on;
    if (wsValue === 'enabled') on = true;
    else if (wsValue === 'disabled') on = false;
    else on = globalState[skill.folderName] === 'enabled';
    if (on) enabled.push(skill.path);
  }
  return enabled;
}

// Write `skills: []` and `extensions: []` to <agentDir>/settings.json so pi
// loads exactly that set on next session boot. Merges into any existing pi
// settings file to preserve anything pi has put there itself. Either field
// may be omitted; the existing value is kept untouched.
export async function writePiSettings(userDataDir, { skills, extensions } = {}) {
  await ensureDirs(userDataDir);
  const file = piSettingsPath(userDataDir);
  let current = {};
  try {
    const raw = await fs.readFile(file, 'utf8');
    current = JSON.parse(raw);
    if (typeof current !== 'object' || current === null) current = {};
  } catch {
    current = {};
  }
  const next = { ...current };
  if (Array.isArray(skills)) next.skills = skills;
  if (Array.isArray(extensions)) next.extensions = extensions;
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
