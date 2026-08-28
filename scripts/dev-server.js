// Local dev server that mirrors Netlify's SPA fallback so client-side routes
// (/due, /picks/results, /pairs/quads, …) work on refresh and deep-link exactly
// like production. A plain static server (python -m http.server, Live Server)
// 404s on those paths because no such file exists on disk.
//
// Serves real files when they exist; otherwise falls back to index.html with a
// 200 — the same rule as netlify.toml. Zero dependencies (Node built-ins only).
//
//   npm run dev            → http://localhost:5500
//   npm run dev -- 3000    → custom port
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 5500;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.css':  'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(ROOT, urlPath);

  // Guard against path traversal, then serve the file if it really exists.
  if (filePath.startsWith(ROOT) && urlPath !== '/' && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  // SPA fallback, mirroring netlify.toml: each app catches its own subtree
  // before the root landing page does. Without the per-app rules a deep link
  // like /nfl/picks renders the sport picker, so client routes cannot be
  // tested locally at all.
  const app = ['/mlb/', '/nfl/'].find(p => urlPath === p.slice(0, -1) || urlPath.startsWith(p));
  const fallback = app ? path.join(ROOT, app.slice(1, -1), 'index.html')
                       : path.join(ROOT, 'index.html');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(fallback).pipe(res);
}).listen(PORT, () => {
  console.log(`Dong Tool dev server → http://localhost:${PORT}  (SPA fallback on, like Netlify)`);
});
