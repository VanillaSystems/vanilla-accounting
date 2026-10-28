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
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DropSession } from '../src/types/drop.js';
import type { BankStatement, BankTransaction, JournalEntry, StatementAsk, StatementImport } from '../src/types/index.js';
import type { ReadStatement } from '../src/types/statement-read.js';
import { toStatementXml } from '../src/providers/statement-read/camt-writer.js';
import type { TwinOption } from '../src/books/twins.js';
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
type Full = { transactions: BankTransaction[]; bankStatements: BankStatement[]; statementAsks?: StatementAsk[]; journalEntries: JournalEntry[]; twins?: Record<string, TwinOption[]> };
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

/** An entry the app booked (as the inbox run writes it), put into the books' file directly. */
const appEntry = (api: ApiServer, e: Pick<JournalEntry, 'id' | 'transactionRef' | 'date' | 'amount'> & Partial<JournalEntry>) =>
  appendFileSync(join(api.root, 'transactional-data', e.date.slice(0, 4), 'books', 'entries.jsonl'), `${JSON.stringify({ accountDebit: '6000', accountCredit: '1021', vatCode: 'I0', description: e.id, origin: 'classify', ...e })}\n`);

test('the first camt.053 after a read: a movement read a few days off takes the bank\'s day, ref kept, the app\'s booking moving with it, the bank\'s reference; one a person booked is asked; one the camt.053 lacks is kept as a movement of its own for the person, never counted twice', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const extra = { date: '2026-10-16', amount: -25, counterparty: 'Kiosk Beispiel', text: 'Bar bezahlt, falsch gelesen' };
  // The model read the rent and the Coop purchase on their value dates, two days late, and a line the bank does not have.
  const read: ReadStatement = {
    ...truth, closing: { ...truth.closing, amount: Math.round((truth.closing.amount - 25) * 100) / 100 },
    movements: [...truth.movements.map((m, i) => (i === 3 ? { ...m, date: '2026-10-16', reference: undefined } : i === 2 ? { ...m, date: '2026-10-11' } : m)), extra],
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
    const coop = before.find((t) => t.date === '2026-10-11' && t.amount === 86.4)!;
    const kiosk = before.find((t) => t.amount === 25)!;
    appEntry(api, { id: 'app-rent', transactionRef: rent.ref, date: rent.date, amount: 450 });
    for (const [t, account, text] of [[coop, '4200', 'Coop'], [kiosk, '6500', 'Kiosk']] as const) {
      const b = await api.send('POST', '/api/journal-entries', { date: t.date, accountDebit: account, accountCredit: '1021', amount: t.amount, description: text, transactionRef: t.ref });
      assert.equal(b.status, 200, JSON.stringify(b.json));
    }
    const bank = { ...truth, movements: truth.movements.map((m, i) => (i === 3 ? { ...m, reference: 'Mietvertrag Lager 7' } : m)) };
    const r = await upload(api, 'bank-oktober.xml', bankExport(bank));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json() as StatementImport).unmatched, 2);
    await rest();
    const after = await full(api);
    const moved = october(after).find((t) => t.ref === rent.ref)!;
    assert.deepEqual([moved.date, moved.reference, moved.source], ['2026-10-14', 'Mietvertrag Lager 7', undefined], 'the bank\'s day and reference, the read\'s ref');
    assert.deepEqual(after.journalEntries.filter((e) => e.id === 'app-rent').map((e) => [e.transactionRef, e.date]), [[rent.ref, '2026-10-14']], 'the app\'s booking stays on it, on the bank\'s day');
    // The Coop purchase a person booked on the read day is not moved by the app: the person is asked.
    const asked = october(after).find((t) => t.ref === coop.ref)!;
    assert.deepEqual([asked.date, asked.unmatched?.by], ['2026-10-11', 'Raiffeisen/bank-oktober.xml']);
    const booked = new Set(after.journalEntries.map((e) => e.transactionRef));
    assert.deepEqual(after.twins?.[coop.ref], [{ pdf: [coop.ref], bank: ['BANKREF-3'] }], '«Ist das dieselbe Zahlung?» names the bank\'s movement');
    assert.equal(booked.has('BANKREF-3'), false, 'the bank\'s movement waits, unbooked');
    const same = await api.send('POST', `/api/transactions/${encodeURIComponent(coop.ref)}/same`, { bank: ['BANKREF-3'] });
    assert.equal(same.status, 200, JSON.stringify(same.json));
    const answered = await full(api);
    assert.equal(answered.transactions.some((t) => t.ref === coop.ref), false, 'the read movement goes');
    assert.deepEqual(answered.journalEntries.filter((e) => e.description === 'Coop').map((e) => [e.transactionRef, e.date, e.origin]), [['BANKREF-3', '2026-10-09', 'manual']], 'her booking moves to the bank\'s movement and day, by her answer');
    assert.equal(october(answered).length, truth.movements.length + 1, 'the bank\'s seven, and the one it lacks; nothing twice');
    const kept = october(answered).find((t) => t.ref === kiosk.ref)!;
    assert.deepEqual([kept.source, kept.unmatched?.by], ['manual', 'Raiffeisen/bank-oktober.xml'], 'kept as a movement of its own, marked');
    assert.equal(answered.journalEntries.find((e) => e.description === 'Kiosk')?.transactionRef, kiosk.ref, 'its booking stays too');
    assert.equal(readFileSync(join(api.root, FOLDER, OCTOBER_XML), 'utf8').includes('Kiosk Beispiel'), false, 'the read statement no longer holds it');
    const keep = await api.send('POST', `/api/transactions/${encodeURIComponent(kiosk.ref)}/kept`);
    assert.equal(keep.status, 200, JSON.stringify(keep.json));
    assert.equal(october(await full(api)).find((t) => t.ref === kiosk.ref)?.unmatched, undefined, '«Behalten»: the mark goes, the movement stays');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a payment the PDF printed a few Rappen off the bank\'s: the bank\'s movement waits for «Ist das dieselbe Zahlung?», unbooked; a person\'s booking of the other amount refuses «Ja, dieselbe» until changed; then the bank\'s movement stays alone', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  // The Coop purchase read as 86.35; the bank booked 86.40.
  const { pages: _, ...whole } = truth;
  const read: ReadStatement = { ...whole, closing: { ...truth.closing, amount: Math.round((truth.closing.amount + 0.05) * 100) / 100 }, movements: truth.movements.map((m, i) => (i === 2 ? { ...m, amount: -86.35 } : m)) };
  const api = await demo(read, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
    s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: read, import: true });
    await rest();
    const coop = october(await full(api)).find((t) => t.amount === 86.35)!;
    const hers = await api.send('POST', '/api/journal-entries', { date: coop.date, accountDebit: '4200', accountCredit: '1021', amount: 86.35, description: 'Coop', transactionRef: coop.ref });
    assert.equal(hers.status, 200, JSON.stringify(hers.json));
    const r = await upload(api, 'bank-oktober.xml', bankExport(truth));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json() as StatementImport).unmatched, 1);
    await rest();
    const after = await full(api);
    assert.equal(after.journalEntries.some((e) => e.transactionRef === 'BANKREF-3'), false, 'not booked while asked: the purchase is not counted twice');
    const asked = await api.send('POST', `/api/transactions/${encodeURIComponent(coop.ref)}/same`, { bank: ['BANKREF-3'] });
    assert.deepEqual([asked.status, asked.json.code], [409, 'twinBookedByHand'], 'her booking of 86.35 is hers to change first');
    const entry = after.journalEntries.find((e) => e.description === 'Coop')!;
    assert.equal((await api.fetch(`/api/journal-entries/${entry.id}`, { method: 'DELETE' })).status, 200);
    const same = await api.send('POST', `/api/transactions/${encodeURIComponent(coop.ref)}/same`, { bank: ['BANKREF-3'] });
    assert.equal(same.status, 200, JSON.stringify(same.json));
    const answered = await full(api);
    assert.deepEqual(october(answered).map((t) => t.ref).filter((ref) => ref === coop.ref), [], 'the read movement goes');
    assert.equal(october(answered).length, truth.movements.length);
    assert.equal(answered.transactions.find((t) => t.ref === 'BANKREF-3')?.amount, 86.4, 'the bank\'s amount stays');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a read movement of a filed day and the bank\'s camt.053 from the first open day: the rent a few days later and the purchase a few Rappen off wait for «Ist das dieselbe Zahlung?», «Automatisch buchen» refused; «Ja, dieselbe» books only the 5 Rappen; marked, no booking takes it without «Trotzdem buchen»; the filed side never changes', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  // The PDF printed the Coop purchase on 3 October at 86.35 and the rent on 8 October; the bank booked 86.40 on the 9th and the rent on the 14th.
  const { pages: _, ...whole } = truth;
  const read: ReadStatement = {
    ...whole, closing: { ...truth.closing, amount: Math.round((truth.closing.amount + 0.05) * 100) / 100 },
    movements: truth.movements.map((m, i) => (i === 2 ? { ...m, date: '2026-10-03', amount: -86.35 } : i === 3 ? { ...m, date: '2026-10-08' } : m)),
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
    const coop = before.find((t) => t.date === '2026-10-03' && t.amount === 86.35)!;
    const rent = before.find((t) => t.date === '2026-10-08' && t.amount === 450)!;
    const booked = new Set((await full(api)).journalEntries.map((e) => e.transactionRef));
    for (const t of [coop, rent]) if (!booked.has(t.ref)) appEntry(api, { id: `app-${t.ref}`, transactionRef: t.ref, date: t.date, amount: t.amount });
    // The days through 8 October filed.
    const ledger = join(api.root, 'ledger.json');
    const config = JSON.parse(readFileSync(ledger, 'utf8'));
    writeFileSync(ledger, JSON.stringify({ ...config, config: { ...config.config, closedThrough: '2026-10-08' } }, null, 2));
    const filedDays = (b: Full) => b.transactions.filter((t) => t.bank === 'Raiffeisen' && t.date >= '2026-10-01' && t.date <= '2026-10-08');
    const filed = filedDays(await full(api));

    // The bank's export starts on the first open day, as the import asks.
    const open = truth.movements.filter((m) => m.date >= '2026-10-09');
    const opening = Math.round((truth.opening.amount + truth.movements.filter((m) => m.date < '2026-10-09').reduce((n, m) => n + m.amount, 0)) * 100) / 100;
    const r = await upload(api, 'bank-oktober.xml', bankExport({ ...whole, period: { from: '2026-10-09', to: '2026-10-31' }, opening: { date: '2026-10-09', amount: opening }, movements: open }));
    assert.equal(r.status, 200, await r.clone().text());
    await rest();
    const after = await full(api);
    assert.deepEqual(filedDays(after), filed, 'nothing of the filed days changed');
    const bankRent = october(after).find((t) => t.date === '2026-10-14' && t.amount === 450)!;
    const bankCoop = october(after).find((t) => t.date === '2026-10-09' && t.amount === 86.4)!;
    assert.deepEqual([after.twins?.[rent.ref], after.twins?.[coop.ref]], [[{ pdf: [rent.ref], bank: [bankRent.ref], filed: true }], [{ pdf: [coop.ref], bank: [bankCoop.ref], filed: true }]], 'both asked, though the export starts after their days');
    assert.equal(after.journalEntries.some((e) => e.transactionRef === bankRent.ref || e.transactionRef === bankCoop.ref), false, 'neither is booked a second time');

    const auto = await api.send('POST', `/api/journal-entries/classify/${bankRent.ref}`, {});
    assert.deepEqual([auto.status, auto.json.code, (auto.json.params as { read?: string } | undefined)?.read], [409, 'twinHeld', rent.ref], '«Automatisch buchen» points to the open question');
    for (const [t, bank] of [[rent, bankRent], [coop, bankCoop]] as const) {
      const same = await api.send('POST', `/api/transactions/${encodeURIComponent(t.ref)}/same`, { bank: [bank.ref] });
      assert.equal(same.status, 200, JSON.stringify(same.json));
    }
    await rest();
    const answered = await full(api);
    assert.deepEqual([bankRent, bankCoop].map((b) => answered.transactions.find((t) => t.ref === b.ref)?.waitsForPerson?.why), ['filedTwin', 'filedTwin'], '«Ja, dieselbe: nicht nochmals buchen»');
    assert.deepEqual(filedDays(answered), filed, 'the filed read movements stay as filed');
    assert.equal(answered.journalEntries.some((e) => e.transactionRef === bankRent.ref), false, 'the rent: nothing booked');
    assert.deepEqual(answered.journalEntries.filter((e) => e.transactionRef === bankCoop.ref).map((e) => [e.date, e.accountCredit, e.amount, e.vatCode, e.origin]), [['2026-10-09', '1021', 0.05, undefined, 'manual']],
      'the purchase: only the 5 Rappen the bank booked more, without VAT, so the account meets the bank\'s balance');

    const again = await api.send('POST', `/api/journal-entries/classify/${bankRent.ref}`, {});
    assert.deepEqual([again.status, again.json.code, (again.json.params as { date?: string } | undefined)?.date], [409, 'bookedInFiled', '2026-10-08'], '«Automatisch buchen» refused, naming the filed movement');
    const line = { accountDebit: '6000', accountCredit: '1021', amount: 450, description: 'Miete' };
    const byHand = await api.send('POST', `/api/transactions/${encodeURIComponent(bankRent.ref)}/entries`, { lines: [line] });
    assert.deepEqual([byHand.status, byHand.json.code], [409, 'bookedInFiled'], 'a booking by hand asks first');
    const anyway = await api.send('DELETE', `/api/transactions/${encodeURIComponent(bankRent.ref)}/filed-twin`);
    assert.equal(anyway.status, 200, JSON.stringify(anyway.json));
    const own = await api.send('POST', `/api/transactions/${encodeURIComponent(bankRent.ref)}/entries`, { lines: [line] });
    assert.equal(own.status, 200, '«Trotzdem buchen»: a payment of its own, booked like any other');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});

