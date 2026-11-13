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
import { loadBooks, PERSON, saveBooks, update, type Books } from '../src/books/store.js';
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
  mkdirSync(join(api.root, 'data/trash/rx/d1'), { recursive: true });
  // Two files that are no receipt (#228): one of the filed quarter, one of the open one, neither linked.
  const books = loadBooks(api.ws);
  const noise = (id: string, filename: string, date: string) => ({ id, filename, originalFilename: filename, extractedText: 'AGB', extractionMethod: 'pdftotext' as const, fileSize: 1, indexedAt: `${date}T00:00:00Z`, location: 'archived' as const, date, kind: 'noise' as const, kindBy: 'human' as const });
  update(books, PERSON, (b) => { b.receipts.push(noise('rf', 'agb-mai.pdf', '2026-05-12'), noise('rn', 'agb-august.pdf', '2026-08-12')); });
  // A statement PDF of the filed quarter whose question waits (#254).
  mkdirSync(join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen'), { recursive: true });
  writeFileSync(join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen', MAY_PDF), '%PDF-1.4 Mai');
  update(books, PERSON, (b) => {
    b.bankStatements.push({ bank: 'Raiffeisen', filename: MAY_PDF, fromDate: '2026-05-01', toDate: '2026-05-31', currency: 'CHF' });
    b.statementAsks = [{ file: `Raiffeisen/${MAY_PDF}`, account: '1021', date: '2026-05-31', since: '2026-06-01', read: { by: 'hand', statement: MAY, check: { ok: true, gaps: [] }, known: [] } }];
    // A reconciliation whose read movement C1 lies in the filed quarter, booked there (#254), and an open bank movement of its amount.
    b.transactions.push({ ref: 'O2', bank: 'Raiffeisen', date: '2026-07-01', amount: 10, currency: 'CHF', direction: 'DBIT', description: 'Bank Juli' });
    b.reconciliations = [{ account: '1021', from: '2026-05-10', to: '2026-07-01', since: '2026-07-02', covered: [], read: ['C1'], bank: ['O2'], pairs: [] }];
    // A VAT adjustment declared in the filed quarter.
    b.config.vatAdjustments = [{ id: 'adj-q2', period: '2026-Q2', ziffer: '405', amount: -1, reason: 'eingereicht', entryIds: ['jc'] }];
  });
  saveBooks(api.ws, books);
  writeFileSync(join(api.root, 'data/trash/rx/d1/trashed.json'), JSON.stringify({ deletedAt: new Date().toISOString(), receipt: { id: 'rx', filename: 'late.pdf', originalFilename: 'late.pdf', extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-06-01T08:00:00Z', location: 'archived' }, mappings: [{ receiptId: 'rx', transactionRef: 'C1' }], file: 'transactional-data/2026/receipts/late.pdf' }));
});
after(() => api?.stop());

/** Import VAT on the filed entry jc refunded in the open quarter. */
const ADJ = { period: '2026-Q3', ziffer: '400', amount: -0.81, reason: 'Einfuhrsteuer zurückerstattet', entryIds: ['jc'] };

const MAY_PDF = 'Kontoauszug 01.05.2026 - 31.05.2026.pdf';
const MAY = { currency: 'CHF', period: { from: '2026-05-01', to: '2026-05-31' }, opening: { date: '2026-05-01', amount: 10 }, closing: { date: '2026-05-31', amount: 10 }, movements: [] };
const MAY_READ = `/api/statements/Raiffeisen/${encodeURIComponent(MAY_PDF)}/read`;
const MAY_FACTS = `/api/statements/Raiffeisen/${encodeURIComponent(MAY_PDF)}/facts`;

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
  // «Löschen» of a file that is no receipt (#228): never one of a filed period, linked there or dated there.
  { method: 'POST', path: '/api/receipts/discard', body: { ids: ['rf'] }, status: 403 },
  { method: 'POST', path: '/api/receipts/discard', body: { ids: ['rn', 'rc'] }, status: 403 },
  { method: 'POST', path: '/api/receipts/rx/restore', status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { amount: 11, currency: 'CHF' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { filename: 'neu.pdf' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { vat: { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 0.81 }] } }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { amount: null }, status: 403 },
  { method: 'POST', path: '/api/receipts/rc/twin', body: { answer: 'same', of: 'ro' }, status: 403 },
  { method: 'POST', path: '/api/vision/extract', body: { receiptId: 'rc' }, status: 403 },
  { method: 'POST', path: '/api/mapping/add', body: { receiptId: 'ro', transactionRef: 'C1' }, status: 403 },
  { method: 'POST', path: '/api/mapping/remove', body: { receiptId: 'rc', transactionRef: 'C1' }, status: 403 },
  // «Zahlung suchen» on a receipt a filed payment holds (#187).
  { method: 'POST', path: '/api/receipts/rc/find-payment', status: 403 },
  { method: 'POST', path: '/api/receipts/rc/filed-payment', body: { payment: null }, status: 403 },
  // «Als Korrektur buchen» of a sales report's refund of a filed period (#231): never on a closed day.
  { method: 'POST', path: '/api/receipts/rc/report-correction', body: { order: '1001', date: '2026-05-04', on: '2026-06-30' }, status: 403 },
  // «Aufteilen» of an order a sales report holds (#405): never on a closed day.
  { method: 'POST', path: '/api/receipts/rr/held-order', body: { order: '1001', parts: [{ amount: 68, rate: 8.1 }, { amount: 33, rate: 2.6 }] }, status: 403 },
  { method: 'PATCH', path: '/api/journal-entries/jc', body: { description: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/journal-entries/jo', body: { date: '2026-06-15' }, status: 403 },
  { method: 'PATCH', path: '/api/journal-entries/jc', body: { amount: 5 }, status: 403 },
  { method: 'DELETE', path: '/api/journal-entries/jc', status: 403 },
  // «Nach Beleg buchen» on a receipt of several VAT groups (#406): never on a filed entry.
  { method: 'POST', path: '/api/journal-entries/jc/by-receipt', status: 403 },
  // Its undo takes only an id the click returned: lines sent in the body, of a filed quarter or any other, write nothing.
  { method: 'POST', path: '/api/journal-entries/by-receipt/undo', body: { before: [{ id: 'jc', transactionRef: 'C1', date: '2026-05-10', accountDebit: '6500', accountCredit: '1021', amount: 5, vatCode: 'I0' }], after: [{ id: 'jc', transactionRef: 'C1', date: '2026-05-10', accountDebit: '6500', accountCredit: '1021', amount: 10, vatCode: 'I81' }] }, status: 410 },
  { method: 'POST', path: '/api/journal-entries', body: { date: '2026-06-30', accountDebit: '6800', accountCredit: '1020', amount: 10, description: 'rückdatiert' }, status: 403 },
  { method: 'POST', path: '/api/journal-entries', body: { date: '2026-08-01', accountDebit: '6800', accountCredit: '1020', amount: 10, description: 'zur geschlossenen Zahlung', transactionRef: 'C1' }, status: 403 },
  { method: 'POST', path: '/api/journal-entries/classify/C1', status: 403 },
  { method: 'POST', path: '/api/transactions/C1/entries', body: { lines: [{ accountDebit: '6800', accountCredit: '1020', amount: 10, description: 'von Hand' }] }, status: 403 },
  // The hand form's booking that links her own invoice, and its sale question answered on the form (#382): never in a closed period.
  { method: 'POST', path: '/api/transactions/C1/entries', body: { lines: [{ accountDebit: '1020', accountCredit: '3400', amount: 10, description: 'von Hand' }], links: ['ro'] }, status: 403 },
  { method: 'POST', path: '/api/transactions/C1/sale', body: { by: 'Anna', choice: 'saleDomestic', lines: [{ accountDebit: '1020', accountCredit: '3400', amount: 10, description: 'von Hand' }], links: [] }, status: 403 },
  { method: 'POST', path: '/api/transactions/C1/attach', body: { ref: 'M2026-002' }, status: 403 },
  { method: 'PATCH', path: '/api/config', body: { closedThrough: '' }, status: 404 },
  { method: 'POST', path: '/api/year-close/2026/entries', body: { date: '2026-06-30', accountDebit: '6800', accountCredit: '1520', amount: 100, description: 'rückdatiert' }, status: 403 },
  { method: 'POST', path: '/api/year-close/2025/templates/receivables/rebook', body: { description: 'Debitoren 2025' }, status: 403 },
  { method: 'POST', path: '/api/year-close/2025/balances/1020?amount=100&name=saldo.pdf', body: { file: 'x' }, status: 403 },
  { method: 'DELETE', path: '/api/year-close/2025/balances/1020', status: 403 },
  { method: 'PUT', path: '/api/year-close/2025/cash/1000', body: { amount: 100 }, status: 403 },
  // «Auszug entfernen» of a filed month's statement: its balance stays as filed. Its undo only puts back what a removal of the open period took.
  { method: 'DELETE', path: `/api/statements/Raiffeisen/${encodeURIComponent(MAY_PDF)}`, status: 403 },
  { method: 'POST', path: '/api/statements/restore', body: { undo: 'none' }, status: 410 },
  { method: 'POST', path: '/api/invoices/in_p/payments', body: { transactionRef: 'CI' }, status: 403 },
  // A filed statement PDF's question (#254): not read, corrected nor read in (closing it books nothing: see below); a filed movement's mark not taken away.
  { method: 'POST', path: MAY_READ, status: 403 },
  { method: 'PUT', path: MAY_READ, body: { statement: MAY }, status: 403 },
  { method: 'POST', path: `${MAY_READ}/import`, body: { statement: MAY }, status: 403 },
  // Its table by hand, and «Neu lesen» (#243): a filed month's balance and references never change.
  { method: 'PUT', path: MAY_FACTS, body: { statement: MAY }, status: 403 },
  { method: 'DELETE', path: MAY_FACTS, status: 403 },
  { method: 'DELETE', path: '/api/transactions/C1/filed-twin', status: 403 },
  { method: 'DELETE', path: '/api/invoices/in_p/payments/CI', status: 403 },
  // Several objects at once (#216): a batch of filed objects only is refused as their single changes are; its undo too.
  { method: 'POST', path: '/api/batch', body: { action: { kind: 'noReceiptNeeded' }, ids: ['C1'] }, status: 403 },
  { method: 'POST', path: '/api/batch', body: { action: { kind: 'vatCode', to: 'I0' }, ids: ['jc'] }, status: 403 },
  { method: 'POST', path: '/api/batch', body: { action: { kind: 'account', from: '6500', to: '6800' }, ids: ['jc'] }, status: 403 },
  { method: 'POST', path: '/api/batch', body: { action: { kind: 'notReceipt' }, ids: ['rc'] }, status: 403 },
  { method: 'POST', path: '/api/batch', body: { action: { kind: 'book', account: '6800', vat: '' }, ids: ['C1'] }, status: 403 },
  // Its undo is the server's own, named by its id: a batch's undo after its period was filed is refused in tests/batch.test.ts.
  // A VAT adjustment (Firma › MWST) is never declared in, changed in nor taken out of a filed period.
  { method: 'POST', path: '/api/vat-adjustments', body: { ...ADJ, period: '2026-Q2' }, status: 403 },
  { method: 'PUT', path: '/api/vat-adjustments/adj-q2', body: ADJ, status: 403 },
  { method: 'DELETE', path: '/api/vat-adjustments/adj-q2', status: 403 },
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
  // «Als Auszug behalten» on a filed statement PDF's question (#254): it books nothing, and nothing else could ever answer it.
  { method: 'DELETE', path: MAY_READ, check: (i) => !i.statementAsks?.length },
  // A reconciliation confirmed with a filed read movement (#254): it stays as filed; the open bank movement is marked as booked there.
  { method: 'POST', path: '/api/reconciliations/1021', body: { pairs: [{ read: 'C1', bank: 'O2' }], own: [] },
    check: (i) => i.transactions.find((t) => t.ref === 'O2')?.waitsForPerson?.why === 'filedTwin' && i.transactions.find((t) => t.ref === 'C1')?.description === 'Bank Mai' && !!i.reconciliations?.[0].done },
  // A batch over a filed and an open object (#216): the filed one is left out, the open one changes.
  { method: 'POST', path: '/api/batch', body: { action: { kind: 'noReceiptNeeded' }, ids: ['C1', 'O1'] },
    check: (i) => i.transactions.find((t) => t.ref === 'O1')?.noReceiptNeeded === true && !i.transactions.find((t) => t.ref === 'C1')?.noReceiptNeeded },
  { method: 'POST', path: '/api/vat-adjustments', body: ADJ,
    check: (i) => i.config?.vatAdjustments?.some((a) => a.id === '2026-Q3-1' && a.amount === -0.81 && a.entryIds[0] === 'jc') === true },
  { method: 'PUT', path: '/api/vat-adjustments/2026-Q3-1', body: { ...ADJ, amount: -0.5 },
    check: (i) => i.config?.vatAdjustments?.find((a) => a.id === '2026-Q3-1')?.amount === -0.5 },
  // An opening balance is in no VAT return and no seal: a filed quarter does not lock the year's opening (r5h-30).
  { method: 'PUT', path: '/api/opening-balances/2026/1021', body: { amount: 5000 },
    check: (i) => i.config?.openingBalances?.['2026']?.['1021'] === 5000 },
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
  // A filed link freezes a receipt's amount, currency, VAT facts and file; its date, text and kind are in no return and under no seal (#151).
  { method: 'PATCH', path: '/api/receipts/rc', body: { description: 'neu' },
    check: (i) => i.receipts.find((r) => r.id === 'rc')?.description === 'neu' },
  { method: 'PATCH', path: '/api/receipts/rc', body: { remarks: 'neu' },
    check: (i) => i.receipts.find((r) => r.id === 'rc')?.remarks === 'neu' },
  { method: 'PATCH', path: '/api/receipts/rc', body: { date: '2026-05-11' },
    check: (i) => i.receipts.find((r) => r.id === 'rc')?.date === '2026-05-11' },
  { method: 'PATCH', path: '/api/receipts/rc', body: { date: null },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'rc'); return !!r && !('date' in r); } },
  { method: 'PATCH', path: '/api/receipts/rc', body: { kind: 'noise' },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'rc'); return r?.kind === 'noise' && r.kindBy === 'human' && i.mappings.some((m) => m.receiptId === 'rc' && m.transactionRef === 'C1'); } },
  { method: 'PATCH', path: '/api/receipts/rc', body: { kind: 'statement' },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'rc'); return r?.kind === 'statement' && r.kindBy === 'human'; } },
  { method: 'PATCH', path: '/api/receipts/rc', body: { kind: null },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'rc'); return !!r && !('kind' in r) && r.kindBy === 'human'; } },
  { method: 'POST', path: '/api/receipts/rc/twin', body: { answer: 'distinct', of: 'ro' },
    check: (i) => i.receipts.find((r) => r.id === 'ro')?.distinctFrom?.includes('rc') === true && !i.receipts.find((r) => r.id === 'rc')?.distinctFrom },
  { method: 'PATCH', path: '/api/receipts/ro', body: { kind: 'noise' },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'ro'); return r?.kind === 'noise' && r.kindBy === 'human'; } },
  { method: 'PATCH', path: '/api/receipts/ro', body: { kind: null },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'ro'); return !!r && !('kind' in r) && r.kindBy === 'human'; } },
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
  // «Beleg suchen» on a filed payment: allowed, it never links (a receipt that pays it is pointed at it, #187).
  { method: 'POST', path: '/api/transactions/CI/find-receipt',
    check: (i) => !i.mappings.some((m) => m.transactionRef === 'CI') },
  // A late receipt pointed at a filed payment by the person, and the pointer taken away again: receipts are not sealed (#187).
  { method: 'POST', path: '/api/receipts/ro/filed-payment', body: { payment: 'CI' },
    check: (i) => i.receipts.find((r) => r.id === 'ro')?.filedPayment === 'CI' && !i.mappings.some((m) => m.transactionRef === 'CI') },
  { method: 'POST', path: '/api/receipts/ro/filed-payment', body: { payment: null },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'ro'); return !!r && !r.filedPayment && !!r.notPaidBy?.includes('CI'); } },
  // «Zahlung suchen» on the receipt just taken apart from O1: the person's unlink stands (Receipt.notPaidBy), nothing is linked again.
  { method: 'POST', path: '/api/receipts/ro/find-payment',
    check: (i) => !i.mappings.some((m) => m.receiptId === 'ro') && !!i.receipts.find((r) => r.id === 'ro')?.notPaidBy?.includes('O1') },
  { method: 'POST', path: '/api/mapping/add', body: { receiptId: 'ro', transactionRef: 'O1' },
    check: (i) => i.mappings.some((m) => m.receiptId === 'ro' && m.transactionRef === 'O1') },
  { method: 'DELETE', path: '/api/receipts/ro',
    check: (i) => !i.receipts.some((r) => r.id === 'ro') && !i.mappings.some((m) => m.receiptId === 'ro') },
  { method: 'POST', path: '/api/receipts/discard', body: { ids: ['rn'] },
    check: (i) => !i.receipts.some((r) => r.id === 'rn') && i.receipts.some((r) => r.id === 'rf') },
  { method: 'POST', path: '/api/receipts/ro/restore',
    check: (i) => i.receipts.some((r) => r.id === 'ro') && i.mappings.some((m) => m.receiptId === 'ro' && m.transactionRef === 'O1') },
  { method: 'POST', path: '/api/receipts/ro/twin', body: { answer: 'same', of: 'rm' },
    check: (i) => { const r = i.receipts.find((x) => x.id === 'ro'); return r?.kind === 'duplicate' && r.kindBy === 'human' && !i.mappings.some((m) => m.receiptId === 'ro'); } },
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
  // Änderungen › Rückgängig of an added account (r9c-6): the chart holds no dated record either.
  { method: 'DELETE', path: '/api/accounts/1100',
    check: () => !readFileSync(api.ws.paths.accounts, 'utf8').includes('"Debitoren"') },
];

