/**
 * Golden rule 1 (AGENTS.md) at the API: nothing dated on or before config.closedThrough may
 * change. Runs the real API server against a temp copy of tests/fixtures/period-lock-index.json
 * (closedThrough 2026-06-30, one closed and one open transaction, entry, receipt and mapping).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Index } from '../src/types/index.js';
import { issue } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type InvoiceBook } from '../src/invoices/model.js';
import { loadBooks, type Books } from '../src/books/store.js';
import { findFile, workspaceAt } from '../src/workspace/workspace.js';
import { booksOnDisk } from './support/workspace.js';
import { closedPart } from '../src/books/seal.js';
import type { RunDetail } from '../src/workflows/model.js';
import { startApi, type ApiServer } from './support/api-server.js';

const REPO = process.cwd();
let api: ApiServer;

/** An issued invoice of CHF 108.10, which the open payment OI and the closed one CI could pay. */
function withInvoice(root: string): void {
  const pdf = Buffer.from('%PDF-1.4 Rechnung 2026-001');
  const customer = { name: 'Beispiel Bistro AG', address: { postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };
  const draft = { id: 'in_p', createdAt: '2026-06-01T08:00:00Z', origin: 'manual' as const, deleted: false, status: 'draft' as const, kind: 'invoice' as const,
    customerId: 'cu_p', date: '2026-06-01', currency: 'CHF' as const, language: 'de' as const, comments: [], lines: [{ text: 'Leistung', quantity: 1, price: 100, vatRate: 8.1 as const }] };
  const sender = { name: 'Muster', uid: 'CHE-123.456.789', address: { street: 'Weg', postcode: '8000', town: 'Zürich', country: 'CH' }, payTo: { account: '1021', iban: 'CH6580808000000000001' } };
  const issued = issue(draft, { customer: { id: 'cu_p', createdAt: '', origin: 'manual', deleted: false, ...customer }, sender, layout: DEFAULT_LAYOUT, invoices: [], now: '2026-06-01T09:00:00Z' });
  const book: InvoiceBook = { schema: 1, customers: [], invoices: [{ ...issued, pdf: { file: 'transactional-data/2026/invoices/2026-001.pdf', sha256: createHash('sha256').update(pdf).digest('hex') } }], sent: [] };
  mkdirSync(join(root, 'transactional-data/2026/invoices'), { recursive: true });
  writeFileSync(join(root, 'transactional-data/2026/invoices/2026-001.pdf'), pdf);
  writeFileSync(join(root, 'invoices.json'), JSON.stringify(book));
}

before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  withInvoice(api.root);
  // A receipt deleted while its payment C1 was open, put back after the quarter was filed.
  mkdirSync(join(api.root, 'data/trash/rx'), { recursive: true });
  writeFileSync(join(api.root, 'data/trash/rx/trashed.json'), JSON.stringify({ deletedAt: new Date().toISOString(), receipt: { id: 'rx', filename: 'late.pdf', originalFilename: 'late.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-06-01T08:00:00Z', location: 'archived' }, mappings: [{ receiptId: 'rx', transactionRef: 'C1' }], file: 'transactional-data/2026/receipts/late.pdf' }));
});
after(() => api?.stop());

type Call = { method: string; path: string; body?: unknown };

async function send({ method, path, body }: Call): Promise<{ status: number; error?: string; json: Record<string, unknown> }> {
  const { status, json } = await api.send(method, path, body);
  return { status, error: json.error as string | undefined, json };
}

