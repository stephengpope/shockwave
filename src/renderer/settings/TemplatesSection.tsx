import React from 'react';
import FolderCombobox from './FolderCombobox.jsx';
import { SettingsSection } from './SectionUI';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';

// Templates settings: pick the folder whose `.md` files are offered in the
// template picker (the double-document icon in the left rail).
export default function TemplatesSection({
  templates,
  onTemplatesChange,
  tree,
  workspacePath,
}) {
  const folder = templates?.folder ?? '';

  return (
    <SettingsSection
      title="Templates"
      description="Choose a folder of Markdown files to use as templates. Pick one from the template button in the left rail to insert it at the cursor (or into a new note when nothing is open)."
    >
      <Field>
        <FieldLabel htmlFor="templates-folder">Templates folder</FieldLabel>
        <FolderCombobox
          id="templates-folder"
          value={folder}
          onChange={(next) => onTemplatesChange({ ...templates, folder: next })}
          tree={tree}
          workspacePath={workspacePath}
        />
        <FieldDescription className="text-xs">
          Markdown files directly in this folder are listed as templates.
        </FieldDescription>
      </Field>
    </SettingsSection>
  );
}
