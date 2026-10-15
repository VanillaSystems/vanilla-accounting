/**
 * Books started mid-year with their first statement (usability finding 34, Malerei Huber): the
 * camt.053 of Q3 names the bank's balance on 30.06 (OPBD), the books have no opening for the
 * account, so the balance check is off by exactly that. The run offers it as the account's
 * opening balance; taken, the check agrees; taken back, the books are as before.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { balanceOf, linesOf } from '../src/app/areas/automation/runs-model.js';
import type { Arrival, RunSummary } from '../src/workflows/model.js';
import type { Index, StatementImport } from '../src/types/index.js';
import { booksOnDisk } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/fresh-books-index.json'); });
after(() => api?.stop());

const q3 = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>Q3</MsgId><CreDtTm>2026-10-01T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>Q3</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">8450.35</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-06-30</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">8330.35</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-30</Dt></Dt></Bal>
<Ntry><Amt Ccy="CHF">120.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-12</Dt></BookgDt><AcctSvcrRef>REF-PAINT</AcctSvcrRef><AddtlNtryInf>Farben Muster AG</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const books = (): Index => loadBooks(workspaceAt(api.ws.paths.root));
const lineOf = (a: Arrival) => {
  const run = { arrived: [a], digest: { files: [] } } as unknown as RunSummary;
  const [line] = linesOf(run, books(), true);
  assert.equal(line.kind, 'statement');
  return line as Extract<typeof line, { kind: 'statement' }>;
};

test('the first statement of fresh books offers its opening balance; taken, the balance check agrees; taken back, the books are as before', async () => {
  const res = await fetch(`http://127.0.0.1:${api.port}/api/statements?name=q3.xml`, { method: 'POST', body: q3 });
  const imported = await res.json() as StatementImport;
  assert.equal(res.status, 200);
  assert.deepEqual(imported.opening, { date: '2026-06-30', amount: 8450.35 });
  const { month: _month, ...done } = imported;
  const arrival: Arrival = { kind: 'statement', ...done };

  const booked = await api.send('POST', '/api/journal-entries', { transactionRef: 'REF-PAINT', date: '2026-08-12', accountDebit: '4000', accountCredit: '1021', amount: 120, description: 'Farben' });
  assert.equal(booked.status, 200, booked.json.error as string);
  const without = booksOnDisk(api.ws);

  const offered = lineOf(arrival);
  assert.deepEqual(offered.balance, { kind: 'differs', date: '2026-09-30', diff: -8450.35 });
  assert.deepEqual(offered.opening, { account: '1021', year: '2026', date: '2026-06-30', amount: 8450.35 });

  const taken = await api.send('PUT', '/api/opening-balances/2026/1021', { amount: 8450.35 });
  assert.equal(taken.status, 200, taken.json.error as string);
  assert.deepEqual(books().config?.openingBalances, { 2026: { 1021: 8450.35, 2970: 8450.35 } }, 'the bank opens the year, retained earnings on the other side');
  const agreed = lineOf(arrival);
  assert.deepEqual(agreed.balance, { kind: 'matches', date: '2026-09-30' });
  assert.equal(agreed.opening, undefined, 'nothing is offered any more');
  assert.deepEqual(balanceOf(arrival, books()), { kind: 'matches', date: '2026-09-30' });

  const undone = await api.send('PUT', '/api/opening-balances/2026/1021', { amount: null });
  assert.equal(undone.status, 200, undone.json.error as string);
  assert.deepEqual(booksOnDisk(api.ws), without, 'the undo leaves the books byte for byte as before');
  assert.ok(lineOf(arrival).opening, 'offered again');
});

test('refused: an opening balance for an account that is no bank account in the base currency', async () => {
  const { status } = await api.send('PUT', '/api/opening-balances/2026/6000', { amount: 1 });
  assert.equal(status, 400);
});
