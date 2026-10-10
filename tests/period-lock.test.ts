/**
 * Golden rule 1 (AGENTS.md) at the API: nothing dated on or before config.closedThrough may
 * change. Runs the real API server against a temp copy of tests/fixtures/period-lock-index.json
 * (closedThrough 2026-06-30, one closed and one open transaction, entry, receipt and mapping).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Index } from '../src/types/index.js';
import { issue } from '../src/invoices/rules.js';
import { DEFAULT_LAYOUT, type InvoiceBook } from '../src/invoices/model.js';
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
  const book: InvoiceBook = { schema: 1, customers: [], invoices: [{ ...issued, pdf: { file: 'invoices/2026-001.pdf', sha256: createHash('sha256').update(pdf).digest('hex') } }], sent: [] };
  mkdirSync(join(root, 'invoices'));
  writeFileSync(join(root, 'invoices/2026-001.pdf'), pdf);
  writeFileSync(join(root, 'invoices.json'), JSON.stringify(book));
}

before(async () => {
  api = await startApi('tests/fixtures/period-lock-index.json');
  withInvoice(api.root);
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
  { method: 'PATCH', path: '/api/receipts/rc', body: { description: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { remarks: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { date: '2026-05-11' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { amount: 11, currency: 'CHF' }, status: 403 },
  { method: 'PATCH', path: '/api/receipts/rc', body: { filename: 'neu.pdf' }, status: 403 },
  { method: 'POST', path: '/api/vision/extract', body: { receiptId: 'rc' }, status: 403 },
  { method: 'POST', path: '/api/mapping/add', body: { receiptId: 'ro', transactionRef: 'C1' }, status: 403 },
  { method: 'POST', path: '/api/mapping/remove', body: { receiptId: 'rc', transactionRef: 'C1' }, status: 403 },
  { method: 'POST', path: '/api/mapping/approve-duplicate', body: { receiptId: 'rc' }, status: 403 },
  { method: 'PATCH', path: '/api/journal-entries/jc', body: { description: 'neu' }, status: 403 },
  { method: 'PATCH', path: '/api/journal-entries/jo', body: { date: '2026-06-15' }, status: 403 },
  { method: 'DELETE', path: '/api/journal-entries/jc', status: 403 },
  { method: 'POST', path: '/api/journal-entries/classify/C1', status: 403 },
  { method: 'PATCH', path: '/api/config', body: { closedThrough: '' }, status: 404 },
  { method: 'POST', path: '/api/year-close/2026/entries', body: { date: '2026-06-30', accountDebit: '6800', accountCredit: '1520', amount: 100, description: 'rückdatiert' }, status: 403 },
  { method: 'POST', path: '/api/invoices/in_p/payments', body: { transactionRef: 'CI' }, status: 403 },
];

test('status: not in audit mode', async () => {
  assert.deepEqual((await api.send('GET', '/api/status')).json, { ok: true, readonly: false });
});

for (const call of refused) {
  test(`refused: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '')} -> ${call.status}, index unchanged`, async () => {
    const before = readFileSync(api.indexPath);
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
    assert.ok(readFileSync(api.indexPath).equals(before), 'index is byte-identical');
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
  { method: 'POST', path: '/api/mapping/approve-duplicate', body: { receiptId: 'ro' },
    check: (i) => i.mappings.find((m) => m.receiptId === 'ro')?.approvedDuplicate === true },
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
  { method: 'DELETE', path: '/api/transactions/M2026-002',
    check: (i) => !i.transactions.some((t) => t.ref === 'M2026-002') && !i.mappings.some((m) => m.transactionRef === 'M2026-002') },
  { method: 'DELETE', path: '/api/journal-entries/jo',
    check: (i) => !i.journalEntries!.some((j) => j.id === 'jo') },
  { method: 'POST', path: '/api/year-close/2026/entries', body: { date: '2026-08-31', accountDebit: '6800', accountCredit: '1520', amount: 100, description: 'Abschreibung' },
    check: (i) => i.journalEntries!.some((j) => j.transactionRef === 'M2026-004' && j.date === '2026-08-31' && j.origin === 'manual') },
  { method: 'POST', path: '/api/invoices/in_p/payments', body: { transactionRef: 'OI' },
    check: (i) => i.journalEntries!.some((j) => j.transactionRef === 'OI' && j.vatCode === 'V81' && j.origin === 'invoice') && i.mappings.some((m) => m.transactionRef === 'OI' && m.rule === 'invoice-reference') },
];

for (const call of allowed) {
  test(`open period: ${call.method} ${call.path} ${JSON.stringify(call.body ?? '')} succeeds`, async () => {
    const { status, error } = await send(call);
    assert.equal(status, 200, error);
    assert.ok(call.check(JSON.parse(readFileSync(api.indexPath, 'utf8'))), 'the change is in the index');
  });
}

test('the closed period is still exactly as in the fixture', () => {
  const fixture: Index = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/period-lock-index.json'), 'utf8'));
  const now: Index = JSON.parse(readFileSync(api.indexPath, 'utf8'));
  const closed = (i: Index) => ({
    transactions: i.transactions.filter((t) => t.date <= '2026-06-30'),
    entries: i.journalEntries!.filter((j) => j.date <= '2026-06-30'),
    receipt: i.receipts.find((r) => r.id === 'rc'),
    mappings: i.mappings.filter((m) => m.transactionRef === 'C1'),
    config: i.config,
  });
  assert.deepEqual(closed(now), closed(fixture));
});