const refused: Array<Call & { status: number }> = [
  { method: 'PATCH', path: '/api/transactions/C1', body: { description: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/transactions/C1', body: { remarks: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/transactions/C1', body: { noReceiptNeeded: true }, status: 403 },
  { method: 'DELETE', path: '/api/transactions/M2026-001', status: 403 },
  { method: 'DELETE', path: '/api/transactions/C1', status: 400 },
  { method: 'DELETE', path: '/api/transactions/O1', status: 400 },
  { method: 'POST', path: '/api/transactions/manual', body: { date: '2026-06-20', description: 'rückdatiert', amount: 1, currency: 'CHF' }, status: 403 },
  { method: 'DELETE', path: '/api/receipts/rc', status: 403 },
  { method: 'POST', path: '/api/receipts/rx/restore', status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { description: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { remarks: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { date: '2026-05-11' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { amount: 11, currency: 'CHF' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { filename: 'neu.pdf' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { kind: 'noise' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { date: null }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { vat: { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 0.81 }] } }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { amount: null }, status: 403 },
  { method: 'POST', path: '/api/vision/extract', body: { receiptId: 'rc' }, status: 403 },
  { method: 'POST', path: '/api/mapping/add', body: { receiptId: 'ro', transactionRef: 'C1' }, status: 403 },
  { method: 'POST', path: '/api/mapping/remove', body: { receiptId: 'rc', transactionRef: 'C1' }, status: 403 },
  { method: 'PATCH', path: '/api/journal-entries/jc', body: { description: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/journal-entries/jo', body: { date: '2026-06-15' }, status: 403 },
  { method: 'PATCH', path: '/api/journal-entries/jc', body: { amount: 5 }, status: 403 },
  { method: 'DELETE', path: '/api/journal-entries/jc', status: 403 },
  { method: 'POST', path: '/api/journal-entries', body: { date: '2026-06-30', accountDebit: '6800', accountCredit: '1020', amount: 10, description: 'rückdatiert' }, status: 403 },
  { method: 'POST', path: '/api/journal-entries', body: { date: '2026-08-01', accountDebit: '6800', accountCredit: '1020', amount: 10, description: 'zur geschlossenen Zahlung', transactionRef: 'C1' }, status: 403 },
  { method: 'POST', path: '/api/journal-entries/classify/C1', status: 403 },
  { method: 'PATCH', path: '/api/config', body: { closedThrough: '' }, status: 404 },
  { method: 'PUT', path: '/api/opening-balances/2026/1021', body: { amount: 5000 }, status: 403 },
  { method: 'POST', path: '/api/year-close/2026/entries', body: { date: '2026-06-30', accountDebit: '6800', accountCredit: '1520', amount: 100, description: 'rückdatiert' }, status: 403 },
  { method: 'POST', path: '/api/invoices/in_p/payments', body: { transactionRef: 'CI' }, status: 403 },
];

test('status: not in audit mode', async () => {
  assert.deepEqual((await api.send('GET', '/api/status')).json, { ok: true, readonly: false });
});

for (const call of refused) {
  test(`refused: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '')} -> ${call.status}, index unchanged`, async () => {
    const before = JSON.stringify(booksOnDisk(api.ws));
    const { status, error, json } = await send(call);
    assert.equal(status, call.status, error);
    if (status === 403) {
      assert.match(error ?? '', /^Periode geschlossen bis 2026-06-30\. /);
      assert.equal(json.code, 'periodClosed', 'the UI translates the refusal by its code');
      assert.equal((json.params as { closedThrough: string }).closedThrough, '2026-06-30');
    }
    if (status === 400) {
      assert.match(error ?? '', /Nur manuelle Transaktionen/);
      assert.equal(json.code, 'manualOnly');
    }
    assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
  });
}

const allowed: Array<Call & { check: (index: Index) => boolean }> = [
  { method: 'PATCH', path: '/api/transactions/O1', body: { description: 'neu' },
    check: (i) => i.transactions.find((t) => t.ref === 'O1')?.description === 'neu' },
  { method: 'PATCH', path: '/api/transactions/O1', body: { remarks: 'Notiz' },
    check: (i) => i.transactions.find((t) => t.ref === 'O1')?.remarks === 'Notiz' },
  { method: 'PATCH', path: '/api/transactions/O1', body: { noReceiptNeeded: true },
    check: (i) => i.transactions.find((t) => t.ref === 'O1')?.noReceiptNeeded === true },
  { method: 'POST', path: '/api/transactions/manual', body: { date: '2026-08-01', description: 'offen', amount: 1, currency: 'CHF' },
    check: (i) => i.transactions.some((t) => t.ref === 'M2026-003' && t.date === '2026-08-01') },
  { method: 'PATCH', path: '/api/receipts/ro', body: { remarks: 'Notiz' },
    check: (i) => i.receipts.find((r) => r.id === 'ro')?.remarks === 'Notiz' },
  { method: 'PATCH', path: '/api/receipts/ro', body: { kind: 'noise' },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'ro'); return r?.kind === 'noise' && r.kindBy === 'human'; } },
  { method: 'PATCH', path: '/api/receipts/ro', body: { kind: null },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'ro'); return !!r && !('kind' in r) && !('kindBy' in r); } },
  { method: 'PATCH', path: '/api/receipts/rm', body: { date: '2026-08-16', amount: 5, currency: 'EUR' },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'rm'); return r?.date === '2026-08-16' && r.amount === 5 && r.currency === 'EUR'; } },
  { method: 'PATCH', path: '/api/receipts/rm', body: { date: null, amount: null },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'rm'); return !!r && !('date' in r) && !('amount' in r); } },
  { method: 'PATCH', path: '/api/journal-entries/jo', body: { amount: 12.5 },
    check: (i) => i.journalEntries!.find((j) => j.id === 'jo')?.amount === 12.5 },
  { method: 'PATCH', path: '/api/journal-entries/jo', body: { date: '2026-08-20' },
    check: (i) => {
      const jo = i.journalEntries!.find((j) => j.id === 'jo');
      return jo?.date === '2026-08-20' && jo.origin === 'manual';
    } },
  { method: 'POST', path: '/api/mapping/remove', body: { receiptId: 'ro', transactionRef: 'O1' },
    check: (i) => !i.mappings.some((m) => m.receiptId === 'ro') },
  { method: 'POST', path: '/api/mapping/add', body: { receiptId: 'ro', transactionRef: 'O1' },
    check: (i) => i.mappings.some((m) => m.receiptId === 'ro' && m.transactionRef === 'O1') },
  { method: 'DELETE', path: '/api/receipts/ro',
    check: (i) => !i.receipts.some((r) => r.id === 'ro') && !i.mappings.some((m) => m.receiptId === 'ro') },
  { method: 'POST', path: '/api/receipts/ro/restore',
    check: (i) => i.receipts.some((r) => r.id === 'ro') && i.mappings.some((m) => m.receiptId === 'ro' && m.transactionRef === 'O1') },
  { method: 'DELETE', path: '/api/transactions/M2026-002',
    check: (i) => !i.transactions.some((t) => t.ref === 'M2026-002') && !i.mappings.some((m) => m.transactionRef === 'M2026-002') },
  { method: 'DELETE', path: '/api/journal-entries/jo',
    check: (i) => !i.journalEntries!.some((j) => j.id === 'jo') },
  { method: 'POST', path: '/api/year-close/2026/entries', body: { date: '2026-08-31', accountDebit: '6800', accountCredit: '1520', amount: 100, description: 'Abschreibung' },
    check: (i) => i.journalEntries!.some((j) => j.transactionRef === 'M2026-004' && j.date === '2026-08-31' && j.origin === 'manual') },
  { method: 'POST', path: '/api/invoices/in_p/payments', body: { transactionRef: 'OI' },
    check: (i) => i.journalEntries!.some((j) => j.transactionRef === 'OI' && j.vatCode === 'V81' && j.origin === 'invoice') && i.mappings.some((m) => m.transactionRef === 'OI' && m.rule === 'invoice-reference') },
  { method: 'POST', path: '/api/journal-entries', body: { date: '2026-08-31', accountDebit: '6800', accountCredit: '1020', amount: 10, vatCode: 'I81', description: 'von Hand' },
    check: (i) => i.journalEntries!.some((j) => j.transactionRef === 'M2026-005' && j.vatCode === 'I81' && j.origin === 'manual') },
  { method: 'POST', path: '/api/journal-entries', body: { id: 'jr', transactionRef: 'O1', date: '2026-08-02', accountDebit: '6800', accountCredit: '1020', amount: 10, description: 'Korrektur', exchangeCurrency: 'EUR', exchangeRate: 0.93, corrects: '2026-Q2', origin: 'classify' },
    check: (i) => { const j = i.journalEntries!.find((x) => x.id === 'jr'); return j?.transactionRef === 'O1' && j.corrects === '2026-Q2' && j.exchangeRate === 0.93 && j.origin === 'classify'; } },
  { method: 'POST', path: '/api/journal-entries', body: { id: 'jn', transactionRef: 'O1', date: '2026-08-02', accountDebit: '6800', accountCredit: '1020', amount: 5, description: 'ohne Herkunft' },
    check: (i) => { const j = i.journalEntries!.find((x) => x.id === 'jn'); return !!j && !('origin' in j); } },
  // The manifest and the chart hold no dated record: no period is closed to them.
  { method: 'PATCH', path: '/api/workspace', body: { company: { business: 'Kaffeerösterei' } },
    check: () => readFileSync(join(api.root, 'belege.workspace.yaml'), 'utf8').includes('business: Kaffeerösterei') },
  { method: 'PATCH', path: '/api/workspace', body: { invoicing: { layout: { accent: '#0f766e' }, texts: { de: { intro: 'Hallo' } } } },
    check: () => readFileSync(join(api.root, 'belege.workspace.yaml'), 'utf8').includes('accent: "#0f766e"') },
  { method: 'PUT', path: '/api/accounts/1100', body: { name: 'Debitoren' },
    check: () => readFileSync(api.ws.paths.accounts, 'utf8').includes('"Debitoren"') },
];

