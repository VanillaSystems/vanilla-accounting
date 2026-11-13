/**
 * Fresh books open on 1 January; a bank account's opening is its balance of that day. A first
 * statement that starts on 1.1. names it (OPBD of 31.12. or 1.1.): the run offers it as the
 * account's opening; taken, the balance check agrees; taken back, the books are as before. A first
 * statement of Q3 names the balance of 30.06. (Malerei Huber, r7-ai-12, #487): that is no opening of
 * the books, so the run does not offer it and says the balance of 1.1. is missing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { openingOffer } from '../src/accounting/opening-balance.js';
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

const camt = (id: string, open: string, opening: number, close: string, closing: number, entry: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>2026-10-01T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${opening}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${open}</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${closing}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${close}</Dt></Dt></Bal>
${entry}
</Stmt></BkToCstmrStmt></Document>`;
const january = camt('JAN', '2025-12-31', 5200, '2026-01-31', 5200, '');

const books = (): Index => loadBooks(workspaceAt(api.ws.paths.root));
const lineOf = (a: Arrival) => {
  const run = { arrived: [a], digest: { files: [] } } as unknown as RunSummary;
  const [line] = linesOf(run, books(), true);
  assert.equal(line.kind, 'statement');
  return line as Extract<typeof line, { kind: 'statement' }>;
};

const imported = async (name: string, body: string): Promise<Arrival> => {
  const res = await api.fetch(`/api/statements?name=${name}`, { method: 'POST', body });
  const done = await res.json() as StatementImport;
  assert.equal(res.status, 200);
  const { month: _month, ...rest } = done;
  return { kind: 'statement', ...rest };
};

test('a first statement of Q3: its balance of 30.06. is not offered as the opening; the run says the balance of 1.1. is missing', async () => {
  const arrival = await imported('q3.xml', q3);
  assert.deepEqual((arrival as Extract<Arrival, { kind: 'statement' }>).opening, { date: '2026-06-30', amount: 8450.35 });
  const booked = await api.send('POST', '/api/journal-entries', { transactionRef: 'REF-PAINT', date: '2026-08-12', accountDebit: '4000', accountCredit: '1021', amount: 120, description: 'Farben' });
  assert.equal(booked.status, 200, booked.json.error as string);

  const line = lineOf(arrival);
  assert.deepEqual(line.balance, { kind: 'differs', date: '2026-09-30', diff: -8450.35 });
  assert.equal(line.opening, undefined, 'a balance from inside the year is never the opening');
  assert.deepEqual(line.startMissing, { year: '2026', from: '2026-07-01', canType: true });
});

test('a first statement that starts on 1.1. offers its opening balance; taken, the balance check agrees; taken back, the books are as before', async () => {
  const arrival = await imported('jan.xml', january);
  const without = booksOnDisk(api.ws);

  const offered = lineOf(arrival);
  assert.deepEqual(offered.balance, { kind: 'differs', date: '2026-01-31', diff: -5200 });
  assert.deepEqual(offered.opening, { account: '1021', year: '2026', date: '2025-12-31', amount: 5200 });
  assert.equal(offered.startMissing, undefined);

  const taken = await api.send('PUT', '/api/opening-balances/2026/1021', { amount: 5200 });
  assert.equal(taken.status, 200, taken.json.error as string);
  assert.deepEqual(books().config?.openingBalances, { 2026: { 1021: 5200, 2970: 5200 } }, 'the bank opens the year, retained earnings on the other side');
  const agreed = lineOf(arrival);
  assert.deepEqual(agreed.balance, { kind: 'matches', date: '2026-01-31' });
  assert.equal(agreed.opening, undefined, 'nothing is offered any more');
  assert.deepEqual(balanceOf(arrival as Extract<Arrival, { kind: 'statement' }>, books()), { kind: 'matches', date: '2026-01-31' });

  const undone = await api.send('PUT', '/api/opening-balances/2026/1021', { amount: null });
  assert.equal(undone.status, 200, undone.json.error as string);
  assert.deepEqual(booksOnDisk(api.ws), without, 'the undo leaves the books byte for byte as before');
  assert.ok(lineOf(arrival).opening, 'offered again');
});

test('only a balance of the first day opens the books: 31.12. of the year before or an opening of 1.1., never one from inside the year', () => {
  const s = (date: string) => ({ account: '1021', bank: 'x', currency: 'CHF', opening: { date, amount: 100 } });
  const fresh = { config: books().config, journalEntries: [] };
  assert.equal(openingOffer(fresh, s('2026-06-30')), undefined);
  assert.equal(openingOffer(fresh, s('2026-03-31')), undefined);
  assert.equal(openingOffer(fresh, s('2026-01-02')), undefined);
  assert.equal(openingOffer(fresh, s('2025-12-31'))?.year, '2026');
  assert.equal(openingOffer(fresh, s('2026-01-01'))?.year, '2026');
});

test('refused: an opening balance for an account that is no bank account in the base currency', async () => {
  const { status } = await api.send('PUT', '/api/opening-balances/2026/6000', { amount: 1 });
  assert.equal(status, 400);
});
