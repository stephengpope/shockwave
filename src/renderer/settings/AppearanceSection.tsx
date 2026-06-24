import React from 'react';
import { THEME_MODES } from '../constants.js';

const OPTIONS = [
  { value: THEME_MODES.SYSTEM, label: 'System (follow your OS appearance)' },
  { value: THEME_MODES.LIGHT, label: 'Light' },
  { value: THEME_MODES.DARK, label: 'Dark' },
];

export default function AppearanceSection({
  themeMode,
  onThemeModeChange,
  hideLineNumbers,
  onHideLineNumbersChange,
  dailyNotesInBookmarks,
  onDailyNotesInBookmarksChange,
}) {
  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Appearance</h2>
      <p className="settings-section-desc">Choose the color theme and editor display options.</p>

      <h3 className="settings-subsection-title">Theme</h3>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="theme-mode">Color theme</label>
        <select
          id="theme-mode"
          className="settings-select"
          value={themeMode}
          onChange={(e) => onThemeModeChange(e.target.value)}
        >
          {OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <h3 className="settings-subsection-title">Editor</h3>
      <div className="settings-field">
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={!!hideLineNumbers}
            onChange={(e) => onHideLineNumbersChange?.(e.target.checked)}
          />
          <span>Hide line numbers in editor</span>
        </label>
      </div>

      <h3 className="settings-subsection-title">Bookmarks</h3>
      <div className="settings-field">
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={!!dailyNotesInBookmarks}
            onChange={(e) => onDailyNotesInBookmarksChange?.(e.target.checked)}
          />
          <span>Show daily notes below bookmarks</span>
        </label>
        <p className="settings-field-hint">
          When the file tree is filtered to bookmarks, list your daily notes underneath so you can jump between them without leaving the bookmarks view.
        </p>
      </div>
    </div>
  );
}
