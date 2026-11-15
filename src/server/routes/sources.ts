/**
 * Firma › Quellen over HTTP (ADR 0014): every source of the app and the workspace with its verdict
 * and whether each channel's secret is in the store (never its value).
 *
 *   GET  /api/sources               SourceRow[]
 *   GET  /api/sources/mail-host     ?address=: MailHost, the provider and IMAP server the domain's MX records suggest
 *   POST /api/sources/:id/approve   switches the version on (outside the workspace): it runs live from now on
 *   POST /api/sources/:id/skip      { sender, version }: a mailbox skips that sender's mail from now on
 *   POST /api/sources/:id/aside     { from, name, version }: a mailbox sets that sender's files of that name shape aside from now on
 *   GET  /api/sources/skip-offer    ?receipt=: { offer: ReceiptSkipOffer | null }, the skip a person's «kein Beleg» on that file offers
 *   POST /api/sources/mail          { address, host, account?, label?, password? }: a new mailbox source
 *   PUT  /api/sources/:id/secret    { password | null }: its mailbox password, into the secret store
 *   POST /api/sources/:id/check     MailCheck: the login tried (or the Mail app asked), and what it would read
 *   POST /api/sources/:id/preview   SourcePreview: any source's code run dry, the documents it would deliver
 */
import { Router } from 'express';
import { WS } from '../books.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { SourceVersionChanged, approveSource, changeKeepingOn, sources } from '../../platform/sources/index.js';
import { RequestError } from '../books.js';
import { secretKey, type ReceiptSkipOffer, type SourcePreview, type MailCheck, type SourceDecl, type SourceRow, type SourcesView } from '../../platform/sources/model.js';
import { mailSecret, secrets } from '../../secrets/secrets.js';
import { mailInputProblem, mailSourceSlot, previewMailbox, writeMailSource, type MailSourceInput } from '../../platform/sources/mail-setup.js';
import { mailBackend, mailFailure, type MailBackend } from '../../platform/sources/mail-channel.js';
import { sourcesRunHere, whyNotHere } from '../../platform/sources/launcher.js';
import { pull } from '../../platform/sources/host.js';
import { NoChromeError } from '../../platform/sources/web-driver.js';
import { sessionOf, signInUrl } from '../../platform/sources/web-channel.js';
import { openSession } from '../../platform/browser/chrome.js';
import { readLedger } from '../../platform/sources/ledger.js';
import { addSkip, mailReachOf, receiptSkipOffer, skipOffers } from '../../platform/sources/skip.js';
import { addAside, asideOffersOf } from '../../platform/sources/aside.js';
import { documents } from '../../engines/index.js';
import { readBooks } from '../books.js';
import { resolveMx } from 'node:dns/promises';
import { domainOf, lookupMailHost } from '../../platform/sources/mail-host.js';
import { MacMailError, macMailAccounts, macMailBackend } from '../../platform/sources/mac-mail.js';

export const router = Router();

router.get('/api/sources', async (_req, res) => {
  const rows: SourceRow[] = [];
  for (const verdict of sources(WS, APP_ROOT)) {
    const decl = verdict.kind === 'invalid' ? undefined : verdict.decl;
    const channels = (['mail', 'api'] as const).filter((c) => decl?.reach[c]);
    const present = await Promise.all(channels.map(async (c) => !!(await secrets.get(secretKey(decl!.id, c)))));
    const mail = decl && mailReachOf(decl);
    const lines = mail ? readLedger(WS, decl.id) : [];
    const offers = mail ? skipOffers(lines, readBooks().receipts, mail.reach) : [];
    const groups = mail && decl.origin === 'company' ? asideOffersOf(WS, APP_ROOT, decl.id, mail.reach, decl.settings, readBooks().receipts, documents()) : [];
    rows.push({ verdict, secrets: channels.map((channel, i) => ({ channel, present: present[i] })), ...(offers.length ? { skipOffers: offers } : {}), ...(groups.length ? { asideOffers: groups } : {}) });
  }
  res.json({ rows, secretsInApp: secrets.inApp(), secretsWhere: secrets.where(mailSecret('<id>')), runsHere: sourcesRunHere() } satisfies SourcesView);
});

/** «Immer so?» under a person's «kein Beleg» (#186): the mailbox that brought the file and its sender, with what a skip would no longer bring. Reads only. */
router.get('/api/sources/skip-offer', (req, res) => {
  const receipt = readBooks().receipts.find((r) => r.id === String(req.query.receipt ?? ''));
  if (!receipt) throw new RequestError(404, 'Diesen Beleg gibt es nicht.');
  const mailboxes = sources(WS, APP_ROOT).flatMap((v) => (v.kind !== 'invalid' && mailReachOf(v.decl) ? [{ decl: v.decl, lines: readLedger(WS, v.decl.id) }] : []));
  res.json({ offer: receiptSkipOffer(receipt, mailboxes, readBooks().receipts) ?? null } satisfies { offer: ReceiptSkipOffer | null });
});

