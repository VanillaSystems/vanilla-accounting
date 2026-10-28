/**
 * Statements without camt.053 in the drop dialog (#217) and their questions kept in the books (#254),
 * through the API on the demo with invented PDFs (the stub answers what a model would):
 * - an account without camt.053 or CSV (the demo's Raiffeisen with its camt.053 files taken away): the
 *   PDF is kept as its statement at once and its question waits in the books; «Einlesen» writes the
 *   table as a camt.053 beside it, «Rückgängig» takes both out; the question survives closing the
 *   dialog and the account's first camt.053 closes it; that camt.053 takes the movements read before it
 *   (the same day and amount, or a few days off) and keeps one it lacks as a movement of its own;
 * - an account with a camt.053: every PDF is kept without a question, whatever days it shows;
 *   «Bewegungen aus dem PDF einlesen» reads one anyway, its days the camt.053 covers adding nothing new;
 * - the table by hand without AI, empty never «Geht auf»; a bank CSV read by its columns.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DropSession } from '../src/types/drop.js';
import type { BankStatement, BankTransaction, JournalEntry, StatementAsk, StatementImport } from '../src/types/index.js';
import type { ReadStatement } from '../src/types/statement-read.js';
import { toStatementXml } from '../src/providers/statement-read/camt-writer.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import { DEMO_OCTOBER, inventedStatement, type Invented } from './support/statement-pdf.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
const FOLDER = 'transactional-data/2026/bank-statements/Raiffeisen';
const OCTOBER_PDF = 'Kontoauszug 01.10.2026 - 31.10.2026.pdf';
const OCTOBER_XML = 'Kontoauszug 01.10.2026 - 31.10.2026.xml';

/** The demo with the model's answer stubbed; `camt: false` takes the Raiffeisen camt.053 files away, so the account has no structured source. */
async function demo(answer?: ReadStatement, o: { camt?: boolean; prompts?: string } = {}): Promise<ApiServer> {
  const env = answer ? { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(answer), ...(o.prompts ? { CLAUDE_STUB_PROMPTS: o.prompts } : {}) } : {};
  const api = await startApi('demo', env);
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  if (o.camt === false) for (const f of readdirSync(join(api.root, FOLDER)).filter((x) => x.endsWith('.xml'))) rmSync(join(api.root, FOLDER, f));
  return api;
}

const raw = async (api: ApiServer, path: string, body: object) => {
  const r = await api.fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return { status: r.status, json: await r.json() as DropSession & { code?: string; params?: Record<string, unknown> } };
};
type Full = { transactions: BankTransaction[]; bankStatements: BankStatement[]; statementAsks?: StatementAsk[]; journalEntries: JournalEntry[] };
const full = async (api: ApiServer) => (await (await api.fetch('/books.json')).json()) as Full;
const october = (b: Pick<Full, 'transactions'>) => b.transactions.filter((t) => t.bank === 'Raiffeisen' && t.date >= '2026-10-01');
const signed = (t: BankTransaction) => (t.direction === 'DBIT' ? -t.amount : t.amount);
const upload = (api: ApiServer, name: string, body: Buffer, q = '') =>
  api.fetch(`/api/statements?name=${encodeURIComponent(name)}${q}`, { method: 'POST', body: new Uint8Array(body), headers: { 'Content-Type': 'application/octet-stream' } });