for (const call of allowed) {
  test(`open period: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '')} succeeds`, async () => {
    const { status, error } = await send(call);
    assert.equal(status, 200, error);
    assert.ok(call.check(loadBooks(workspaceAt(api.ws.paths.root))), 'the change is in the index');
  });
}

test('refused: DELETE of a manual payment that is booked -> 409 hasEntries, index unchanged', async () => {
  const made = await send({ method: 'POST', path: '/api/transactions/manual', body: { date: '2026-08-03', description: 'privat', amount: 7, currency: 'CHF' } });
  const ref = made.json.ref as string;
  const booked = await send({ method: 'POST', path: '/api/journal-entries', body: { transactionRef: ref, date: '2026-08-03', accountDebit: '6800', accountCredit: '2100', amount: 7, description: 'privat' } });
  assert.equal(booked.status, 200, booked.error);
  const before = JSON.stringify(booksOnDisk(api.ws));
  const { status, json } = await send({ method: 'DELETE', path: `/api/transactions/${ref}` });
  assert.equal(status, 409);
  assert.equal(json.code, 'hasEntries');
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
});

/** A camt.053 of the demo's Raiffeisen account with one payment on `date` and the bank's closing balance that day. */
const camt = (id: string, date: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${date}T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">4321.10</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>
<Ntry><Amt Ccy="CHF">12.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>${date}</Dt></BookgDt><AcctSvcrRef>REF-${id}</AcctSvcrRef><AddtlNtryInf>Upload ${id}</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const upload = (name: string, body: string) => fetch(`http://127.0.0.1:${api.port}/api/statements?name=${encodeURIComponent(name)}`, { method: 'POST', body })
  .then(async (r) => ({ status: r.status, json: await r.json() as Record<string, unknown> }));

test('refused: POST /api/statements with a statement wholly inside the filed quarter -> 403, index unchanged, no file kept', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const { status, json } = await upload('mai.xml', camt('S-MAI', '2026-05-20'));
  assert.equal(status, 403, json.error as string);
  assert.equal(json.code, 'periodClosed');
  assert.equal((json.params as { reason: string }).reason, 'newStatement');
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
  assert.equal(!!findFile(api.ws.paths, 'statements', 'Raiffeisen/mai.xml'), false);
});

