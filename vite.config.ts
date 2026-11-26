import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { optionalComponents } from './scripts/optional-components.mjs';

export default defineConfig({
  plugins: [react(), optionalComponents()],
  clearScreen: false,
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
