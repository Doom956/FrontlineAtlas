// Serves the built client (dist/) over plain HTTP. Small on purpose: GET/HEAD only, no directory listings, paths
// can't leave the folder, unknown paths without an extension get index.html. A single byte range is answered (206):
// Safari only streams <audio> (the music) from a server that does.

import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Answers the request from `root`; returns false when nothing was found (the caller sends 404). */
export async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const base = resolve(root);
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return false;
  }
  if (path.includes('\0')) return false;
  let file = normalize(join(base, path));
  if (file !== base && !file.startsWith(base + sep)) return false;
  if (path.endsWith('/')) file = join(file, 'index.html');
  if (!(await isFile(file))) {
    if (extname(path) !== '') return false;
    file = join(base, 'index.html');
    if (!(await isFile(file))) return false;
  }
  const body = await readFile(file);
  const ext = extname(file).toLowerCase();
  const head = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  const range = byteRange(req.headers.range, body.length);
  if (range === 'bad') {
    res.writeHead(416, { ...head, 'Content-Range': `bytes */${body.length}` });
    res.end();
    return true;
  }
  if (range) {
    const [a, b] = range;
    res.writeHead(206, { ...head, 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${body.length}` });
    res.end(req.method === 'HEAD' ? undefined : body.subarray(a, b + 1));
    return true;
  }
  res.writeHead(200, { ...head, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/** A single "bytes=a-b" range (a-, -n too) of a body `size` long: [first, last], null for none or several, 'bad'. */
export function byteRange(h: string | undefined, size: number): [number, number] | null | 'bad' {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // unknown or several ranges: the whole body
  let a: number;
  let b: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n <= 0) return 'bad';
    a = Math.max(0, size - n);
    b = size - 1;
  } else {
    a = Number(m[1]);
    b = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]));
  }
  if (!(a <= b) || a >= size) return 'bad';
  return [a, b];
}
