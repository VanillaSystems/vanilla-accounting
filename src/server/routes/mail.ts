/**
 * Firma › E-Mail: whether the outgoing mailbox can send (its settings are in the manifest, the
 * password in src/secrets/), and a login to check it without sending anything.
 */
import { Router } from 'express';
import { verifyMail } from '../../invoices/mail.js';
import { secrets } from '../../secrets/secrets.js';
import { WS } from '../books.js';
import type { MailStatus } from '../../types/api-error.js';

export const router = Router();

router.get('/api/mail', async (_req, res) => {
  const m = WS.outgoingMail;
  const password = !m?.user ? 'none' : (await secrets.get('smtp')) ? 'set' : 'missing';
  res.json({ configured: !!m, password, where: secrets.where('smtp') } satisfies MailStatus);
});

router.post('/api/mail/verify', async (_req, res) => {
  await verifyMail(WS);
  res.json({ ok: true });
});
