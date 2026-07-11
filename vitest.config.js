import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A separate config file (not vite.config.js) because vite.config.js sets
// root: 'src/renderer' for the app build — Vitest needs project root to be
// the repo root instead, so it can discover test files anywhere under src/.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
  },
});
