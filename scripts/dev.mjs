// `npm run dev`: the Vite client dev server plus the multiplayer server, in one terminal, no extra packages.
// - game server: vite-node --watch server/index.ts on DEV_SERVER_PORT (default 8787); restarts when server code changes
// - client: Vite (vite.config.ts) with /ws proxied to the game server, so the page's default server URL (same
//   origin) works in dev too.
// Ctrl+C stops both.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const viteNodeBin = resolve(dirname(require.resolve('vite-node')), '..', 'vite-node.mjs');
const serverPort = Number(process.env.DEV_SERVER_PORT || 8787);

const server = spawn(process.execPath, [viteNodeBin, '--watch', 'server/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(serverPort),
    HOST: '127.0.0.1',
    STATIC_DIR: '', // Vite serves the client in dev
    PUBLIC_START_SECONDS: process.env.PUBLIC_START_SECONDS || '15',
  },
});

const vite = await createServer({
  root,
  server: {
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      '/health': { target: `http://127.0.0.1:${serverPort}` },
    },
  },
});
await vite.listen();
vite.printUrls();
console.log(`  multiplayer server: ws://127.0.0.1:${serverPort}/ws (proxied at /ws)\n`);

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.kill('SIGTERM');
  await vite.close().catch(() => {});
  process.exit(code);
}
server.on('exit', (code) => {
  if (!stopping) {
    console.error(`game server exited (${code}); stopping`);
    stop(code ?? 1);
  }
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
