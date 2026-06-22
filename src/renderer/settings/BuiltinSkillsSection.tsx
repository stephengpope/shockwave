import React, { useCallback, useEffect, useRef, useState } from 'react';

// Global on/off for the agent's bundled built-in skills (excalidraw, firecrawl,
// playwright, …). This is the master default; a workspace can override any of
// these per-workspace on its "Manage Skills" page. Absent in the global map ⇒
// enabled (default-on).

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

export default function BuiltinSkillsSection({ globalBuiltinSkills, onGlobalBuiltinSkillToggle }) {
  const [builtin, setBuiltin] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    (async () => {
      try {
        const { builtin: b } = await window.api.skills.list(null);
        if (mountedRef.current) setBuiltin(b ?? []);
      } catch (err: any) {
        if (mountedRef.current) setError(err?.message ?? String(err));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
  }, []);

  const isEnabled = useCallback((fn: string) => globalBuiltinSkills?.[fn] !== 'disabled', [globalBuiltinSkills]);

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Built-in Skills</h2>
      <p className="settings-section-desc">
        Skills bundled with the agent. These toggles are the global default; any
        workspace can override them on its <strong>Manage Skills</strong> page.
      </p>

      {error && <div className="skill-error">{error}</div>}

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
                <div className="skill-state-group" role="radiogroup" aria-label={`${s.name} (global)`}>
                  {['enabled', 'disabled'].map((st) => {
                    const active = (st === 'enabled') === isEnabled(s.folderName);
                    return (
                      <button
                        key={st}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`skill-state-button ${active ? 'active' : ''}`}
                        onClick={() => onGlobalBuiltinSkillToggle(s.folderName, st === 'enabled')}
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
    </div>
  );
}
