/**
 * A statement PDF kept as its statement gives the books its closing balance and the references and
 * foreign amounts the bank's export lacks (#243), from its one table: the model's read kept beside
 * it, a person's table, or its question's while that waits. Invented data throughout.
 * - Reading: only the model's real answers are kept; a failed call keeps nothing and is read again;
 *   a refusal no further call gets past ends the reading; filed months and asked PDFs are not read.
 * - Through the API on the demo: the table by hand, «Neu lesen», the reading the person starts, and
 *   a question's table kept beside its PDF when it closes, which a question asked again starts from.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { besidePath, readBeside, writeBeside } from '../src/books/pdf-reads.js';
import { readFailures, readKeptPdfs, readsByItself, unreadPdfs } from '../src/intake/statement-read.js';
import { AiRefused } from '../src/llm/provider.js';
import { workspacePaths, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { bankOf, tableOfPayments, type Account } from '../src/app/areas/bank/model.js';
import type { BankStatement, BankTransaction, Index, StatementAsk, StatementClosingBalance } from '../src/types/index.js';
import type { PdfFactsView, ReadStatement, StatementReadsView } from '../src/types/statement-read.js';
import { DEMO_OCTOBER, inventedStatement } from './support/statement-pdf.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';

const account = { account: '1021', bank: 'Musterbank', currency: 'CHF', label: 'Musterbank', statements: 'camt053', role: 'bank' } as LedgerBankAccount;
const month = (m: string, last: string): BankStatement => ({ bank: 'Musterbank', filename: `Kontoauszug 01.${m}.2026 - ${last}.${m}.2026.pdf`, fromDate: `2026-${m}-01`, toDate: `2026-${m}-${last}` });

test('reading kept PDFs: real answers kept beside each, a failed call keeps nothing and is read again, a refusal ends the reading; filed months, asked PDFs and a person\'s table are not read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-facts-'));
  const dir = join(root, 'transactional-data', '2026', 'bank-statements', 'Musterbank');
  mkdirSync(dir, { recursive: true });
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const months = [month('03', '31'), month('07', '31'), month('08', '31'), month('09', '30'), month('10', '31'), month('11', '30')];
  months.forEach((m, i) => writeFileSync(join(dir, m.filename), Buffer.concat([pdf, Buffer.from(`\n%${i}`)])));
  const ws = { paths: workspacePaths(root), bankAccounts: [account] };
  const asks = [{ file: `Musterbank/${months[5].filename}` } as StatementAsk];
  const books = { bankStatements: months, statementAsks: asks, config: { closedThrough: '2026-06-30' } as never };
  const unread = () => unreadPdfs(ws, books).map((p) => p.to.slice(5, 7));
  assert.deepEqual(unread(), ['07', '08', '09', '10'], 'not the filed March, not November whose question waits');

  const asked: string[] = [];
  const answers: Record<string, () => string> = {
    '07': () => JSON.stringify(truth),
    '08': () => { throw new Error('timeout after 300 s'); },
    '09': () => JSON.stringify({ notStatement: true }),
    '10': () => 'no JSON at all',
  };
  const ask = async (_prompt: string, o: { attachments?: string[] }) => {
    const m = /\.(\d{2})\.2026\.pdf$/.exec(o.attachments![0])![1];
    asked.push(m);
    return answers[m]();
  };
  const first = await readKeptPdfs(unreadPdfs(ws, books), ask);
  assert.deepEqual([first.read, first.failed.map((f) => f.file), first.stopped], [3, [`Musterbank/${months[2].filename}`], undefined]);
  const kept = (i: number) => readBeside(join(dir, months[i].filename));
  const keptStatement = (i: number) => { const k = kept(i); return k && 'statement' in k ? k : undefined; };
  const keptWhy = (i: number) => { const k = kept(i); return k && 'why' in k ? k.why : undefined; };
  assert.deepEqual(keptStatement(1)?.statement.closing, truth.closing, 'the model\'s statement kept beside July');
  assert.equal(existsSync(besidePath(join(dir, months[2].filename))), false, 'August\'s failed call keeps nothing');
  assert.equal(readFailures().get(`Musterbank/${months[2].filename}`), 'timeout after 300 s', 'and is told');
  assert.deepEqual([keptWhy(3), keptWhy(4)], ['notStatement', 'unreadable'], 'a real answer without a statement is kept too');
  assert.deepEqual(unread(), ['08'], 'the next run asks August again, and only August');

  answers['08'] = () => { throw new AiRefused({ reason: 'limit', cli: 'claude', said: 'usage limit reached' }, 'usage limit reached'); };
  writeBeside(join(dir, months[1].filename), { by: 'hand', statement: { ...truth, closing: { ...truth.closing, amount: 1 } } });
  writeFileSync(join(dir, months[3].filename), Buffer.concat([pdf, Buffer.from('\n%other')]));
  assert.deepEqual(unread(), ['08', '09'], 'another file under September\'s name has no read; July\'s table by hand is never read over');
  asked.length = 0;
  const second = await readKeptPdfs(unreadPdfs(ws, books), ask);
  assert.deepEqual([asked, second.read, second.stopped?.refusal?.reason], [['08'], 0, 'limit'], 'a plan\'s limit ends the reading: September is not asked');
  assert.equal(keptStatement(1)?.by, 'hand');
});

test('an empty or cut-off answer is a failed call: nothing kept, told, asked again; the inbox run reads at most one PDF of each account by itself (#243 review)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-facts-'));
  const dir = join(root, 'transactional-data', '2026', 'bank-statements', 'Musterbank');
  mkdirSync(dir, { recursive: true });
  const { pdf } = await inventedStatement(DEMO_OCTOBER);
  const months = [month('07', '31'), month('08', '31')];
  months.forEach((m, i) => writeFileSync(join(dir, m.filename), Buffer.concat([pdf, Buffer.from(`\n%cut${i}`)])));
  const ws = { paths: workspacePaths(root), bankAccounts: [account] };
  const books = { bankStatements: months, config: { closedThrough: '2026-06-30' } as never };
  const answers = ['', '{"currency": "CHF", "movements": [{"date": "2026-07-02", "amo'];
  const run = await readKeptPdfs(unreadPdfs(ws, books), async () => answers.shift()!);
  assert.deepEqual([run.read, run.failed.map((f) => f.file)], [0, months.map((m) => `Musterbank/${m.filename}`)]);
  assert.equal(months.some((m) => existsSync(besidePath(join(dir, m.filename)))), false, 'nothing kept as unreadable');
  assert.equal(unreadPdfs(ws, books).length, 2, 'both asked again');

  const other = { ...account, account: '1022', bank: 'Zweitbank' } as LedgerBankAccount;
  const [july, august] = unreadPdfs(ws, books);
  assert.equal(readsByItself([july, august]), false, 'two of one account are a backlog the person is asked about');
  assert.equal(readsByItself([july, { ...august, account: other }]), true, 'one of each account');
});

test('the table by hand is prefilled with the bank\'s balance of the statement\'s last day, never the books\' own figure (#243 review)', () => {
  const ACCOUNTS: Account[] = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Raiffeisen', statements: 'camt053', role: 'bank' }];
  const pay: BankTransaction = { ref: 'P1', bank: 'Raiffeisen', date: '2026-09-03', amount: 40, currency: 'CHF', direction: 'DBIT', description: 'Coop' };
  const index = (balances?: StatementClosingBalance[]): Index => ({
    receipts: [], transactions: [pay], mappings: [],
    bankStatements: [{ bank: 'Raiffeisen', filename: 'Kontoauszug 01.09.2026 - 30.09.2026.pdf', fromDate: '2026-09-01', toDate: '2026-09-30' }],
    journalEntries: [{ id: 'E1', date: '2026-09-03', description: 'Coop', debit: '6000', credit: '1021', amount: 40, currency: 'CHF' } as never],
    ...(balances ? { statementBalances: balances } : {}),
  });
  const tableOf = (i: Index) => {
    const bank = bankOf(i, ACCOUNTS, '2026-10-15');
    const [s] = bank.statements('2026-09-01', '2026-09-30');
    return tableOfPayments(s, [pay], bank.check(s));
  };
  const none = tableOf(index());
  assert.deepEqual([none.closing, none.opening, none.movements.map((m) => [m.amount, m.payment])], [undefined, undefined, [[-40, 'P1']]], 'no bank balance: the closing stays empty');
  const bank = tableOf(index([{ account: '1021', bank: 'Raiffeisen', currency: 'CHF', date: '2026-09-30', amount: 960, source: 'camt', sourceFile: 'q3.xml' }]));
  assert.deepEqual([bank.opening, bank.closing], [{ date: '2026-09-01', amount: 1000 }, { date: '2026-09-30', amount: 960 }]);
});

// ─── Through the API ────────────────────────────────────────────────────────

const SEPTEMBER = 'Kontoauszug 01.09.2026 - 30.09.2026 - CH6580808000000000001 - 2026-09-30.pdf';
const FILE = `Raiffeisen/${SEPTEMBER}`;
const URL_OF = `/api/statements/Raiffeisen/${encodeURIComponent(SEPTEMBER)}`;
const STUB = join(process.cwd(), 'tests/support/stub-bin');

type Full = { transactions: BankTransaction[]; statementBalances?: StatementClosingBalance[]; statementAsks?: StatementAsk[] };
const full = async (api: ApiServer) => (await (await api.fetch('/books.json')).json()) as Full;
const json = async <T>(api: ApiServer, path: string, method = 'GET', body?: object) => {
  const r = await api.fetch(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
  return { status: r.status, body: await r.json() as T };
};
const signed = (t: BankTransaction) => (t.direction === 'DBIT' ? -t.amount : t.amount);
const r2 = (n: number) => Math.round(n * 100) / 100;

async function demo(answer?: ReadStatement): Promise<ApiServer> {
  const api = await startApi('demo', answer ? { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(answer) } : {});
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  return api;
}

/** A September table of the demo's Raiffeisen account: one payment's line with `reference`, closing at `closing`, opening at what it leaves. */
function septemberTable(t: BankTransaction, reference: string, closing: number, o: { payment?: boolean } = {}): ReadStatement {
  return {
    currency: 'CHF', period: { from: '2026-09-01', to: '2026-09-30' }, opening: { date: '2026-09-01', amount: r2(closing - signed(t)) }, closing: { date: '2026-09-30', amount: closing },
    movements: [{ date: t.date, amount: signed(t), text: t.description, reference, ...(o.payment ? { payment: t.ref } : {}) }],
  };
}

