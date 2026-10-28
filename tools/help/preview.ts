/**
 * npm run help:preview [-- <port>]
 *
 * Serves the help pages on http://127.0.0.1:<port>/ (4300), on this machine only, built in memory
 * from the sources on each page request: edit a page and reload, and the browser shows it as it is
 * now, or the build's error.
 */
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { buildSite } from './build.js';

const port = Number(process.argv[2] ?? 4300);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };
let site = await buildSite();

createServer(async (req, res) => {
  let path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  if (path.endsWith('.html')) {
    try {
      site = await buildSite();
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end((e as Error).message);
      return;
    }
  }
  const body = site.get(path);
  if (body === undefined) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`${path}: no such page`); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) }).end(body);
}).listen(port, '127.0.0.1', () => console.log(`help pages on http://127.0.0.1:${port}/de/index.html`));