const prompted = (path: string) => existsSync(path) && readFileSync(path, 'utf8').includes('bank or card account statement');
const promptsFile = () => join(process.env.TMPDIR ?? '/tmp', `read-prompts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** The bank's own camt.053 of a statement: its movements under the bank's refs, no read mark. */
const bankExport = (s: ReadStatement, id = 'BANK-OCT') =>
  Buffer.from(toStatementXml(s, { id, source: 'x', by: 'model' }).replace(/<AddtlStmtInf>.*<\/AddtlStmtInf>\n/, '').replace(new RegExp(`${id}#(\\d+)`, 'g'), 'BANKREF-$1'));

test('an account without camt.053: the PDF is kept as its statement at once, its question in the books; a misread digit fails the check; the corrected table is read in beside the PDF; «Rückgängig» takes both out', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const misread: ReadStatement = { ...truth, movements: truth.movements.map((m, i) => (i === 0 ? { ...m, amount: -1240 } : m)) };
  const api = await demo(misread, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=${encodeURIComponent('Auszug Oktober.pdf')}`, pdf);
    let [row] = s.rows;
    assert.deepEqual([row.kind, row.state, row.reason, row.read?.by, row.asked?.file], ['statement-pdf', 'asks', 'check-read', 'model', `Raiffeisen/${OCTOBER_PDF}`]);
    assert.ok(existsSync(join(api.root, FOLDER, OCTOBER_PDF)), 'kept as the statement, named by its days');
    assert.deepEqual(row.read!.check.gaps.map((g) => [g.where, g.page, g.gap]), [['page', 1, 36], ['total', undefined, 36]], 'the gap names its page and how much');
    assert.deepEqual((await full(api)).statementAsks?.map((a) => [a.file, a.account, a.read.by]), [[`Raiffeisen/${OCTOBER_PDF}`, '1021', 'model']], 'the question is in the books');

    const refused = await raw(api, `/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: misread, import: true });
    assert.deepEqual([refused.status, refused.json.code, refused.json.params], [400, 'statementRead', { why: 'gap', gap: 36, currency: 'CHF', page: 1 }]);
    assert.equal(existsSync(join(api.root, FOLDER, OCTOBER_XML)), false, 'nothing read in');

    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: truth });
    assert.deepEqual([s.rows[0].state, s.rows[0].read!.check.ok], ['asks', true], 'the corrected line checks, the row still waits for «Einlesen»');
    assert.equal((await full(api)).statementAsks?.[0].read.check.ok, true, 'the books keep the corrected table');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: truth, import: true });
    [row] = s.rows;
    assert.deepEqual([row.state, row.statement?.file, row.asked], ['taken', `Raiffeisen/${OCTOBER_XML}`, undefined]);
    assert.match(readFileSync(join(api.root, FOLDER, OCTOBER_XML), 'utf8'), /<AddtlStmtInf>vanilla-accounting:read model Kontoauszug 01\.10\.2026 - 31\.10\.2026\.pdf<\/AddtlStmtInf>/);
    await rest();
    const books = await full(api);
    assert.equal(books.statementAsks, undefined, 'the question is answered');
    assert.deepEqual(october(books).map(signed), truth.movements.map((m) => m.amount));
    assert.equal(october(books)[0].reference, '210000000003139471430009017');
    assert.deepEqual(books.bankStatements.filter((b) => b.filename.startsWith('Kontoauszug 01.10.2026')).map((b) => [b.filename, b.refs?.length]), [[OCTOBER_XML, 7]], 'listed once, as the camt.053');

    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'undo' });
    assert.equal(s.rows[0].state, 'undone');
    assert.equal(existsSync(join(api.root, FOLDER, OCTOBER_XML)) || existsSync(join(api.root, FOLDER, OCTOBER_PDF)), false, 'both files go');
    assert.deepEqual(october(await full(api)), [], 'and the payments it brought');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('the question survives closing the dialog; the account\'s first camt.053 closes it, the PDF kept as the statement', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const api = await demo(truth, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    const s = await post(`/api/drop/${(await post('/api/drop')).id}/files?name=oktober.pdf`, pdf);
    assert.equal(s.rows[0].asked?.file, `Raiffeisen/${OCTOBER_PDF}`);
    assert.equal((await api.fetch(`/api/drop/${s.id}`, { method: 'DELETE' })).status, 200);
    await rest();
    assert.deepEqual((await full(api)).statementAsks?.map((a) => a.file), [`Raiffeisen/${OCTOBER_PDF}`], 'still asked after the dialog closed');
    const camt = readdirSync(join(DEMO_ROOT, FOLDER)).filter((f) => f.endsWith('.xml')).sort().at(-1)!;
    const r = await upload(api, camt, readFileSync(join(DEMO_ROOT, FOLDER, camt)));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json() as StatementImport).closedAsks, 1);
    await rest();
    const books = await full(api);
    assert.equal(books.statementAsks, undefined, 'closed as «als Auszug behalten»');
    assert.ok(books.bankStatements.some((b) => b.filename === OCTOBER_PDF), 'the PDF stays the statement');
    assert.deepEqual(october(books), [], 'its movements were never read in');
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
  const opening = Math.round((88252.44 - before.reduce((n, t) => n + signed(t), 0)) * 100) / 100;
  return inventedStatement({
    ...DEMO_OCTOBER, from: '2026-09-21', to: '2026-10-15', opening, perPage: 20,
    movements: [...before.map((t) => ({ date: t.date, amount: signed(t), text: t.description })), ...DEMO_OCTOBER.movements.filter((m) => m.date <= '2026-10-15')],
    ...over,
  });
}

