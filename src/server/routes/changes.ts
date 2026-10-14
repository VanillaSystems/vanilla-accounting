/**
 * Änderungen over HTTP (docs/0.4.0/ui/design.md): read only in this unit.
 *
 *   GET /api/changes?since=<rev>          the view, or { unchanged: true }
 *   GET /api/changes/saves/:oid           one save of Verlauf with its files
 *   GET /api/changes/diff?source=&path=   before and after of one file (source: draft, outside or a save's oid)
 */
import { Router } from 'express';
import { RequestError, WS } from '../books.js';
import { changesView, fileDiff, saveDetail } from '../../saving/changes.js';

export const router = Router();

router.get('/api/changes', async (req, res) => {
  const view = await changesView(WS);
  res.json(req.query.since === view.rev ? { unchanged: true } : view);
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