for (const call of allowed) {
  test(`open period: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '')} succeeds`, async () => {
    const { status, error } = await send(call);
    assert.equal(status, 200, error);
    assert.ok(call.check(loadBooks(workspaceAt(api.ws.paths.root))), 'the change is in the index');
  });
}

test('a VAT adjustment of the open quarter is not moved into the filed one (403), and is taken out', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const moved = await send({ method: 'PUT', path: '/api/vat-adjustments/2026-Q3-1', body: { ...ADJ, period: '2026-Q2' } });
  assert.equal(moved.status, 403, moved.error);
  assert.equal(moved.json.code, 'periodClosed');
  assert.equal((moved.json.params as { reason: string }).reason, 'vatAdjustment');
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'index is byte-identical');
  const wrong = await send({ method: 'POST', path: '/api/vat-adjustments', body: { ...ADJ, entryIds: ['nope'] } });
  assert.equal(wrong.status, 400, wrong.error);
  assert.deepEqual([wrong.json.code, wrong.json.params], ['vatAdjustment', { why: 'entryMissing', value: 'nope' }], 'the UI says why in the person\'s language');
  const removed =await send({ method: 'DELETE', path: '/api/vat-adjustments/2026-Q3-1' });
  assert.equal(removed.status, 200, removed.error);
  assert.deepEqual(loadBooks(api.ws).config.vatAdjustments?.map((a) => a.id), ['adj-q2'], 'the filed one stays');
});

