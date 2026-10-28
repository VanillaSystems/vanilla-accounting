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
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DropSession } from '../src/types/drop.js';
import type { BankTransaction, BankStatement, StatementClosingBalance } from '../src/types/index.js';
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
const full = async (api: ApiServer) => (await (await api.fetch('/books.json')).json()) as { transactions: BankTransaction[]; bankStatements: BankStatement[]; statementBalances?: StatementClosingBalance[] };

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

/** The demo's late-September Raiffeisen payments (its camt.053 covers September) and an invented statement from 21 September to 15 October holding them. */
async function straddling(over: Partial<Invented> = {}) {
  const before = (await import('../src/books/store.js')).loadBooks((await import('../src/workspace/workspace.js')).workspaceAt(DEMO_ROOT)).transactions
    .filter((t) => t.bank === 'Raiffeisen' && t.date >= '2026-09-21' && t.date <= '2026-09-30');
  assert.ok(before.length >= 3, 'the demo has late-September payments');
  const signed = (t: BankTransaction) => (t.direction === 'DBIT' ? -t.amount : t.amount);
  const opening = Math.round((88252.44 - before.reduce((n, t) => n + signed(t), 0)) * 100) / 100;
  return inventedStatement({
    ...DEMO_OCTOBER, from: '2026-09-21', to: '2026-10-15', opening, perPage: 20,
    movements: [...before.map((t) => ({ date: t.date, amount: signed(t), text: t.description })), ...DEMO_OCTOBER.movements.filter((m) => m.date <= '2026-10-15')],
    ...over,
  });
}

