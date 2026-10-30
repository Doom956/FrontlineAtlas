// Production entry: `npm run start` (runs the bundle server-dist/index.js built from this file).
// Dev: `npm run dev` runs this with vite-node next to the Vite client server. Settings: docs/MULTIPLAYER.md.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionsFromEnv } from './options';
import { startServer } from './server';

function findStaticDir(): string | null {
  if (process.env.STATIC_DIR !== undefined) return process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
  // server/ (dev) and server-dist/ (production) both sit next to dist/.
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const dir of [resolve(here, '../dist'), resolve(process.cwd(), 'dist')]) {
    if (existsSync(resolve(dir, 'index.html'))) return dir;
  }
  return null;
}

const staticDir = findStaticDir();
const server = await startServer({ ...optionsFromEnv(process.env), staticDir });
server.hub.opts.log(
  `Borderfall server on port ${server.port} (WebSocket ${server.wsUrl})` +
    (staticDir
      ? `, serving ${staticDir}`
      : process.env.STATIC_DIR === ''
        ? ' (client files not served here)'
        : ', no client build found (run npm run build)'),
);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