test('a read movement on a day before the bank\'s export and its payment two days later inside it: asked, whatever the export covers; «Nein, eine eigene Zahlung» takes it out of the read statement, kept with its ref, and the bank\'s is free', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const { pages: _, ...whole } = truth;
  const api = await demo(whole, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
    s = await post(`/api/drop/${s.id}/rows/${s.rows[0].key}`, { kind: 'read', statement: whole, import: true });
    assert.equal(s.rows[0].state, 'taken');
    await rest();
    const rent = october(await full(api)).find((t) => t.date === '2026-10-14' && t.amount === 450)!;
    // The bank's export of 15 to 31 October holds the rent on the 16th.
    const later = truth.movements.filter((m) => m.date >= '2026-10-15');
    const opening = Math.round((truth.opening.amount + truth.movements.filter((m) => m.date < '2026-10-14').reduce((n, m) => n + m.amount, 0)) * 100) / 100;
    const bank = { ...whole, period: { from: '2026-10-15', to: '2026-10-31' }, opening: { date: '2026-10-15', amount: opening }, movements: [{ ...truth.movements[3], date: '2026-10-16' }, ...later] };
    const r = await upload(api, 'bank-spaet.xml', bankExport(bank, 'BANK-LATE'));
    assert.equal(r.status, 200, await r.clone().text());
    await rest();
    const after = await full(api);
    const bankRent = october(after).find((t) => t.date === '2026-10-16' && t.amount === 450)!;
    assert.deepEqual(after.twins?.[rent.ref], [{ pdf: [rent.ref], bank: [bankRent.ref] }], 'asked, though the 14th lies before the export\'s days');
    const no = await api.send('POST', `/api/transactions/${encodeURIComponent(rent.ref)}/kept`);
    assert.equal(no.status, 200, JSON.stringify(no.json));
    const answered = await full(api);
    assert.equal(Object.values(answered.twins ?? {}).some((os) => os.some((o) => o.bank.includes(bankRent.ref))), false, 'the bank\'s rent is free to book');
    assert.deepEqual(answered.transactions.filter((t) => t.ref === rent.ref).map((t) => [t.date, t.source]), [['2026-10-14', 'manual']], 'kept as a movement of its own, its ref kept');
    assert.equal(readFileSync(join(api.root, FOLDER, OCTOBER_XML), 'utf8').includes('Muster Immobilien'), false, 'the read statement no longer holds it');
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

test('a line on the edge of the bank export\'s days: read on 1 October, it is the camt.053\'s payment of the last days of September, not a second one', async () => {
  const { loadBooks } = await import('../src/books/store.js');
  const { workspaceAt } = await import('../src/workspace/workspace.js');
  const last = loadBooks(workspaceAt(DEMO_ROOT)).transactions.filter((t) => t.bank === 'Raiffeisen' && t.source !== 'manual' && t.date >= '2026-09-24' && t.date <= '2026-09-30').sort((a, b) => a.date.localeCompare(b.date)).at(-1)!;
  assert.ok(last, 'the demo has a payment in the last week of September');
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const edge = { date: '2026-10-01', amount: signed(last), text: last.description };
  const read: ReadStatement = { ...truth, closing: { ...truth.closing, amount: Math.round((truth.closing.amount + edge.amount) * 100) / 100 }, movements: [edge, ...truth.movements] };
  const api = await demo(read);
  try {
    const kept = await upload(api, 'oktober.pdf', pdf);
    assert.equal(kept.status, 200, await kept.clone().text());
    const path = `/api/statements/${(await kept.json() as StatementImport).file.split('/').map(encodeURIComponent).join('/')}/read`;
    const asked = await api.send('POST', path);
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    assert.deepEqual((asked.json as unknown as StatementAsk).read.known, [{ date: '2026-10-01', amount: edge.amount }], 'shown as a payment the books hold');
    const had = (await full(api)).transactions.length;
    const done = await api.send('POST', `${path}/import`, { statement: read });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const books = await full(api);
    assert.equal(books.transactions.length, had + truth.movements.length, 'October\'s seven are new; the edge line is September\'s payment');
    assert.equal(books.transactions.filter((t) => t.ref === last.ref).length, 1);
  } finally {
    await api.stop();
  }
});

test('a statement question of a period filed meanwhile can still be closed as «Als Auszug behalten»; closing the period closes it', async () => {
  const { pdf, truth } = await inventedStatement(DEMO_OCTOBER);
  const api = await demo(truth, { camt: false });
  try {
    const { post, rest } = SESSION(api);
    const s = await post(`/api/drop/${(await post('/api/drop')).id}/files?name=oktober.pdf`, pdf);
    assert.equal(s.rows[0].asked?.file, `Raiffeisen/${OCTOBER_PDF}`);
    assert.equal((await api.fetch(`/api/drop/${s.id}`, { method: 'DELETE' })).status, 200);
    await rest();
    const ledger = join(api.root, 'ledger.json');
    const config = JSON.parse(readFileSync(ledger, 'utf8'));
    writeFileSync(ledger, JSON.stringify({ ...config, config: { ...config.config, closedThrough: '2026-10-31' } }, null, 2));
    const closed = await api.fetch(`/api/statements/Raiffeisen/${encodeURIComponent(OCTOBER_PDF)}/read`, { method: 'DELETE' });
    assert.equal(closed.status, 200, await closed.clone().text());
    assert.equal((await full(api)).statementAsks, undefined, 'no question left that nothing could answer');
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});
