import React from 'react';
import { THEME_MODES } from '../constants.js';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

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
    <SettingsSection title="Appearance" description="Choose the color theme and editor display options.">
      <SettingsGroup title="Theme">
        <Field>
          <FieldLabel htmlFor="theme-mode">Color theme</FieldLabel>
          <Select value={themeMode} onValueChange={onThemeModeChange}>
            <SelectTrigger id="theme-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Editor">
        <Label className="gap-2.5 text-[13px] font-normal">
          <Checkbox
            checked={!!hideLineNumbers}
            onCheckedChange={(v) => onHideLineNumbersChange?.(v === true)}
          />
          Hide line numbers in editor
        </Label>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Bookmarks">
        <Field>
          <Label className="gap-2.5 text-[13px] font-normal">
            <Checkbox
              checked={!!dailyNotesInBookmarks}
              onCheckedChange={(v) => onDailyNotesInBookmarksChange?.(v === true)}
            />
            Show daily notes below bookmarks
          </Label>
          <FieldDescription className="pl-[26px]">
            When the file tree is filtered to bookmarks, list your daily notes underneath so you can jump between them without leaving the bookmarks view.
          </FieldDescription>
        </Field>
      </SettingsGroup>
    </SettingsSection>
  );
}
