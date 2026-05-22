import React from 'react';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function PageIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

export function FolderIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

export function GraphIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <line x1="7.7" y1="7.5" x2="11.1" y2="16" />
      <line x1="16.3" y1="7.5" x2="12.9" y2="16" />
      <line x1="8" y1="6" x2="16" y2="6" />
    </svg>
  );
}

export function PencilIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

export function CodeIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

export function LockIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function CheckCircleIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="8 12.5 11 15.5 16.5 9.5" />
    </svg>
  );
}

export function DotCircleIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  );
}
