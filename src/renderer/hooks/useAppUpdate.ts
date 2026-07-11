import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { UpdateStatus } from '../../shared/api';

// Holds the app-update status used by the always-visible "Update available" pill
// (editor pane, top-right) and the Settings → Updates manual-check button.
//
// Seeded from main's cached result on mount, refreshed by the background push
// (launch check + daily poll), and re-checkable on demand. Packaged builds
// auto-download via electron-updater — once a status arrives with
// `downloaded: true` we toast a "Restart now" action; dev builds are
// notify-only (the pill opens the release page).
export function useAppUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const toastedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.api.app.getUpdateStatus().then((s) => { if (alive && s) setStatus(s); }).catch(() => {});
    const off = window.api.app.onUpdateStatus((s) => {
      setStatus(s);
      // Repeated pushes for the same downloaded version (daily re-poll,
      // manual checks) must not stack toasts.
      if (s.downloaded && s.latest && toastedVersionRef.current !== s.latest) {
        toastedVersionRef.current = s.latest;
        toast.success('Update downloaded', {
          description: `v${s.latest} installs on restart.`,
          action: { label: 'Restart now', onClick: () => window.api.app.restartToUpdate() },
        });
      }
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
