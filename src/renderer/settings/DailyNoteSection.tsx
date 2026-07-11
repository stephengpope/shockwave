import React, { useMemo } from 'react';
import {
  DAILY_NOTE_FORMAT_PRESETS,
  DEFAULT_DAILY_NOTE_FORMAT,
  DAILY_NOTE_FORMAT_HELP_URL,
  formatDailyNote,
} from '../dailyNote.js';
import FolderCombobox from './FolderCombobox.jsx';
import { SettingsSection } from './SectionUI';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CUSTOM_VALUE = '__custom__';
// Radix Select forbids an empty-string item value; map '' (no template)
// through a sentinel. The stored settings value stays ''.
const NO_TEMPLATE_VALUE = '__none__';

export default function DailyNoteSection({
  dailyNote,
  onDailyNoteChange,
  tree,
  workspacePath,
  templateOptions = [] as Array<{ name: string; value: string }>,
}) {
  const format = dailyNote?.format || DEFAULT_DAILY_NOTE_FORMAT;
  const folder = dailyNote?.folder ?? '';
  const templatePath = dailyNote?.templatePath ?? '';

  const isPreset = DAILY_NOTE_FORMAT_PRESETS.includes(format);
  const previewToday = useMemo(() => formatDailyNote(format), [format]);

  const onSelectChange = (v) => {
    if (v === CUSTOM_VALUE) {
      // Switch to custom mode without changing the saved format yet — but
      // we keep the current value as the seed so the input shows something
      // meaningful.
      onDailyNoteChange({ ...dailyNote, format });
    } else {
      onDailyNoteChange({ ...dailyNote, format: v });
    }
  };

  const onCustomChange = (e) => {
    onDailyNoteChange({ ...dailyNote, format: e.target.value });
  };

  const onFolderChange = (next) => {
    onDailyNoteChange({ ...dailyNote, folder: next });
  };

  const openHelp = (e) => {
    e.preventDefault();
    if (window.api?.openExternal) {
      window.api.openExternal(DAILY_NOTE_FORMAT_HELP_URL);
    } else {
      window.open(DAILY_NOTE_FORMAT_HELP_URL, '_blank');
    }
  };

  return (
    <SettingsSection
      title="Daily Notes"
      description="Configure how the calendar button creates and opens daily notes."
    >
      <Field>
        <FieldLabel htmlFor="daily-note-format">Date format</FieldLabel>
        <Select value={isPreset ? format : CUSTOM_VALUE} onValueChange={onSelectChange}>
          <SelectTrigger id="daily-note-format" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAILY_NOTE_FORMAT_PRESETS.map((p) => (
              <SelectItem key={p} value={p}>{formatDailyNote(p)}</SelectItem>
            ))}
            <SelectItem value={CUSTOM_VALUE}>Custom</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription className="text-xs">
          Choose how daily notes are named in your workspace.
        </FieldDescription>
      </Field>

      {!isPreset && (
        <Field>
          <FieldLabel htmlFor="daily-note-custom">Custom format</FieldLabel>
          <Input
            id="daily-note-custom"
            type="text"
            className="font-mono"
            value={format}
            onChange={onCustomChange}
            placeholder="YYYY-MM-DD"
          />
          <FieldDescription className="text-xs">
            For more syntax, refer to{' '}
            <a href={DAILY_NOTE_FORMAT_HELP_URL} onClick={openHelp}>
              format reference
            </a>
            .<br />
            Your current syntax looks like this: <strong>{previewToday}</strong>
          </FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="daily-note-folder">New file location</FieldLabel>
        <FolderCombobox
          id="daily-note-folder"
          value={folder}
          onChange={onFolderChange}
          tree={tree}
          workspacePath={workspacePath}
        />
        <FieldDescription className="text-xs">
          New daily notes will be placed here.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="daily-note-template">Default template</FieldLabel>
        <Select
          value={templatePath === '' ? NO_TEMPLATE_VALUE : templatePath}
          onValueChange={(v) =>
            onDailyNoteChange({ ...dailyNote, templatePath: v === NO_TEMPLATE_VALUE ? '' : v })
          }
        >
          <SelectTrigger id="daily-note-template" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TEMPLATE_VALUE}>None</SelectItem>
            {templateOptions.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription className="text-xs">
          New daily notes start from this template. Configure the templates folder under Settings → Templates.
        </FieldDescription>
      </Field>
    </SettingsSection>
  );
}