test('DELETE of an open manual payment that is booked takes its booking with it (r7h-23: the undo of «Privat bezahlt» is one step)', async () => {
  const made = await send({ method: 'POST', path: '/api/transactions/manual', body: { date: '2026-08-03', description: 'privat', amount: 7, currency: 'CHF' } });
  const ref = made.json.ref as string;
  const booked = await send({ method: 'POST', path: '/api/journal-entries', body: { transactionRef: ref, date: '2026-08-03', accountDebit: '6800', accountCredit: '2100', amount: 7, description: 'privat' } });
  assert.equal(booked.status, 200, booked.error);
  const { status } = await send({ method: 'DELETE', path: `/api/transactions/${ref}` });
  assert.equal(status, 200);
  const books = loadBooks(api.ws);
  assert.equal(books.transactions.some((t) => t.ref === ref), false);
  assert.equal(books.journalEntries.some((e) => e.transactionRef === ref), false, 'its booking went with it');
});

/** A camt.053 of the demo's Raiffeisen account with one payment on `date` and the bank's closing balance that day. */
const camt = (id: string, date: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${date}T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">4321.10</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>
<Ntry><Amt Ccy="CHF">12.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>${date}</Dt></BookgDt><AcctSvcrRef>REF-${id}</AcctSvcrRef><AddtlNtryInf>Upload ${id}</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const upload = (name: string, body: string) => api.fetch(`/api/statements?name=${encodeURIComponent(name)}`, { method: 'POST', body })
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
    receipt: (({ id, filename, amount, currency, hasSwissVat, vatSummary, vatId }) => ({ id, filename, amount, currency, hasSwissVat, vatSummary, vatId }))(i.receipts.find((r) => r.id === 'rc')!),
    mappings: i.mappings.filter((m) => m.transactionRef === 'C1'),
    closedThrough: i.config?.closedThrough,
  });
  assert.deepEqual(closed(now), closed(fixture));
  assert.deepEqual(closedPart(now as Books, '2026-06-30'), closedPart(fixture as Books, '2026-06-30'), 'the sealed part is unchanged');
});