test('open period: POST /api/statements reads the statement in, keeps every payment it does not hold', async () => {
  const { status, json } = await upload('august.xml', camt('S-AUG', '2026-08-25'));
  assert.equal(status, 200, json.error as string);
  assert.deepEqual(json, {
    file: 'Raiffeisen/august.xml', account: '1021', month: '2026-08', added: 1,
    bank: 'Raiffeisen', currency: 'CHF', from: '2026-08-25', to: '2026-08-25', closing: { date: '2026-08-25', amount: 4321.1 },
  });
  const now: Index = loadBooks(workspaceAt(api.ws.paths.root));
  assert.ok(now.transactions.some((t) => t.ref === 'REF-S-AUG' && t.date === '2026-08-25' && t.amount === 12));
  assert.ok(['C1', 'O1', 'CI', 'OI'].every((ref) => now.transactions.some((t) => t.ref === ref)), 'payments of no file stay');
  const again = await upload('august-2.xml', camt('S-AUG', '2026-08-25'));
  assert.equal(again.status, 409, 'the same statement under another name is read once');
  assert.equal((again.json.params as { reason: string }).reason, 'duplicate');
  assert.equal(!!findFile(api.ws.paths, 'statements', 'Raiffeisen/august-2.xml'), false);
});

test('the closed period is still exactly as in the fixture', () => {
  const fixture: Index = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/period-lock-index.json'), 'utf8'));
  const now: Index = loadBooks(workspaceAt(api.ws.paths.root));
  const closed = (i: Index) => ({
    transactions: i.transactions.filter((t) => t.date <= '2026-06-30').sort((a, b) => a.ref.localeCompare(b.ref)),
    entries: i.journalEntries!.filter((j) => j.date <= '2026-06-30').sort((a, b) => a.id.localeCompare(b.id)),
    receipt: i.receipts.find((r) => r.id === 'rc'),
    mappings: i.mappings.filter((m) => m.transactionRef === 'C1'),
    config: i.config,
  });
  assert.deepEqual(closed(now), closed(fixture));
});

