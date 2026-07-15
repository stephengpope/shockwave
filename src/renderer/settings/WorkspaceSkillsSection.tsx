import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import ConfirmDialog from '../ConfirmDialog.jsx';
import ErrorMessage from '../ErrorMessage.jsx';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// "Manage Skills" — per-workspace skills for the coding agent (active workspace):
//   • Built-in (bundled) skills — a per-workspace on/off toggle. Built-ins are
//     default-on: enabled unless this workspace explicitly disables one. There
//     is no global tier.
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

export default function WorkspaceSkillsSection({ workspacePath, builtinSkills, onBuiltinSkillToggle }) {
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

  // Built-ins are default-on: an absent key means enabled. Only an explicit
  // 'disabled' turns one off for this workspace.
  const isBuiltinEnabled = (folderName: string) => {
    return builtinSkills?.[folderName] !== 'disabled';
  };

  return (
    <SettingsSection
      title="Manage Skills"
      description="Skills for this workspace. Toggle the agent's built-ins just for this workspace, or add your own — uploads are copied into the workspace and travel with it."
    >
      {error && <ErrorMessage>{error}</ErrorMessage>}

      <SettingsGroup title="Built-in">
        {loading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : builtin.length === 0 ? (
          <div className="text-xs text-muted-foreground">No built-in skills.</div>
        ) : (
          <ul className="flex flex-col">
            {builtin.map((s) => (
              <li
                key={s.folderName}
                className="flex items-start justify-between gap-4 border-b border-border py-2.5 last:border-0"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{s.name}</div>
                  {s.description && (
                    <div className="text-xs text-muted-foreground" title={s.description}>
                      {shortDescription(s.description)}
                    </div>
                  )}
                </div>
                <Select
                  value={isBuiltinEnabled(s.folderName) ? 'enabled' : 'disabled'}
                  onValueChange={(st) => onBuiltinSkillToggle(s.folderName, st === 'enabled')}
                >
                  <SelectTrigger
                    size="sm"
                    className="h-8 w-24 shrink-0"
                    aria-label={`${s.name} for this workspace`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="enabled">On</SelectItem>
                    <SelectItem value="disabled">Off</SelectItem>
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Uploaded">
        <button
          type="button"
          className={cn(
            'w-full cursor-pointer rounded-md border border-dashed border-border bg-transparent p-4 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50',
            dragOver && 'border-ring bg-accent/50'
          )}
          onClick={onImportClick}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          Drop a skill folder here, or click to choose one. It's copied into this
          workspace's <code>.shockwave/skills/</code> and travels with it.
        </button>

        {loading ? null : uploaded.length === 0 ? (
          <div className="text-xs text-muted-foreground">No uploaded skills yet.</div>
        ) : (
          <ul className="flex flex-col">
            {uploaded.map((s) => (
              <li
                key={s.folderName}
                className={cn(
                  'flex items-start justify-between gap-4 border-b border-border py-2.5 last:border-0',
                  !s.hasSkillMd && 'opacity-70'
                )}
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    {s.name}
                    {!s.hasSkillMd && (
                      <span className="ml-2 rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                        no SKILL.md
                      </span>
                    )}
                  </div>
                  {s.description && (
                    <div className="text-xs text-muted-foreground" title={s.description}>
                      {shortDescription(s.description)}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  title="Remove skill"
                  onClick={() => setConfirmRemove(s)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove skill"
        message={confirmRemove ? `Delete "${confirmRemove.name}" from this workspace's skills folder? This can't be undone.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={() => { const s = confirmRemove; setConfirmRemove(null); if (s) onRemove(s); }}
        onClose={() => setConfirmRemove(null)}
      />
    </SettingsSection>
  );
}
