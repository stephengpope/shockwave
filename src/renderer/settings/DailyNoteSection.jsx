import React, { useMemo } from 'react';
import {
  DAILY_NOTE_FORMAT_PRESETS,
  DEFAULT_DAILY_NOTE_FORMAT,
  DAILY_NOTE_FORMAT_HELP_URL,
  formatDailyNote,
} from '../dailyNote.js';
import FolderCombobox from './FolderCombobox.jsx';

const CUSTOM_VALUE = '__custom__';

export default function DailyNoteSection({
  dailyNote,
  onDailyNoteChange,
  tree,
  workspacePath,
}) {
  const format = dailyNote?.format || DEFAULT_DAILY_NOTE_FORMAT;
  const folder = dailyNote?.folder ?? '';

  const isPreset = DAILY_NOTE_FORMAT_PRESETS.includes(format);
  const previewToday = useMemo(() => formatDailyNote(format), [format]);

  const onSelectChange = (e) => {
    const v = e.target.value;
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
    <div className="settings-section">
      <h2 className="settings-section-title">Daily Notes</h2>
      <p className="settings-section-desc">
        Configure how the calendar button creates and opens daily notes.
      </p>

      <div className="settings-field-row">
        <div className="settings-field-text">
          <label className="settings-field-label" htmlFor="daily-note-format">Date format</label>
          <div className="settings-field-help">
            Choose how daily notes are named in your workspace.
          </div>
        </div>
        <select
          id="daily-note-format"
          className="settings-select"
          value={isPreset ? format : CUSTOM_VALUE}
          onChange={onSelectChange}
        >
          {DAILY_NOTE_FORMAT_PRESETS.map((p) => (
            <option key={p} value={p}>{formatDailyNote(p)}</option>
          ))}
          <option value={CUSTOM_VALUE}>Custom</option>
        </select>
      </div>

      {!isPreset && (
        <div className="settings-field-row">
          <div className="settings-field-text">
            <label className="settings-field-label" htmlFor="daily-note-custom">Custom format</label>
            <div className="settings-field-help">
              For more syntax, refer to{' '}
              <a href={DAILY_NOTE_FORMAT_HELP_URL} onClick={openHelp} className="settings-link">
                format reference
              </a>
              .<br />
              Your current syntax looks like this: <strong>{previewToday}</strong>
            </div>
          </div>
          <input
            id="daily-note-custom"
            type="text"
            className="settings-input settings-input-mono"
            value={format}
            onChange={onCustomChange}
            placeholder="YYYY-MM-DD"
          />
        </div>
      )}

      <div className="settings-field-row">
        <div className="settings-field-text">
          <label className="settings-field-label" htmlFor="daily-note-folder">New file location</label>
          <div className="settings-field-help">New daily notes will be placed here.</div>
        </div>
        <FolderCombobox
          id="daily-note-folder"
          value={folder}
          onChange={onFolderChange}
          tree={tree}
          workspacePath={workspacePath}
        />
      </div>
    </div>
  );
}
