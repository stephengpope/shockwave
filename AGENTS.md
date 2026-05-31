# AGENTS.md

For deep architecture, invariants, and process docs see `CLAUDE.md` (root), `src/main/CLAUDE.md`, `src/renderer/CLAUDE.md`, `tests/CLAUDE.md`.

## Commands

| Action | Command | Notes |
|---|---|---|
| Dev | `npm run dev` | electron-vite + hot reload, CDP on :9222 |
| Build | `npm run build` | outputs to `out/` |
| Test | `npm test` | node:test runner — `node --test tests/<file>.test.js` for one file |
| Lint | `npx eslint .` | No npm script — run via npx |
| TypeCheck | `npm run typecheck` | `tsc --noEmit` |
| Dist | `npm run dist` | electron-builder into `dist/` |

## Architecture (3 processes)

- **Main** (`src/main/main.ts`): Electron main — fs, IPC, settings, watcher, sync, agent session
- **Preload** (`src/preload/preload.cjs`): CJS bridge — `window.api.*` is the only boundary; renderer never touches Node
- **Renderer** (`src/renderer/main.tsx` → `App.tsx`): Vite + React 19, CodeMirror 6

Cross-process types in `src/shared/`: `api.d.ts`, `settings.ts`, `constants.ts`.

## Key constraints

- **Import extensions**: `.js`/`.jsx` imports resolve to `.ts`/`.tsx` via `extensionAlias` in `electron.vite.config.js` — do NOT "fix" import extensions.
- **TypeScript**: `noImplicitAny: false`, no strict mode. Migration posture: permissive; many components use `any`.
- **Settings**: `Settings` type + `DEFAULT_SETTINGS` in `src/shared/settings.ts` is the single source of truth. Adding a field = update type + defaults + `readSettings` merge + `useSettings` hook.
- **Renderer path helpers**: POSIX-only, always forward slashes. **Do not import `node:path`** (blocked by contextIsolation).
- **Save lifecycle**: `writeNow()` flush before any operation that changes `activeFile` (tab switch, rename, delete, graph toggle).
- **mtime invariant**: Never use `Date.now()` for mtime — always use `stat.mtimeMs` from the file write. Using integer ms breaks the self-echo guard.
- **Style convention**: CSS classes over inline `style={{}}`. Copy from nearest similar component. Standard classes in `src/renderer/CLAUDE.md`.
- **Terminology**: "file" (not page/note), "workspace" (not vault), "wiki-link" (not internal link).

## Tests

All in `tests/*.test.js` with `node:test`. Coverage per file in `tests/CLAUDE.md`. No UI tests — Electron UI is manual-verify only.

## IPC surface exposed via preload

`window.api.*` covers: Dialogs, FS, Shell, Context menus, Settings, Bookmarks, Theme, Voice tokens, Agent send/abort/skills, Sync. Full handler list in `src/main/CLAUDE.md`.


## Recent Changes & Commit History

Last updated:
2026-05-31 21:29:34

### 2026-05-31 | 1c80605 | Stephen G. Pope
**Files changed:** CLAUDE.md, src/main/CLAUDE.md, src/main/codingAgent.ts, src/renderer/App.tsx, src/renderer/ChatSidebar.tsx
**Category:** Docs
**Changes:** Editor + chat + sync polish; start TS doc refresh
**Impact:** Documentation update

### 2026-05-30 | 56e62b0 | Stephen G. Pope
**Files changed:** package.json

**Changes:** build: publish releases directly (skip draft step)
**Impact:** See commit details for impact

### 2026-05-30 | c38e7d1 | Stephen G. Pope
**Files changed:** CLAUDE.md, src/main/CLAUDE.md
**Category:** Docs
**Changes:** docs: correct the renderer-side mtime story in CLAUDE.md
**Impact:** Documentation update

### 2026-05-30 | 3613ca2 | Stephen G. Pope
**Files changed:** package-lock.json, package.json, src/renderer/App.tsx, src/renderer/hooks/useLinkIndex.ts, src/renderer/linkIndex.js

**Changes:** Release v1.0.1 + fix sync clobbering typed edits
**Impact:** Bug fix, improves stability

### 2026-05-30 | 26e075b | Stephen G. Pope
**Files changed:** electron.vite.config.js, src/main/agentSystemPrompt.js, src/main/agentSystemPrompt.ts, src/main/agentTokensExtension.js, src/main/agentTokensExtension.ts

**Changes:** TS: convert main process to .ts (main, sync, syncEngine, codingAgent, skillLibrary, pathResolver, agentSystemPrompt, agentTokensExtension)
**Impact:** Bug fix, improves stability

### 2026-05-30 | 30db15f | Stephen G. Pope
**Files changed:** src/renderer/App.jsx, src/renderer/App.tsx, src/renderer/BacklinksPanel.jsx, src/renderer/BacklinksPanel.tsx, src/renderer/ChatSidebar.jsx

**Changes:** TS: convert all 35 renderer components .jsx -> .tsx (incl App.tsx)
**Impact:** See commit details for impact

### 2026-05-30 | 5d0d2af | Stephen G. Pope
**Files changed:** src/renderer/hooks/useFileOps.js, src/renderer/hooks/useFileOps.ts, src/renderer/hooks/useLinkIndex.js, src/renderer/hooks/useLinkIndex.ts, src/renderer/hooks/useTabs.js

**Changes:** TS: convert renderer hooks (useTabs/useLinkIndex/useFileOps) to .ts
**Impact:** See commit details for impact

### 2026-05-30 | eae7347 | Stephen G. Pope
**Files changed:** src/renderer/autoLinks.js, src/renderer/autoLinks.ts, src/renderer/bulletPoints.js, src/renderer/bulletPoints.ts, src/renderer/headingStyles.js

**Changes:** TS: convert renderer logic modules to .ts (CM decorations, image paste/widgets, voice, autolinks, etc.)
**Impact:** See commit details for impact

### 2026-05-30 | 5f1f5e8 | Stephen G. Pope
**Files changed:** src/renderer/chatAttachments.js, src/renderer/chatAttachments.ts, src/renderer/constants.js, src/renderer/constants.ts, src/renderer/dailyNote.js

**Changes:** TS: noImplicitAny off (migration posture) + convert dailyNote/diffFlash/chatAttachments/constants + vite-env
**Impact:** See commit details for impact

### 2026-05-30 | 2393ac7 | Stephen G. Pope
**Files changed:** electron.vite.config.js, src/renderer/App.jsx, src/renderer/hooks/useBookmarks.ts, src/renderer/imagePaste.js, src/renderer/imageWidgets.js

**Changes:** TS: add Vite extensionAlias (.js->.ts dev resolution) + convert pathUtils
**Impact:** New functionality added