test('an account with a camt.053: a PDF is kept as its statement without a question and without the model, whether the camt.053 covers its days or not', async () => {
  const covered = await straddling();
  const { pdf: octPdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const prompts = promptsFile();
  const api = await demo(truth, { prompts });
  try {
    const { post, rest } = SESSION(api);
    const had = (await full(api)).transactions.length;
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=september-oktober.pdf`, covered.pdf);
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, octPdf);
    assert.deepEqual(s.rows.map((r) => [r.state, r.read, r.asked, r.statement?.file]), [
      ['taken', undefined, undefined, 'Raiffeisen/Kontoauszug 21.09.2026 - 15.10.2026.pdf'],
      ['taken', undefined, undefined, `Raiffeisen/${OCTOBER_PDF}`],
    ], 'October has no camt.053 yet: kept all the same');
    await rest();
    assert.equal(prompted(prompts), false, 'the model was not asked to read them');
    const books = await full(api);
    assert.equal(books.transactions.length, had, 'no movement imported');
    assert.equal(books.statementAsks, undefined, 'nothing asked');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a scan whose IBAN only the read gives, of an account with a camt.053: read once to find its account, then kept without a question', async () => {
  const { pdf, truth } = await straddling({ noIban: true });
  const prompts = promptsFile();
  const api = await demo(truth, { prompts });
  try {
    const { post, rest } = SESSION(api);
    const had = (await full(api)).transactions.length;
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=scan.pdf`, pdf);
    const [row] = s.rows;
    assert.deepEqual([row.state, row.read, row.statement?.file], ['taken', undefined, 'Raiffeisen/Kontoauszug 21.09.2026 - 15.10.2026.pdf']);
    await rest();
    assert.equal(prompted(prompts), true, 'the model read it, for its account');
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
  const api = await demo(first.truth, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=okt-1.pdf`, first.pdf);
    s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: first.truth, import: true });
    assert.deepEqual([s.rows[0].state, s.rows[0].statement?.file], ['taken', 'Raiffeisen/Kontoauszug 01.10.2026 - 14.10.2026.xml']);
    await rest();
    const had = (await full(api)).transactions.length;
    s = await post(`/api/drop/${s.id}/files?name=okt-2.pdf`, second.pdf);
    const row = s.rows[1];
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: second.truth });
    assert.deepEqual([s.rows[1].read!.covered, s.rows[1].read!.known.length], [undefined, 2], 'a statement the app wrote is no structured source; its two lines are marked');
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
  const api = await demo(truth, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
    s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: truth, import: true });
    const row = s.rows[0];
    assert.equal(row.state, 'taken');
    await rest();
    const read = october(await full(api));
    const booked = await api.send('POST', '/api/journal-entries', { date: read[3].date, accountDebit: '6000', accountCredit: '1021', amount: 450, description: 'Miete Lager Oktober', transactionRef: read[3].ref });
    assert.equal(booked.status, 200, JSON.stringify(booked.json));
    const r = await upload(api, 'bank-oktober.xml', bankExport(truth));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json() as StatementImport).unmatched, undefined, 'every read movement is the export\'s');
    await rest();
    assert.deepEqual(october(await full(api)).map((t) => t.ref), read.map((t) => t.ref), 'one payment each, under the read\'s ref');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'undo' });
    assert.equal(s.rows[0].state, 'undone');
    await rest();
    const after = await full(api);
    assert.deepEqual(october(after).map((t) => t.ref), truth.movements.map((_, i) => `BANKREF-${i + 1}`), 'every payment the export holds stays, under its ref');
    assert.equal(after.journalEntries.find((e) => e.description === 'Miete Lager Oktober')?.transactionRef, 'BANKREF-4', 'the booking moves with its payment');
    assert.equal(existsSync(join(api.root, FOLDER, OCTOBER_XML)) || existsSync(join(api.root, FOLDER, OCTOBER_PDF)), false, 'the read\'s files go');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('the first camt.053 after a read: a movement read a few days off takes the bank\'s day, ref kept, booking kept, the bank\'s reference; one the camt.053 lacks is kept as a movement of its own for the person, never counted twice', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const extra = { date: '2026-10-16', amount: -25, counterparty: 'Kiosk Beispiel', text: 'Bar bezahlt, falsch gelesen' };
  // The model read the rent on its value date, two days late, and a line the bank does not have.
  const read: ReadStatement = {
    ...truth, closing: { ...truth.closing, amount: Math.round((truth.closing.amount - 25) * 100) / 100 },
    movements: [...truth.movements.map((m, i) => (i === 3 ? { ...m, date: '2026-10-16', reference: undefined } : m)), extra],
  };
  const api = await demo(read, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
    s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: read, import: true });
    assert.equal(s.rows[0].state, 'taken');
    await rest();
    const before = october(await full(api));
    const rent = before.find((t) => t.date === '2026-10-16' && t.amount === 450)!;
    const kiosk = before.find((t) => t.amount === 25)!;
    for (const [t, account, text] of [[rent, '6000', 'Miete'], [kiosk, '6500', 'Kiosk']] as const) {
      const b = await api.send('POST', '/api/journal-entries', { date: t.date, accountDebit: account, accountCredit: '1021', amount: t.amount, description: text, transactionRef: t.ref });
      assert.equal(b.status, 200, JSON.stringify(b.json));
    }
    const bank = { ...truth, movements: truth.movements.map((m, i) => (i === 3 ? { ...m, reference: 'RF18539007547034' } : m)) };
    const r = await upload(api, 'bank-oktober.xml', bankExport(bank));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json() as StatementImport).unmatched, 1);
    await rest();
    const after = await full(api);
    assert.equal(october(after).length, truth.movements.length + 1, 'the bank\'s seven, and the one it lacks; nothing twice');
    const moved = october(after).find((t) => t.ref === rent.ref)!;
    assert.deepEqual([moved.date, moved.reference, moved.source], ['2026-10-14', 'RF18539007547034', undefined], 'the bank\'s day and reference, the read\'s ref');
    assert.equal(after.journalEntries.find((e) => e.description === 'Miete')?.transactionRef, rent.ref, 'its booking stays on it');
    const kept = october(after).find((t) => t.ref === kiosk.ref)!;
    assert.deepEqual([kept.source, kept.unmatched?.by], ['manual', 'Raiffeisen/bank-oktober.xml'], 'kept as a movement of its own, marked');
    assert.equal(after.journalEntries.find((e) => e.description === 'Kiosk')?.transactionRef, kiosk.ref, 'its booking stays too');
    assert.equal(readFileSync(join(api.root, FOLDER, OCTOBER_XML), 'utf8').includes('Kiosk Beispiel'), false, 'the read statement no longer holds it');
    const keep = await api.send('POST', `/api/transactions/${encodeURIComponent(kiosk.ref)}/kept`);
    assert.equal(keep.status, 200, JSON.stringify(keep.json));
    assert.equal(october(await full(api)).find((t) => t.ref === kiosk.ref)?.unmatched, undefined, '«Behalten»: the mark goes, the movement stays');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('«Bewegungen aus dem PDF einlesen» on a PDF kept as the statement: read, corrected, read in beside it, and taken back with the PDF kept; on days the camt.053 covers only the payments the books hold', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const api = await demo(truth);
  try {
    const kept = await upload(api, 'oktober.pdf', pdf);
    assert.equal(kept.status, 200, await kept.clone().text());
    const file = (await kept.json() as StatementImport).file;
    assert.equal(file, `Raiffeisen/${OCTOBER_PDF}`, 'an account with a camt.053: kept without the drop dialog');
    const path = `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/read`;
    const asked = await api.send('POST', path);
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    const ask = asked.json as unknown as StatementAsk;
    assert.deepEqual([ask.read.by, ask.read.check.ok, ask.read.covered], ['model', true, undefined], 'October: no camt.053 days');
    const corrected = await api.send('PUT', path, { statement: { ...truth, movements: truth.movements.slice(0, 1) } });
    assert.equal((corrected.json as unknown as StatementAsk).read.check.ok, false, 'checked again on every change');
    const done = await api.send('POST', `${path}/import`, { statement: truth });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const books = await full(api);
    assert.equal(october(books).length, truth.movements.length);
    assert.equal(books.statementAsks, undefined);
    const xml = (done.json as unknown as StatementImport).file;
    assert.equal(xml, `Raiffeisen/${OCTOBER_XML}`);
    const undone = await api.fetch(`/api/statements/${xml.split('/').map(encodeURIComponent).join('/')}?keepPdf=1`, { method: 'DELETE' });
    assert.equal(undone.status, 200, await undone.clone().text());
    assert.deepEqual([existsSync(join(api.root, FOLDER, OCTOBER_XML)), existsSync(join(api.root, FOLDER, OCTOBER_PDF))], [false, true], 'the reading goes, the PDF stays the statement');
    assert.deepEqual(october(await full(api)), []);

    const { pdf: straddle, truth: both } = await straddling();
    const r = await upload(api, 'sept-okt.pdf', straddle);
    assert.equal(r.status, 200, await r.clone().text());
    const second = (await r.json() as StatementImport).file;
    assert.equal((await api.send('POST', `/api/statements/${second.split('/').map(encodeURIComponent).join('/')}/read`)).status, 200);
    // The stub reads every PDF as October: the person types the table the PDF shows.
    const read = await api.send('PUT', `/api/statements/${second.split('/').map(encodeURIComponent).join('/')}/read`, { statement: both });
    const covered = (read.json as unknown as StatementAsk).read;
    assert.deepEqual([covered.covered?.map((c) => [c.from, c.to]), covered.whole], [[['2026-09-21', '2026-09-30']], undefined], 'it says which days the account has, not all');
    const had = (await full(api)).transactions.length;
    const into = await api.send('POST', `/api/statements/${second.split('/').map(encodeURIComponent).join('/')}/read/import`, { statement: both });
    assert.equal(into.status, 200, JSON.stringify(into.json));
    assert.equal((await full(api)).transactions.length, had + DEMO_OCTOBER.movements.filter((m) => m.date <= '2026-10-15').length, 'only October\'s lines are new; September\'s are the camt.053\'s');
  } finally {
    await api.stop();
  }
});

test('Kontoauszüge › upload: a PDF of an account without camt.053 goes to the drop dialog to be read; kept as the month\'s statement on its undo', async () => {
  const oct = await inventedStatement(DEMO_OCTOBER);
  const api = await demo(undefined, { camt: false });
  try {
    const refused = await upload(api, 'oktober.pdf', oct.pdf);
    const body = await refused.json() as { code: string; params: { reason: string } };
    assert.deepEqual([refused.status, body.code, body.params.reason], [409, 'statement', 'read']);
    assert.equal(existsSync(join(api.root, FOLDER, 'oktober.pdf')), false, 'nothing written');
    const kept = await upload(api, 'oktober.pdf', oct.pdf, '&account=1021&month=2026-10&keep=1');
    assert.equal(kept.status, 200, await kept.clone().text());
  } finally {
    await api.stop();
  }
});

test('a file of the same name in the statements folder is never taken up nor removed; a statement of an account the books lack is not read in', async () => {
  const { pdf: own, truth } = await inventedStatement(DEMO_OCTOBER);
  const { pdf: other, truth: foreign } = await inventedStatement({ ...DEMO_OCTOBER, iban: 'CH8180808000000000004' });
  for (const [answer, pdf, imports] of [[truth, own, true], [foreign, other, false]] as const) {
    const api = await demo(answer, { camt: false });
    try {
      writeFileSync(join(api.root, FOLDER, 'oktober.pdf'), 'kept earlier');
      const { post, rest } = SESSION(api);
      let s = await post('/api/drop');
      s = await post(`/api/drop/${s.id}/files?name=${encodeURIComponent('scan oktober.pdf')}`, Buffer.from(pdf));
      if (imports) {
        s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: answer, import: true });
        assert.deepEqual([s.rows[0].state, s.rows[0].statement?.file], ['taken', `Raiffeisen/${OCTOBER_XML}`]);
        await rest();
        s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'undo' });
        assert.equal(existsSync(join(api.root, FOLDER, OCTOBER_PDF)), false, 'what the read wrote goes');
      } else {
        assert.deepEqual([s.rows[0].state, s.rows[0].asked], ['asks', undefined], 'an account the books lack: the row asks, nothing kept');
        const refused = await raw(api, `/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: answer, import: true });
        assert.notEqual(refused.json.rows?.[0]?.state, 'taken', 'not imported');
      }
      await rest();
      assert.equal(readFileSync(join(api.root, FOLDER, 'oktober.pdf'), 'utf8'), 'kept earlier', 'the file that was there stays as it was');
    } finally {
      await SESSION(api).rest().catch(() => {});
      await api.stop();
    }
  }
});