/** Where an address's mail lives (Belege › «Weg hinzufügen»): the provider and IMAP server, from the domain or its MX records. Reads DNS, writes nothing. */
router.get('/api/sources/mail-host', async (req, res) => {
  const domain = domainOf(String(req.query.address ?? ''));
  if (!domain) throw new RequestError(400, 'Das Feld address ist nicht gültig.', { code: 'mailSourceField', params: { field: 'address' } });
  res.json(await lookupMailHost(domain, resolveMx));
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
  // One source per mailbox (r6h-25): the same address again brings that source up to date. The
  // password goes into the store first, the one step that can fail: nothing is written when it does.
  const { id, existing } = mailSourceSlot(input.address, sources(WS, APP_ROOT));
  if (body.password) await storeSecret(mailSecret(id), body.password);
  writeMailSource(WS, id, input, !!existing);
  res.json({ ok: true, id, ...(existing ? { updated: true } : {}) });
});


/** Into the secret store, or a refusal the UI can word: the keychain is not at hand (an app started outside the GUI session, a locked store). */
async function storeSecret(name: Parameters<typeof secrets.set>[0], value: string | null): Promise<void> {
  try {
    await secrets.set(name, value);
  } catch (e) {
    throw new RequestError(503, `Der Passwortspeicher ist nicht erreichbar: ${(e as Error).message}`, { code: 'secretStore' });
  }
}

/** The secret of a source's channel, into the secret store: its mailbox password, or its API token (`channel: "api"`); null removes it. Never echoed, never logged. */
router.put('/api/sources/:id/secret', async (req, res) => {
  const body = (req.body ?? {}) as { password?: unknown; channel?: unknown };
  const channel = body.channel === 'api' ? 'api' : 'mail';
  const v = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === req.params.id);
  const decl = v && v.kind !== 'invalid' && (channel === 'api' ? v.decl.reach.api : v.decl.reach.mail) ? v.decl : undefined;
  if (!decl) throw new RequestError(404, `Die Quelle ${req.params.id} gibt es nicht, oder sie hat Fehler.`);
  const { password } = body;
  if (password !== null && (typeof password !== 'string' || !password)) throw new RequestError(400, 'password: ein Text, oder null zum Entfernen.');
  if (!secrets.inApp()) throw new RequestError(409, `Das Passwort gehört nach ${secrets.where(secretKey(decl.id, channel))}.`);
  await storeSecret(secretKey(decl.id, channel), password);
  res.json({ ok: true });
});

/** «Verbindung prüfen»: logs in and says which of the last weeks' mails the source would read. Fetches no attachment, writes nothing. */
router.post('/api/sources/:id/check', async (req, res) => {
  const decl = mailDecl(req.params.id);
  let backend: MailBackend;
  if (decl.reach.macMail) {
    try {
      backend = await macMailBackend(decl.reach.macMail);
    } catch (e) {
      if (e instanceof MacMailError) return void res.json({ ok: false, reason: 'mail-app', problem: e.problem } satisfies MailCheck);
      throw e;
    }
  } else {
    const password = await secrets.get(mailSecret(decl.id));
    if (!password) return void res.json({ ok: false, reason: 'no-secret' } satisfies MailCheck);
    try {
      backend = await mailBackend(decl.reach.mail!, password);
    } catch (e) {
      return void res.json(mailFailure(e) satisfies MailCheck);
    }
  }
  try {
    res.json({ ok: true, ...(await previewMailbox(backend, decl)) } satisfies MailCheck);
  } catch (e) {
    if (e instanceof MacMailError) return void res.json({ ok: false, reason: 'mail-app', problem: e.problem } satisfies MailCheck);
    throw e;
  } finally {
    await backend.close();
  }
});

/** How many documents «Prüfen» shows: enough to see it reads the right mail, not a first pull over months. */
const PREVIEW_LIMIT = 12;

/**
 * «Prüfen» of any source, pending or switched on: its code runs dry (nothing delivered, no ledger
 * line, no cursor), and the person sees the documents it would bring, or why it could not look.
 * The Mail app's accounts are listed only on this click, when the one named is not among them.
 */
