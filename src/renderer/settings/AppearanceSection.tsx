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
}) {
  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Appearance</h2>
      <p className="settings-section-desc">Choose the color theme and editor display options.</p>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="theme-mode">Theme</label>
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
    </div>
  );
}
