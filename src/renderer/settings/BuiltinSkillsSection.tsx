import React, { useCallback, useEffect, useRef, useState } from 'react';
import ErrorMessage from '../ErrorMessage.jsx';
import { SettingsSection } from './SectionUI';
import { Switch } from '@/components/ui/switch';

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
    <SettingsSection
      title="Built-in Skills"
      description={(
        <>
          Skills bundled with the agent. These toggles are the global default; any
          workspace can override them on its <strong>Manage Skills</strong> page.
        </>
      )}
    >
      {error && <ErrorMessage>{error}</ErrorMessage>}

      {loading ? (
        <div className="text-[13px] text-muted-foreground">Loading…</div>
      ) : builtin.length === 0 ? (
        <div className="text-[13px] text-muted-foreground">No built-in skills.</div>
      ) : (
        <ul className="flex flex-col">
          {builtin.map((s) => (
            <li
              key={s.folderName}
              className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-foreground">{s.name}</div>
                {s.description && (
                  <div className="text-xs text-muted-foreground" title={s.description}>
                    {shortDescription(s.description)}
                  </div>
                )}
              </div>
              <Switch
                checked={isEnabled(s.folderName)}
                onCheckedChange={(v) => onGlobalBuiltinSkillToggle(s.folderName, v === true)}
                aria-label={`${s.name} (global)`}
              />
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