test('open period: POST /api/workspace/logo succeeds: a logo is no dated record, the books stay as they were', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const res = await fetch(`http://127.0.0.1:${api.port}/api/workspace/logo`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([137, 80, 78, 71]) });
  assert.equal(res.status, 200);
  assert.match(readFileSync(join(api.root, 'belege.workspace.yaml'), 'utf8'), /logo: logos\/logo-[0-9a-f]{12}\.png/);
  assert.equal(JSON.stringify(booksOnDisk(api.ws)), before);
});

test('open period: a run of the inbox processing keeps the filed quarter\'s entries, payments and links', async () => {
  const fixture = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/period-lock-index.json'), 'utf8')) as Books;
  const { status, json } = await send({ method: 'POST', path: '/api/automation', body: { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } } });
  assert.equal(status, 200);
  const id = (json as { run: string }).run;
  let run: RunDetail | undefined;
  for (let i = 0; i < 500; i++) {
    run = (await api.send('GET', `/api/automation/runs/${id}`)).json as unknown as RunDetail;
    if (run.status !== 'queued' && run.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(run?.status, 'done', run?.error);
  const now = loadBooks(workspaceAt(api.ws.paths.root)) as Books;
  assert.deepEqual(closedPart(now, '2026-06-30'), closedPart(fixture, '2026-06-30'));
});
