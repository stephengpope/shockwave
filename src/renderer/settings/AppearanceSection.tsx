import React from 'react';
import { THEME_MODES } from '../constants.js';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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

const TREE_PANEL_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'recent', label: 'Recent files' },
  { value: 'daily', label: 'Daily notes' },
  { value: 'both', label: 'Files + Notes' },
];

export default function AppearanceSection({
  themeMode,
  onThemeModeChange,
  hideLineNumbers,
  onHideLineNumbersChange,
  treePanel,
  onTreePanelChange,
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

      <SettingsGroup title="File tree">
        <Field>
          <FieldLabel htmlFor="tree-panel-content">Show below the file tree</FieldLabel>
          <Select
            value={treePanel?.content ?? 'off'}
            onValueChange={(v) => onTreePanelChange?.({ ...treePanel, content: v })}
          >
            <SelectTrigger id="tree-panel-content" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TREE_PANEL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            A quick-access list under the file tree in the left sidebar, sorted by last modified. When showing both, daily notes are left out of recent files.
          </FieldDescription>
        </Field>
        {treePanel?.content !== 'off' && (
          <Field>
            <FieldLabel htmlFor="tree-panel-count">Items per list</FieldLabel>
            <Input
              id="tree-panel-count"
              type="number"
              min={1}
              max={50}
              className="w-24"
              value={treePanel?.count ?? 10}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (!Number.isFinite(n) || n < 1) return;
                onTreePanelChange?.({ ...treePanel, count: Math.min(50, n) });
              }}
            />
          </Field>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