test('open period: POST /api/workspace/logo succeeds: a logo is no dated record, the books stay as they were', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const res = await api.fetch('/api/workspace/logo', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([137, 80, 78, 71]) });
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

test('open period: keeping a rule books its open payments and leaves the filed quarter\'s; its undo too (#383)', async () => {
  const fixture = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/period-lock-index.json'), 'utf8')) as Books;
  // «Manuell Juni» (M2026-001) lies in the filed quarter, unbooked; a payment of the open quarter says «Manuell» too.
  // Earlier tests of this file write the firm's chart: the rule's account is put into it here.
  assert.equal((await send({ method: 'PUT', path: '/api/accounts/6570', body: { name: 'Informatikaufwand' } })).status, 200);
  const opened = await send({ method: 'POST', path: '/api/transactions/manual', body: { date: '2026-08-03', description: 'Manuell Lizenz', amount: 5, currency: 'CHF', direction: 'DBIT' } });
  assert.equal(opened.status, 200, opened.error);
  const ref = String(opened.json.ref);
  // It needs no receipt, so the keep books it rather than wait for one.
  assert.equal((await send({ method: 'PATCH', path: `/api/transactions/${ref}`, body: { noReceiptNeeded: true } })).status, 200);
  const made = await send({ method: 'POST', path: '/api/rules/hand', body: { match: { kind: 'text', text: 'Manuell' }, direction: 'out', account: '6570', vat: '0' } });
  assert.equal(made.status, 200, made.error);
  const path = String(made.json.path);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`)).json as { basis: string; preview: Array<{ open?: { book: string[] } }> };
  assert.ok(card.preview[0].open?.book.includes(ref) && !card.preview[0].open.book.includes('M2026-001'), JSON.stringify(card.preview[0].open));
  const kept = (await send({ method: 'POST', path: '/api/rules/draft', body: { kind: 'keep', path, basis: card.basis, confirm: true } })).json as { ok: boolean; booked?: { runs: string[]; refs: string[]; entries: string[] }; keep?: { id: string } };
  assert.ok(kept.booked?.refs.includes(ref) && !kept.booked.refs.includes('M2026-001'), JSON.stringify(kept));
  let now = loadBooks(workspaceAt(api.ws.paths.root)) as Books;
  assert.ok(!now.journalEntries.some((e) => e.transactionRef === 'M2026-001'));
  assert.deepEqual(closedPart(now, '2026-06-30'), closedPart(fixture, '2026-06-30'));
  const undone = await send({ method: 'POST', path: '/api/rules/kept/undo', body: { keep: kept.keep!.id } });
  assert.equal(undone.json.ok, true, JSON.stringify(undone.json));
  await api.rest();
  now = loadBooks(workspaceAt(api.ws.paths.root)) as Books;
  assert.ok(!now.journalEntries.some((e) => e.transactionRef === ref));
  assert.deepEqual(closedPart(now, '2026-06-30'), closedPart(fixture, '2026-06-30'));
  // «Automatisch buchen» for all (#396): what the kept rule decides in the open period is booked, the filed quarter's stays.
  const again = (await send({ method: 'POST', path: '/api/rules/hand', body: { match: { kind: 'text', text: 'Manuell' }, direction: 'out', account: '6570', vat: '0' } })).json;
  const card2 = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(String(again.path))}`)).json as { basis: string };
  assert.equal((await send({ method: 'POST', path: '/api/rules/draft', body: { kind: 'keep', path: String(again.path), basis: card2.basis, confirm: true } })).json.ok, true);
  await api.rest();
  const id = loadBooks(workspaceAt(api.ws.paths.root)).journalEntries.find((e) => e.transactionRef === ref)!.id;
  assert.equal((await send({ method: 'DELETE', path: `/api/journal-entries/${id}` })).status, 200);
  assert.equal((await send({ method: 'PATCH', path: `/api/transactions/${ref}`, body: { noReceiptNeeded: true } })).status, 200);
  const all = await send({ method: 'POST', path: '/api/rules/book-open', body: {} });
  assert.equal(all.status, 200, JSON.stringify(all.json));
  now = loadBooks(workspaceAt(api.ws.paths.root)) as Books;
  assert.ok(!now.journalEntries.some((e) => e.transactionRef === 'M2026-001'), 'the filed quarter\'s payment stays unbooked');
  assert.deepEqual(closedPart(now, '2026-06-30'), closedPart(fixture, '2026-06-30'));
});

