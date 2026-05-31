import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TrashIcon } from '../Icons.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';

const GLOBAL_STATES = ['enabled', 'disabled'];

function StateButtons({ states, value, onChange, ariaLabel }) {
  return (
    <div className="skill-state-group" role="radiogroup" aria-label={ariaLabel}>
      {states.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          className={`skill-state-button ${value === s ? 'active' : ''}`}
          onClick={() => onChange(s)}
        >
          {s.charAt(0).toUpperCase() + s.slice(1)}
        </button>
      ))}
    </div>
  );
}

// Show only the first sentence. If the description has no period, cap at
// MAX_DESC_CHARS so a paragraph-long blob doesn't blow up the row height.
const MAX_DESC_CHARS = 120;
function shortDescription(text) {
  if (!text) return '';
  const periodIdx = text.indexOf('.');
  if (periodIdx >= 0) {
    const sentence = text.slice(0, periodIdx + 1);
    return text.length > sentence.length ? `${sentence} …` : sentence;
  }
  if (text.length > MAX_DESC_CHARS) {
    return `${text.slice(0, MAX_DESC_CHARS).trimEnd()} …`;
  }
  return text;
}

export default function AiSkillsTab({ skills, onSkillsChange }) {
  const [installed, setInstalled] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<any>(null);

  // Async settings calls (reload, importPicker, importFromPath, remove) may
  // resolve after the modal closes. Gate all state updates on this so we
  // don't write to an unmounted component.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const reload = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    try {
      const list = await window.api.skills.list();
      if (!mountedRef.current) return;
      setInstalled(list);
    } catch (err: any) {
      if (!mountedRef.current) return;
      setError(err?.message ?? String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const globalState = skills?.global ?? {};

  const setGlobal = useCallback((folderName, value) => {
    const nextGlobal = { ...globalState, [folderName!]: value };
    onSkillsChange({ ...skills, global: nextGlobal });
  }, [skills, globalState, onSkillsChange]);

  // Wrap setError so post-await calls don't write to an unmounted component.
  const safeSetError = useCallback((msg) => {
    if (mountedRef.current) setError(msg);
  }, []);

  const onImportClick = useCallback(async () => {
    setError(null);
    try {
      const destPath = await window.api.skills.importPicker();
      if (destPath) {
        const folderName = destPath.split(/[\\/]/).pop();
        onSkillsChange({ ...skills, global: { ...globalState, [folderName!]: 'enabled' } });
        await reload();
      }
    } catch (err: any) {
      safeSetError(err?.message ?? String(err));
    }
  }, [reload, skills, globalState, onSkillsChange, safeSetError]);

  const onRemove = useCallback(async (skill) => {
    setError(null);
    try {
      await window.api.skills.remove(skill.folderName);
      // Clean up state entries pointing at the removed skill.
      const nextGlobal = { ...globalState };
      delete nextGlobal[skill.folderName];
      const nextWorkspaces = {};
      for (const [wsId, m] of Object.entries(skills?.workspaces ?? {})) {
        const copy = { ...(m as any) };
        delete copy[skill.folderName];
        nextWorkspaces[wsId] = copy;
      }
      onSkillsChange({ ...skills, global: nextGlobal, workspaces: nextWorkspaces });
      await reload();
    } catch (err: any) {
      safeSetError(err?.message ?? String(err));
    }
  }, [skills, globalState, onSkillsChange, reload, safeSetError]);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragOver(false);
    setError(null);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const importedFolders: any[] = [];
    for (const file of files) {
      const srcPath = window.api.skills.pathForFile(file);
      if (!srcPath) {
        setError('Could not resolve dropped item path. Use the picker instead.');
        continue;
      }
      try {
        const destPath = await window.api.skills.importFromPath(srcPath);
        if (destPath) importedFolders.push(destPath.split(/[\\/]/).pop());
      } catch (err: any) {
        safeSetError(err?.message ?? String(err));
      }
    }
    if (importedFolders.length > 0) {
      const nextGlobal = { ...globalState };
      for (const fn of importedFolders) nextGlobal[fn] = 'enabled';
      onSkillsChange({ ...skills, global: nextGlobal });
      await reload();
    }
  }, [reload, skills, globalState, onSkillsChange, safeSetError]);

  return (
    <div>
      <p className="settings-tab-intro">
        Skills are reusable instructions the Agent loads on demand. Global state below sets the
        default; per-workspace overrides live in the Workspace Skills tab.
      </p>

      <h3 className="settings-subsection-title">Add a skill</h3>
      <div
        className={`skill-dropzone ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <span>Drop a skill folder here</span>
        <button type="button" className="skill-dropzone-button" onClick={onImportClick}>
          or choose a folder…
        </button>
      </div>

      {error && <div className="skill-error">{error}</div>}

      <h3 className="settings-subsection-title">Installed skills</h3>
      {loading ? (
        <div className="settings-empty">Loading…</div>
      ) : installed.length === 0 ? (
        <div className="settings-empty">No skills installed yet.</div>
      ) : (
        <ul className="skill-list">
          {installed.map((skill) => {
            const gValue = globalState[skill.folderName] ?? 'disabled';
            return (
              <li key={skill.folderName} className={`skill-row ${skill.hasSkillMd ? '' : 'broken'}`}>
                <div className="skill-info">
                  <div className="skill-name">
                    {skill.name}
                    {!skill.hasSkillMd && <span className="skill-broken-badge">no SKILL.md</span>}
                  </div>
                  {skill.description && (
                    <div className="skill-description" title={skill.description}>
                      {shortDescription(skill.description)}
                    </div>
                  )}
                  <div className="skill-folder">{skill.folderName}</div>
                </div>
                <div className="skill-controls">
                  <StateButtons
                    states={GLOBAL_STATES}
                    value={gValue}
                    onChange={(v) => setGlobal(skill.folderName, v)}
                    ariaLabel={`Global state for ${skill.name}`}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setConfirmRemove(skill)}
                    title="Remove skill"
                    aria-label={`Remove ${skill.name}`}
                    style={{ marginLeft: 'auto' }}
                  ><TrashIcon size={14} /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="settings-field-hint">
        Changes take effect on the next chat session. Use the chat sidebar's Clear button to start a new session.
      </p>

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove skill"
        message={confirmRemove ? `Remove "${confirmRemove.name}"? Its files will be deleted from the skill library.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          const target = confirmRemove;
          setConfirmRemove(null);
          if (target) onRemove(target);
        }}
        onClose={() => setConfirmRemove(null)}
      />
    </div>
  );
}
