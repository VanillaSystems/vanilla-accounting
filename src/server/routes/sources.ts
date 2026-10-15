/**
 * Firma › Quellen over HTTP (ADR 0014): every source of the app and the workspace with its verdict
 * and whether each channel's secret is in the store (never its value).
 *
 *   GET  /api/sources               SourceRow[]
 *   POST /api/sources/:id/approve   switches the version on (outside the workspace): it runs live from now on
 *   POST /api/sources/:id/skip      { sender, version }: a mailbox skips that sender's mail from now on
 */
import { Router } from 'express';
import { WS } from '../books.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { approveSource, sources } from '../../platform/sources/index.js';
import { RequestError } from '../books.js';
import { secretKey, type SourceRow } from '../../platform/sources/model.js';
import { secrets } from '../../secrets/secrets.js';
import { readLedger } from '../../platform/sources/ledger.js';
import { addSkip, skipOffers } from '../../platform/sources/skip.js';
import { reachDiff } from '../../platform/sources/reach.js';
import { readBooks } from '../books.js';

export const router = Router();

router.get('/api/sources', async (_req, res) => {
  const rows: SourceRow[] = [];
  for (const verdict of sources(WS, APP_ROOT)) {
    const decl = verdict.kind === 'invalid' ? undefined : verdict.decl;
    const channels = (['mail', 'api'] as const).filter((c) => decl?.reach[c]);
    const present = await Promise.all(channels.map(async (c) => !!(await secrets.get(secretKey(decl!.id, c)))));
    const offers = decl?.reach.mail ? skipOffers(readLedger(WS, decl.id), readBooks().receipts, decl.reach.mail) : [];
    rows.push({ verdict, secrets: channels.map((channel, i) => ({ channel, present: present[i] })), ...(offers.length ? { skipOffers: offers } : {}) });
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

/**
 * The person's click on «Absender überspringen»: the sender goes into reach.mail.skip. That only
 * narrows what the source may read, so a source that ran live keeps running live: its new version
 * is switched on by the same click, and refused if the change would reach anything new.
 */
router.post('/api/sources/:id/skip', (req, res) => {
  const { sender, version } = (req.body ?? {}) as { sender?: string; version?: string };
  const before = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === req.params.id);
  if (!before || before.kind === 'invalid' || !before.decl.reach.mail || before.decl.origin !== 'company') throw new RequestError(404, `Die Mailbox ${req.params.id} gibt es nicht, oder sie hat Fehler.`);
  if (before.decl.version !== version) throw new RequestError(409, 'Die Quelle hat sich seit dem Anzeigen geändert: neu laden und noch einmal prüfen.');
  if (typeof sender !== 'string') throw new RequestError(400, 'sender fehlt.');
  try { addSkip(WS, before.decl.id, sender); } catch (e) { throw new RequestError(400, (e as Error).message); }
  const after = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === req.params.id);
  if (!after || after.kind === 'invalid') throw new RequestError(500, 'Die Quelle lädt nach dem Ändern nicht mehr.');
  const diff = reachDiff(before.decl.reach, after.decl.reach);
  if (before.kind === 'ready' && !diff.added.some((l) => !l.what.startsWith('not from '))) approveSource(WS, after.decl);
  res.json({ ok: true });
});
