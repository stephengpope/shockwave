import dayjs from 'dayjs';

// Format presets shown in the Daily Note settings dropdown. The 4th entry is
// path-style — the "/" in the format becomes a folder separator on disk so
// you can bucket notes under year/month folders automatically.
export const DAILY_NOTE_FORMAT_PRESETS = [
  'YYYY-MM-DD',
  'YYYY.MM.DD',
  'YYYY/MM/DD',
  'YYYY/MM/YYYY-MM-DD',
];

export const DEFAULT_DAILY_NOTE_FORMAT = 'YYYY-MM-DD';
export const DAILY_NOTE_FORMAT_HELP_URL = 'https://day.js.org/docs/en/display/format';

// Format a JS Date using dayjs (moment-compatible tokens). Catches invalid
// formats — returns '' so the UI can show "Invalid format" rather than crash.
export function formatDailyNote(format, date = new Date()) {
  try {
    const out = dayjs(date).format(format || DEFAULT_DAILY_NOTE_FORMAT);
    return out;
  } catch {
    return '';
  }
}

// Resolve the absolute on-disk path for a daily note. `folder` is workspace-
// relative ('' or '/' = root). `formatted` may contain "/"; the last segment
// is the basename, leading segments become subfolders.
//
// Returns { dir, name, absPath } where:
//   dir      — absolute folder the file should live in
//   name     — basename (no .md)
//   absPath  — `${dir}/${name}.md`
export function resolveDailyNotePath(workspacePath, folder, formatted) {
  const cleanFolder = (folder ?? '').replace(/^\/+|\/+$/g, '');
  const segments = formatted.split('/').filter(Boolean);
  const name = segments.pop() || formatted;
  const subdirs = segments.join('/');

  const parts = [workspacePath];
  if (cleanFolder) parts.push(cleanFolder);
  if (subdirs) parts.push(subdirs);
  const dir = parts.join('/');
  const absPath = `${dir}/${name}.md`;
  return { dir, name, absPath };
}
