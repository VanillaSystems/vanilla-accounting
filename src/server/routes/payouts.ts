/**
 * A payment provider's payouts without a booking (#404, src/server/provider-payouts.ts):
 *
 *   GET  /api/payouts          the groups by provider and by what they wait for (Aufgaben names them as payouts)
 *   POST /api/payouts/book     { provider }: books the payouts code books now, in code; how many of how many, or that booking waits for «Einschalten»
 */
import { Router } from 'express';
import { RequestError } from '../books.js';
import { bookPayouts, payoutGroups, readyPayouts } from '../provider-payouts.js';

export const router = Router();

router.get('/api/payouts', (_req, res) => { res.json({ groups: payoutGroups() }); });

router.post('/api/payouts/book', async (req, res) => {
  const provider = (req.body as { provider?: unknown })?.provider;
  if (typeof provider !== 'string' || !provider) throw new RequestError(400, 'provider erwartet.');
  const refs = readyPayouts(provider);
  res.json({ ok: true, ...(await bookPayouts(refs)) });
});
