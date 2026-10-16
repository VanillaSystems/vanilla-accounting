/**
 * An entry booked in Buchungen › N for a payment (persona test «treuhaender», finding 22): typed
 * without the payment, the payment stayed «nicht gebucht» and a later run booked it a second time.
 * The unbooked payment offers the manual booking that adds up to it, and tying it moves the
 * entries to the payment's ref and date; the N form can name the payment from the start.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { unattachedFor } from '../src/accounting/manual-booking.js';
import { unbookedPayments } from '../src/app/areas/journal/model.js';
import type { JournalEntry } from '../src/types/index.js';
import { booksOnDisk } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>Q4</MsgId><CreDtTm>2026-10-13T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>Q4</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">386.60</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-02</Dt></BookgDt><AcctSvcrRef>RB-1001</AcctSvcrRef><AddtlNtryInf>Malerbedarf RE-4471</AddtlNtryInf></Ntry>
<Ntry><Amt Ccy="CHF">187.35</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-05</Dt></BookgDt><AcctSvcrRef>RB-1002</AcctSvcrRef><AddtlNtryInf>Baucenter</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

before(async () => {
  api = await startApi('tests/fixtures/fresh-books-index.json');
  const res = await fetch(`http://127.0.0.1:${api.port}/api/statements?name=q4.xml`, { method: 'POST', body: camt });
  assert.equal(res.status, 200);
});
after(() => api?.stop());

const books = () => loadBooks(workspaceAt(api.ws.paths.root));
const book = async (body: object) => {
  const r = await api.send('POST', '/api/journal-entries', body);
  assert.equal(r.status, 200, String(r.json.error));
  return r.json.entry as JournalEntry;
};

test('an entry typed without its payment is offered on the payment and, tied, books it: the payment\'s ref and date, a second booking refused', async () => {
  const typed = await book({ date: '2026-10-03', accountDebit: '4400', accountCredit: '1021', amount: 386.6, description: 'Malerbedarf RE-4471', vatCode: 'M0' });
  await book({ date: '2026-10-03', accountDebit: '6500', accountCredit: '1021', amount: 99, description: 'anderes' });
  const ws = workspaceAt(api.ws.paths.root);
  const offered = unattachedFor(books(), 'RB-1001', ws.bankAccounts);
  assert.deepEqual(offered.map((u) => [u.ref, u.days]), [[typed.transactionRef, 1]], 'only the booking of the payment\'s amount on its bank account');
  assert.deepEqual(unattachedFor(books(), 'RB-1002', ws.bankAccounts), [], 'no booking adds up to 187.35');

  const r = await api.send('POST', '/api/transactions/RB-1001/attach', { ref: typed.transactionRef });
  assert.equal(r.status, 200, String(r.json.error));
  assert.deepEqual((r.json.before as JournalEntry[]).map((e) => [e.id, e.transactionRef, e.date]), [[typed.id, typed.transactionRef, '2026-10-03']], 'the entries as they were, for the undo');
  const tied = books().journalEntries.find((e) => e.id === typed.id)!;
  assert.deepEqual([tied.transactionRef, tied.date, tied.origin, tied.amount, tied.accountDebit], ['RB-1001', '2026-10-02', 'manual', 386.6, '4400']);
  assert.deepEqual(unattachedFor(books(), 'RB-1001', ws.bankAccounts), [], 'nothing offered on a booked payment');
  assert.ok(!unbookedPayments(books(), '', undefined, api.ws.bankAccounts).some((t) => t.ref === 'RB-1001'), 'the N form no longer offers it');

  const again = await api.send('POST', '/api/transactions/RB-1001/entries', { lines: [{ accountDebit: '4400', accountCredit: '1021', amount: 386.6, description: 'zweimal' }] });
  assert.deepEqual([again.status, again.json.code], [409, 'hasEntries'], 'a booked payment is not booked twice');
});

test('refused: a booking that does not add up to the payment, a ref that is no booking without payment', async () => {
  const short = await book({ date: '2026-10-05', accountDebit: '4400', accountCredit: '1021', amount: 180, description: 'Baucenter' });
  const before = booksOnDisk(api.ws);
  const off = await api.send('POST', '/api/transactions/RB-1002/attach', { ref: short.transactionRef });
  assert.deepEqual([off.status, off.json.code], [400, 'paymentBalance']);
  const none = await api.send('POST', '/api/transactions/RB-1002/attach', { ref: 'RB-1001' });
  assert.equal(none.status, 404);
  assert.deepEqual(booksOnDisk(api.ws), before, 'nothing written');
});

test('the N form finds the open payments by date, amount or text, the typed amount first', () => {
  const b = books();
  assert.deepEqual(unbookedPayments(b, '', undefined, api.ws.bankAccounts).map((t) => t.ref), ['RB-1002'], 'only the unbooked one');
  assert.deepEqual(unbookedPayments(b, 'bau', undefined, api.ws.bankAccounts).map((t) => t.ref), ['RB-1002']);
  assert.deepEqual(unbookedPayments(b, '05.10.2026', undefined, api.ws.bankAccounts).map((t) => t.ref), ['RB-1002']);
  assert.deepEqual(unbookedPayments(b, '187.35', undefined, api.ws.bankAccounts).map((t) => t.ref), ['RB-1002']);
  assert.deepEqual(unbookedPayments(b, 'malerbedarf', undefined, api.ws.bankAccounts), []);
  const tx = (ref: string, date: string, amount: number) => ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT' as const, description: ref });
  const many = { transactions: [tx('a', '2026-10-01', 50), tx('b', '2026-10-09', 20), tx('c', '2026-06-01', 50)], journalEntries: [], config: { closedThrough: '2026-06-30' } };
  assert.deepEqual(unbookedPayments(many, '', undefined, []).map((t) => t.ref), ['b', 'a'], 'newest first, a filed one never');
  assert.deepEqual(unbookedPayments(many, '', 50, []).map((t) => t.ref), ['a', 'b'], 'the typed amount first');
});
