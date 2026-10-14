/**
 * Firma › Quellen over HTTP (ADR 0014): every source of the app and the workspace with its verdict
 * and whether each channel's secret is in the store (never its value).
 *
 *   GET  /api/sources               SourceRow[]
 *   POST /api/sources/:id/approve   switches the version on (outside the workspace): it runs live from now on
 */
import { Router } from 'express';
import { WS } from '../books.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { approveSource, sources } from '../../platform/sources/index.js';
import { RequestError } from '../books.js';
import { secretKey, type SourceRow } from '../../platform/sources/model.js';
import { secrets } from '../../secrets/secrets.js';

export const router = Router();

router.get('/api/sources', async (_req, res) => {
  const rows: SourceRow[] = [];
  for (const verdict of sources(WS, APP_ROOT)) {
    const decl = verdict.kind === 'invalid' ? undefined : verdict.decl;
    const channels = (['mail', 'api'] as const).filter((c) => decl?.reach[c]);
    const present = await Promise.all(channels.map(async (c) => !!(await secrets.get(secretKey(decl!.id, c)))));
    rows.push({ verdict, secrets: channels.map((channel, i) => ({ channel, present: present[i] })) });
  }
  res.json(rows);
});

router.post('/api/sources/:id/approve', (req, res) => {
  const v = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === req.params.id);
  if (!v || v.kind === 'invalid') throw new RequestError(404, `Die Quelle ${req.params.id} gibt es nicht, oder sie hat Fehler.`);
  if (v.decl.version !== (req.body as { version?: string })?.version) throw new RequestError(409, 'Die Quelle hat sich seit dem Anzeigen geändert: neu laden und noch einmal prüfen.');
  approveSource(WS, v.decl);
  res.json({ ok: true });
});
