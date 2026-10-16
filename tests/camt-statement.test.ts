/**
 * A camt.053 alone is a statement (usability finding quarter-close-2): its opening (OPBD) and
 * closing (CLBD) balance become the account's statement balances, the days between them its
 * period, so Kontoauszüge covers its months and checks the balance without a PDF. Beside the
 * PDFs of every month it touches, the camt adds no row, and a PDF's balance of a day wins.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { withCamtBalances } from '../src/books/bank-import.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { bankOf, type Account } from '../src/app/areas/bank/model.js';
import type { Index, StatementClosingBalance } from '../src/types/index.js';
import { startApi, type ApiServer } from './support/api-server.js';
import './support/jurisdiction.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/fresh-books-index.json'); });
after(() => api?.stop());

const camt = (id: string, opbd: string, entries: [date: string, amount: number][], clbd: string, open: number, close: number) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>2026-10-01T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${open}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${opbd}</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${close}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${clbd}</Dt></Dt></Bal>
${entries.map(([d, a], i) => `<Ntry><Amt Ccy="CHF">${Math.abs(a)}</Amt><CdtDbtInd>${a < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><BookgDt><Dt>${d}</Dt></BookgDt><AcctSvcrRef>${id}-${i}</AcctSvcrRef><AddtlNtryInf>Zahlung ${i}</AddtlNtryInf></Ntry>`).join('\n')}
</Stmt></BkToCstmrStmt></Document>`;

const books = (): Index => loadBooks(workspaceAt(api.ws.paths.root));
const accounts = (): Account[] => api.ws.bankAccounts as Account[];

test('a quarter\'s camt.053: one statement Jul–Sep, its balances recorded, every month covered, the balance checked', async () => {
  const q3 = camt('Q3', '2026-06-30', [['2026-07-14', 4860], ['2026-08-12', -120], ['2026-09-03', -1000]], '2026-09-30', 8450.35, 12190.35);
  const res = await api.fetch('/api/statements?name=q3.xml', { method: 'POST', body: q3 });
  assert.equal(res.status, 200, await res.clone().text());

  const b = books();
  const [account] = accounts().filter((a) => a.statements);
  assert.deepEqual(b.bankStatements, [{ bank: account.bank, filename: 'q3.xml', fromDate: '2026-07-01', toDate: '2026-09-30', currency: 'CHF', refs: b.transactions.map((t) => t.ref) }], 'the statement names the payments its file holds (r10c-2)');
  assert.deepEqual(b.statementBalances?.map(({ date, amount, source, sourceFile }) => ({ date, amount, source, sourceFile })), [
    { date: '2026-06-30', amount: 8450.35, source: 'camt', sourceFile: 'q3.xml' },
    { date: '2026-09-30', amount: 12190.35, source: 'camt', sourceFile: 'q3.xml' },
  ]);

  const bank = bankOf(b, accounts(), '2026-10-15');
  const listed = bank.statements('2026-07-01', '2026-09-30');
  assert.deepEqual(listed.map((s) => [s.key, !!s.file]), [[`${account.account}-2026-07`, true]], 'no month is missing');
  const c = bank.check(listed[0]);
  assert.deepEqual({ open: c.open, close: c.close, diff: c.diff, ok: c.ok, n: c.n }, { open: 8450.35, close: 12190.35, diff: 0, ok: true, n: 3 });
});

test('an opening dated on a day the bank booked is the close of the day before (Raiffeisen\'s export)', async () => {
  const oct = camt('OCT', '2026-10-08', [['2026-10-08', -50], ['2026-10-09', 20]], '2026-10-09', 12190.35, 12160.35);
  const res = await api.fetch('/api/statements?name=oct.xml', { method: 'POST', body: oct });
  assert.equal(res.status, 200, await res.clone().text());
  const b = books();
  assert.deepEqual(b.bankStatements.find((s) => s.filename === 'oct.xml'), { bank: accounts()[0].bank, filename: 'oct.xml', fromDate: '2026-10-08', toDate: '2026-10-09', currency: 'CHF', refs: ['OCT-0', 'OCT-1'] });
  assert.ok(b.statementBalances?.some((x) => x.date === '2026-10-07' && x.amount === 12190.35 && x.sourceFile === 'oct.xml'));
});

const bal = (date: string, amount: number, source: 'pdf' | 'camt'): StatementClosingBalance =>
  ({ account: '1021', bank: 'Raiffeisen', currency: 'CHF', date, amount, source, sourceFile: `${source}-${date}` });

test('a PDF\'s balance of a day wins over the camt\'s; the camt\'s are read anew each time', () => {
  const pdf = bal('2026-07-31', 950, 'pdf');
  assert.deepEqual(withCamtBalances([pdf, bal('2026-05-31', 1, 'camt')], [bal('2026-07-31', 951, 'camt'), bal('2026-06-30', 1000, 'camt')]), [bal('2026-06-30', 1000, 'camt'), pdf]);
  assert.equal(withCamtBalances(undefined, []), undefined, 'books without balances get none');
});

test('beside a PDF for every month it touches, a camt adds no row; from the first month without one it does', () => {
  const ACCOUNTS: Account[] = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Raiffeisen', statements: 'camt053' }];
  const pdf = (m: string, last: string) => ({ bank: 'Raiffeisen', filename: `Kontoauszug 01.${m}.2026 - ${last}.${m}.2026.pdf`, fromDate: `2026-${m}-01`, toDate: `2026-${m}-${last}` });
  const camtFile = { bank: 'Raiffeisen', filename: 'q3.xml', fromDate: '2026-07-08', toDate: '2026-09-30', currency: 'CHF' };
  const of = (bankStatements: Index['bankStatements']): Index => ({ receipts: [], transactions: [], mappings: [], bankStatements });
  const all = bankOf(of([pdf('07', '31'), pdf('08', '31'), pdf('09', '30'), camtFile]), ACCOUNTS, '2026-10-15').statements('2026-07-01', '2026-09-30');
  assert.deepEqual(all.map((s) => s.file?.filename), [pdf('09', '30').filename, pdf('08', '31').filename, pdf('07', '31').filename]);
  const julyOnly = bankOf(of([pdf('07', '31'), camtFile]), ACCOUNTS, '2026-10-15').statements('2026-07-01', '2026-09-30');
  assert.deepEqual(julyOnly.map((s) => [s.key, s.from, s.file?.filename]), [['1021-2026-08', '2026-08-01', 'q3.xml'], ['1021-2026-07', '2026-07-01', pdf('07', '31').filename]]);
});
