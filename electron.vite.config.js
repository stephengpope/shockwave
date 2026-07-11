import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import fs from 'node:fs';

const root = import.meta.dirname;

// Vendor Excalidraw's font assets into the renderer's public dir so the drawing
// canvas works OFFLINE. Without a local copy, Excalidraw fetches fonts from
// esm.sh at runtime (fine in dev, broken in a packaged offline app). Served at
// `/excalidraw/fonts/` in dev and copied next to index.html on build; the
// renderer points window.EXCALIDRAW_ASSET_PATH at `<htmlDir>/excalidraw/` (see
// src/renderer/main.tsx). Skips if already copied — delete the dest dir to
// refresh after an @excalidraw/excalidraw upgrade.
function vendorExcalidrawFonts() {
  return {
    name: 'vendor-excalidraw-fonts',
    configResolved() {
      const src = resolve(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
      const dest = resolve(root, 'src/renderer/public/excalidraw/fonts');
      if (!fs.existsSync(src) || fs.existsSync(dest)) return;
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/main.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/preload.cjs') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    // Resolve a `.js`/`.jsx` import to a sibling `.ts`/`.tsx` if present, in the
    // DEV SERVER too (the esbuild build already does this). Without it, after a
    // .js→.ts rename any importer still spelling `.js` 404s in dev and silently
    // blanks the renderer while the build stays green. With it, conversions need
    // no importer changes and can't break dev.
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer'),
      },
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
        '.jsx': ['.tsx', '.jsx'],
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    plugins: [react(), tailwindcss(), vendorExcalidrawFonts()],
  },
});
