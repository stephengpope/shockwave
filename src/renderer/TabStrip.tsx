import React from 'react';
import { basenameOf, toRelPath } from './pathUtils';
import { XIcon, PlusIcon } from './Icons.jsx';

// Show the full filename incl. extension (Meeting.md, Notes.txt), matching the
// sidebar. prettyName (which strips .md) stays for wiki-link display only.
function shortLabel(path) {
  if (!path) return 'Untitled';
  return basenameOf(path);
}

export default function TabStrip({
  tabs,
  activeTabId,
  vaultPath,
  activeOverrideLabel,
  onSwitch,
  onClose,
  onAdd,
}) {
  return (
    <div className="tab-strip">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = isActive && activeOverrideLabel
          ? activeOverrideLabel
          : shortLabel(tab.path);
        const tooltip = tab.path ? (toRelPath(tab.path, vaultPath) || basenameOf(tab.path)) : 'New tab';
        return (
          <div
            key={tab.id}
            className={`tab ${isActive ? 'active' : ''}`}
            onClick={() => onSwitch(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            title={tooltip}
          >
            <span className="tab-label">{label}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              aria-label="Close tab"
            >
              <XIcon size={12} />
            </button>
          </div>
        );
      })}
      <button className="tab-add" onClick={onAdd} aria-label="New tab"><PlusIcon size={14} /></button>
    </div>
  );
}
