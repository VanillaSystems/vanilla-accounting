/**
 * Firma › Quellen over HTTP (ADR 0014): every source of the app and the workspace with its verdict
 * and whether each channel's secret is in the store (never its value).
 *
 *   GET  /api/sources               SourceRow[]
 *   POST /api/sources/:id/approve   switches the version on (outside the workspace): it runs live from now on
 *   POST /api/sources/:id/skip      { sender, version }: a mailbox skips that sender's mail from now on
 *   POST /api/sources/mail          { address, host, account?, label?, password? }: a new mailbox source
 *   PUT  /api/sources/:id/secret    { password | null }: its mailbox password, into the secret store
 *   POST /api/sources/:id/check     MailCheck: the login tried, and what it would read
 */
import { Router } from 'express';
import { WS } from '../books.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { approveSource, sources } from '../../platform/sources/index.js';
import { RequestError } from '../books.js';
import { secretKey, type MailCheck, type SourceDecl, type SourceRow, type SourcesView } from '../../platform/sources/model.js';
import { mailSecret, secrets } from '../../secrets/secrets.js';
import { mailInputProblem, mailSourceId, previewMailbox, writeMailSource, type MailSourceInput } from '../../platform/sources/mail-setup.js';
import { mailBackend, mailFailure, type MailBackend } from '../../platform/sources/mail-channel.js';
import { sourcesRunHere } from '../../platform/sources/launcher.js';
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
  res.json({ rows, secretsInApp: secrets.inApp(), secretsWhere: secrets.where(mailSecret('<id>')), runsHere: sourcesRunHere() } satisfies SourcesView);
});

/**
 * «Postfach verbinden» (r5h-27): a person adds a mailbox with its address, IMAP server and login;
 * the source folder is written and waits to be switched on, the password goes into the secret
 * store (never the workspace, never a log).
 */
router.post('/api/sources/mail', async (req, res) => {
  const body = (req.body ?? {}) as Partial<MailSourceInput> & { password?: unknown };
  const input: MailSourceInput = { address: String(body.address ?? ''), host: String(body.host ?? ''), ...(body.account !== undefined ? { account: String(body.account) } : {}), ...(body.label ? { label: String(body.label) } : {}) };
  const problem = mailInputProblem(input);
  if (problem) throw new RequestError(400, `Das Feld ${problem} ist nicht gültig.`, { code: 'mailSourceField', params: { field: problem } });
  if (body.password !== undefined && (typeof body.password !== 'string' || !body.password)) throw new RequestError(400, 'password: ein Text.');
  if (body.password && !secrets.inApp()) throw new RequestError(409, `Das Passwort gehört nach ${secrets.where(mailSecret('<id>'))}.`);
  const taken = new Set(sources(WS, APP_ROOT).map((v) => (v.kind === 'invalid' ? v.id : v.decl.id)));
  const id = mailSourceId(input.address, taken);
  writeMailSource(WS, id, input);
  if (body.password) await secrets.set(mailSecret(id), body.password);
  res.json({ ok: true, id });
});

/** The password of a source's mailbox, into the secret store; null removes it. Never echoed, never logged. */
router.put('/api/sources/:id/secret', async (req, res) => {
  const decl = mailDecl(req.params.id);
  const password = (req.body as { password?: unknown })?.password;
  if (password !== null && (typeof password !== 'string' || !password)) throw new RequestError(400, 'password: ein Text, oder null zum Entfernen.');
  if (!secrets.inApp()) throw new RequestError(409, `Das Passwort gehört nach ${secrets.where(mailSecret(decl.id))}.`);
  await secrets.set(mailSecret(decl.id), password);
  res.json({ ok: true });
});

/** «Verbindung prüfen»: logs in and says which of the last weeks' mails the source would read. Fetches no attachment, writes nothing. */
router.post('/api/sources/:id/check', async (req, res) => {
  const decl = mailDecl(req.params.id);
  const password = await secrets.get(mailSecret(decl.id));
  if (!password) return void res.json({ ok: false, reason: 'no-secret' } satisfies MailCheck);
  let backend: MailBackend;
  try {
    backend = await mailBackend(decl.reach.mail!, password);
  } catch (e) {
    return void res.json(mailFailure(e) satisfies MailCheck);
  }
  try {
    res.json({ ok: true, ...(await previewMailbox(backend, decl)) } satisfies MailCheck);
  } finally {
    await backend.close();
  }
});

/** A mailbox source of the workspace (pending or switched on), or 404. */
function mailDecl(id: string): SourceDecl {
  const v = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === id);
  if (!v || v.kind === 'invalid' || !v.decl.reach.mail) throw new RequestError(404, `Die Mailbox ${id} gibt es nicht, oder sie hat Fehler.`);
  return v.decl;
}

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