test('without AI the table is filled by hand: an empty one checks nothing and is not read in; filled, it is read in the same way', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const api = await demo(undefined, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
    const [row] = s.rows;
    assert.deepEqual([row.state, row.read?.by, row.read?.statement.iban, row.read?.statement.period, row.read?.statement.movements], ['asks', 'hand', 'CH6580808000000000001', { from: '2026-10-01', to: '2026-10-31' }, []], 'what the text gives is filled in; the movements are typed');
    assert.ok(row.read?.why === 'noAi' || row.read?.why === 'noProvider', `why the hand: ${row.read?.why}`);
    assert.equal(row.asked?.file, `Raiffeisen/${OCTOBER_PDF}`, 'its text names the account and days: kept, the question in the books');
    const blank = await raw(api, `/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: row.read!.statement, import: true });
    assert.deepEqual([blank.status, blank.json.code, blank.json.params?.why], [400, 'statementRead', 'blank'], 'an empty table is not read in');
    const half = await raw(api, `/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: { ...truth, movements: [...truth.movements, { date: '2026-10-31', text: 'ohne Betrag' }] }, import: true });
    assert.deepEqual([half.status, half.json.code], [400, 'statementRead']);
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: truth, import: true });
    assert.equal(s.rows[0].state, 'taken');
    await rest();
    assert.match(readFileSync(join(api.root, FOLDER, OCTOBER_XML), 'utf8'), /vanilla-accounting:read hand Kontoauszug 01\.10\.2026 - 31\.10\.2026\.pdf/);
    assert.equal(october(await full(api)).length, truth.movements.length);
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a bank CSV: its columns are asked once, kept for the account; the next CSV of that header reads by itself', async () => {
  const header = 'Datum;Buchungstext;Betrag;Saldo';
  const oct = [header, '02.10.2026;Zahlung Gruenkaffee;-1204.00;87048.44', '05.10.2026;Gutschrift Café Beispiel;2380.50;89428.94'].join('\n');
  const nov = [header, '03.11.2026;Miete Lager;-450.00;88978.94'].join('\n');
  const api = await demo();
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=export-oktober.csv`, Buffer.from(oct));
    let [row] = s.rows;
    assert.deepEqual([row.kind, row.state, row.reason, row.csv?.columns], ['statement-csv', 'asks', 'csv-columns', { date: 0, balance: 3, amount: 2, text: 1 }], 'the columns its header names, proposed');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'csv', columns: row.csv!.columns, account: '1021' });
    [row] = s.rows;
    assert.deepEqual([row.reason, row.read?.by, row.read?.check.ok, row.read?.statement.opening.amount], ['check-read', 'csv', true, 88252.44]);
    assert.match(readFileSync(join(api.root, 'knowledge/bank-csv.yaml'), 'utf8'), /account: "1021"/);
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'read', statement: row.read!.statement, import: true });
    assert.equal(s.rows[0].state, 'taken');
    assert.ok(existsSync(join(api.root, FOLDER, 'export-oktober.csv')), 'the CSV is kept beside the camt.053 written from it');
    s = await post(`/api/drop/${s.id}/files?name=export-november.csv`, Buffer.from(nov));
    const next = s.rows[1];
    assert.deepEqual([next.state, next.reason, next.account, next.read?.statement.movements.length], ['asks', 'check-read', '1021', 1], 'read by the kept columns, for the person to check');
    await rest();
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});
