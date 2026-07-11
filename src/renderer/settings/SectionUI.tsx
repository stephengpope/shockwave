import React from 'react';
import { cn } from '@/lib/utils';

// Shared scaffolding for settings pages (polish spec §7). Every section:
//
//   <SettingsSection title="Appearance" description="One-line intro.">
//     <SettingsGroup title="Theme">…controls…</SettingsGroup>
//     <SettingsDivider />
//     <SettingsGroup title="Editor">…controls…</SettingsGroup>
//   </SettingsSection>
//
// Controls come from shadcn (Field, Input, Select, Switch, Checkbox, Slider,
// Button). Field groups cap at a 360px measure (`SETTINGS_MEASURE`).

export const SETTINGS_MEASURE = 'max-w-[360px]';

export function SettingsSection({ title, description, children, wide = false }: any) {
  return (
    <div className="flex min-h-full flex-col px-7 pb-8 pt-6">
      <div className="pr-8">
        <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-1.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      <div className={cn('flex flex-col gap-[22px] pt-[22px]', !wide && SETTINGS_MEASURE)}>
        {children}
      </div>
    </div>
  );
}

export function SettingsGroup({ title, children, className }: any) {
  return (
    <div className={className}>
      {title && <div className="mb-2.5 text-xs font-semibold text-foreground">{title}</div>}
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

export function SettingsDivider() {
  return <div className={cn('h-px bg-border', SETTINGS_MEASURE, 'w-full')} />;
}