test('by hand: a person\'s table of a kept PDF gives the books its reference, which survives a rebuild; the camt\'s balance of the day stands over hers; «Neu lesen» only once confirmed, and drops it; a filed month refuses', async () => {
  const api = await demo();
  try {
    const before = await full(api);
    const pay = before.transactions.find((t) => t.bank === 'Raiffeisen' && t.date.startsWith('2026-09') && !t.reference && !t.counterparty?.includes('Raiffeisen'))!;
    const unread = await json<PdfFactsView>(api, `${URL_OF}/facts`);
    assert.deepEqual([unread.body.state, unread.body.closing?.amount], ['unread', 88252.44], 'not read yet; the balance the books hold from this file is named');
    const saved = await json<PdfFactsView>(api, `${URL_OF}/facts`, 'PUT', { statement: septemberTable(pay, 'RE-2026-0777', 70000, { payment: true }) });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.state, saved.body.closing, saved.body.bank, saved.body.taken], ['hand', undefined, { date: '2026-09-30', amount: 88252.44 }, { references: 1, originals: 0 }], 'the bank\'s export states 30.09.: her typed balance does not stand over it');
    const after = await full(api);
    assert.equal(after.transactions.find((t) => t.ref === pay.ref)?.reference, 'RE-2026-0777');
    const lastDay = (b: Full) => b.statementBalances?.filter((x) => x.account === '1021' && x.date === '2026-09-30').map((x) => [x.source, x.amount]);
    assert.deepEqual(lastDay(after), [['camt', 88252.44]], 'one balance of 30.09., the camt\'s');
    assert.equal(readBeside(join(api.root, 'transactional-data/2026/bank-statements', FILE))?.by, 'hand', 'kept beside the PDF as hers');
    // A rebuild of the bank side from the folder (an import does one) takes it again.
    const other = 'Kontoauszug 01.08.2026 - 31.08.2026 - CH6580808000000000001 - 2026-08-31.pdf';
    await json(api, `/api/statements/Raiffeisen/${encodeURIComponent(other)}/facts`, 'DELETE');
    assert.equal((await full(api)).transactions.find((t) => t.ref === pay.ref)?.reference, 'RE-2026-0777', 'survives the next merge');

    const refused = await json<{ code?: string; params?: { why?: string } }>(api, `${URL_OF}/facts`, 'DELETE');
    assert.deepEqual([refused.status, refused.body.code, refused.body.params?.why], [409, 'statementRead', 'hand'], 'her table goes only once she confirmed it');
    assert.equal((await full(api)).transactions.find((t) => t.ref === pay.ref)?.reference, 'RE-2026-0777', 'nothing gone yet');
    const forgot = await json<PdfFactsView>(api, `${URL_OF}/facts?confirmed=1`, 'DELETE');
    assert.equal(forgot.body.state, 'unread');
    const again = await full(api);
    assert.equal(again.transactions.find((t) => t.ref === pay.ref)?.reference, undefined, 'the reference came from the table and goes with it');
    assert.deepEqual(lastDay(again), [['camt', 88252.44]]);

    const march = 'Kontoauszug 01.03.2026 - 31.03.2026 - CH6580808000000000001 - 2026-03-31.pdf';
    const filed = await json<{ code?: string }>(api, `/api/statements/Raiffeisen/${encodeURIComponent(march)}/facts`, 'PUT', { statement: septemberTable(pay, 'x', 1) });
    assert.equal(filed.status, 403, 'a filed month takes no table');
  } finally {
    await api.stop();
  }
});

