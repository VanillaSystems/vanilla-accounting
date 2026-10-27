/**
 * #190 part 2 over HTTP: the sets of receipts a payment's line in Kontoauszüge offers come from the
 * server, with the workspace's batch payers (GET /api/transactions/:ref/receipt-sets), and the
 * «Immer so?» that makes a business a batch payer (GET and POST /api/rules/grouped, refused with
 * `noBatchPayer`). Synthetic receipts and payments of businesses the app's files know.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import type { ReceiptSet } from '../src/intake/receipt-sets.js';
import './support/jurisdiction.js';

const servers: ApiServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); });

let n = 0;
const receipt = (amount: number, vatId: string, date: string, over: Partial<Receipt> = {}): Receipt => {
  const k = ++n;
  return {
    id: `api-r${k}`, filename: `beleg-${k}.pdf`, originalFilename: `beleg-${k}.pdf`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived',
    date, amount, currency: 'CHF', vatId, description: `Bestellung ${k}`, extractedText: `Rechnung Bestellung ${800000 + k}`, ...over,
  } as Receipt;
};
const pay = (ref: string, amount: number, date: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', description });

test('GET receipt-sets: the server proposes with the batch payers of the business files, a run beyond the free combinations; an unknown payment is 404', async () => {
  const api = await startApi('demo');
  servers.push(api);
  const AMAZON = 'CHE-269.567.571';
  const amounts = [1, 2, 4, ...Array.from({ length: 12 }, (_, i) => 200.37 + 13.1 * i)];
  const rs = amounts.map((a, i) => receipt(Math.round(a * 100) / 100, AMAZON, `2026-11-${String(1 + i).padStart(2, '0')}`));
  const books = loadBooks(api.ws);
  update(books, PERSON, (b) => { b.receipts.push(...rs); b.transactions.push(pay('AMZ-1', 7, '2026-11-20', 'AMAZON MARKETPLACE')); });
  saveBooks(api.ws, books);
  const res = await api.send('GET', '/api/transactions/AMZ-1/receipt-sets');
  assert.equal(res.status, 200);
  const sets = res.json.sets as ReceiptSet[];
  assert.deepEqual(sets.filter((s) => s.exact).map((s) => [s.receipts, s.run]), [[rs.slice(0, 3).map((r) => r.id).sort(), true]], JSON.stringify(res.json));
  const gone = await api.send('GET', '/api/transactions/NOPE/receipt-sets');
  assert.deepEqual([gone.status, gone.json.code], [404, 'gone']);
});

test('GET and POST /api/rules/grouped: offered after two payments a person linked several receipts of one business to, drafted on the click; never for a business whose file says grouped; refused with noBatchPayer', async () => {
  const api = await startApi('demo');
  servers.push(api);
  const DIGITEC = 'CHE-109.049.266';
  const VISTA = 'vistaprint';
  const d = [receipt(30, DIGITEC, '2026-11-01'), receipt(20, DIGITEC, '2026-11-02'), receipt(12, DIGITEC, '2026-11-05'), receipt(8, DIGITEC, '2026-11-06')];
  const v = [0, 1, 2, 3].map((i) => receipt(10 + i, 'CHE-283.746.519', `2026-11-0${1 + i}`, { title: { vendor: 'Vistaprint', what: 'Druck' }, extractedText: 'Vistaprint B.V. Rechnung' }));
  const books = loadBooks(api.ws);
  update(books, PERSON, (b) => {
    b.receipts.push(...d, ...v);
    b.transactions.push(pay('DG-1', 50, '2026-11-03', 'Digitec Galaxus AG'), pay('DG-2', 20, '2026-11-07', 'Digitec Galaxus AG'), pay('VP-1', 21, '2026-11-03', 'Vistaprint'), pay('VP-2', 25, '2026-11-07', 'Vistaprint'));
    b.mappings.push(...([['DG-1', d[0]], ['DG-1', d[1]], ['DG-2', d[2]], ['DG-2', d[3]], ['VP-1', v[0]], ['VP-1', v[1]], ['VP-2', v[2]], ['VP-2', v[3]]] as const).map(([ref, r]) => ({ transactionRef: ref, receiptId: r.id, by: 'human' as const })));
  });
  saveBooks(api.ws, books);
  const offer = await api.send('GET', '/api/rules/grouped?ref=DG-2');
  assert.deepEqual(offer.json.offer, { ref: 'DG-2', business: { id: 'digitec-galaxus', name: 'Digitec Galaxus' }, payments: 2, path: 'knowledge/suppliers/digitec-galaxus.yaml' });
  assert.equal((await api.send('GET', '/api/rules/grouped?ref=VP-2')).json.offer, null, `${VISTA}'s app file says grouped: false`);
  const drafted = await api.send('POST', '/api/rules/grouped', { ref: 'DG-2' });
  assert.deepEqual([drafted.status, drafted.json.path], [200, 'knowledge/suppliers/digitec-galaxus.yaml']);
  const refused = await api.send('POST', '/api/rules/grouped', { ref: 'VP-2' });
  assert.deepEqual([refused.status, refused.json.code], [404, 'noBatchPayer']);
  assert.equal((await api.send('POST', '/api/rules/grouped', {})).status, 400);
});
