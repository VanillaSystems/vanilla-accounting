/**
 * What a mailbox sets aside besides the words of a file (src/platform/sources/aside.ts): a group of a
 * sender's files by file-name shape, offered once two of them were set aside and none stands in the
 * books, and kept aside at delivery once the person switched it on; a duplicate by content of a
 * receipt in the books; the sender skip offered only for a sender none of whose files is in the
 * books; «Aussortiert» deleted after 30 days, never what a person brought or kept. The rule above
 * all: a real receipt is never lost. Made-up mail only.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { approveSource, changeKeepingOn, SourceVersionChanged, sources } from '../src/platform/sources/index.js';
import { pull, type PullRequest } from '../src/platform/sources/host.js';
import { detailsPath, readLedger, type LedgerLine } from '../src/platform/sources/ledger.js';
import type { MailBackend, MailSummary } from '../src/platform/sources/mail-channel.js';
import { addAside, asideGroupOf, asideOffers, contentTwin, editSourceYaml, nameShape, offerableShape, switchAsideOff, type AsideInput } from '../src/platform/sources/aside.js';
import { skipOffers } from '../src/platform/sources/skip.js';
import { parseSender } from '../src/platform/sources/reach.js';
import type { SenderPattern } from '../src/platform/sources/model.js';
import { formatReason, keepQuarantined, lastSwept, parseReason, putInQuarantine, quarantined, sweepQuarantine } from '../src/intake/quarantine.js';
import { asideGroups } from '../src/app/areas/receipts/aside-groups.js';
import { documents } from '../src/engines/index.js';
import { APP_ROOT, type Workspace } from '../src/workspace/workspace.js';
import type { Receipt } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import { startApi } from './support/api-server.js';

process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'aside-approvals-'));
const secretsFile = join(mkdtempSync(join(tmpdir(), 'aside-secrets-')), 'secrets.json');
process.env.VANILLA_SECRETS_FILE = secretsFile;
writeFileSync(secretsFile, JSON.stringify({ 'source:office:mail': 'app-password' }));

const W = documents();
const sender = (s: string): SenderPattern => { const p = parseSender(s); if (!p.ok) throw new Error(p.message); return p.value; };
const REACH = { from: [sender('*')], skip: [] as SenderPattern[] };
const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
let n = 0;
const line = (name: string, from: string, x: { aside?: boolean; day?: string } = {}): LedgerLine => {
  const s = sha(`${name}-${n++}`);
  return {
    at: `${x.day ?? '2026-10-01'}T08:00:00Z`, run: 'r', feed: 'attachments', key: `${n}#${name}`,
    got: { kind: 'document', sha256: s, from, shape: nameShape(name), ...(x.aside ? { quarantined: { file: name, why: 'price-list' as const } } : { file: name }) },
  };
};
const fileOf = (l: LedgerLine) => { const g = (l as Extract<LedgerLine, { got: { kind: 'document' } }>).got; return g.quarantined?.file ?? g.file ?? ''; };
const receiptOf = (l: LedgerLine, x: Partial<Receipt> = {}): Receipt => {
  const got = (l as Extract<LedgerLine, { got: { kind: 'document' } }>).got;
  return { id: got.sha256.slice(0, 16), filename: `x-${fileOf(l)}`, originalFilename: fileOf(l), extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: l.at, location: 'archived', ...x };
};
const offers = (lines: LedgerLine[], receipts: Receipt[] = [], over: Partial<AsideInput> = {}) => asideOffers({ lines, receipts, reach: REACH, settings: {}, words: W, ...over });

test('a file name\'s shape: numbers and ids out, a copy\'s mark gone, words and the extension kept', () => {
  const cases: Array<[string, string]> = [
    ['report.pdf', 'report.pdf'],
    ['Report (1).pdf', 'report.pdf'],
    ['report-2.pdf', 'report.pdf'],
    ['5714779795.pdf', '#.pdf'],
    ['5598005849.PDF', '#.pdf'],
    ['IMG_1771.pdf', 'img_#.pdf'],
    ['IMG_1760 2.pdf', 'img_#.pdf'],
    ['Invoice-9BF0758D-7523929.pdf', 'invoice_#.pdf'],
    ['Receipt-2047-6241.pdf', 'receipt_#.pdf'],
    ['Rechnung 2026-04.pdf', 'rechnung_#.pdf'],
    ['Rechnung_9003316975.pdf', 'rechnung_#.pdf'],
    ['katalog_v3_herbst.pdf', 'katalog_v#_herbst.pdf'],
    ['Prospekt Gläser.pdf', 'prospekt_gläser.pdf'],
    ['ohne-endung', 'ohne_endung'],
    ['Invoice #123.pdf', 'invoice_#.pdf'],
  ];
  for (const [name, shape] of cases) assert.equal(nameShape(name), shape, name);
  assert.notEqual(nameShape('Rechnung 7.pdf'), nameShape('Katalog 7.pdf'), 'the words tell kinds apart');
  assert.notEqual(nameShape('report.pdf'), nameShape('report.csv'), 'and the extension');
  for (const [, shape] of cases) assert.equal(nameShape(shape), shape, `a shape is its own shape: ${shape}`);
});

test('a shape without a telling word, or of a receipt\'s words, is never a group', () => {
  for (const s of ['#.pdf', 'img_#.pdf', 'img.pdf', 'scan.pdf', 'scan_#.pdf', 'document_#.pdf', 'rechnung_#.pdf', 'invoice_#.pdf', 'receipt_#.pdf', 'beleg.pdf', 'quittung_#.pdf', 'facture_#.pdf', 'fattura.pdf', 'ricevuta_#.pdf', 'rechnungskopie.pdf']) {
    assert.equal(offerableShape(s, W), false, s);
  }
  for (const s of ['re_#.pdf', 'rg_#.pdf', 'inv_#.pdf', 'rech_#.pdf', 'fact_#.pdf', 'gs_#.pdf', 'screenshot_#.png', 'screen_shot_#.png', 'bildschirmfoto_#.png', 'whatsapp_image_#.jpeg']) {
    assert.equal(offerableShape(s, W), false, `a receipt's short form or a screen's default: ${s}`);
  }
  assert.equal(nameShape('RE_2026-104.pdf'), 're_#.pdf');
  assert.equal(nameShape('Screenshot 2026-10-01 at 08.15.22.png'), 'screenshot_#_at_#.png');
  assert.equal(offerableShape(nameShape('Screenshot 2026-10-01 at 08.15.22.png'), W), false, 'a two-letter word («at», «um») tells nothing');
  assert.equal(offerableShape(nameShape('Bildschirmfoto 2026-10-01 um 08.15.22.png'), W), false);
  for (const s of ['report.pdf', 'katalog_#.pdf', 'newsletter_#.pdf', 'prospekt_gläser.pdf', 'preview.pdf', 'invest_news.pdf']) assert.equal(offerableShape(s, W), true, s);
  const lines = [line('IMG_1.pdf', 'me@phone.example', { aside: true }), line('IMG_22.pdf', 'me@phone.example', { aside: true }), line('IMG_333.pdf', 'me@phone.example', { aside: true })];
  assert.deepEqual(offers(lines), [], 'a phone\'s photos: a receipt photo has the same name');
  const invoices = [line('Rechnung 101.pdf', 'billing@x.example', { aside: true }), line('Rechnung 202.pdf', 'billing@x.example', { aside: true })];
  assert.deepEqual(offers(invoices), []);
  assert.equal(asideGroupOf({ aside: [{ from: 'me@phone.example', name: 'img_#.pdf' }] }, 'me@phone.example', 'IMG_9.pdf', W), undefined, 'not even a group written by hand');
});

test('a group is offered once two of its files were set aside and none is in the books, with every file and its day', () => {
  const lines = [
    line('report.pdf', 'Reports@Tool.example', { aside: true, day: '2026-09-01' }),
    line('report.pdf', 'reports@tool.example', { aside: true, day: '2026-10-01' }),
  ];
  assert.deepEqual(offers(lines), [{
    sender: 'reports@tool.example', shape: 'report.pdf', inBooks: 0,
    files: [{ name: 'report.pdf', date: '2026-09-01', aside: true }, { name: 'report.pdf', date: '2026-10-01', aside: true }],
  }]);
  assert.deepEqual(offers(lines.slice(0, 1)), [], 'one file set aside is not yet a group');
  const named = new Map([[`attachments ${(lines[0] as { key: string }).key}`, { name: 'report (Kopie).pdf' }]]);
  assert.equal(offers(lines, [], { details: named })[0].files[0].name, 'report (Kopie).pdf', 'the own name, where data/ kept it');
});

test('a person\'s «kein Beleg» counts as set aside; the model\'s does not', () => {
  const lines = [line('Flyer 1.pdf', 'news@shop.example'), line('Flyer 2.pdf', 'news@shop.example')];
  assert.equal(offers(lines, lines.map((l) => receiptOf(l, { kind: 'noise', kindBy: 'human' }))).length, 1);
  assert.deepEqual(offers(lines, lines.map((l) => receiptOf(l, { kind: 'noise', kindBy: 'rule', kindRule: 'model:no-receipt' }))), []);
});

test('never offered: a group with one file in the books or waiting in the inbox; a supplier\'s invoice after two brochures stays out of the brochures\' group', () => {
  const brochures = [line('Katalog 2025.pdf', 'sales@supplier.example', { aside: true }), line('Katalog 2026.pdf', 'sales@supplier.example', { aside: true })];
  const invoice = line('Rechnung 4711.pdf', 'sales@supplier.example');
  assert.deepEqual(offers([...brochures, invoice], [receiptOf(invoice)]).map((o) => o.shape), ['katalog_#.pdf'], 'the brochures, not the invoice');
  const groups = { aside: [{ from: 'sales@supplier.example', name: 'katalog_#.pdf' }] };
  assert.equal(asideGroupOf(groups, 'sales@supplier.example', 'Rechnung 4712.pdf', W), undefined, 'the next invoice is delivered');
  assert.ok(asideGroupOf(groups, 'Sales@Supplier.example', 'Katalog 2027.pdf', W), 'the next brochure is set aside');
  assert.equal(asideGroupOf(groups, 'sales@supplier.example', 'Katalog 2027.pdf', W, true), undefined, 'unless its words name it a receipt');

  const reports = [line('report.pdf', 'a@tool.example', { aside: true }), line('report.pdf', 'a@tool.example', { aside: true }), line('report.pdf', 'a@tool.example')];
  assert.deepEqual(offers(reports, [receiptOf(reports[2])]), [], 'one of the group stands in the books');
  assert.deepEqual(offers(reports, [], { pending: new Set([fileOf(reports[2])]) }), [], 'one of the group waits in the inbox: it may be a receipt');
  assert.equal(offers(reports, [receiptOf(reports[2], { kind: 'noise', kindBy: 'human' })]).length, 1, 'set aside by a person, it does not stand in the books');
});

test('«none in the books» looks at the whole books: a receipt of that shape from that sender by another mailbox, its VAT number or its domain', () => {
  const lines = [line('report.pdf', 'a@tool.example', { aside: true }), line('report.pdf', 'a@tool.example', { aside: true })];
  const dropped = (x: Partial<Receipt>): Receipt => ({ id: 'dropped0000000aa', filename: 'r.pdf', originalFilename: 'report.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-10-01', location: 'archived', ...x });
  assert.equal(offers(lines, [dropped({})]).length, 1, 'a «report.pdf» of someone else: no matter');
  assert.deepEqual(offers(lines, [dropped({ extractedText: 'Tool GmbH · billing@tool.example · Rechnung' })]), [], 'its domain in the receipt');
  assert.deepEqual(offers(lines, [dropped({})], { senders: new Map([['dropped0000000aa', 'a@tool.example']]) }), [], 'its sender by another mailbox');
  const vat = new Map([[`attachments ${(lines[0] as { key: string }).key}`, { vatId: 'CHE-111.222.333' }]]);
  assert.deepEqual(offers(lines, [dropped({ vatId: 'CHE-111.222.333' })], { details: vat }), [], 'a VAT number one of the group showed');
  assert.equal(offers(lines, [dropped({ extractedText: 'billing@tool.example', kind: 'noise', kindBy: 'human' })]).length, 1, 'set aside itself: not in the books');
});

test('not offered again: a group in the settings, switched on or off; nor a sender the mailbox skips', () => {
  const lines = [line('report.pdf', 'a@tool.example', { aside: true }), line('report.pdf', 'a@tool.example', { aside: true })];
  assert.deepEqual(offers(lines, [], { settings: { aside: [{ from: 'a@tool.example', name: 'report.pdf', off: true }] } }), []);
  assert.deepEqual(offers(lines, [], { reach: { from: [sender('*')], skip: [sender('a@tool.example')] } }), []);
  assert.equal(asideGroupOf({ aside: [{ from: 'a@tool.example', name: 'report.pdf', off: true }] }, 'a@tool.example', 'report.pdf', W), undefined, 'a group switched off sets nothing aside');
});

test('the sender skip is offered only for a sender none of whose files stands in the books', () => {
  const news = [1, 2, 3].map((i) => line(`flyer-${i}.pdf`, 'sales@supplier.example', { aside: true }));
  const invoice = line('Rechnung 1.pdf', 'sales@supplier.example');
  const waiting = line('Rechnung 2.pdf', 'sales@supplier.example');
  assert.deepEqual(skipOffers([...news, invoice], [receiptOf(invoice)], REACH), [], 'one real invoice: never offered');
  assert.deepEqual(skipOffers([...news, invoice, waiting], [], REACH), [{ sender: 'sales@supplier.example', n: 3 }], 'nothing in the books: offered, whatever share the inbox still holds');
  assert.deepEqual(skipOffers(news.slice(0, 2), [], REACH), [], 'fewer than three set aside');
});

test('keeping a group writes it into settings.aside; switched off it stays there; every write is atomic and never over a change made meanwhile', () => {
  const root = mkdtempSync(join(tmpdir(), 'aside-yaml-'));
  mkdirSync(join(root, 'sources', 'office'), { recursive: true });
  const file = join(root, 'sources', 'office', 'source.yaml');
  writeFileSync(file, 'label: Office\nsettings:\n  boxes: [{ label: Office, address: office@example.com }]  # the box\nreach:\n  mail: { host: imap.example.com, from: ["*"] }\n');
  const ws = { paths: { root } } as Parameters<typeof addAside>[0];
  addAside(ws, 'office', { from: 'Reports@Tool.example', name: 'report.pdf' }, new Date('2026-11-14T10:00:00Z'));
  const text = readFileSync(file, 'utf8');
  assert.match(text, /# the box/);
  assert.match(text, /aside:\n\s+- from: reports@tool\.example\n\s+name: report\.pdf\n\s+source: hand 2026-11-14/);
  assert.throws(() => addAside(ws, 'office', { from: 'a@b.example', name: 'Report 7.pdf' }), /no file-name shape/, 'a shape, never a file name');
  assert.throws(() => switchAsideOff(ws, 'office', { from: 'reports@tool.example', name: 'report.pdf' }, 'label: something read before\n'), SourceVersionChanged);
  assert.equal(readFileSync(file, 'utf8'), text, 'a stale read writes nothing');
  assert.equal(switchAsideOff(ws, 'office', { from: 'reports@tool.example', name: 'report.pdf' }, text), true);
  assert.match(readFileSync(file, 'utf8'), /off: true/);
  assert.equal(switchAsideOff(ws, 'office', { from: 'reports@tool.example', name: 'report.pdf' }), false, 'off already');
  addAside(ws, 'office', { from: 'reports@tool.example', name: 'report.pdf' });
  assert.doesNotMatch(readFileSync(file, 'utf8'), /off: true/, 'kept again, it is on again, once');
  assert.equal((readFileSync(file, 'utf8').match(/name: report\.pdf/g) ?? []).length, 1);
  assert.deepEqual(readdirSync(join(root, 'sources', 'office')), ['source.yaml'], 'no temporary file left');
  assert.equal(editSourceYaml(ws, 'office', () => false), false, 'nothing to change writes nothing');
});

const INVOICE = 'Vendor AG\nRechnung Nr. R-2026-0815\nDatum: 01.10.2026\nTotal CHF 54.00\nMWST 8.1 % 4.05';
const BOOKS = [{ receipt: { id: 'r1', filename: '20261001-vendor.pdf', extractedText: INVOICE, amount: 54, currency: 'CHF', date: '2026-10-01' }, from: 'billing@vendor.example' }];

test('a duplicate by content: same sender, own invoice number, signed amount, both dated within a week', () => {
  assert.deepEqual(contentTwin(`${INVOICE}\nKopie`, 'Billing@Vendor.example', BOOKS, W), { id: 'r1', filename: '20261001-vendor.pdf' });
  assert.equal(contentTwin(INVOICE, 'other@vendor.example', BOOKS, W), undefined, 'another sender, no VAT number to tell');
  assert.equal(contentTwin(INVOICE.replace('R-2026-0815', 'R-2026-0816'), 'billing@vendor.example', BOOKS, W), undefined, 'another number');
  assert.equal(contentTwin(INVOICE.replace('54.00', '64.00'), 'billing@vendor.example', BOOKS, W), undefined, 'another amount');
  assert.equal(contentTwin(INVOICE, 'billing@vendor.example', [{ ...BOOKS[0], receipt: { ...BOOKS[0].receipt, amount: -54 } }], W), undefined, 'the sign counts');
  assert.equal(contentTwin(INVOICE, 'billing@vendor.example', [{ ...BOOKS[0], receipt: { ...BOOKS[0].receipt, kind: 'noise' as const } }], W), undefined, 'set aside itself: not in the books');
});

test('never a duplicate: a credit note, an undated instalment, next year\'s invoice of the same number, a proforma\'s invoice, a reminder, a number labelled only by the title word', () => {
  const twin = (text: string, books = BOOKS) => contentTwin(text, 'billing@vendor.example', books, W);
  assert.equal(twin('Vendor AG\nGutschrift G-77\nzu Rechnung Nr. R-2026-0815\nDatum: 03.10.2026\nTotal CHF -54.00'), undefined, 'a credit note, negative');
  assert.equal(twin('Vendor AG\nGutschrift G-77\nzu Rechnung Nr. R-2026-0815\nDatum: 03.10.2026\nTotal CHF 54.00'), undefined, 'a credit note, written positive');
  assert.equal(twin('Vendor AG\nRechnung Nr. R-2026-0815\n2. Rate\nTotal CHF 54.00'), undefined, 'an instalment, undated');
  assert.equal(twin(INVOICE.replace(/Datum: .*\n/, '')), undefined, 'undated: nothing decided');
  assert.equal(twin(INVOICE.replace('01.10.2026', '01.10.2027')), undefined, 'next year, the number counted again');
  const proforma = [{ ...BOOKS[0], receipt: { ...BOOKS[0].receipt, extractedText: INVOICE.replace('Rechnung Nr.', 'Proformarechnung\nRechnung Nr.') } }];
  assert.equal(twin(`${INVOICE}\nDefinitiv`, proforma), undefined, 'the invoice after its proforma');
  assert.equal(twin(`Vendor AG\nZweite Mahnung\n${INVOICE.split('\n').slice(1).join('\n')}`), undefined, 'a reminder');
  const refund = (word: string) => `Vendor AG\n${word}\nInvoice number: R-2026-0815\nDatum: 01.10.2026\nTotal CHF 54.00`;
  assert.ok(twin(refund('Kopie')), 'the same lines without a refund\'s word are a copy: the words decide');
  for (const word of ['Refund', 'Rückerstattung', 'Erstattung', 'Rückzahlung', 'Korrektur', 'Korrekturrechnung', 'Remboursement', 'Rimborso', 'Nota di accredito']) {
    assert.equal(twin(refund(word)), undefined, `a refund, written positive: ${word}`);
  }
  const bare = (t: string) => t.replace('Rechnung Nr. R-2026-0815', 'Rechnung R-2026-0815');
  assert.equal(twin(bare(INVOICE), [{ ...BOOKS[0], receipt: { ...BOOKS[0].receipt, extractedText: bare(INVOICE) } }]), undefined, 'the bare «Rechnung» also names the invoice a document refers to');
});

test('the reason beside a file reads back; deletion counts from the recorded time, never a future one, never a person\'s, a drop\'s or a kept one', () => {
  const reasons = [
    { kind: 'not-receipt', why: 'newsletter', from: 'news@vendor.example', source: 'office', at: '2026-10-01T08:00:00.000Z' },
    { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'a@tool.example', source: 'office', at: '2026-10-01T08:00:00.000Z' },
    { kind: 'duplicate', of: 'abcdef0123456789', ofFile: 'Rechnung 7 Kopie.pdf', from: 'billing@vendor.example', source: 'office', at: '2026-10-01T08:00:00.000Z' },
    { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'a@tool.example', source: 'office', at: '2026-10-01T08:00:00.000Z', kept: true },
    { kind: 'not-receipt', why: 'tracking' },
    { kind: 'held' },
    { kind: 'unreadable' },
  ] as const;
  for (const r of reasons) assert.deepEqual(parseReason(formatReason(r)), r);
  assert.deepEqual(parseReason('not-receipt newsletter from news@vendor.example'), { kind: 'not-receipt', why: 'newsletter', from: 'news@vendor.example' }, 'a line written before reads as before');

  const data = mkdtempSync(join(tmpdir(), 'aside-sweep-'));
  const now = new Date('2026-11-14T12:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const put = (name: string, reason: Parameters<typeof putInQuarantine>[3]) => putInQuarantine(data, name, Buffer.from(name), reason);
  put('old-news.pdf', { kind: 'not-receipt', why: 'newsletter', source: 'office', at: ago(31) });
  put('old-group.pdf', { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'a@tool.example', source: 'office', at: ago(30) });
  put('young-news.pdf', { kind: 'not-receipt', why: 'newsletter', source: 'office', at: ago(29) });
  put('future.pdf', { kind: 'not-receipt', why: 'newsletter', source: 'office', at: new Date(now.getTime() + 5 * 86_400_000).toISOString() });
  put('no-time.pdf', { kind: 'not-receipt', why: 'newsletter', source: 'office' });
  put('kept.pdf', { kind: 'not-receipt', why: 'newsletter', source: 'office', at: ago(90) });
  put('dropped.pdf', { kind: 'not-receipt', why: 'tracking' });
  put('held.pdf', { kind: 'held' });
  const old = new Date(now.getTime() - 400 * 86_400_000);
  for (const f of ['young-news.pdf', 'no-time.pdf', 'dropped.pdf', 'held.pdf']) utimesSync(join(data, 'quarantine', f), old, old);
  keepQuarantined(data, ['kept.pdf']);
  assert.equal(quarantined(data).find((q) => q.file === 'young-news.pdf')?.deleteOn, '2026-11-15', 'the list says the day');
  assert.equal(quarantined(data).find((q) => q.file === 'kept.pdf')?.deleteOn, undefined, 'kept by a person');
  assert.deepEqual(sweepQuarantine(data, now).map((q) => q.file).sort(), ['old-group.pdf', 'old-news.pdf'], 'the time on disk does not count');
  assert.deepEqual(quarantined(data).map((q) => q.file).sort(), ['dropped.pdf', 'future.pdf', 'held.pdf', 'kept.pdf', 'no-time.pdf', 'young-news.pdf']);
  assert.deepEqual(lastSwept(data), { on: '2026-11-14', n: 2 }, 'the person is told');
  assert.deepEqual(readdirSync(join(data, 'quarantine')).filter((f) => f.startsWith('old')), [], 'their reasons went too');
});

test('«Aussortiert» groups by why: a group kept aside per sender and shape, duplicates, each word verdict', () => {
  const q = (file: string, reason: Parameters<typeof formatReason>[0]) => ({ file, reason, at: '2026-11-01T08:00:00Z' });
  const groups = asideGroups([
    q('a.pdf', { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'a@tool.example', source: 'office' }),
    q('b.pdf', { kind: 'not-receipt', why: 'newsletter', from: 'n@x.example' }),
    q('c.pdf', { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'a@tool.example', source: 'office' }),
    q('d.pdf', { kind: 'not-receipt', why: 'newsletter', from: 'm@y.example' }),
    q('e.pdf', { kind: 'duplicate', of: 'r1' }),
    q('f.pdf', { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'b@tool.example', source: 'office' }),
  ]);
  assert.deepEqual(groups.map((g) => g.files.map((f) => f.file)), [['a.pdf', 'c.pdf'], ['b.pdf', 'd.pdf'], ['e.pdf'], ['f.pdf']]);
});

// ---------------------------------------------------------------------------------------------
// At delivery
// ---------------------------------------------------------------------------------------------

type Mail = MailSummary & { files: Array<{ filename: string; contentType: string; content: Buffer }> };
const mailOf = (uid: number, from: string, filename: string, content: Buffer, subject = filename): Mail =>
  ({ uid, from, to: ['office@example.com'], subject, date: `2026-10-${String(uid).padStart(2, '0')}T08:00:00Z`, messageId: `<${uid}@mail>`, files: [{ filename, contentType: 'application/pdf', content }] });
const backendOf = (mails: Mail[]): PullRequest['mailBackend'] => async () => ({
  async list(_f, after, _s, limit) { return { validity: '7', messages: mails.filter((m) => !after || m.uid > after).slice(0, limit).map(({ files: _x, ...m }) => m) }; },
  async attachments(_f, uid) { return mails.find((m) => m.uid === uid)!.files; },
  async close() {},
} satisfies MailBackend);

const YAML = `label: Office
code: app:imap
settings:
  boxes: [{ label: Office, address: office@example.com }]
  aside:
    - { from: reports@tool.example, name: report.pdf, source: hand 2026-11-01 }
reach:
  mail: { host: imap.example.com, account: office@example.com, from: ["*"] }
feeds:
  attachments: { output: document, every: daily }
`;

function office(): Workspace {
  const ws = tempWorkspace('aside-pull-');
  mkdirSync(join(ws.paths.root, 'sources', 'office'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'sources', 'office', 'source.yaml'), YAML);
  const v = sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office');
  assert.ok(v && v.kind !== 'invalid');
  approveSource(ws, v.decl);
  return ws;
}
const req = (ws: Workspace, mails: Mail[], over: Partial<PullRequest> = {}): PullRequest =>
  ({ ws, appRoot: APP_ROOT, source: 'office', run: 'collect-1', mode: 'live', mailBackend: backendOf(mails), ...over });
const inbox = (ws: Workspace) => (existsSync(ws.paths.inbox) ? readdirSync(ws.paths.inbox).sort() : []);

test('at delivery: a file of a group kept aside goes to «Aussortiert»; one of its shape whose words name it a receipt and the sender\'s invoice come in; git keeps the shape, data/ the subject and name', async () => {
  const ws = office();
  const report = await textPdf(['Tool weekly report', 'Visits this week: 1204', 'Top page: /pricing']);
  const billed = await textPdf(['Tool GmbH', 'Rechnung Nr. T-78', 'Total CHF 20.00']);
  const invoice = await textPdf(['Tool GmbH', 'Rechnung Nr. T-77', 'Total CHF 20.00']);
  const r = await pull(req(ws, [
    mailOf(1, 'Reports@Tool.example', 'report.pdf', report, 'Your weekly report for Hans Muster'),
    mailOf(2, 'reports@tool.example', 'report.pdf', billed),
    mailOf(3, 'reports@tool.example', 'Rechnung T-77.pdf', invoice),
  ]));
  assert.deepEqual(r, { outcome: 'ok', feeds: [{ feed: 'attachments', documents: 2, duplicates: 0, quarantined: 1, complete: true }] });
  assert.deepEqual(inbox(ws), ['Rechnung T-77.pdf', 'report.pdf']);
  const [aside] = quarantined(ws.paths.data);
  assert.equal(aside.file, 'report.pdf');
  assert.deepEqual({ ...aside.reason, at: '…' }, { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'reports@tool.example', source: 'office', at: '…' });
  assert.ok(aside.deleteOn, 'deleted after 30 days unless kept');
  const docs = readLedger(ws, 'office').flatMap((l) => ('got' in l && l.got.kind === 'document' ? [l.got] : []));
  assert.deepEqual({ ...docs[0], sha256: '…' }, { kind: 'document', sha256: '…', from: 'reports@tool.example', quarantined: { file: 'report.pdf', why: 'group', group: 'report.pdf' }, shape: 'report.pdf', date: '2026-10-01T08:00:00Z', size: report.length, pages: 1, text: true });
  const ledgerText = readFileSync(join(ws.paths.root, 'collected', 'office.jsonl'), 'utf8');
  assert.doesNotMatch(ledgerText, /Hans Muster|weekly report|"subject"|"name"/, 'no subject and no own name in git');
  assert.match(readFileSync(detailsPath(ws, 'office'), 'utf8'), /Your weekly report for Hans Muster/, 'kept in data/, outside git');
  assert.ok(detailsPath(ws, 'office').startsWith(ws.paths.data));
});

test('at delivery: a re-sent invoice with other bytes is set aside as the duplicate of the receipt in the books; another invoice of the sender comes in', async () => {
  const ws = office();
  const first = await textPdf(INVOICE.split('\n'));
  await pull(req(ws, [mailOf(1, 'billing@vendor.example', 'Rechnung R-2026-0815.pdf', first)]));
  const id = createHash('sha256').update(first).digest('hex').slice(0, 16);
  writeIndex(ws, { receipts: [{ id, filename: '20261001-vendor-rechnung.pdf', originalFilename: 'Rechnung R-2026-0815.pdf', extractedText: INVOICE, extractionMethod: 'pdftotext', fileSize: first.length, indexedAt: '2026-10-01T09:00:00Z', location: 'archived', date: '2026-10-01', amount: 54, currency: 'CHF' }] });
  const again = await textPdf([...INVOICE.split('\n'), 'Kopie für Ihre Unterlagen']);
  const next = await textPdf(INVOICE.replace('R-2026-0815', 'R-2026-0901').replace('01.10.2026', '02.10.2026').split('\n'));
  const r = await pull(req(ws, [mailOf(1, 'billing@vendor.example', 'Rechnung R-2026-0815.pdf', first), mailOf(2, 'billing@vendor.example', 'Rechnung R-2026-0815 (1).pdf', again), mailOf(3, 'billing@vendor.example', 'Rechnung R-2026-0901.pdf', next)], { feeds: ['attachments'] }));
  assert.deepEqual(r.feeds.map((f) => [f.documents, f.quarantined]), [[1, 1]]);
  assert.deepEqual(inbox(ws), ['Rechnung R-2026-0815.pdf', 'Rechnung R-2026-0901.pdf']);
  assert.deepEqual({ ...quarantined(ws.paths.data)[0].reason, at: '…' }, { kind: 'duplicate', of: id, ofFile: '20261001-vendor-rechnung.pdf', from: 'billing@vendor.example', source: 'office', at: '…' });
});

test('a file deleted after 30 days is no longer held: the ledger says so, and the same file sent again is delivered anew, not taken for a duplicate', async () => {
  const ws = office();
  const news = await textPdf(['Vendor News', 'Ausgabe 7: neue Farben', 'Abmelden: vendor.example/abmelden']);
  const day = new Date('2026-10-01T08:00:00Z');
  await pull(req(ws, [mailOf(1, 'news@vendor.example', 'news.pdf', news)], { now: () => day }));
  assert.equal(quarantined(ws.paths.data).length, 1);
  const later = new Date(day.getTime() + 31 * 86_400_000);
  const r = await pull(req(ws, [mailOf(1, 'news@vendor.example', 'news.pdf', news), mailOf(2, 'news@vendor.example', 'news.pdf', news)], { now: () => later, feeds: ['attachments'] }));
  assert.deepEqual(r.feeds.map((f) => [f.duplicates, f.quarantined]), [[0, 1]], 'set aside again by its words, not a duplicate of bytes nobody holds');
  const deleted = readLedger(ws, 'office').filter((l) => 'deleted' in l);
  assert.equal(deleted.length, 1);
  assert.deepEqual(quarantined(ws.paths.data).map((q) => q.at.slice(0, 10)), [later.toISOString().slice(0, 10)], 'the old one gone, the new one there');
});

test('a settings change by the person\'s click keeps a switched-on mailbox switched on; one waiting stays waiting; a version the person did not see is refused', () => {
  const ws = office();
  const on = () => sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office');
  changeKeepingOn(ws, APP_ROOT, 'office', (expect) => { addAside(ws, 'office', { from: 'news@shop.example', name: 'flyer.pdf' }, new Date(), expect); });
  assert.equal(on()?.kind, 'ready');
  assert.throws(() => changeKeepingOn(ws, APP_ROOT, 'office', () => {}, 'stale'), SourceVersionChanged);
  const file = join(ws.paths.root, 'sources', 'office', 'source.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('label: Office', 'label: Büro'));
  changeKeepingOn(ws, APP_ROOT, 'office', (expect) => { switchAsideOff(ws, 'office', { from: 'news@shop.example', name: 'flyer.pdf' }, expect); });
  assert.equal(on()?.kind, 'pending', 'an edit nobody switched on is not switched on by the click');
});

test('over HTTP: Quellen offers the group, «Immer beiseite» keeps it; reading «Aussortiert» deletes nothing; «Doch behalten» writes the inbox first, all or none, switches the group off and keeps its other files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aside-api-'));
  const fixture = join(dir, 'index.json');
  writeFileSync(fixture, JSON.stringify({ receipts: [], transactions: [], mappings: [], bankStatements: [] }));
  const api = await startApi(relative(process.cwd(), fixture));
  try {
    mkdirSync(join(api.root, 'sources', 'office'), { recursive: true });
    const yamlFile = join(api.root, 'sources', 'office', 'source.yaml');
    writeFileSync(yamlFile, YAML.replace(/  aside:\n.*\n/, ''));
    mkdirSync(join(api.root, 'collected'), { recursive: true });
    const lines = [line('report.pdf', 'reports@tool.example', { aside: true }), line('report.pdf', 'reports@tool.example', { aside: true })];
    writeFileSync(join(api.root, 'collected', 'office.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    type Row = { verdict: { decl: { id: string; version: string } }; asideOffers?: Array<{ sender: string; shape: string; files: unknown[] }> };
    const row = async () => ((await api.send('GET', '/api/sources')).json.rows as unknown as Row[]).find((r) => r.verdict.decl?.id === 'office')!;
    const offered = await row();
    assert.deepEqual(offered.asideOffers?.map((o) => [o.sender, o.shape, o.files.length]), [['reports@tool.example', 'report.pdf', 2]]);
    assert.equal((await api.send('POST', '/api/sources/office/aside', { from: 'reports@tool.example', name: 'report.pdf', version: 'stale' })).status, 409);
    const kept = await api.send('POST', '/api/sources/office/aside', { from: 'reports@tool.example', name: 'report.pdf', version: offered.verdict.decl.version });
    assert.equal(kept.status, 200, String(kept.json.error));
    assert.match(readFileSync(yamlFile, 'utf8'), /aside:[\s\S]*from: reports@tool\.example[\s\S]*name: report\.pdf/);
    assert.equal((await row()).asideOffers, undefined, 'kept: no longer offered');

    const data = join(api.root, 'data');
    const longAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const group = { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'reports@tool.example', source: 'office', at: longAgo } as const;
    const files = [1, 2, 3].map((i) => putInQuarantine(data, 'report.pdf', Buffer.from(`%PDF-1.4\n% report ${i}\n%%EOF\n`), group));
    const listed = (await api.send('GET', '/api/quarantine')).json as unknown as Array<{ file: string; deleteOn?: string }>;
    assert.equal(listed.length, 3, 'past their day, but reading the list deletes nothing');

    const missing = await api.send('POST', '/api/quarantine/nothing.pdf/take');
    assert.deepEqual([missing.status, missing.json.code], [404, 'gone']);
    const partly = await api.send('POST', '/api/quarantine/take', { files: [files[0], 'nothing.pdf'] });
    assert.equal(partly.status, 404);
    assert.equal(quarantined(data).length, 3, 'all or none');

    const inboxDir = join(api.root, 'beleg-import');
    rmSync(inboxDir, { recursive: true, force: true });
    writeFileSync(inboxDir, 'not a folder');
    const blocked = await api.send('POST', '/api/quarantine/take', { files: files.slice(0, 2) });
    assert.notEqual(blocked.status, 200);
    assert.equal(quarantined(data).length, 3, 'the inbox could not take them: nothing left the quarantine');
    rmSync(inboxDir, { force: true });

    // The group cannot be switched off (its folder is not writable): the file is taken all the same, and the answer says the group is still on.
    const extra = putInQuarantine(data, 'report.pdf', Buffer.from('%PDF-1.4\n% report 4\n%%EOF\n'), group);
    chmodSync(join(api.root, 'sources', 'office'), 0o555);
    let stuck;
    try {
      stuck = await api.send('POST', `/api/quarantine/${encodeURIComponent(extra)}/take`);
    } finally {
      chmodSync(join(api.root, 'sources', 'office'), 0o755);
    }
    assert.equal(stuck.status, 200, String(stuck.json.error));
    assert.deepEqual(stuck.json.groupStillOn, { code: 'groupStillOn', groups: [{ source: 'office', from: 'reports@tool.example', shape: 'report.pdf' }] });
    assert.doesNotMatch(readFileSync(yamlFile, 'utf8'), /off: true/, 'still on, as the answer says');

    const took = await api.send('POST', `/api/quarantine/${encodeURIComponent(files[0])}/take`);
    assert.equal(took.status, 200, String(took.json.error));
    assert.equal(took.json.groupStillOn, undefined);
    assert.match(readFileSync(yamlFile, 'utf8'), /off: true/, 'the person said it is a receipt: the group is off');
    const rest = quarantined(data);
    assert.deepEqual(rest.map((q) => [q.file, q.deleteOn]).sort(), [[files[1], undefined], [files[2], undefined]], 'its other files are kept: never deleted by themselves');
    assert.equal((await row()).asideOffers, undefined, 'switched off, never offered again');
    assert.deepEqual((await api.send('GET', '/api/quarantine/.swept')).json, { swept: null });
  } finally {
    await api.stop();
  }
});
