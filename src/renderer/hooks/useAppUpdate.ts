import { useState, useEffect, useCallback } from 'react';
import type { UpdateStatus } from '../../shared/api';

// Holds the app-update status used by the always-visible "Update available" pill
// (editor pane, top-right) and the Settings → Updates manual-check button.
//
// Seeded from main's cached result on mount, refreshed by the background push
// (launch check + daily poll), and re-checkable on demand. Notify-only — the
// only action is opening the release page (window.api.openExternal).
export function useAppUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    window.api.app.getUpdateStatus().then((s) => { if (alive && s) setStatus(s); }).catch(() => {});
    const off = window.api.app.onUpdateStatus((s) => {
      setStatus(s);
      // PLACEHOLDER — when auto-download ships (electron-updater), toast here
      // on the downloaded event:
      //   toast.success('Update downloaded', {
      //     description: `v${s.latest} installs on restart.`,
      //     action: { label: 'Restart now', onClick: () => window.api.app.restartToUpdate() },
      //   });
      // Today updates are notify-only (the pill opens the release page).
    });
    return () => { alive = false; off(); };
  }, []);

  // Manual check (returns the result so the caller can show inline feedback).
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const s = await window.api.app.checkForUpdates();
      setStatus(s);
      return s;
    } finally {
      setChecking(false);
    }
  }, []);

  return { status, checking, check };
}
