import React, { useState } from 'react';
import { APP_NAME } from '../constants.js';
import { SettingsSection } from './SectionUI';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
    <SettingsSection
      title="Updates"
      description={`${APP_NAME} checks for new versions automatically. You can also check now.`}
    >
      <div className="text-[13px] text-foreground">
        Current version: {current ? `v${current}` : '—'}
      </div>

      <Button size="sm" className="w-fit" onClick={onCheck} disabled={checking}>
        Check for updates
      </Button>

      {result && (
        <p className={cn('text-xs', status?.updateAvailable ? 'text-primary' : 'text-muted-foreground')}>
          {result}{' '}
          {status?.updateAvailable && status.url && (
            <a
              href="#"
              className="underline underline-offset-4"
              onClick={(e) => { e.preventDefault(); window.api.openExternal(status.url); }}
            >
              View release
            </a>
          )}
        </p>
      )}
    </SettingsSection>
  );
}
