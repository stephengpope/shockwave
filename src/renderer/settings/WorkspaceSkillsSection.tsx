import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TrashIcon } from '../Icons.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';

// "Manage Skills" — per-workspace skills for the coding agent (active workspace):
//   • Built-in (bundled) skills — a per-workspace on/off OVERRIDE of the global
//     Built-in Skills default (AI Agent → Built-in Skills). Shown state is the
//     effective one (workspace override if set, else global, else on).
//   • Uploaded skills — folders the user drops into `<workspace>/.shockwave/skills/`.
//     Presence ⇒ enabled; remove deletes the folder.
// (Skills the agent itself writes to `<workspace>/.agents/skills/` are auto-
// discovered by pi and don't appear here.)

const MAX_DESC_CHARS = 120;
function shortDescription(text: string) {
  if (!text) return '';
  const periodIdx = text.indexOf('.');
  if (periodIdx >= 0) {
    const sentence = text.slice(0, periodIdx + 1);
    return text.length > sentence.length ? `${sentence} …` : sentence;
  }
  return text.length > MAX_DESC_CHARS ? `${text.slice(0, MAX_DESC_CHARS).trimEnd()} …` : text;
}

export default function WorkspaceSkillsSection({ workspacePath, builtinSkills, globalBuiltinSkills, onBuiltinSkillToggle }) {
  const [builtin, setBuiltin] = useState<any[]>([]);
  const [uploaded, setUploaded] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<any>(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const reload = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    try {
      const { builtin: b, workspace: w } = await window.api.skills.list(workspacePath);
      if (!mountedRef.current) return;
      setBuiltin(b ?? []);
      setUploaded(w ?? []);
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message ?? String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => { reload(); }, [reload]);

  const safeSetError = useCallback((msg: any) => { if (mountedRef.current) setError(msg); }, []);

  const onImportClick = useCallback(async () => {
    setError(null);
    try {
      const dest = await window.api.skills.importPicker(workspacePath);
      if (dest) await reload();
    } catch (err: any) {
      safeSetError(err?.message ?? String(err));
    }
  }, [workspacePath, reload, safeSetError]);

  const onRemove = useCallback(async (skill: any) => {
    setError(null);
    try {
      await window.api.skills.remove(workspacePath, skill.folderName);
      await reload();
    } catch (err: any) {
      safeSetError(err?.message ?? String(err));
    }
  }, [workspacePath, reload, safeSetError]);

  const onDrop = useCallback(async (e: any) => {
    e.preventDefault();
    setDragOver(false);
    setError(null);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    let any = false;
    for (const file of files) {
      const srcPath = window.api.skills.pathForFile(file);
      if (!srcPath) { setError('Could not resolve the dropped item. Use the picker instead.'); continue; }
      try { await window.api.skills.importFromPath(workspacePath, srcPath); any = true; }
      catch (err: any) { safeSetError(err?.message ?? String(err)); }
    }
    if (any) await reload();
  }, [workspacePath, reload, safeSetError]);

  // Effective state for a built-in here: workspace override wins, else the global
  // default, else enabled (default-on).
  const isBuiltinEnabled = (folderName: string) => {
    const state = builtinSkills?.[folderName] ?? globalBuiltinSkills?.[folderName];
    return state !== 'disabled';
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Manage Skills</h2>
      <p className="settings-section-desc">
        Skills for this workspace. Toggle the agent's built-ins just for this
        workspace, or add your own — uploads are copied into the workspace and
        travel with it.
      </p>

      {error && <div className="skill-error">{error}</div>}

      <h3 className="settings-subsection-title">Built-in</h3>
      {loading ? (
        <div className="settings-empty">Loading…</div>
      ) : builtin.length === 0 ? (
        <div className="settings-empty">No built-in skills.</div>
      ) : (
        <ul className="skill-list">
          {builtin.map((s) => (
            <li key={s.folderName} className="skill-row">
              <div className="skill-info">
                <div className="skill-name">{s.name}</div>
                {s.description && (
                  <div className="skill-description" title={s.description}>{shortDescription(s.description)}</div>
                )}
              </div>
              <div className="skill-controls">
                <div className="skill-state-group" role="radiogroup" aria-label={`${s.name} for this workspace`}>
                  {['enabled', 'disabled'].map((st) => {
                    const active = (st === 'enabled') === isBuiltinEnabled(s.folderName);
                    return (
                      <button
                        key={st}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`skill-state-button ${active ? 'active' : ''}`}
                        onClick={() => onBuiltinSkillToggle(s.folderName, st === 'enabled')}
                      >
                        {st === 'enabled' ? 'On' : 'Off'}
                      </button>
                    );
                  })}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="settings-subsection-title">Uploaded</h3>
      <button
        type="button"
        className={`skill-dropzone ${dragOver ? 'over' : ''}`}
        onClick={onImportClick}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        Drop a skill folder here, or click to choose one. It's copied into this
        workspace's <code>.shockwave/skills/</code> and travels with it.
      </button>

      {loading ? null : uploaded.length === 0 ? (
        <div className="settings-empty">No uploaded skills yet.</div>
      ) : (
        <ul className="skill-list">
          {uploaded.map((s) => (
            <li key={s.folderName} className={`skill-row ${s.hasSkillMd ? '' : 'broken'}`}>
              <div className="skill-info">
                <div className="skill-name">
                  {s.name}
                  {!s.hasSkillMd && <span className="skill-broken-badge">no SKILL.md</span>}
                </div>
                {s.description && (
                  <div className="skill-description" title={s.description}>{shortDescription(s.description)}</div>
                )}
              </div>
              <div className="skill-controls">
                <button className="icon-btn" title="Remove skill" onClick={() => setConfirmRemove(s)}>
                  <TrashIcon size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove skill"
        message={confirmRemove ? `Delete "${confirmRemove.name}" from this workspace's skills folder? This can't be undone.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={() => { const s = confirmRemove; setConfirmRemove(null); if (s) onRemove(s); }}
        onClose={() => setConfirmRemove(null)}
      />
    </div>
  );
}