test('a statement PDF whose text shows days a bank camt.053 covers is kept as the month\'s statement, as before: not read, no movement imported', async () => {
  const { pdf, truth } = await straddling();
  const prompts = join(process.env.TMPDIR ?? '/tmp', `read-prompts-${process.pid}-${Date.now()}`);
  const api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(truth), CLAUDE_STUB_PROMPTS: prompts });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  try {
    const { post, rest } = SESSION(api);
    const had = (await full(api)).transactions.length;
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=september-oktober.pdf`, pdf);
    const [row] = s.rows;
    assert.deepEqual([row.state, row.read, row.statement?.file], ['taken', undefined, 'Raiffeisen/Kontoauszug 01.10.2026 - 31.10.2026.pdf']);
    assert.equal(existsSync(prompts) && readFileSync(prompts, 'utf8').includes('bank or card account statement'), false, 'the drop does not ask the model to read it');
    await rest();
    // The run reads it once for what the bank export lacks (#243), kept beside it; the demo's statements have their reads already.
    assert.equal(readFileSync(prompts, 'utf8').split('bank or card account statement').length - 1, 1, 'the run reads the kept PDF, and only it');
    const kept = join(api.root, 'transactional-data', '2026', 'bank-statements', row.statement!.file.replace(/\.pdf$/, '.read.json'));
    assert.equal(existsSync(kept), true, 'its read lies beside it');
    const books = await full(api);
    assert.equal(books.transactions.length, had, 'no movement imported');
    assert.deepEqual(books.statementBalances?.filter((b) => b.sourceFile === row.statement!.file.split('/')[1]).map((b) => [b.account, b.date, b.amount]), [['1021', truth.closing.date, truth.closing.amount]], 'its closing balance closes the day it ends');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a scan whose IBAN only the read gives, of days a bank camt.053 covers: no movement is imported, even the lines that match; the row says so and keeps it as the month\'s statement', async () => {
  const { pdf, truth } = await straddling({ noIban: true });
  const api = await demo(truth);
  try {
    const { post, rest } = SESSION(api);
    const had = (await full(api)).transactions.length;
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=scan.pdf`, pdf);
    let [row] = s.rows;
    assert.deepEqual([row.state, row.read?.by, row.read?.check.ok], ['asks', 'model', true]);
    assert.match(row.read!.covered!.file, /^Raiffeisen\/.*\.xml$/, 'the bank export that covers its days');
    const refused = await raw(api, `/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: truth, import: true });
    assert.deepEqual([refused.status, refused.json.code, refused.json.params?.why], [400, 'statementRead', 'covered']);
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'keep', statement: truth });
    [row] = s.rows;
    assert.deepEqual([row.state, row.statement?.file], ['taken', 'Raiffeisen/Kontoauszug 01.10.2026 - 31.10.2026.pdf']);
    await rest();
    assert.equal((await full(api)).transactions.length, had, 'nothing doubled, nothing added');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('lines an earlier read statement brought are recognised and not added again; only the new ones are', async () => {
  const first = await inventedStatement({ ...DEMO_OCTOBER, to: '2026-10-14', movements: DEMO_OCTOBER.movements.slice(0, 4) });
  const rest4 = DEMO_OCTOBER.movements.slice(2);
  const secondOpening = Math.round((DEMO_OCTOBER.opening + DEMO_OCTOBER.movements.slice(0, 2).reduce((n, m) => n + m.amount, 0)) * 100) / 100;
  const second = await inventedStatement({ ...DEMO_OCTOBER, from: '2026-10-08', opening: secondOpening, movements: rest4 });
  const api = await demo(first.truth);
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=okt-1.pdf`, first.pdf);
    s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: first.truth, import: true });
    assert.equal(s.rows[0].state, 'taken');
    await rest();
    const had = (await full(api)).transactions.length;
    s = await post(`/api/drop/${s.id}/files?name=okt-2.pdf`, second.pdf);
    const row = s.rows[1];
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: second.truth });
    assert.deepEqual([s.rows[1].read!.covered, s.rows[1].read!.known.length], [undefined, 2], 'a statement the app wrote is no bank export; its two lines are marked');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: second.truth, import: true });
    assert.equal(s.rows[1].state, 'taken');
    await rest();
    assert.equal((await full(api)).transactions.length, had + rest4.length - 2, 'only the new lines are added');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('read first, the bank\'s camt.053 of the same days later, then the read statement taken back: every payment stays with its booking, under the export\'s ref', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const api = await demo(truth);
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
    s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: truth, import: true });
    const row = s.rows[0];
    assert.equal(row.state, 'taken');
    await rest();
    const october = (b: { transactions: BankTransaction[] }) => b.transactions.filter((t) => t.bank === 'Raiffeisen' && t.date >= '2026-10-01');
    const read = october(await full(api));
    const booked = await api.send('POST', '/api/journal-entries', { date: read[3].date, accountDebit: '6000', accountCredit: '1021', amount: 450, description: 'Miete Lager Oktober', transactionRef: read[3].ref });
    assert.equal(booked.status, 200, JSON.stringify(booked.json));
    // The bank's own export of October: the same movements under the bank's refs, no read mark.
    const xml = readFileSync(join(api.root, FOLDER, 'oktober.xml'), 'utf8').replace(/<AddtlStmtInf>.*<\/AddtlStmtInf>\n/, '')
      .replace(/read-[^<#]+#(\d+)/g, 'BANKREF-$1').replace(/<Id>read-[^<]+<\/Id>/g, '<Id>BANK-OCT</Id>').replace(/<MsgId>[^<]+<\/MsgId>/, '<MsgId>BANK-OCT</MsgId>');
    const r = await api.fetch('/api/statements?name=bank-oktober.xml', { method: 'POST', body: new Uint8Array(Buffer.from(xml)), headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 200, await r.clone().text());
    await rest();
    assert.deepEqual(october(await full(api)).map((t) => t.ref), read.map((t) => t.ref), 'one payment each, under the read\'s ref');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'undo' });
    assert.equal(s.rows[0].state, 'undone');
    await rest();
    const after = await full(api);
    assert.deepEqual(october(after).map((t) => t.ref), truth.movements.map((_, i) => `BANKREF-${i + 1}`), 'every payment the export holds stays, under its ref');
    const entry = (after as unknown as { journalEntries: { transactionRef: string; description: string }[] }).journalEntries.find((e) => e.description === 'Miete Lager Oktober');
    assert.equal(entry?.transactionRef, 'BANKREF-4', 'the booking moves with its payment');
    assert.equal(existsSync(join(api.root, FOLDER, 'oktober.xml')) || existsSync(join(api.root, FOLDER, 'oktober.pdf')), false, 'the read\'s files go');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a file of the same name in the statements folder is never taken up nor removed: the read writes under a name of its own; a refused import leaves it too', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const foreign = { ...truth, iban: 'CH8180808000000000004' };
  for (const [answer, imports] of [[truth, true], [foreign, false]] as const) {
    const api = await demo(answer);
    try {
      writeFileSync(join(api.root, FOLDER, 'oktober.pdf'), 'kept earlier');
      const { post, rest } = SESSION(api);
      let s = await post('/api/drop');
      s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
      s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: answer, import: true });
      const row = s.rows[0];
      if (imports) {
        assert.deepEqual([row.state, row.statement?.file], ['taken', 'Raiffeisen/oktober-2.xml']);
        assert.ok(existsSync(join(api.root, FOLDER, 'oktober-2.pdf')));
        await rest();
        s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'undo' });
        assert.equal(existsSync(join(api.root, FOLDER, 'oktober-2.pdf')), false, 'what the read wrote goes');
      } else {
        assert.notEqual(row.state, 'taken', 'an account the books lack: not imported');
        assert.equal(existsSync(join(api.root, FOLDER, 'oktober-2.xml')) || existsSync(join(api.root, FOLDER, 'oktober-2.pdf')), false);
      }
      await rest();
      assert.equal(readFileSync(join(api.root, FOLDER, 'oktober.pdf'), 'utf8'), 'kept earlier', 'the file that was there stays as it was');
    } finally {
      await SESSION(api).rest().catch(() => {});
      await api.stop();
    }
  }
});

test('Kontoauszüge › upload: a PDF no camt.053 covers goes to the drop dialog to be read; kept as the month\'s statement on its undo; one a camt.053 covers is kept as before', async () => {
  const october = await inventedStatement(DEMO_OCTOBER);
  const covered = await straddling();
  const api = await demo();
  try {
    const up = (name: string, body: Buffer, q = '') => api.fetch(`/api/statements?name=${encodeURIComponent(name)}${q}`, { method: 'POST', body: new Uint8Array(body), headers: { 'Content-Type': 'application/octet-stream' } });
    const refused = await up('oktober.pdf', october.pdf);
    const body = await refused.json() as { code: string; params: { reason: string } };
    assert.deepEqual([refused.status, body.code, body.params.reason], [409, 'statement', 'read']);
    assert.equal(existsSync(join(api.root, FOLDER, 'oktober.pdf')), false, 'nothing written');
    const kept = await up('oktober.pdf', october.pdf, '&account=1021&month=2026-10&keep=1');
    assert.equal(kept.status, 200, await kept.clone().text());
    const old = await up('september-oktober.pdf', covered.pdf, '&account=1021&month=2026-09');
    assert.equal(old.status, 200, await old.clone().text());
  } finally {
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
