import React, { useCallback, useEffect, useMemo, useState } from 'react';

const WORKSPACE_STATES = ['inherit', 'enabled', 'disabled'];

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

// Workspace-scoped skill overrides. Editor picks one workspace at a time so the
// UI stays compact regardless of workspace count. Defaults to the active
// workspace if one is open.
export default function WorkspaceSkillsTab({ skills, onSkillsChange, workspaces, activeWorkspaceId }) {
  const [installed, setInstalled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Local picker state — defaults to active workspace, falls back to first.
  const initialId = activeWorkspaceId ?? workspaces?.[0]?.id ?? '';
  const [selectedId, setSelectedId] = useState(initialId);
  useEffect(() => {
    // If the active workspace changes (or selectedId no longer exists), realign.
    if (!workspaces?.some((w) => w.id === selectedId)) {
      setSelectedId(activeWorkspaceId ?? workspaces?.[0]?.id ?? '');
    }
  }, [activeWorkspaceId, workspaces, selectedId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await window.api.skills.list();
        if (!cancelled) setInstalled(list);
      } catch (err) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const globalState = skills?.global ?? {};
  const wsOverrides = useMemo(() => (
    (selectedId && skills?.workspaces?.[selectedId]) || {}
  ), [skills, selectedId]);

  const setOverride = useCallback((folderName, value) => {
    if (!selectedId) return;
    const currentWs = skills?.workspaces?.[selectedId] ?? {};
    const nextWs = { ...currentWs };
    if (value === 'inherit') delete nextWs[folderName];
    else nextWs[folderName] = value;
    const nextWorkspaces = { ...(skills?.workspaces ?? {}), [selectedId]: nextWs };
    onSkillsChange({ ...skills, workspaces: nextWorkspaces });
  }, [skills, selectedId, onSkillsChange]);

  const noWorkspaces = !workspaces || workspaces.length === 0;

  return (
    <div>
      <p className="settings-tab-intro">
        Override the global enable/disable per workspace. <strong>Inherit</strong> follows the
        global setting; <strong>Enabled</strong> and <strong>Disabled</strong> override it for this
        workspace only.
      </p>

      {noWorkspaces ? (
        <div className="settings-empty">No workspaces yet. Add one from the Workspaces section.</div>
      ) : (
        <>
        <h3 className="settings-subsection-title">Workspace</h3>
        <div className="settings-field">
          <label className="settings-field-label" htmlFor="ws-skills-picker">Choose workspace</label>
          <select
            id="ws-skills-picker"
            className="settings-select"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}{ws.id === activeWorkspaceId ? ' (active)' : ''}
              </option>
            ))}
          </select>
        </div>
        </>
      )}

      {error && <div className="skill-error">{error}</div>}

      {!noWorkspaces && <h3 className="settings-subsection-title">Skills</h3>}
      {noWorkspaces ? null : loading ? (
        <div className="settings-empty">Loading…</div>
      ) : installed.length === 0 ? (
        <div className="settings-empty">No skills installed. Add some in the Global Skills tab.</div>
      ) : (
        <ul className="skill-list">
          {installed.map((skill) => {
            const wValue = wsOverrides[skill.folderName] ?? 'inherit';
            const inheritedFrom = globalState[skill.folderName] === 'enabled' ? 'enabled' : 'disabled';
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
                  <div className="skill-folder">Inherits global: {inheritedFrom}</div>
                </div>
                <div className="skill-controls">
                  <StateButtons
                    states={WORKSPACE_STATES}
                    value={wValue}
                    onChange={(v) => setOverride(skill.folderName, v)}
                    ariaLabel={`Override for ${skill.name} in selected workspace`}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
