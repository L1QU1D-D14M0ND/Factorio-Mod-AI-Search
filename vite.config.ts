import { defineConfig } from 'vite';

// The web UI is a standalone static app that only talks to the server over HTTP,
// so it can later be wrapped by Tauri/Electron without changes.
export default defineConfig({
  root: 'web',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.FMF_PORT ?? 3000}` },
  },
});