test('POST /api/payouts/book and «Einschalten» of the booking (#404): a provider payout of the filed quarter stays as it is, an open one is booked from the clearing account', async () => {
  // Shopify's company file with its clearing account and a cut-over day before the line, written by hand; the clearing account in the chart.
  mkdirSync(join(api.root, 'knowledge', 'suppliers'), { recursive: true });
  writeFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-06-01\n');
  const konten = join(api.ws.paths.history, 'prior-year.Konten.txt');
  writeFileSync(konten, `${readFileSync(konten, 'utf8')}1093\tDurchlaufkonto Shopify\n`);
  // An earlier test gave the books a chart of their own: the clearing account goes there too.
  if (existsSync(api.ws.paths.accounts)) writeFileSync(api.ws.paths.accounts, JSON.stringify([...JSON.parse(readFileSync(api.ws.paths.accounts, 'utf8')), { number: '1093', name: 'Durchlaufkonto Shopify' }]));
  await api.rest();
  const books = loadBooks(api.ws);
  const payout = (ref: string, date: string) => ({ ref, bank: 'Raiffeisen', date, amount: 191.75, currency: 'CHF', direction: 'CRDT' as const, description: 'Gutschrift Shopify Payments', counterparty: 'Shopify Payments' });
  books.transactions.push(payout('PC', '2026-06-20'), payout('PO', '2026-08-20'));
  saveBooks(api.ws, books);
  const sealed = closedPart(loadBooks(api.ws) as Books, '2026-06-30');
  const on = await send({ method: 'POST', path: '/api/automation', body: { kind: 'approve', workflow: 'booking' } });
  assert.equal(on.status, 200, on.error);
  const book = await send({ method: 'POST', path: '/api/payouts/book', body: { provider: 'shopify' } });
  assert.equal(book.status, 200, book.error);
  const now = loadBooks(api.ws) as Books;
  assert.ok(now.journalEntries.some((e) => e.transactionRef === 'PO' && e.accountCredit === '1093'), JSON.stringify([on.json, book.json]));
  assert.ok(!now.journalEntries.some((e) => e.transactionRef === 'PC'), 'the filed quarter\'s payout stays unbooked');
  assert.deepEqual(closedPart(now, '2026-06-30'), sealed);
});
