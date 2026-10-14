/** The workspace's files the UI reads directly, served by the API (Vite proxies them in dev). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { Router } from 'express';
import { WS } from './books.js';
import { APP_ROOT, findFile } from '../workspace/workspace.js';
import { loadBooks } from '../books/store.js';
import { workspaceModules } from '../core/modules/load.js';
import { isAppPath } from './app-paths.js';

export const router = Router();

router.get('/books.json', (_req, res) => {
  res.json(loadBooks(WS));
});
router.get('/modules.json', (_req, res) => {
  res.json(workspaceModules(APP_ROOT, WS.paths.root));
});
/** A receipt or statement file of the books open now, from whichever year folder holds it. */
function yearFile(part: 'receipts' | 'statements'): express.RequestHandler {
  return (req, res, next) => {
    const name = decodeURIComponent(req.path.slice(1));
    if (!name || name.split('/').includes('..')) return next();
    const file = findFile(WS.paths, part, name);
    if (file) res.sendFile(file); else next();
  };
}
router.use('/receipts', yearFile('receipts'));
router.use('/bank-statements', yearFile('statements'));

/** The built app (npm run build), when there is one: every app path answers with its index.html. */
const DIST = process.env.APP_DIST || join(APP_ROOT, 'dist');
if (existsSync(join(DIST, 'index.html'))) {
  router.use(express.static(DIST, { index: false }));
  router.get(/.*/, (req, res, next) => (isAppPath(req.path) ? res.sendFile(join(DIST, 'index.html')) : next()));
}
