import React, { useState } from 'react';
import { APP_NAME } from '../constants.js';

// Settings → General → Updates. Shows the running version and a manual
// "Check for updates" button with inline feedback. Detection + the ambient
// "Update available" pill live in main + App; this is just the on-demand check.
export default function UpdatesSection({ appUpdate }) {
  const { status, checking, check } = appUpdate;
  const [checkedOnce, setCheckedOnce] = useState(false);

  const onCheck = async () => {
    await check();
    setCheckedOnce(true);
  };

  const current = status?.current;

  // Result line: only after a manual check (or a known update from the poll).
  let result: string | null = null;
  if (checking) {
    result = 'Checking…';
  } else if (status?.updateAvailable) {
    result = `Version ${status.latest} is available.`;
  } else if (checkedOnce && status?.error) {
    result = `Couldn't check for updates (${status.error}).`;
  } else if (checkedOnce) {
    result = "You're on the latest version.";
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Updates</h2>
      <p className="settings-section-desc">
        {APP_NAME} checks for new versions automatically. You can also check now.
      </p>

      <div className="settings-field">
        <span className="settings-field-label">Current version: {current ? `v${current}` : '—'}</span>
      </div>

      <button
        type="button"
        className="settings-button settings-button-primary settings-update-check"
        onClick={onCheck}
        disabled={checking}
      >
        Check for updates
      </button>

      {result && (
        <p
          className="settings-field-hint"
          style={status?.updateAvailable ? { color: 'var(--accent)' } : undefined}
        >
          {result}{' '}
          {status?.updateAvailable && status.url && (
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.api.openExternal(status.url); }}
            >
              View release
            </a>
          )}
        </p>
      )}
    </div>
  );
}
