/**
 * What a mailbox sets aside besides the words of a file (src/platform/sources/aside.ts): a group of a
 * sender's files by file-name shape, offered once two of them were set aside and none stands in the
 * books, and kept aside at delivery once the person switched it on; a duplicate by content of a
 * receipt in the books; the sender skip offered only for a sender none of whose files is in the
 * books; «Aussortiert» deleted after 30 days, never what a person brought or kept. Made-up mail only.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { approveSource, changeKeepingOn, sources } from '../src/platform/sources/index.js';
import { pull, type PullRequest } from '../src/platform/sources/host.js';
import { readLedger, type LedgerLine } from '../src/platform/sources/ledger.js';
import type { MailBackend, MailSummary } from '../src/platform/sources/mail-channel.js';
import { addAside, asideGroupOf, asideOffers, contentTwin, nameShape, switchAsideOff } from '../src/platform/sources/aside.js';
import { skipOffers } from '../src/platform/sources/skip.js';
import { parseSender } from '../src/platform/sources/reach.js';
import type { SenderPattern } from '../src/platform/sources/model.js';
import { formatReason, parseReason, putInQuarantine, quarantined, sweepQuarantine } from '../src/intake/quarantine.js';
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

const sender = (s: string): SenderPattern => { const p = parseSender(s); if (!p.ok) throw new Error(p.message); return p.value; };
const REACH = { from: [sender('*')], skip: [] as SenderPattern[] };
const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
let n = 0;
const line = (name: string, from: string, x: { aside?: boolean; day?: string; seed?: string } = {}): LedgerLine => {
  const s = sha(x.seed ?? `${name}-${n++}`);
  return {
    at: `${x.day ?? '2026-10-01'}T08:00:00Z`, run: 'r', feed: 'attachments', key: `${n}#${name}`,
    got: { kind: 'document', sha256: s, from, name, ...(x.aside ? { quarantined: { file: name, why: 'price-list' as const } } : { file: name }) },
  };
};
const receiptOf = (l: LedgerLine, x: Partial<Receipt> = {}): Receipt => {
  const got = (l as Extract<LedgerLine, { got: { kind: 'document' } }>).got;
  return { id: got.sha256.slice(0, 16), filename: `x-${got.name}`, originalFilename: got.name ?? '', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: l.at, location: 'archived', ...x };
};

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

test('a group is offered once two of its files were set aside and none is in the books, with every file and its day', () => {
  const lines = [
    line('report.pdf', 'Reports@Tool.example', { aside: true, day: '2026-09-01' }),
    line('report.pdf', 'reports@tool.example', { aside: true, day: '2026-10-01' }),
    line('report.pdf', 'reports@tool.example', { day: '2026-11-01' }),
  ];
  assert.deepEqual(asideOffers(lines, [], REACH, {}), [{
    sender: 'reports@tool.example', shape: 'report.pdf', inBooks: 0,
    files: [{ name: 'report.pdf', date: '2026-09-01', aside: true }, { name: 'report.pdf', date: '2026-10-01', aside: true }, { name: 'report.pdf', date: '2026-11-01', aside: false }],
  }]);
  assert.deepEqual(asideOffers(lines.slice(0, 1), [], REACH, {}), [], 'one file set aside is not yet a group');
});

test('a person\'s «kein Beleg» counts as set aside; the model\'s does not', () => {
  const lines = [line('IMG_1.pdf', 'me@phone.example'), line('IMG_2.pdf', 'me@phone.example')];
  const human = lines.map((l) => receiptOf(l, { kind: 'noise', kindBy: 'human' }));
  assert.equal(asideOffers(lines, human, REACH, {}).length, 1);
  const model = lines.map((l) => receiptOf(l, { kind: 'noise', kindBy: 'rule', kindRule: 'model:no-receipt' }));
  assert.deepEqual(asideOffers(lines, model, REACH, {}), []);
});

test('never offered: a group with one file in the books; a supplier\'s invoice after two brochures stays out of the brochures\' group', () => {
  const brochures = [line('Katalog 2025.pdf', 'sales@supplier.example', { aside: true }), line('Katalog 2026.pdf', 'sales@supplier.example', { aside: true })];
  const invoice = line('Rechnung 4711.pdf', 'sales@supplier.example');
  const lines = [...brochures, invoice];
  const books = [receiptOf(invoice)];
  assert.deepEqual(asideOffers(lines, books, REACH, {}).map((o) => o.shape), ['katalog_#.pdf'], 'the brochures, not the invoice');
  assert.equal(asideGroupOf({ aside: [{ from: 'sales@supplier.example', name: 'katalog_#.pdf' }] }, 'sales@supplier.example', 'Rechnung 4712.pdf'), undefined, 'the next invoice is delivered');
  assert.ok(asideGroupOf({ aside: [{ from: 'sales@supplier.example', name: 'katalog_#.pdf' }] }, 'Sales@Supplier.example', 'Katalog 2027.pdf'), 'the next brochure is set aside');

  const reports = [line('report.pdf', 'a@tool.example', { aside: true }), line('report.pdf', 'a@tool.example', { aside: true }), line('report.pdf', 'a@tool.example')];
  assert.deepEqual(asideOffers(reports, [receiptOf(reports[2])], REACH, {}), [], 'one of the group stands in the books');
  assert.equal(asideOffers(reports, [receiptOf(reports[2], { kind: 'noise', kindBy: 'human' })], REACH, {}).length, 1, 'set aside by a person, it does not stand in the books');
});

test('not offered again: a group in the settings, switched on or off; nor a sender the mailbox skips', () => {
  const lines = [line('report.pdf', 'a@tool.example', { aside: true }), line('report.pdf', 'a@tool.example', { aside: true })];
  assert.deepEqual(asideOffers(lines, [], REACH, { aside: [{ from: 'a@tool.example', name: 'report.pdf', off: true }] }), []);
  assert.deepEqual(asideOffers(lines, [], { from: [sender('*')], skip: [sender('a@tool.example')] }, {}), []);
  assert.equal(asideGroupOf({ aside: [{ from: 'a@tool.example', name: 'report.pdf', off: true }] }, 'a@tool.example', 'report.pdf'), undefined, 'a group switched off sets nothing aside');
});

test('the sender skip is offered only for a sender none of whose files stands in the books', () => {
  const news = [1, 2, 3].map((i) => line(`flyer-${i}.pdf`, 'sales@supplier.example', { aside: true }));
  const invoice = line('Rechnung 1.pdf', 'sales@supplier.example');
  const waiting = line('Rechnung 2.pdf', 'sales@supplier.example');
  assert.deepEqual(skipOffers([...news, invoice], [receiptOf(invoice)], REACH), [], 'one real invoice: never offered');
  assert.deepEqual(skipOffers([...news, invoice, waiting], [], REACH), [{ sender: 'sales@supplier.example', n: 3 }], 'nothing in the books: offered, whatever share the inbox still holds');
  assert.deepEqual(skipOffers(news.slice(0, 2), [], REACH), [], 'fewer than three set aside');
});

test('keeping a group writes it into settings.aside; «Ist ein Beleg» switches it off and it stays there', () => {
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
  assert.equal(switchAsideOff(ws, 'office', { from: 'reports@tool.example', name: 'report.pdf' }), true);
  assert.match(readFileSync(file, 'utf8'), /off: true/);
  assert.equal(switchAsideOff(ws, 'office', { from: 'reports@tool.example', name: 'report.pdf' }), false, 'off already');
  addAside(ws, 'office', { from: 'reports@tool.example', name: 'report.pdf' });
  assert.doesNotMatch(readFileSync(file, 'utf8'), /off: true/, 'kept again, it is on again, once');
  assert.equal((readFileSync(file, 'utf8').match(/name: report\.pdf/g) ?? []).length, 1);
});

const W = documents();
const INVOICE = 'Vendor AG\nRechnung Nr. R-2026-0815\nDatum: 01.10.2026\nTotal CHF 54.00\nMWST 8.1 % 4.05';

test('a duplicate by content: same sender, invoice number and amount, the day within a week; nothing where a fact is missing', () => {
  const books = [{ receipt: { id: 'r1', filename: '20261001-vendor.pdf', extractedText: INVOICE, amount: 54, currency: 'CHF', date: '2026-10-01' }, from: 'billing@vendor.example' }];
  assert.deepEqual(contentTwin(`${INVOICE}\nKopie`, 'Billing@Vendor.example', books, W), { id: 'r1', filename: '20261001-vendor.pdf' });
  assert.equal(contentTwin(INVOICE, 'other@vendor.example', books, W), undefined, 'another sender, no VAT number to tell');
  assert.equal(contentTwin(INVOICE.replace('R-2026-0815', 'R-2026-0816'), 'billing@vendor.example', books, W), undefined, 'another number');
  assert.equal(contentTwin(INVOICE.replace('54.00', '64.00'), 'billing@vendor.example', books, W), undefined, 'another amount');
  assert.equal(contentTwin(INVOICE.replace('01.10.2026', '01.12.2026'), 'billing@vendor.example', books, W), undefined, 'two months later: a new invoice');
  assert.equal(contentTwin(INVOICE.replace(/Rechnung Nr\. R-2026-0815\n/, ''), 'billing@vendor.example', books, W), undefined, 'no number: nothing decided');
  assert.equal(contentTwin(INVOICE, 'billing@vendor.example', [{ ...books[0], receipt: { ...books[0].receipt, kind: 'noise' as const } }], W), undefined, 'set aside itself: not in the books');
});

test('the reason beside a file reads back; what a mailbox set aside is deleted after 30 days, a drop\'s and a person\'s never', () => {
  const reasons = [
    { kind: 'not-receipt', why: 'newsletter', from: 'news@vendor.example', source: 'office' },
    { kind: 'not-receipt', why: 'group', shape: 'img_#.pdf', from: 'me@phone.example', source: 'office' },
    { kind: 'duplicate', of: 'abcdef0123456789', ofFile: 'Rechnung 7 Kopie.pdf', from: 'billing@vendor.example', source: 'office' },
    { kind: 'not-receipt', why: 'tracking' },
    { kind: 'held' },
    { kind: 'unreadable' },
  ] as const;
  for (const r of reasons) assert.deepEqual(parseReason(formatReason(r)), r);
  assert.deepEqual(parseReason('not-receipt newsletter from news@vendor.example'), { kind: 'not-receipt', why: 'newsletter', from: 'news@vendor.example' }, 'a line written before reads as before');

  const data = mkdtempSync(join(tmpdir(), 'aside-sweep-'));
  const now = new Date('2026-11-14T12:00:00Z');
  const put = (name: string, reason: Parameters<typeof putInQuarantine>[3], daysAgo: number) => {
    const f = putInQuarantine(data, name, Buffer.from(name), reason);
    const t = new Date(now.getTime() - daysAgo * 86_400_000);
    utimesSync(join(data, 'quarantine', f), t, t);
  };
  put('old-news.pdf', reasons[0], 31);
  put('old-group.pdf', reasons[1], 30);
  put('young-news.pdf', reasons[0], 29);
  put('dropped.pdf', reasons[3], 90);
  put('held.pdf', reasons[4], 90);
  assert.equal(quarantined(data).find((q) => q.file === 'young-news.pdf')?.deleteOn, '2026-11-15', 'the list says the day');
  assert.equal(quarantined(data).find((q) => q.file === 'dropped.pdf')?.deleteOn, undefined);
  assert.deepEqual(sweepQuarantine(data, now).sort(), ['old-group.pdf', 'old-news.pdf']);
  assert.deepEqual(quarantined(data).map((q) => q.file).sort(), ['dropped.pdf', 'held.pdf', 'young-news.pdf']);
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

test('at delivery: a file of a group kept aside goes to «Aussortiert» with the group as its reason; the sender\'s invoice comes in; the ledger logs what learning needs', async () => {
  const ws = office();
  const report = await textPdf(['Tool weekly report', 'Visits this week: 1204', 'Top page: /pricing']);
  const invoice = await textPdf(['Tool GmbH', 'Rechnung Nr. T-77', 'Total CHF 20.00']);
  const r = await pull(req(ws, [mailOf(1, 'Reports@Tool.example', 'report.pdf', report, 'Your weekly report'), mailOf(2, 'reports@tool.example', 'Rechnung T-77.pdf', invoice)]));
  assert.deepEqual(r, { outcome: 'ok', feeds: [{ feed: 'attachments', documents: 1, duplicates: 0, quarantined: 1, complete: true }] });
  assert.deepEqual(inbox(ws), ['Rechnung T-77.pdf']);
  const [aside] = quarantined(ws.paths.data);
  assert.deepEqual([aside.file, aside.reason], ['report.pdf', { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'reports@tool.example', source: 'office' }]);
  assert.ok(aside.deleteOn, 'deleted after 30 days unless kept');
  const docs = readLedger(ws, 'office').flatMap((l) => ('got' in l && l.got.kind === 'document' ? [l.got] : []));
  assert.deepEqual(docs.map((g) => ({ ...g, sha256: '…' })), [
    { kind: 'document', sha256: '…', from: 'reports@tool.example', quarantined: { file: 'report.pdf', why: 'group', group: 'report.pdf' }, name: 'report.pdf', subject: 'Your weekly report', date: '2026-10-01T08:00:00Z', size: report.length, pages: 1, text: true },
    { kind: 'document', sha256: '…', file: 'Rechnung T-77.pdf', from: 'reports@tool.example', name: 'Rechnung T-77.pdf', subject: 'Rechnung T-77.pdf', date: '2026-10-02T08:00:00Z', size: invoice.length, pages: 1, text: true },
  ]);
});

test('at delivery: a re-sent invoice with other bytes is set aside as the duplicate of the receipt in the books; another invoice of the sender comes in', async () => {
  const ws = office();
  const first = await textPdf(INVOICE.split('\n'));
  await pull(req(ws, [mailOf(1, 'billing@vendor.example', 'Rechnung R-2026-0815.pdf', first)]));
  writeIndex(ws, { receipts: [{ id: createHash('sha256').update(first).digest('hex').slice(0, 16),filename: '20261001-vendor-rechnung.pdf', originalFilename: 'Rechnung R-2026-0815.pdf', extractedText: INVOICE, extractionMethod: 'pdftotext', fileSize: first.length, indexedAt: '2026-10-01T09:00:00Z', location: 'archived', date: '2026-10-01', amount: 54, currency: 'CHF' }] });
  const again = await textPdf([...INVOICE.split('\n'), 'Kopie für Ihre Unterlagen']);
  const next = await textPdf(INVOICE.replace('R-2026-0815', 'R-2026-0901').replace('01.10.2026', '02.10.2026').split('\n'));
  const r = await pull(req(ws, [mailOf(1, 'billing@vendor.example', 'Rechnung R-2026-0815.pdf', first), mailOf(2, 'billing@vendor.example', 'Rechnung R-2026-0815 (1).pdf', again), mailOf(3, 'billing@vendor.example', 'Rechnung R-2026-0901.pdf', next)], { feeds: ['attachments'] }));
  assert.deepEqual(r.feeds.map((f) => [f.documents, f.quarantined]), [[1, 1]]);
  assert.deepEqual(inbox(ws), ['Rechnung R-2026-0815.pdf', 'Rechnung R-2026-0901.pdf']);
  const dup = quarantined(ws.paths.data)[0];
  assert.deepEqual(dup.reason, { kind: 'duplicate', of: createHash('sha256').update(first).digest('hex').slice(0, 16), ofFile: '20261001-vendor-rechnung.pdf', from: 'billing@vendor.example', source: 'office' });
});

test('a settings change by the person\'s click keeps a switched-on mailbox switched on; one waiting to be switched on stays waiting', () => {
  const ws = office();
  changeKeepingOn(ws, APP_ROOT, 'office', () => { addAside(ws, 'office', { from: 'me@phone.example', name: 'img_#.pdf' }); });
  assert.equal(sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office')?.kind, 'ready');
  writeFileSync(join(ws.paths.root, 'sources', 'office', 'source.yaml'), readFileSync(join(ws.paths.root, 'sources', 'office', 'source.yaml'), 'utf8').replace('label: Office', 'label: Büro'));
  changeKeepingOn(ws, APP_ROOT, 'office', () => { switchAsideOff(ws, 'office', { from: 'me@phone.example', name: 'img_#.pdf' }); });
  assert.equal(sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office')?.kind, 'pending', 'an edit nobody switched on is not switched on by the click');
});

test('over HTTP: Quellen offers the group, «Immer beiseite» keeps it; «Doch behalten» of a file of it takes it back and switches the group off', async () => {
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
    const files = [1, 2].map((i) => putInQuarantine(data, 'report.pdf', Buffer.from(`%PDF-1.4\n% report ${i}\n%%EOF\n`), { kind: 'not-receipt', why: 'group', shape: 'report.pdf', from: 'reports@tool.example', source: 'office' }));
    const listed = (await api.send('GET', '/api/quarantine')).json as unknown as Array<{ file: string; deleteOn?: string }>;
    assert.ok(listed.every((q) => q.deleteOn), 'each says the day it goes');
    const took = await api.send('POST', '/api/quarantine/take', { files });
    assert.equal(took.status, 200, String(took.json.error));
    assert.match(readFileSync(yamlFile, 'utf8'), /off: true/, 'the person said it is a receipt: the group is off');
    assert.deepEqual(quarantined(data), []);
    assert.equal((await row()).asideOffers, undefined, 'switched off, never offered again');
  } finally {
    await api.stop();
  }
});