test('by hand without a balance: her references go into the books, no balance is made, the books keep the one they hold (#243 review)', async () => {
  const api = await demo();
  try {
    const AUGUST = 'Kontoauszug 01.08.2026 - 31.08.2026 - CH6580808000000000001 - 2026-08-31.pdf';
    const url = `/api/statements/Raiffeisen/${encodeURIComponent(AUGUST)}/facts`;
    const before = await full(api);
    const held = before.statementBalances?.filter((b) => b.sourceFile === AUGUST).map((b) => [b.date, b.amount]);
    assert.equal(held?.length, 1, 'the demo\'s books hold August\'s balance from its PDF');
    const pay = before.transactions.find((t) => t.bank === 'Raiffeisen' && t.date.startsWith('2026-08') && !t.reference && !t.counterparty?.includes('Raiffeisen'))!;
    const table = { currency: 'CHF', period: { from: '2026-08-01', to: '2026-08-31' }, opening: { date: '2026-08-01', amount: '' }, closing: { date: '2026-08-31', amount: '' },
      movements: [{ date: pay.date, amount: signed(pay), text: pay.description, reference: 'RE-2026-0778', payment: pay.ref }] };
    const saved = await json<PdfFactsView>(api, url, 'PUT', { statement: table });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.state, saved.body.adds, saved.body.taken?.references, saved.body.statement?.closing], ['hand', false, 1, undefined]);
    const after = await full(api);
    assert.equal(after.transactions.find((t) => t.ref === pay.ref)?.reference, 'RE-2026-0778');
    assert.deepEqual(after.statementBalances?.filter((b) => b.sourceFile === AUGUST).map((b) => [b.date, b.amount]), held, 'no balance of hers: the one the books held stays');
  } finally {
    await api.stop();
  }
});

