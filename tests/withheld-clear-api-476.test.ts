/**
 * «2270 ausgleichen» (#476) through the real API server: one write that makes the proposal from the books (the open
 * item, never the request), books it as the person's change, and an undo that puts the payment's lines back as they
 * were, with why, now hers (#489: the app does not book the share on it again). Where the payslips tell the fund's share, the click asks for that and no more:
 * a later payment to the fund whose share is nothing has nothing to clear.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, type ApiServer } from './support/api-server.js';
import { writeIndex } from './support/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(async () => { await api?.stop(); });

const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description });
const entry = (ref: string, date: string, debit: string, credit: string, amount: number, receipts: string[] = []): JournalEntry =>
  ({ id: `e-${ref}-${debit}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, description: ref, origin: 'classify', receipts, reason: 'ganze Zahlung ist Arbeitgeberaufwand', by: { kind: 'model', model: 'test' } }) as JournalEntry;
const slip = (id: string, date: string): Receipt => ({ id, filename: `${id}.pdf`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date, amount: 8602, currency: 'CHF',
  extractedText: 'Lohnabrechnung\nBruttolohn\nAHV/IV/EO 5.3%\nALV 1.1%\nPensionskasse (BVG), Arbeitnehmerbeitrag\nNettolohn\n\n9500.00\n-503.50\n-104.50\n-290.00\n8602.00' } as Receipt);

const MONTHS = [['W7', '2026-07-27'], ['W8', '2026-08-25'], ['W9', '2026-09-25']] as const;
/** The consultancy's Q3: wages gross, the pension fund paid its share, the Akonto payment booked whole as the employer's. `slips`: the payslips linked. */
function books(slips: boolean, extra: { tx: BankTransaction; lines: JournalEntry[] }[] = [], bvgPaid = true) {
  writeIndex(api.ws, {
    config: { closedThrough: '2026-06-30' },
    transactions: [...MONTHS.map(([r, d]) => pay(r, d, 8602, 'Matthias Kälin', 'Lohn')), pay('BVG', '2026-07-10', 1740, 'Vorsorgestiftung Zentralschweiz', 'BVG Q3'), pay('AK', '2026-09-25', 4078.92, 'Ausgleichskasse Zug', 'Akonto Q3 2026'), ...extra.map((x) => x.tx)],
    journalEntries: [
      ...MONTHS.flatMap(([r, d]) => [entry(r, d, '5000', '1020', 8602, slips ? [`s${r}`] : []), { ...entry(r, d, '5000', '2270', 898, slips ? [`s${r}`] : []), id: `e-${r}-2270` }]),
      ...(bvgPaid ? [entry('BVG', '2026-07-10', '2270', '1020', 870), entry('BVG', '2026-07-10', '5720', '1020', 870)] : []),
      entry('AK', '2026-09-25', '5700', '1020', 3708.42), entry('AK', '2026-09-25', '5710', '1020', 370.5),
      ...extra.flatMap((x) => x.lines),
    ],
    receipts: slips ? MONTHS.map(([r, d]) => slip(`s${r}`, d)) : [],
    mappings: slips ? MONTHS.map(([r]) => ({ transactionRef: r, receiptId: `s${r}` })) : [],
  });
}
const linesOf = (ref: string) => loadBooks(workspaceAt(api.ws.paths.root)).journalEntries.filter((e) => e.transactionRef === ref);

test('#476 the click books what 2270 holds from 5700 onto 2270 as hers in one write; the undo puts the lines back with who booked them and why', async () => {
  books(false);
  const was = linesOf('AK');
  const done = await api.send('POST', '/api/payments/AK/clear-withheld');
  assert.equal(done.status, 200, String(done.json.error));
  assert.deepEqual([done.json.amount, done.json.account], [1824, '2270']);
  const now = linesOf('AK');
  assert.deepEqual(now.map((e) => [e.accountDebit, e.amount, e.origin]).sort(), [['2270', 1824, 'manual'], ['5700', 1884.42, 'manual'], ['5710', 370.5, 'classify']]);
  assert.ok(now.filter((e) => e.origin === 'manual').every((e) => e.by?.kind === 'person'), 'the person\'s change');
  assert.equal((await api.send('POST', '/api/payments/AK/clear-withheld')).json.code, 'withheldNone', 'nothing left to clear');
  const undo = await api.send('POST', '/api/journal-entries/by-receipt/undo', { undo: done.json.undo });
  assert.equal(undo.status, 200, String(undo.json.error));
  const back = linesOf('AK');
  assert.deepEqual(back.map((e) => [e.id, e.accountDebit, e.amount, e.origin, e.reason]).sort(), was.map((e) => [e.id, e.accountDebit, e.amount, e.origin, e.reason]).sort());
  // #489: she took the proposal back, so the booking as it stands is hers: the app never books the share on it again.
  assert.ok(back.every((e) => e.by?.kind === 'person'), 'marked hers');
});

test('#476 with the payslips read, a later payment to the fund whose share is nothing has nothing to clear: the pension fund\'s withheld stays on 2270', async () => {
  const NACH = pay('NACH', '2026-09-28', 300, 'Ausgleichskasse Zug', 'Nachzahlung 2026');
  // The pension fund not paid yet: 2270 holds its 870 beside the fund's 1'824.
  books(true, [{ tx: NACH, lines: [entry('NACH', '2026-09-28', '5700', '1020', 300)] }], false);
  const done = await api.send('POST', '/api/payments/AK/clear-withheld');
  assert.equal(done.status, 200, String(done.json.error));
  assert.equal(done.json.amount, 1824, 'the fund\'s share, not the 2\'694 2270 holds');
  const nach = await api.send('POST', '/api/payments/NACH/clear-withheld');
  assert.equal(nach.status, 409);
  assert.equal(nach.json.code, 'withheldNone');
  assert.deepEqual(linesOf('NACH').map((e) => [e.accountDebit, e.amount]), [['5700', 300]]);
  assert.equal(loadBooks(workspaceAt(api.ws.paths.root)).journalEntries.filter((e) => e.accountCredit === '2270').reduce((s, e) => s + e.amount, 0) - linesOf('AK').filter((e) => e.accountDebit === '2270').reduce((s, e) => s + e.amount, 0), 870, 'the pension fund\'s 870 stays on 2270');
});
