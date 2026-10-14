/**
 * Änderungen over HTTP (docs/0.4.0/ui/design.md, docs/0.4.0/saving.md).
 *
 *   GET  /api/changes?since=<rev>         the view, or { unchanged: true }
 *   POST /api/changes                     a SavingCommand → SavingResult (prepare, talk, refresh, save, sync, discard, undo)
 *   GET /api/changes/saves/:oid           one save of Verlauf with its files
 *   GET /api/changes/diff?source=&path=   before and after of one file (source: draft, outside or a save's oid)
 */
import { Router } from 'express';
import { RequestError, WS } from '../books.js';
import { fileDiff, saveDetail } from '../../saving/changes.js';
import { openSaving } from '../../saving/saving.js';
import type { SavingCommand, SavingResult } from '../../saving/model.js';
import { ask } from '../../llm/ask.js';
import { queueCommit } from './automation.js';

export const router = Router();

const saving = () => openSaving(WS, { ask: (prompt, opts) => ask(prompt, { ...opts, model: 'sonnet' }) });

router.get('/api/changes', async (req, res) => {
  const view = await saving().view();
  res.json(req.query.since === view.rev ? { unchanged: true } : view);
});

const KINDS = new Set<SavingCommand['kind']>(['prepare', 'talk', 'refresh', 'save', 'sync', 'discard', 'undo']);

router.post('/api/changes', async (req, res) => {
  const c = req.body as SavingCommand;
  if (!c || !KINDS.has(c.kind)) throw new RequestError(400, 'Unbekannter Befehl.');
  if (c.kind === 'talk' && (typeof c.text !== 'string' || !c.text.trim())) throw new RequestError(400, 'text erwartet.');
  if (c.kind === 'undo' && !/^[0-9a-f]{40}$/.test(String(c.oid))) throw new RequestError(400, 'oid erwartet.');
  // What commits or moves the books' line waits its turn behind the app's own commits.
  const writes = c.kind === 'save' || c.kind === 'sync' || c.kind === 'undo';
  const result = writes
    ? await new Promise<SavingResult>((resolve, reject) => { void queueCommit(() => saving().command(c).then((r) => { resolve(r); return false; }, (e) => { reject(e); return false; })); })
    : await saving().command(c);
  res.json(result);
});

router.get('/api/changes/saves/:oid', async (req, res) => {
  const detail = await saveDetail(WS, req.params.oid);
  if (!detail) throw new RequestError(404, `Speicherstand ${req.params.oid} gibt es nicht.`);
  res.json(detail);
});

router.get('/api/changes/diff', async (req, res) => {
  const source = String(req.query.source ?? '');
  const path = String(req.query.path ?? '');
  if (!source || !path || path.includes('..')) throw new RequestError(400, 'source und path erwartet.');
  const diff = await fileDiff(WS, source, path);
  if (!diff) throw new RequestError(404, `${path} gibt es dort nicht.`);
  res.json(diff);
});
