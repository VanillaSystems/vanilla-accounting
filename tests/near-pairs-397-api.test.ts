/**
 * «Beleg suchen» without a model (#397): a receipt of the same business whose amount differs by
 * rounding is no candidate of the chain, so the search links nothing; it is offered beside the
 * outcome with what differs, and «Zahlung suchen» on the receipt offers the payment the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import type { Index, Receipt } from '../src/types/index.js';
import type { Found } from '../src/intake/pairing.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT, writeIndex } from './support/workspace.js';
import { startApi } from './support/api-server.js';

test('a rounded bill of the payment\'s business is offered by «Beleg suchen» and «Zahlung suchen», never linked', async () => {
  const api = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    const index = JSON.parse(JSON.stringify(loadBooks(workspaceAt(DEMO_ROOT)))) as Index;
    index.receipts.push({ id: 'natel', filename: 'natel.pdf', originalFilename: 'natel.pdf', fileSize: 1, indexedAt: '', location: 'archived', extractionMethod: 'pdftotext',
      extractedText: 'Swisscom (Schweiz) AG\n3050 Bern\nRechnung 7712345678\nDatum: 10.09.2026\ninOne mobile business\nTotal CHF 88.98', date: '2026-09-10', amount: 88.98, currency: 'CHF' } as Receipt);
    index.transactions.push({ ref: 'REF-N', bank: 'Raiffeisen', date: '2026-09-15', amount: 89, currency: 'CHF', direction: 'DBIT', counterparty: 'Swisscom (Schweiz) AG', description: 'Rechnung September Natel' });
    writeIndex(api.ws, index);

    const byPayment = (await api.send('POST', '/api/transactions/REF-N/find-receipt')).json as Found;
    assert.equal(byPayment.outcome, 'none');
    assert.deepEqual(byPayment.outcome === 'none' && byPayment.near?.map((o) => [o.receipt, o.payment, o.gap.kind, o.days, o.supplier]), [['natel', 'REF-N', 'rounded', 5, true]]);
    const byReceipt = (await api.send('POST', '/api/receipts/natel/find-payment')).json as Found;
    assert.deepEqual((byReceipt.outcome === 'none' || byReceipt.outcome === 'candidates') && byReceipt.near?.map((o) => o.payment), ['REF-N']);
    const books = (await (await api.fetch('/books.json')).json()) as Index;
    assert.ok(!books.mappings.some((m) => m.receiptId === 'natel'), 'nothing linked');
  } finally {
    await api.stop();
  }
});
