import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

/** Only built application assets. Never expose config, databases, source maps or arbitrary files. */
export async function serveWeb(root: string, pathname: string, method: string, res: ServerResponse) {
  if (!['GET', 'HEAD'].includes(method)) return false;
  const relative = pathname === '/' || pathname === '/index.html' ? 'index.html'
    : /^\/assets\/[A-Za-z0-9_-]+\.(js|css|woff2|png|svg)$/.test(pathname) ? pathname.slice(1) : '';
  if (!relative) return false;
  let file: string, canonical: string;
  try {
    canonical = await realpath(root); file = await realpath(path.join(canonical, relative));
    if (!file.startsWith(canonical + path.sep) || !(await stat(file)).isFile()) return false;
  } catch { return false; }
  const bytes = await readFile(file);
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Content-Length': bytes.length,
    'Cache-Control': relative === 'index.html' ? 'no-store' : 'public, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
  res.end(method === 'HEAD' ? undefined : bytes); return true;
}
