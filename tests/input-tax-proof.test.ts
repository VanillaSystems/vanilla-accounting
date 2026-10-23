/**
 * Input tax on other proof than a receipt (issue #134): MWSTG Art. 81 Abs. 3 weighs evidence freely,
 * and the ESTV accepts several documents together (a contract, a payment confirmation) where no
 * invoice is at hand (MWST-Info 09, Ziff. 1.6). A person books the payment by hand with the rate
 * and names the proof; the payment keeps it, and the booking is not flagged as a deduction without
 * evidence. Only a person's booking records it; the app's own runs never claim input tax without a
 * receipt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { evidenceCheck } from '../src/accounting/evidence-check.js';
import { journalOf } from '../src/app/areas/journal/model.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { Index, JournalEntry } from '../src/types/index.js';
import { startApi } from './support/api-server.js';

const person = { kind: 'person' as const, at: '2026-10-16T09:00:00.000Z' };
const entry: JournalEntry = { id: 'e1', transactionRef: 'T1', date: '2026-09-09', accountDebit: '4400', accountCredit: '1021', amount: 158.6, vatCode: 'M81', origin: 'manual', by: person };
const proof = { text: 'Werkvertrag vom 2.9.2026 mit 8.1 % MWST, Zahlungsbestätigung der Bank', at: '2026-10-16T09:00:00.000Z' };

test('a rate code without a receipt is flagged, unless the payment names the other proof', () => {
  assert.deepEqual(evidenceCheck(entry, [], undefined), { kind: 'vatWithoutReceipt', code: 'M0', decided: true });
  assert.equal(evidenceCheck(entry, [], undefined, proof), undefined, 'the other proof backs the deduction');
});

test('the journal shows no contradiction for a booking whose payment names its other proof', () => {
  const books = {
    transactions: [{ ref: 'T1', bank: 'ubs', date: '2026-09-09', amount: 158.6, currency: 'CHF', direction: 'DBIT', description: 'Schreinerei Holz', inputTaxProof: proof }],
    journalEntries: [entry], receipts: [], mappings: [], config: {},
  } as unknown as Index;
  assert.equal(journalOf(books).byId.get('e1')?.evidence, undefined);
});

test('a payment booked by hand with input tax and its other proof: the payment keeps the proof; an empty proof is refused; a patch takes it back', async () => {
  const api = await startApi('tests/fixtures/classify-index.json');
  try {
    assert.equal((await api.send('POST', '/api/mapping/remove', { receiptId: 'rw', transactionRef: 'W1' })).status, 200);
    await api.rest();
    if (loadBooks(workspaceAt(api.ws.paths.root)).journalEntries.some((e) => e.id === 'jw')) assert.equal((await api.send('DELETE', '/api/journal-entries/jw')).status, 200);
    const lines = [{ accountDebit: '4400', accountCredit: '1023', amount: 50, vatCode: 'M81', description: 'Shop EU, Material' }];

    const empty = await api.send('POST', '/api/transactions/W1/entries', { lines, inputTaxProof: '  ' });
    assert.equal(empty.status, 400, 'a proof must name something');

    const { status, json } = await api.send('POST', '/api/transactions/W1/entries', { lines, inputTaxProof: ` ${proof.text} ` });
    assert.equal(status, 200, String(json.error));
    const books = loadBooks(workspaceAt(api.ws.paths.root));
    const tx = books.transactions.find((t) => t.ref === 'W1')!;
    assert.equal(tx.inputTaxProof?.text, proof.text);
    assert.ok(tx.inputTaxProof?.at, 'when it was named');
    assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === 'W1').map((e) => [e.vatCode, e.origin, e.by?.kind]), [['M81', 'manual', 'person']]);

    assert.equal((await api.send('PATCH', '/api/transactions/W1', { inputTaxProof: '' })).status, 200);
    assert.equal(loadBooks(workspaceAt(api.ws.paths.root)).transactions.find((t) => t.ref === 'W1')!.inputTaxProof, undefined, 'the undo takes the proof back');
  } finally {
    await api.stop();
  }
});
