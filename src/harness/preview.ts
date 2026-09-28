// Preview: a small static file server for a session's folder, on its own local port, so a plain web page runs the
// way it would when hosted (module scripts, fetch and absolute paths all work, unlike a page opened from disk).
// Projects with a dev server use that instead (see CodeHarness.preview).

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

export interface StaticPreview {
  url: string;
  close: () => void;
}

// Serves `folder` on 127.0.0.1 (never other machines). Hidden files and folders (.git, .env, …) are not served.
export function serveFolder(folder: string): Promise<StaticPreview> {
  const root = realpathSync(folder);
  const server: Server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    let full = resolve(root, `.${path}`);
    const rel = relative(root, full);
    if (rel.startsWith('..') || rel.split(sep).some((part) => part.startsWith('.'))) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (existsSync(full) && statSync(full).isDirectory()) full = join(full, 'index.html');
    if (!existsSync(full) || !statSync(full).isFile() || relative(root, realpathSync(full)).startsWith('..')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`Not found: ${path}`);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(full).pipe(res);
  });
  return new Promise((resolvePreview, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePreview({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}
