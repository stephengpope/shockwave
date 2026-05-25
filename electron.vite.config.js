import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/main.js') },
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
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    plugins: [react()],
  },
});