test('the reading the person starts: N of M, the model\'s table kept beside the PDF, its reference on the payment it names beyond doubt, its balance only when it adds up', async () => {
  const probe = await demo();
  const pay = (await full(probe)).transactions.find((t) => t.bank === 'Raiffeisen' && t.date.startsWith('2026-09') && !t.reference && !t.counterparty?.includes('Raiffeisen'))!;
  await probe.stop();
  const api = await demo(septemberTable(pay, 'RE-2026-0999', 71000));
  try {
    const view = await json<StatementReadsView>(api, '/api/statement-reads');
    assert.equal(view.body.ai, 'ready');
    assert.ok(view.body.unread.includes(FILE) && view.body.unread.length > 1, `a backlog the run does not read by itself: ${view.body.unread.length}`);
    assert.ok(!view.body.unread.some((f) => f.includes('2026-03-31') || f.includes('_2026-03-01_')), 'no filed month among them');
    const started = await json<StatementReadsView>(api, '/api/statement-reads', 'POST', { files: [FILE] });
    assert.deepEqual([started.status, started.body.job?.total], [200, 1]);
    let now = started.body;
    for (let i = 0; i < 100 && !now.job?.finished; i++) {
      await new Promise((r) => setTimeout(r, 100));
      now = (await json<StatementReadsView>(api, '/api/statement-reads')).body;
    }
    assert.deepEqual([now.job?.finished, now.job?.read, now.job?.failed], [true, 1, []]);
    assert.equal(now.unread.includes(FILE), false);
    const facts = (await json<PdfFactsView>(api, `${URL_OF}/facts`)).body;
    assert.deepEqual([facts.state, facts.adds, facts.closing?.amount, facts.bank?.amount, facts.taken?.references], ['read', true, undefined, 88252.44, 1], 'the read adds up, yet the camt\'s balance of 30.09. stands');
    assert.equal((await full(api)).transactions.find((t) => t.ref === pay.ref)?.reference, 'RE-2026-0999');
  } finally {
    await api.stop();
  }
});

