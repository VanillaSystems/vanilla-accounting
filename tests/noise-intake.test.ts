/**
 * Round 5 (r5h-28, r5h-29): what is no receipt, dropped or collected on a Mac without poppler's
 * pdftotext (the packed app), is quarantined with its reason; a payment reminder is kept beside
 * the invoice it reminds of, never a second receipt.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognize, notReceipt } from '../src/intake/recognize.js';
import { documents } from '../src/engines/index.js';
import { documentKind } from '../src/intake/document-kind.js';
import { twinFinder } from '../src/intake/duplicates.js';
import { textPdf } from './support/text-pdf.js';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import { DEMO_ROOT } from './support/workspace.js';
import type { QuarantinedFile } from '../src/types/drop.js';

const NEWSLETTER = ['Baucenter Gossau', 'Herbst-News', 'Liebe Handwerkerinnen und Handwerker', 'Diese Woche: Malerwerkzeug 30 % guenstiger.', 'Sie erhalten diesen Newsletter, weil Sie die Profi-Karte haben. Abmelden: baucenter.example/abmelden'];
const TRACKING = ['Die Post', 'Ihre Sendung ist unterwegs', 'Sendungsnummer 99.60.123456.78901234', 'Voraussichtliche Zustellung: 21.10.2026', 'Sendung verfolgen auf post.example/track.'];
const REMINDER = ['Farbmix AG', 'Farbweg 3, 9000 St. Gallen', 'Malerei Huber GmbH', 'Zahlungserinnerung', 'Datum: 15.10.2026',
  "Unsere Rechnung FM-79010 vom 28.09.2026 ueber CHF 1'537.22 ist in unserer Buchhaltung noch offen.", 'Wir bitten Sie um Zahlung innert 10 Tagen.'];

/** Runs `fn` with a PATH on which no pdftotext is found, as on a fresh Mac. */
async function withoutPoppler<T>(fn: () => Promise<T>): Promise<T> {
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try { return await fn(); } finally { process.env.PATH = path; }
}

test('a dropped newsletter and a tracking notice are quarantined by their words without pdftotext', async () => {
  const news = await textPdf(NEWSLETTER);
  const track = await textPdf(TRACKING);
  const [a, b] = await withoutPoppler(() => Promise.all([recognize(news, 'Baucenter_News.pdf'), recognize(track, 'Post.pdf')]));
  assert.deepEqual([a.state, a.reason, a.document], ['quarantine', 'not-receipt', 'newsletter']);
  assert.deepEqual([b.state, b.reason, b.document], ['quarantine', 'not-receipt', 'tracking']);
});

test('a collected attachment that is no receipt is named so without pdftotext', async () => {
  const news = await textPdf(NEWSLETTER);
  assert.equal(await withoutPoppler(() => notReceipt(news)), 'newsletter');
});

test('a payment reminder is a document beside its invoice, linked to it by the invoice number, even with a fee on top and weeks later', () => {
  const W = documents();
  const reminder = REMINDER.join('\n');
  assert.deepEqual(documentKind(reminder, W), { is: 'supporting', why: 'reminder' });
  const invoice = { id: 'inv', extractedText: 'Farbmix AG\nRechnung FM-79010\nDatum: 28.08.2026\nTotal CHF 1537.22\nMWST 8.1%', date: '2026-08-28', amount: 1537.22, currency: 'CHF' };
  const other = { id: 'other', extractedText: 'Farbmix AG\nRechnung FM-78230\nDatum: 28.07.2026\nTotal CHF 1537.22', date: '2026-07-28', amount: 1537.22, currency: 'CHF' };
  const withFee = { id: 'rem', extractedText: reminder, date: '2026-10-15', amount: 1557.22, currency: 'CHF', kind: 'supporting' as const };
  assert.deepEqual(twinFinder([invoice, other], W).find(withFee), { of: 'inv', why: 'same-number', relation: 'companion' });
});

test('Belege lists what lies in quarantine with its reason, and «Ist ein Beleg» takes a file back into the inbox', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=Baucenter_News.pdf`, await textPdf(NEWSLETTER));
    s = await post(`/api/drop/${s.id}/files?name=Post.pdf`, await textPdf(TRACKING));
    const list = async () => (await api.send('GET', '/api/quarantine')).json as unknown as QuarantinedFile[];
    const before = await list();
    assert.deepEqual(before.map((q) => [q.file, q.reason]).sort(), [['Baucenter_News.pdf', { kind: 'not-receipt', why: 'newsletter' }], ['Post.pdf', { kind: 'not-receipt', why: 'tracking' }]]);
    const r = await api.fetch('/api/quarantine/Post.pdf');
    assert.equal(r.status, 200, 'the file can be looked at');
    assert.equal((await api.fetch('/api/quarantine/..%2Fledger.json')).status, 404, 'nothing outside the folder');
    const took = await api.send('POST', '/api/quarantine/Post.pdf/take');
    assert.equal(took.status, 200);
    await rest();
    assert.deepEqual((await list()).map((q) => q.file), ['Baucenter_News.pdf'], 'out of quarantine');
    assert.equal(existsSync(join(api.root, 'data/quarantine/Post.pdf.reason.txt')), false);
    const books = (await (await api.fetch('/books.json')).json()) as { receipts: Array<{ originalFilename?: string; filename: string }> };
    const inbox = existsSync(join(api.root, 'beleg-import')) ? readdirSync(join(api.root, 'beleg-import')) : [];
    assert.ok(inbox.includes('Post.pdf') || books.receipts.some((x) => x.originalFilename === 'Post.pdf'), 'in the inbox, or read by its run');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('Belege says why a file is no receipt: the word rule that typed it, its words, its kind, or no amount', async () => {
  const { noneWhyOf } = await import('../src/app/areas/receipts/model.js');
  assert.equal(noneWhyOf({ kind: 'noise', kindRule: 'document:terms' }), 'terms');
  assert.equal(noneWhyOf({ extractedText: NEWSLETTER.join('\n') }), 'newsletter', 'untyped, read before the drop judged it (r5h-28)');
  assert.equal(noneWhyOf({ extractedText: TRACKING.join('\n') }), 'tracking');
  assert.equal(noneWhyOf({ kind: 'supporting', extractedText: REMINDER.join('\n') }), 'reminder');
  assert.equal(noneWhyOf({ kind: 'duplicate' }), 'duplicate');
  assert.equal(noneWhyOf({ extractedText: 'Kassenzettel' }), 'empty');
});
