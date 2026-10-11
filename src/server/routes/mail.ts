/**
 * Firma › E-Mail: whether the outgoing mailbox can send (its settings are in the manifest, the
 * password in src/secrets/), and a login to check it without sending anything.
 */
import { Router } from 'express';
import { verifyMail } from '../../invoices/mail.js';
import { secrets } from '../../secrets/secrets.js';
import { RequestError, WS } from '../books.js';
import type { ApiErrorBody, MailStatus } from '../../types/api-error.js';

export const router = Router();

router.get('/api/mail', async (_req, res) => {
  const m = WS.outgoingMail;
  const password = !m?.user ? 'none' : (await secrets.get('smtp')) ? 'set' : 'missing';
  res.json({ configured: !!m, password, where: secrets.where('smtp'), inApp: secrets.inApp() } satisfies MailStatus);
});

/** The desktop app keeps the password in its keychain store; under `npm start` it is in .env, and this refuses. */
router.put('/api/mail/password', async (req, res) => {
  const password = (req.body as { password?: unknown }).password;
  if (!secrets.inApp()) return void res.status(409).json({ error: `The password goes into ${secrets.where('smtp')}.` } satisfies ApiErrorBody);
  if (password !== null && (typeof password !== 'string' || !password)) throw new RequestError(400, 'password: a non-empty string, or null to remove it');
  await secrets.set('smtp', password);
  res.json({ ok: true });
});

router.post('/api/mail/verify', async (_req, res) => {
  await verifyMail(WS);
  res.json({ ok: true });
});
