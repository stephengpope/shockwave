import { useState, useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { formatDailyNote, resolveDailyNotePath } from '../dailyNote.js';

interface DailyNoteConfig {
  format: string;
  folder: string;
  // Workspace-relative path of the template seeded into a new daily note
  // ('' = none).
  templatePath: string;
}

interface UseDailyNoteOpts {
  workspacePath: string | null;
  // Read via ref so openJournal always sees the latest format/folder without
  // being rebuilt when the setting changes.
  dailyNoteRef: MutableRefObject<DailyNoteConfig>;
  writeNow: () => Promise<unknown>;
  openInActiveTab: (path: string) => Promise<unknown> | unknown;
  linkIndex: {
    cache: { candidatesFor: (basename: string) => string[] };
    updateFile: (path: string, text: string, mtime: number) => void;
  };
  fileOps: { treeAndIndexChanged: () => Promise<unknown> };
  showError: (msg: string) => void;
}

// Daily notes: the calendar date-picker anchor + openJournal, which opens (or
// creates) the daily note for a date using the user's configured format/folder.
export function useDailyNote({
  workspacePath,
  dailyNoteRef,
  writeNow,
  openInActiveTab,
  linkIndex,
  fileOps,
  showError,
}: UseDailyNoteOpts) {
  // Anchor for the JournalDatePicker popover ({x, y} on right-click, else null).
  const [journalPickerAnchor, setJournalPickerAnchor] = useState<{ x: number; y: number } | null>(null);

  // openJournal(date?) — opens (or creates) the daily note for `date` (default
  // today) using the user's configured format + folder. If the format contains
  // "/" the leading segments become subfolders. Existing notes are opened in
  // place regardless of where they live (basename uniqueness is workspace-wide).
  const openJournal = useCallback(async (date?: Date) => {
    if (!workspacePath) return;
    const d = date ?? new Date();
    const dn = dailyNoteRef.current;
    const formatted = formatDailyNote(dn.format, d);
    if (!formatted) {
      showError('Daily note format is invalid. Open Settings → Daily Note to fix it.');
      return;
    }
    const { dir, name } = resolveDailyNotePath(workspacePath, dn.folder, formatted);
    try {
      await writeNow();
      // Daily notes are basename-keyed; if duplicates exist, open the shallowest.
      const dnPaths = linkIndex.cache.candidatesFor(name.toLowerCase());
      const existing = dnPaths && dnPaths.length
        ? dnPaths.slice().sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0]
        : null;
      if (existing) {
        await openInActiveTab(existing);
        return;
      }
      // Seed a new daily note with the configured default template, if any.
      let initial = '';
      if (dn.templatePath) {
        try {
          initial = await window.api.readFile(`${workspacePath}/${dn.templatePath}`);
        } catch {
          // Template missing/unreadable — fall back to an empty note.
          initial = '';
        }
      }
      await window.api.ensureDir(dir);
      const { path: newPath, mtime } = await window.api.createFile(dir, `${name}.md`, initial);
      linkIndex.updateFile(newPath, initial, mtime);
      await fileOps.treeAndIndexChanged();
      await openInActiveTab(newPath);
    } catch (err: any) {
      showError(err.message ?? String(err));
    }
  }, [workspacePath, dailyNoteRef, writeNow, linkIndex, openInActiveTab, fileOps, showError]);

  return { journalPickerAnchor, setJournalPickerAnchor, openJournal };
}
