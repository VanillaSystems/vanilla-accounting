/** The workspace's files the UI reads directly, served by the API (Vite proxies them in dev). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { Router } from 'express';
import { WS } from './books.js';
import { APP_ROOT } from '../workspace/workspace.js';
import { isAppPath } from './app-paths.js';
import { BOOKS_VERSION } from '../types/api-error.js';
import { versionOf } from '../workspace/own-writes.js';

export const router = Router();

router.get('/books.json', (_req, res) => {
  if (!existsSync(WS.paths.books)) { res.sendStatus(404); return; }
  const text = readFileSync(WS.paths.books);
  res.type('json').set(BOOKS_VERSION, versionOf(text)).send(text);
});
/** The folder of the books open now: the desktop app switches them while the server runs. */
function staticOf(dir: () => string): express.RequestHandler {
  let served: { dir: string; handler: express.RequestHandler } | undefined;
  return (req, res, next) => {
    if (served?.dir !== dir()) served = { dir: dir(), handler: express.static(dir()) };
    served.handler(req, res, next);
  };
}
router.use('/receipts', staticOf(() => WS.paths.receipts));
router.use('/bank-statements', staticOf(() => WS.paths.statements));

/** The built app (npm run build), when there is one: every app path answers with its index.html. */
const DIST = process.env.APP_DIST || join(APP_ROOT, 'dist');
if (existsSync(join(DIST, 'index.html'))) {
  router.use(express.static(DIST, { index: false }));
  router.get(/.*/, (req, res, next) => (isAppPath(req.path) ? res.sendFile(join(DIST, 'index.html')) : next()));
}
