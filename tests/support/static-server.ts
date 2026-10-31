/**
 * A plain static file server, as a host or `npx serve` would be: files only, no API and no
 * fallback route. It records every request path, so a test can show the UI asked for no /api/*.
 * Run alone: node --import tsx tests/support/static-server.ts <dir> [port]
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

export interface StaticServer { url: string; requests: string[]; stop(): Promise<void> }

/** `log` prints each request path as it comes. */
export function serveStatic(dir: string, port = 0, log = false): Promise<StaticServer> {
  const root = resolve(dir);
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    requests.push(path);
    if (log) console.log(`${req.method} ${path}`);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
    // With its length, as a host sends a file: chunked, Chrome now and then never finished the app's script and the page's load hung (#246).
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => {
    const { port: p } = server.address() as { port: number };
    ok({ url: `http://127.0.0.1:${p}`, requests, stop: () => new Promise((done) => server.close(() => done())) });
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log((await serveStatic(process.argv[2] ?? '.', Number(process.argv[3] ?? 0), true)).url);
}