router.post('/api/sources/:id/preview', async (req, res) => {
  const v = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === req.params.id);
  if (!v || v.kind === 'invalid') throw new RequestError(404, `Die Quelle ${req.params.id} gibt es nicht, oder sie hat Fehler.`);
  if (whyNotHere(v.decl)) return void res.json({ ok: false, reason: 'not-here' } satisfies SourcePreview);
  let r;
  try {
    r = await pull({ ws: WS, appRoot: APP_ROOT, source: v.decl.id, run: 'preview', mode: 'dry', feeds: v.decl.feeds.map((f) => f.id), limit: PREVIEW_LIMIT });
  } catch (e) {
    if (e instanceof NoChromeError) return void res.json({ ok: false, reason: 'no-browser' } satisfies SourcePreview);
    throw e;
  }
  const seen = r.feeds.flatMap((f) => f.seen ?? []);
  let out: SourcePreview;
  switch (r.outcome) {
    case 'ok': out = { ok: true, seen, more: seen.length >= PREVIEW_LIMIT }; break;
    case 'missing-secret': out = { ok: false, reason: 'missing-secret', channel: r.channel }; break;
    case 'mail-app': {
      const accounts = r.problem === 'no-account' ? await macMailAccounts().then((a) => a.map((x) => x.name), () => undefined) : undefined;
      out = { ok: false, reason: 'mail-app', problem: r.problem, ...(accounts ? { accounts } : {}) };
      break;
    }
    case 'changed': out = { ok: false, reason: 'changed', detail: r.message }; break;
    case 'over-reach': out = { ok: false, reason: 'over-reach', detail: r.attempted }; break;
    case 'login-needed': out = { ok: false, reason: 'login-needed' }; break;
  }
  res.json(out);
});

/**
 * «Anmelden» on a source over a browser session: its own Chrome window opens on its sign-in page,
 * and the person signs in there as always, a second factor included. The app never sees the
 * password; the session keeps the sign-in for the source's runs.
 */
router.post('/api/sources/:id/sign-in', async (req, res) => {
  const v = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === req.params.id);
  const web = v && v.kind !== 'invalid' ? v.decl.reach.web : undefined;
  const url = web && signInUrl(web);
  if (!v || v.kind === 'invalid' || !url) throw new RequestError(404, `Die Quelle ${req.params.id} meldet sich nirgends an.`);
  try {
    const open = await openSession(sessionOf(v.decl.id), { url, headless: false });
    if (!open.started) await open.browser.contexts()[0]?.newPage().then((p) => p.goto(url)).catch(() => undefined);
    await open.detach();
  } catch (e) {
    throw new RequestError(503, (e as Error).message, { code: 'noBrowser' });
  }
  res.json({ ok: true });
});

/** A mailbox source of the workspace (pending or switched on), or 404. */
function mailDecl(id: string): SourceDecl {
  const v = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === id);
  if (!v || v.kind === 'invalid' || !(v.decl.reach.mail || v.decl.reach.macMail)) throw new RequestError(404, `Die Mailbox ${id} gibt es nicht, oder sie hat Fehler.`);
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
  const mail = before && before.kind !== 'invalid' ? mailReachOf(before.decl) : undefined;
  if (!before || before.kind === 'invalid' || !mail || before.decl.origin !== 'company') throw new RequestError(404, `Die Mailbox ${req.params.id} gibt es nicht, oder sie hat Fehler.`);
  if (before.decl.version !== version) throw new RequestError(409, 'Die Quelle hat sich seit dem Anzeigen geändert: neu laden und noch einmal prüfen.');
  if (typeof sender !== 'string') throw new RequestError(400, 'sender fehlt.');
  keepingOn(before.decl.id, version, (expect) => addSkip(WS, before.decl.id, sender, mail.key, expect));
  res.json({ ok: true });
});

/**
 * The person's click on «Immer beiseite»: the sender's files of that file-name shape go into the
 * mailbox's settings.aside (src/platform/sources/aside.ts) and are set aside at delivery from now on,
 * never deleted before 30 days and never by the click. A settings change only narrows what the
 * source delivers: a source that ran live keeps running live.
 */
router.post('/api/sources/:id/aside', (req, res) => {
  const { from, name, version } = (req.body ?? {}) as { from?: unknown; name?: unknown; version?: unknown };
  const before = sources(WS, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === req.params.id);
  if (!before || before.kind === 'invalid' || !mailReachOf(before.decl) || before.decl.origin !== 'company') throw new RequestError(404, `Die Mailbox ${req.params.id} gibt es nicht, oder sie hat Fehler.`);
  if (before.decl.version !== version) throw new RequestError(409, 'Die Quelle hat sich seit dem Anzeigen geändert: neu laden und noch einmal prüfen.');
  if (typeof from !== 'string' || typeof name !== 'string') throw new RequestError(400, 'from und name fehlen.');
  keepingOn(before.decl.id, version, (expect) => addAside(WS, before.decl.id, { from, name }, new Date(), expect));
  res.json({ ok: true });
});

/** A person's change to a mailbox's source.yaml, kept switched on (changeKeepingOn): a version changed meanwhile is 409, a refused value 400. */
function keepingOn(id: string, version: string, change: (expect: string) => void): void {
  try {
    changeKeepingOn(WS, APP_ROOT, id, change, version);
  } catch (e) {
    if (e instanceof SourceVersionChanged) throw new RequestError(409, 'Die Quelle hat sich seit dem Anzeigen geändert: neu laden und noch einmal prüfen.');
    throw new RequestError(400, (e as Error).message);
  }
}
