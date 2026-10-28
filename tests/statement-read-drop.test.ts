/**
 * A statement without camt.053 in the drop dialog (#217), through the API on the demo: an invented
 * PDF statement read by the model (the stub answers what a model would, a misread digit first), the
 * balance check refusing it, the corrected table imported through the camt path with the PDF kept
 * beside it and «Rückgängig» taking both out; movements the books hold from a bank export not added
 * twice; the same table filled by hand without AI; a bank CSV read by its columns, kept per account.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DropSession } from '../src/types/drop.js';
import type { BankTransaction, BankStatement } from '../src/types/index.js';
import type { ReadStatement } from '../src/types/statement-read.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import { DEMO_OCTOBER, inventedStatement, type Invented } from './support/statement-pdf.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
const FOLDER = 'transactional-data/2026/bank-statements/Raiffeisen';

async function demo(answer?: ReadStatement): Promise<ApiServer> {
  const api = await startApi('demo', answer ? { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(answer) } : {});
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  return api;
}

const raw = async (api: ApiServer, path: string, body: object) => {
  const r = await api.fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return { status: r.status, json: await r.json() as DropSession & { code?: string; params?: Record<string, unknown> } };
};
const full = async (api: ApiServer) => (await (await api.fetch('/books.json')).json()) as { transactions: BankTransaction[]; bankStatements: BankStatement[] };

test('a PDF statement read by the model: a misread digit fails the check and nothing is imported; the corrected table is imported as a camt.053 beside its PDF; «Rückgängig» takes both out', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const misread: ReadStatement = { ...truth, movements: truth.movements.map((m, i) => (i === 0 ? { ...m, amount: -1240 } : m)) };
  const api = await demo(misread);
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=${encodeURIComponent('Auszug Oktober.pdf')}`, pdf);
    let [row] = s.rows;
    assert.deepEqual([row.kind, row.state, row.reason, row.read?.by], ['statement-pdf', 'asks', 'check-read', 'model']);
    assert.deepEqual(row.read!.check.gaps.map((g) => [g.where, g.page, g.gap]), [['page', 1, 36], ['total', undefined, 36]], 'the gap names its page and how much');
    assert.deepEqual(row.read!.known, [], 'October is not in the books');

    const refused = await raw(api, `/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: misread, import: true });
    assert.equal(refused.status, 400);
    assert.deepEqual([refused.json.code, refused.json.params], ['statementRead', { why: 'gap', gap: 36, currency: 'CHF', page: 1 }]);
    assert.equal(existsSync(join(api.root, FOLDER, 'Auszug Oktober.xml')), false, 'nothing written');

    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: truth });
    assert.deepEqual([s.rows[0].state, s.rows[0].read!.check.ok], ['asks', true], 'the corrected line checks, the row still waits for «Einlesen»');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: truth, import: true });
    [row] = s.rows;
    assert.equal(row.state, 'taken');
    assert.equal(row.statement!.file, 'Raiffeisen/Auszug Oktober.xml');
    assert.equal(row.statement!.refs.length, truth.movements.length);
    assert.ok(existsSync(join(api.root, FOLDER, 'Auszug Oktober.pdf')), 'the PDF it was read from is kept beside it');
    assert.match(readFileSync(join(api.root, FOLDER, 'Auszug Oktober.xml'), 'utf8'), /<AddtlStmtInf>vanilla-accounting:read model Auszug Oktober\.pdf<\/AddtlStmtInf>/);
    await rest();
    const books = await full(api);
    const october = books.transactions.filter((t) => t.bank === 'Raiffeisen' && t.date >= '2026-10-01');
    assert.deepEqual(october.map((t) => (t.direction === 'DBIT' ? -t.amount : t.amount)), truth.movements.map((m) => m.amount));
    assert.equal(october[0].reference, '210000000003139471430009017');
    assert.equal(october[0].counterparty, 'Gruenkaffee Muster AG');
    assert.deepEqual(books.bankStatements.filter((b) => b.filename.startsWith('Auszug Oktober')).map((b) => [b.filename, b.fromDate, b.toDate, b.refs?.length]), [['Auszug Oktober.xml', '2026-10-01', '2026-10-31', 7]], 'listed once, as the camt.053');

    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'undo' });
    assert.equal(s.rows[0].state, 'undone');
    assert.equal(existsSync(join(api.root, FOLDER, 'Auszug Oktober.xml')) || existsSync(join(api.root, FOLDER, 'Auszug Oktober.pdf')), false, 'both files go');
    assert.equal((await full(api)).transactions.some((t) => t.bank === 'Raiffeisen' && t.date >= '2026-10-01'), false, 'and the payments it brought');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('movements a bank export brought already are recognised and not added again; only the statement\'s new ones are', async () => {
  const before = (await import('../src/books/store.js')).loadBooks((await import('../src/workspace/workspace.js')).workspaceAt(DEMO_ROOT)).transactions
    .filter((t) => t.bank === 'Raiffeisen' && t.date >= '2026-09-21' && t.date <= '2026-09-30');
  assert.ok(before.length >= 3, 'the demo has late-September payments');
  const signed = (t: BankTransaction) => (t.direction === 'DBIT' ? -t.amount : t.amount);
  const opening = Math.round((88252.44 - before.reduce((n, t) => n + signed(t), 0)) * 100) / 100;
  const straddling: Invented = {
    ...DEMO_OCTOBER, from: '2026-09-21', to: '2026-10-15', opening, perPage: 20,
    movements: [...before.map((t) => ({ date: t.date, amount: signed(t), text: t.description })), ...DEMO_OCTOBER.movements.filter((m) => m.date <= '2026-10-15')],
  };
  const { pdf, truth } = await inventedStatement(straddling);
  const api = await demo(truth);
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=september-oktober.pdf`, pdf);
    const [row] = s.rows;
    assert.equal(row.read!.check.ok, true);
    assert.equal(row.read!.known.length, before.length, 'the September lines are marked as in the books');
    const had = (await full(api)).transactions.length;
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: truth, import: true });
    assert.equal(s.rows[0].state, 'taken');
    await rest();
    const after = (await full(api)).transactions;
    assert.equal(after.length, had + truth.movements.length - before.length, 'only the new lines are added');
    for (const t of before) assert.equal(after.filter((x) => x.bank === 'Raiffeisen' && x.date === t.date && x.amount === t.amount && x.direction === t.direction).length, before.filter((x) => x.date === t.date && x.amount === t.amount && x.direction === t.direction).length, `${t.ref} once`);
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('without AI the same table is filled by hand and imported the same way', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const api = await demo();
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
    const [row] = s.rows;
    assert.deepEqual([row.state, row.read?.by, row.read?.why, row.read?.statement.iban, row.read?.statement.period, row.read?.statement.movements], ['asks', 'hand', 'noAi', 'CH6580808000000000001', { from: '2026-10-01', to: '2026-10-31' }, []], 'what the text gives is filled in; the movements are typed');
    const half = await raw(api, `/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: { ...truth, movements: [...truth.movements, { date: '2026-10-31', text: 'ohne Betrag' }] }, import: true });
    assert.deepEqual([half.status, half.json.code], [400, 'statementRead']);
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: truth, import: true });
    assert.equal(s.rows[0].state, 'taken');
    await rest();
    assert.match(readFileSync(join(api.root, FOLDER, 'oktober.xml'), 'utf8'), /vanilla-accounting:read hand oktober\.pdf/);
    assert.equal((await full(api)).transactions.filter((t) => t.bank === 'Raiffeisen' && t.date >= '2026-10-01').length, truth.movements.length);
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a bank CSV: its columns are asked once, kept for the account; the next CSV of that header reads by itself', async () => {
  const header = 'Datum;Buchungstext;Betrag;Saldo';
  const october = [header, '02.10.2026;Zahlung Gruenkaffee;-1204.00;87048.44', '05.10.2026;Gutschrift Café Beispiel;2380.50;89428.94'].join('\n');
  const november = [header, '03.11.2026;Miete Lager;-450.00;88978.94'].join('\n');
  const api = await demo();
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=export-oktober.csv`, Buffer.from(october));
    let [row] = s.rows;
    assert.deepEqual([row.kind, row.state, row.reason, row.csv?.columns], ['statement-csv', 'asks', 'csv-columns', { date: 0, balance: 3, amount: 2, text: 1 }], 'the columns its header names, proposed');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'csv', columns: row.csv!.columns, account: '1021' });
    [row] = s.rows;
    assert.deepEqual([row.reason, row.read?.by, row.read?.check.ok, row.read?.statement.opening.amount], ['check-read', 'csv', true, 88252.44]);
    assert.match(readFileSync(join(api.root, 'knowledge/bank-csv.yaml'), 'utf8'), /account: "1021"/);
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: row.read!.statement, import: true });
    assert.equal(s.rows[0].state, 'taken');
    assert.ok(existsSync(join(api.root, FOLDER, 'export-oktober.csv')), 'the CSV is kept beside the camt.053 written from it');
    s = await post(`/api/drop/${s.id}/files?name=export-november.csv`, Buffer.from(november));
    const next = s.rows[1];
    assert.deepEqual([next.state, next.reason, next.account, next.read?.statement.movements.length], ['asks', 'check-read', '1021', 1], 'read by the kept columns, for the person to check');
    await rest();
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});
