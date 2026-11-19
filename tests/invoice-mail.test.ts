/**
 * Sending invoices, reminders and cancellation notices through the company's own mailbox (ADR 0010):
 * the real API server against a local SMTP server (smtp-server) that captures each message. The
 * attachment is the stored PDF byte for byte; a sent document records channel, recipient, time and
 * Message-ID; a message the server refuses records nothing. The password never enters the workspace.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { simpleParser, type ParsedMail } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { issue } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type InvoiceBook, type SentDocument } from '../src/invoices/model.js';
import { MailError, sendMail } from '../src/invoices/mail.js';
import { envSecrets, useSecretStore } from '../src/secrets/secrets.js';
import { patchManifest } from '../src/workspace/manifest-write.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { tempWorkspace } from './support/workspace.js';

const USER = 'rechnung@muster.example';
const PASSWORD = 'smtp-geheim';
const PDF = Buffer.from('%PDF-1.4 Rechnung 2026-001 wie ausgestellt\n%%EOF\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let api: ApiServer;
let smtp: SMTPServer;
let port = 0;
const inbox: Array<{ rcpt: string[]; mail: ParsedMail }> = [];
const logins: string[] = [];

before(async () => {
  smtp = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, cb) {
      logins.push(`${auth.username}:${auth.password}`);
      cb(auth.username === USER && auth.password === PASSWORD ? null : new Error('Invalid login'), { user: auth.username });
    },
    onRcptTo(address, _session, cb) {
      cb(address.address.startsWith('abgelehnt@') ? Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }) : undefined);
    },
    onData(stream, session, cb) {
      simpleParser(stream).then((mail) => { inbox.push({ rcpt: session.envelope.rcptTo.map((r) => r.address), mail }); cb(); }, cb);
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  port = (smtp.server.address() as AddressInfo).port;
  api = await startApi('tests/fixtures/period-lock-index.json', { VANILLA_SMTP_PASSWORD: PASSWORD });
  withIssuedInvoice(api.root);
});
after(async () => {
  await api?.stop();
  await new Promise<void>((resolve) => smtp.close(resolve));
});

/** An issued, overdue invoice of CHF 108.10 to a customer with an e-mail address, its PDF stored. */
function withIssuedInvoice(root: string): void {
  const customer = { name: 'Beispiel Bistro AG', address: { postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30, email: 'buchhaltung@bistro.example' };
  const draft = { id: 'in_m', createdAt: '2026-06-01T08:00:00Z', origin: 'manual' as const, deleted: false, status: 'draft' as const, kind: 'invoice' as const,
    customerId: 'cu_m', date: '2026-06-01', currency: 'CHF' as const, language: 'de' as const, comments: [], lines: [{ text: 'Leistung', quantity: 1, price: 100, vatRate: 8.1 as const }] };
  const sender = { name: 'Muster', uid: 'CHE-123.456.789', address: { street: 'Weg', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo: { account: '1021', iban: 'CH6580808000000000001' } };
  const issued = issue(draft, { customer: { id: 'cu_m', createdAt: '', origin: 'manual', deleted: false, ...customer }, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-06-01T09:00:00Z' });
  const book: InvoiceBook = { schema: 1, contacts: [], invoices: [{ ...issued, pdf: { file: 'transactional-data/2026/invoices/2026-001.pdf', sha256: sha(PDF) } }], articles: [], sent: [] };
  mkdirSync(join(root, 'transactional-data/2026/invoices'), { recursive: true });
  writeFileSync(join(root, 'transactional-data/2026/invoices/2026-001.pdf'), PDF);
  writeFileSync(join(root, 'invoices.json'), JSON.stringify(book));
}

const sentLog = (): SentDocument[] => (JSON.parse(readFileSync(join(api.root, 'invoices.json'), 'utf8')) as InvoiceBook).sent;
const mailbox = { host: '127.0.0.1', security: 'none', user: USER, fromName: 'Muster GmbH', fromAddress: USER, replyTo: 'buchhaltung@muster.example' };

test('Firma › E-Mail: the settings go into the manifest, the password stays out', async () => {
  assert.deepEqual((await api.send('GET', '/api/mail')).json, { configured: false, password: 'none', where: 'VANILLA_SMTP_PASSWORD in .env', inApp: false });
  const refused = await api.send('PATCH', '/api/workspace', { outgoingMail: { ...mailbox, port, password: PASSWORD } });
  assert.equal(refused.status, 400, 'a password is no field of the workspace');
  const set = await api.send('PATCH', '/api/workspace', { outgoingMail: { ...mailbox, port } });
  assert.equal(set.status, 200, String(set.json.error));
  const manifest = readFileSync(join(api.root, 'belege.workspace.yaml'), 'utf8');
  assert.match(manifest, /outgoingMail:/);
  assert.ok(!manifest.includes(PASSWORD), 'no password in belege.workspace.yaml');
  assert.deepEqual((await api.send('GET', '/api/mail')).json, { configured: true, password: 'set', where: 'VANILLA_SMTP_PASSWORD in .env', inApp: false });
  assert.equal((await api.send('POST', '/api/mail/verify')).status, 200);
  assert.ok(logins.includes(`${USER}:${PASSWORD}`), 'logged in with the password from the environment');
});

test('an invoice by e-mail: the stored PDF byte for byte, recorded with channel, recipient, time and Message-ID', async () => {
  const res = await api.send('POST', '/api/invoices/in_m/send', { email: { to: 'chefin@bistro.example', subject: 'Rechnung 2026-001 · Muster GmbH', body: 'Guten Tag\n\nIm Anhang finden Sie Rechnung 2026-001.' } });
  assert.equal(res.status, 200, String(res.json.error));
  const doc = res.json as unknown as SentDocument;
  assert.deepEqual([doc.kind, doc.channel, doc.to, doc.file, doc.sha256], ['invoice', 'email', 'chefin@bistro.example', 'transactional-data/2026/invoices/2026-001.pdf', sha(PDF)]);
  assert.ok(doc.messageId && doc.sentAt);
  const { rcpt, mail } = inbox.at(-1)!;
  assert.deepEqual(rcpt, ['chefin@bistro.example']);
  assert.equal(mail.messageId, doc.messageId, 'the recorded Message-ID is the message’s');
  assert.equal(mail.subject, 'Rechnung 2026-001 · Muster GmbH');
  assert.match(mail.text ?? '', /Im Anhang finden Sie Rechnung 2026-001\./);
  assert.equal(mail.from?.value[0].address, USER);
  assert.equal(mail.from?.value[0].name, 'Muster GmbH');
  assert.equal(mail.replyTo?.value[0].address, 'buchhaltung@muster.example');
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].filename, '2026-001.pdf');
  assert.equal(mail.attachments[0].contentType, 'application/pdf');
  assert.equal(sha(mail.attachments[0].content), sha(PDF), 'the attachment is the stored PDF');
  assert.deepEqual(sentLog().map((d) => [d.kind, d.channel, d.to]), [['invoice', 'email', 'chefin@bistro.example']]);
});

test('a message the server refuses: the error shows, nothing is recorded', async () => {
  const before = readFileSync(join(api.root, 'invoices.json'));
  const res = await api.send('POST', '/api/invoices/in_m/send', { email: { to: 'abgelehnt@bistro.example', subject: 's', body: 'b' } });
  assert.equal(res.status, 502);
  assert.equal(res.json.mailRefusal, 'failed');
  assert.match(String(res.json.error), /E-Mail nicht gesendet: .*550/);
  assert.ok(readFileSync(join(api.root, 'invoices.json')).equals(before), 'invoices.json is byte-identical');
  const bad = await api.send('POST', '/api/invoices/in_m/send', { email: { to: 'keine adresse', subject: 's', body: 'b' } });
  assert.deepEqual([bad.status, bad.json.mailRefusal], [400, 'recipient']);
});

test('a reminder and a cancellation notice by e-mail; a refused notice leaves no PDF and no cancellation', async () => {
  const reminder = await api.send('POST', '/api/invoices/in_m/reminders', { email: { to: 'buchhaltung@bistro.example', subject: '1. Mahnung', body: 'Bitte zahlen.' } });
  assert.equal(reminder.status, 200, String(reminder.json.error));
  const sent = (reminder.json as { sent: SentDocument }).sent;
  assert.deepEqual([sent.kind, sent.channel, sent.to], ['reminder', 'email', 'buchhaltung@bistro.example']);
  const got = inbox.at(-1)!.mail;
  assert.equal(got.messageId, sent.messageId);
  assert.equal(sha(got.attachments[0].content), sent.sha256, 'the attachment is the reminder as stored');
  assert.equal(sha(readFileSync(join(api.root, sent.file))), sent.sha256);

  const sentDir = join(api.root, dirname(sent.file));
  const files = readdirSync(sentDir).length;
  const refused = await api.send('POST', '/api/invoices/in_m/cancel', { reason: 'Doppelt', notify: true, email: { to: 'abgelehnt@bistro.example', subject: 's', body: 'b' } });
  assert.equal(refused.status, 502);
  assert.equal(readdirSync(sentDir).length, files, 'the printed notice is removed again');
  const book = JSON.parse(readFileSync(join(api.root, 'invoices.json'), 'utf8')) as InvoiceBook;
  assert.ok(!('cancelled' in book.invoices[0] && book.invoices[0].cancelled), 'not cancelled');

  const cancelled = await api.send('POST', '/api/invoices/in_m/cancel', { reason: 'Doppelt', notify: true, email: { to: 'buchhaltung@bistro.example', subject: 'Storno', body: 'Storniert.' } });
  assert.equal(cancelled.status, 200, String(cancelled.json.error));
  const notice = (cancelled.json as { sent: SentDocument }).sent;
  assert.deepEqual([notice.kind, notice.channel], ['cancellation', 'email']);
  assert.equal(sha(inbox.at(-1)!.mail.attachments[0].content), notice.sha256);
  assert.deepEqual(sentLog().map((d) => [d.kind, d.channel]), [['invoice', 'email'], ['reminder', 'email'], ['cancellation', 'email']]);
});

test('a download still records the send, as downloaded', async () => {
  const ws = tempWorkspace('invoice-mail-');
  withIssuedInvoice(ws.paths.root);
  const { recordSend } = await import('../src/invoices/service.js');
  const doc = await recordSend(ws, 'in_m', { to: 'download', now: '2026-10-11T10:00:00Z' });
  assert.deepEqual([doc.channel, doc.to, doc.messageId], ['download', 'download', undefined]);
});

test('the password comes from the secret store: none there is a clear refusal; the desktop app’s store replaces the environment', async () => {
  const ws = tempWorkspace('invoice-mail-');
  patchManifest(ws.paths.manifest, { outgoingMail: { ...mailbox, port, security: 'none' } });
  const fresh = workspaceAt(ws.paths.root);
  const message = { to: 'chefin@bistro.example', subject: 's', body: 'b' };
  const pdf = { filename: 'x.pdf', content: PDF };
  const saved = process.env.VANILLA_SMTP_PASSWORD;
  delete process.env.VANILLA_SMTP_PASSWORD;
  try {
    await assert.rejects(sendMail(fresh, message, pdf), (e: MailError) => e.code === 'noPassword' && /VANILLA_SMTP_PASSWORD in \.env/.test(e.message));
    useSecretStore({ get: async () => PASSWORD, where: () => 'Schlüsselbund' });
    const { messageId } = await sendMail(fresh, message, pdf);
    assert.equal(inbox.at(-1)!.mail.messageId, messageId);
  } finally {
    useSecretStore(envSecrets);
    if (saved !== undefined) process.env.VANILLA_SMTP_PASSWORD = saved;
  }
  assert.ok(!existsSync(join(ws.paths.root, 'invoices.json')), 'sendMail records nothing itself');
});

test('P3.6 the Vorlage «Regie» with the Rapport, picked on one Rechnung: sent to two recipients, a CC and a copy to the firm, with both PDFs; the sent log keeps both checksums', async () => {
  const { storeAttachment } = await import('../src/invoices/attachments.js');
  const { createCustomer, createDraft, issueInvoice, updateDraft } = await import('../src/invoices/service.js');
  const RAPPORT = Buffer.from('%PDF-1.4 Regierapport KW 46\n%%EOF\n');
  const rapport = storeAttachment(workspaceAt(api.root), 'Rapport KW 46.pdf', RAPPORT, '2026-11-19');
  const added = await api.send('PATCH', '/api/workspace', { invoicing: { templates: { add: { id: 'regie', name: 'Regie' }, attachment: { id: 'regie', value: { name: rapport.name, file: rapport.file, kinds: ['invoice'] } } } } });
  assert.equal(added.status, 200, String(added.json.error));
  const ws = workspaceAt(api.root);
  assert.deepEqual(ws.invoicing!.templates.map((t) => [t.id, t.attachment?.file]), [['standard', undefined], ['regie', rapport.file]]);
  const c = createCustomer(ws, { name: 'Regie Kunde AG', address: { postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de', paymentTermsDays: 30 });
  const draft = createDraft(ws, { customerId: c.id, date: '2026-11-19', lines: [{ text: 'Regiearbeit', quantity: 10, price: 95, vatRate: 8.1, unit: 'h' }] }, '2026-11-19T08:00:00Z');
  const picked = await api.send('PATCH', `/api/invoices/${draft.id}`, { templateId: 'regie' });
  assert.equal(picked.status, 200, String(picked.json.error));
  assert.equal((await api.send('PATCH', `/api/invoices/${draft.id}`, { templateId: 'nope' })).json.invoiceRefusal, 'templateGone');
  const INVOICE = Buffer.from('%PDF-1.4 Regierechnung\n%%EOF\n');
  const issued = await issueInvoice(ws, draft.id, { now: '2026-11-19T09:00:00Z', printer: { pdf: async () => ({ html: '', pages: 1, pdf: INVOICE }), html: async () => ({ html: '', pages: 1 }) } });
  assert.deepEqual(issued.attachments, [rapport]);

  const res = await api.send('POST', `/api/invoices/${issued.id}/send`, { email: { to: ['chefin@kunde.example', 'buchhaltung@kunde.example'], cc: 'bauleiter@kunde.example', copy: true, subject: `Rechnung ${issued.number}`, body: 'Im Anhang Rechnung und Rapport.' } });
  assert.equal(res.status, 200, String(res.json.error));
  const doc = res.json as unknown as SentDocument;
  const { rcpt, mail } = inbox.at(-1)!;
  assert.deepEqual([...rcpt].sort(), ['bauleiter@kunde.example', 'buchhaltung@kunde.example', 'chefin@kunde.example', USER].sort(), 'every recipient, the CC and the firm\'s own copy');
  assert.deepEqual(mail.to && !Array.isArray(mail.to) ? mail.to.value.map((a) => a.address) : [], ['chefin@kunde.example', 'buchhaltung@kunde.example']);
  assert.deepEqual(mail.cc && !Array.isArray(mail.cc) ? mail.cc.value.map((a) => a.address) : [], ['bauleiter@kunde.example']);
  assert.equal(mail.bcc, undefined, 'the copy to the firm is blind');
  assert.deepEqual(mail.attachments.map((a) => [a.filename, sha(a.content)]), [[`${issued.number}.pdf`, sha(INVOICE)], [rapport.name, sha(RAPPORT)]], 'both PDFs, byte for byte');
  assert.deepEqual([doc.to, doc.cc, doc.bcc], ['chefin@kunde.example, buchhaltung@kunde.example', ['bauleiter@kunde.example'], [USER]]);
  assert.deepEqual([doc.sha256, doc.attachments?.map((a) => [a.name, a.sha256])], [sha(INVOICE), [[rapport.name, sha(RAPPORT)]]], 'the sent log keeps both checksums');
  assert.deepEqual(sentLog().at(-1), doc);

  // A recipient the server refuses among several: nothing goes on record.
  const before = readFileSync(join(api.root, 'invoices.json'));
  const refused = await api.send('POST', `/api/invoices/${issued.id}/send`, { email: { to: 'chefin@kunde.example, abgelehnt@kunde.example', subject: 's', body: 'b' } });
  assert.equal(refused.status, 502);
  assert.ok(readFileSync(join(api.root, 'invoices.json')).equals(before));
  const wrong = await api.send('POST', `/api/invoices/${issued.id}/send`, { email: { to: 'chefin@kunde.example', cc: 'kein-mail', subject: 's', body: 'b' } });
  assert.deepEqual([wrong.status, wrong.json.mailRefusal], [400, 'recipient']);
});

test('the Kontoauszug of a contact over the API: per currency, the balance Offene Posten names; a period backwards is refused', async () => {
  const book = JSON.parse(readFileSync(join(api.root, 'invoices.json'), 'utf8')) as InvoiceBook;
  const contact = book.contacts.find((c) => c.name === 'Regie Kunde AG')!;
  const view = await api.send('GET', `/api/contacts/${contact.id}/statement?from=2026-01-01&to=2026-12-31`);
  assert.equal(view.status, 200, String(view.json.error));
  const sections = (view.json as { sections: Array<{ currency: string; closing: number }> }).sections;
  assert.deepEqual(sections.map((s) => [s.currency, s.closing]), [['CHF', 1026.95]]);
  assert.equal((await api.send('GET', `/api/contacts/${contact.id}/statement?from=2026-12-31&to=2026-01-01`)).status, 400);
});
