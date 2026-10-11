/**
 * GET /api/events: the workspace's changes (src/server/watch.ts) as Server-Sent Events, so the UI
 * reloads what changed outside it. The watcher runs while a page listens; the books open now are
 * the ones watched (books.ts follows every reopen).
 */
import { Router, type Response } from 'express';
import type { WorkspaceChange } from '../types/api-error.js';
import type { Workspace } from '../workspace/workspace.js';
import { watchWorkspace, type Watcher } from './watch.js';

export const router = Router();

const pages = new Set<Response>();
let books: Workspace | undefined;
let watcher: Watcher | undefined;

function send(change: WorkspaceChange): void {
  for (const res of pages) res.write(`data: ${JSON.stringify(change)}\n\n`);
}

/** Watch these books from now on (the desktop app opened others, a route reopened the manifest). */
export function follow(ws: Workspace): void {
  const moved = books?.paths.root !== ws.paths.root;
  books = ws;
  if (!watcher || !moved) return;
  watcher.close();
  watcher = watchWorkspace(ws, send);
}

router.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': open\n\n');
  pages.add(res);
  if (!watcher && books) watcher = watchWorkspace(books, send);
  // A proxy or the browser may drop a stream that stays silent.
  const beat = setInterval(() => res.write(': beat\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(beat);
    pages.delete(res);
    if (pages.size === 0) { watcher?.close(); watcher = undefined; }
  });
});