test('a question\'s table is the PDF\'s one table: «Als Auszug behalten» keeps it beside the PDF, and a question asked again starts from it', async () => {
  const api = await demo();
  try {
    const pay = (await full(api)).transactions.find((t) => t.bank === 'Raiffeisen' && t.date.startsWith('2026-09') && !t.reference && !t.counterparty?.includes('Raiffeisen'))!;
    const asked = await json<StatementAsk>(api, `${URL_OF}/read`, 'POST');
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal((await json<PdfFactsView>(api, `${URL_OF}/facts`)).body.state, 'asked');
    assert.equal((await json<{ code?: string }>(api, `${URL_OF}/facts`, 'PUT', { statement: septemberTable(pay, 'x', 1) })).status, 409, 'its correction goes to the question');
    await json(api, `${URL_OF}/read`, 'PUT', { statement: septemberTable(pay, 'RF-ASKED', 72000) });
    await json(api, `${URL_OF}/read`, 'DELETE');
    const kept = readBeside(join(api.root, 'transactional-data/2026/bank-statements', FILE));
    assert.ok(kept && 'statement' in kept && kept.statement.closing?.amount === 72000, 'the table as corrected stays the PDF\'s');
    const again = await json<StatementAsk>(api, `${URL_OF}/read`, 'POST');
    assert.equal(again.body.read.statement.closing.amount, 72000, 'asked again, it starts from that table, no model asked');
  } finally {
    await api.stop();
  }
});
