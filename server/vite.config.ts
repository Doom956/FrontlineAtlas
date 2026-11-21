// Builds the game server into one Node file: server-dist/index.js (npm run build:server). Only 'ws' stays external.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  publicDir: false,
  logLevel: 'warn',
  build: {
    ssr: 'server/index.ts',
    outDir: 'server-dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { format: 'es', entryFileNames: 'index.js' } },
  },
  ssr: { external: ['ws'] },
});
