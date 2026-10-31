/**
 * Issue #186, part 2: a person's «kein Beleg» on a file a mailbox brought offers to skip its sender
 * («Immer so?»), with what the mailbox brought from it and which of those the books hold as
 * receipts. Kept, the sender goes into that mailbox's settings in the workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { addSkip, receiptSkipOffer } from '../src/platform/sources/skip.js';
import { startApi } from './support/api-server.js';
import { parseSender } from '../src/platform/sources/reach.js';
import type { LedgerLine } from '../src/platform/sources/ledger.js';
import type { SenderPattern, SourceDecl } from '../src/platform/sources/model.js';
import type { Receipt } from '../src/types/index.js';

const sender = (s: string): SenderPattern => { const p = parseSender(s); if (!p.ok) throw new Error(p.message); return p.value; };
const decl = (skip: string[] = [], origin: SourceDecl['origin'] = 'company'): Pick<SourceDecl, 'id' | 'label' | 'origin' | 'version' | 'reach'> => ({
  id: 'office', label: { en: 'Office' }, origin, version: 'v1',
  reach: { mail: { host: 'imap.example.com', account: 'office@example.com', folders: ['INBOX'], from: [sender('*')], skip: skip.map(sender) } },
});
const got = (sha: string, file: string, from: string): LedgerLine => ({ at: '2026-10-20T08:00:00Z', run: 'r', feed: 'attachments', key: file, got: { kind: 'document', sha256: `${sha}${'0'.repeat(48)}`, file, from } });
const receipt = (id: string, x: Partial<Receipt> = {}): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-10-20T08:00:00Z', location: 'staged', ...x,
});

const LINES = [
  got('aaaaaaaaaaaaaaaa', 'brochure.pdf', 'Sales@Carrier.example'),
  got('bbbbbbbbbbbbbbbb', 'invoice-7.pdf', 'sales@carrier.example'),
  got('cccccccccccccccc', 'flyer.pdf', 'sales@carrier.example'),
  got('dddddddddddddddd', 'bill.pdf', 'billing@carrier.example'),
];
const BOOKS = [
  receipt('aaaaaaaaaaaaaaaa', { originalFilename: 'brochure.pdf', kind: 'noise', kindBy: 'human' }),
  receipt('bbbbbbbbbbbbbbbb', { originalFilename: 'invoice-7.pdf', filename: '20261001-invoice-7.pdf', date: '2026-10-01' }),
  receipt('cccccccccccccccc', { originalFilename: 'flyer.pdf', kind: 'noise', kindBy: 'rule', kindRule: 'model:no-receipt' }),
  receipt('dddddddddddddddd', { originalFilename: 'bill.pdf' }),
];

test('a person\'s «kein Beleg» offers its sender, with what the mailbox brought from it and the receipts among them', () => {
  const offer = receiptSkipOffer(BOOKS[0], [{ decl: decl(), lines: LINES }], BOOKS);
  assert.deepEqual(offer, {
    source: 'office', label: { en: 'Office' }, version: 'v1', sender: 'sales@carrier.example', delivered: 3,
    receipts: [{ id: 'bbbbbbbbbbbbbbbb', filename: '20261001-invoice-7.pdf', date: '2026-10-01' }],
  }, 'the sender\'s other files that are no receipt are not counted as receipts; another address of the same domain is not the sender');
});

test('nothing is offered for a kind the person did not give, a file no mailbox brought, a sender skipped already, or the app\'s own mailbox', () => {
  assert.equal(receiptSkipOffer(BOOKS[2], [{ decl: decl(), lines: LINES }], BOOKS), undefined, 'the model set it aside, not a person');
  assert.equal(receiptSkipOffer(receipt('eeeeeeeeeeeeeeee', { kind: 'noise', kindBy: 'human' }), [{ decl: decl(), lines: LINES }], BOOKS), undefined, 'dropped by hand');
  assert.equal(receiptSkipOffer(BOOKS[0], [{ decl: decl(['sales@carrier.example']), lines: LINES }], BOOKS), undefined, 'skipped already');
  assert.equal(receiptSkipOffer(BOOKS[0], [{ decl: decl([], 'app'), lines: LINES }], BOOKS), undefined, 'only a company mailbox is changed');
});

test('a file renamed in the books is still found by the start of its SHA-256', () => {
  const renamed = { ...BOOKS[0], originalFilename: 'Broschuere.pdf' };
  assert.equal(receiptSkipOffer(renamed, [{ decl: decl(), lines: LINES }], BOOKS)?.sender, 'sales@carrier.example');
});

test('a file name two senders share never names the wrong sender: the bytes decide, a shared name alone offers nothing', () => {
  const lines = [
    got('1111111111111111', 'Rechnung.pdf', 'news@carrier.example'),
    got('2222222222222222', 'Rechnung.pdf', 'billing@supplier.example'),
    got('3333333333333333', 'Rechnung.pdf', 'news@carrier.example'),
  ];
  const brochure = receipt('1111111111111111', { originalFilename: 'Rechnung.pdf', kind: 'noise', kindBy: 'human' });
  const invoice = receipt('2222222222222222', { originalFilename: 'Rechnung.pdf' });
  const offer = receiptSkipOffer(brochure, [{ decl: decl(), lines }], [brochure, invoice]);
  assert.deepEqual([offer?.sender, offer?.delivered, offer?.receipts], ['news@carrier.example', 2, []], 'the supplier\'s invoice of the same name is not counted as the carrier\'s');
  const photo = receipt('9999999999999999', { originalFilename: 'Rechnung.pdf', kind: 'noise', kindBy: 'human' });
  assert.equal(receiptSkipOffer(photo, [{ decl: decl(), lines }], [photo, invoice]), undefined, 'no bytes match and two senders sent that name: no offer');
  const alone = [got('4444444444444444', 'Broschuere.pdf', 'news@carrier.example')];
  const scan = receipt('8888888888888888', { originalFilename: 'Broschuere.pdf', kind: 'noise', kindBy: 'human' });
  assert.equal(receiptSkipOffer(scan, [{ decl: decl(), lines: alone }], [])?.sender, 'news@carrier.example', 'a name one sender alone sent still counts');
});

test('keeping the skip writes the sender into the mailbox\'s reach, of an IMAP mailbox or the Mail app, comments and all', () => {
  const root = mkdtempSync(join(tmpdir(), 'skip-offer-'));
  const write = (id: string, text: string) => { mkdirSync(join(root, 'sources', id), { recursive: true }); writeFileSync(join(root, 'sources', id, 'source.yaml'), text); };
  write('office', 'label: Office\nreach:\n  mail:\n    host: imap.example.com\n    from: ["*"]  # everyone\n');
  write('mac', 'label: Mac\nreach:\n  mac-mail:\n    account: Work\n    from: ["*"]\n    skip: [news@shop.example]\n');
  const ws = { paths: { root } } as Parameters<typeof addSkip>[0];
  addSkip(ws, 'office', 'Sales@Carrier.example');
  addSkip(ws, 'mac', 'sales@carrier.example', 'mac-mail');
  const office = readFileSync(join(root, 'sources/office/source.yaml'), 'utf8');
  assert.match(office, /# everyone/);
  assert.match(office, /skip:\n\s+- sales@carrier\.example/);
  assert.match(readFileSync(join(root, 'sources/mac/source.yaml'), 'utf8'), /mac-mail:[\s\S]*skip: \[ news@shop\.example, sales@carrier\.example \]/);
});

test('over HTTP: «kein Beleg» on a collected file offers its sender; «Behalten» writes the skip, and the offer is gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skip-api-'));
  const fixture = join(dir, 'index.json');
  writeFileSync(fixture, JSON.stringify({ receipts: BOOKS.map((r, i) => (i === 0 ? receipt(r.id, { originalFilename: r.originalFilename }) : r)), transactions: [], mappings: [], bankStatements: [] }));
  const api = await startApi(relative(process.cwd(), fixture));
  try {
    mkdirSync(join(api.root, 'sources', 'office'), { recursive: true });
    writeFileSync(join(api.root, 'sources', 'office', 'source.yaml'), 'label: Office\ncode: app:imap\nsettings:\n  boxes: [{ label: Office, address: office@example.com }]\nreach:\n  mail: { host: imap.example.com, account: office@example.com, from: ["*"] }\nfeeds:\n  attachments: { output: document, every: daily }\n');
    mkdirSync(join(api.root, 'collected'), { recursive: true });
    writeFileSync(join(api.root, 'collected', 'office.jsonl'), LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const id = BOOKS[0].id;
    const offer = async () => (await api.send('GET', `/api/sources/skip-offer?receipt=${id}`)).json.offer as { sender: string; version: string; delivered: number } | null;
    assert.equal(await offer(), null, 'nothing while no person set it aside');
    assert.equal((await api.send('PATCH', `/api/receipts/${id}`, { kind: 'noise' })).status, 200);
    const o = await offer();
    assert.deepEqual([o?.sender, o?.delivered], ['sales@carrier.example', 3]);
    const kept = await api.send('POST', '/api/sources/office/skip', { sender: o!.sender, version: o!.version });
    assert.equal(kept.status, 200, String(kept.json.error));
    assert.match(readFileSync(join(api.root, 'sources', 'office', 'source.yaml'), 'utf8'), /skip:[\s\S]*sales@carrier\.example/);
    assert.equal(await offer(), null, 'the sender is skipped now');
  } finally {
    await api.stop();
  }
});
