import React from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import App from './App.jsx';

// NOTE: window.EXCALIDRAW_ASSET_PATH is set by an inline <script> in index.html,
// NOT here. ES import hoisting evaluates `import App` (which transitively loads
// @excalidraw/excalidraw and bakes its font-URL registry from the global) BEFORE
// this module's body runs — so setting it here is too late and Excalidraw falls
// back to the esm.sh CDN. The inline script runs before the bundle loads.

// Block default file-drop behavior at the window level. Without this, a file
// dropped anywhere outside an explicit drop target causes Chromium to
// navigate the renderer to the file's URL, blanking the app. Components that
// want to accept drops (the editor, the tree) handle the event themselves
// and stop propagation; everything else falls through to here and is ignored.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
  }
});
window.addEventListener('drop', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
  }
});

createRoot(document.getElementById('root')!).render(<App />);
