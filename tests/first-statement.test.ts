/**
 * The first statement of a new firm with staff (issue #340): the bank's own fee row and the wages
 * need no receipt, so the run does not hold them back for one. The statement is the one of the
 * persona tests (.claude/skills/verify/persona-files.mjs): a made-up painting firm, a camt.053
 * without bank transaction codes whose fee row names the bank by the short form of its name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStep } from '../src/intake/classify.js';
import { readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import { isBankFee } from '../src/booking/separate-fee.js';
import { checkAnswers } from '../src/workspace/create.js';
import { PRESETS, employs, type Answers } from '../src/workspace/setup.js';
import { parseReceiptApply, receiptWordings } from '../src/booking/receipt-wait.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { applyPlan, planWorkspace } from '../src/workspace/scaffold.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_FOLDER, APP_ROOT, workspaceAt, type Uid, type Workspace } from '../src/workspace/workspace.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction } from '../src/types/index.js';
import './support/jurisdiction.js';

type Row = [date: string, direction: 'DBIT' | 'CRDT', amount: number, who: string, text: string];
const ROWS: Row[] = [
  ['2026-07-02', 'CRDT', 4860.00, 'Familie Keller', 'Rechnung 2026-028 Malerarbeiten Wohnzimmer'],
  ['2026-07-03', 'DBIT', 1243.55, 'Farbmix AG', 'Rechnung FM-77812'],
  ['2026-07-25', 'DBIT', 5200.00, 'Marco Rossi', 'Lohn Juli 2026'],
  ['2026-07-25', 'DBIT', 4800.00, 'Sandra Huber', 'Lohn Juli 2026'],
  ['2026-08-15', 'DBIT', 89.00, 'Swisscom (Schweiz) AG', 'Rechnung August Natel'],
  ['2026-08-25', 'DBIT', 5200.00, 'Marco Rossi', 'Lohn August 2026'],
  ['2026-09-30', 'DBIT', 12.00, 'Raiffeisenbank', 'Kontoführung Q3'],
];

/** The persona's statement: no BkTxCd on any entry, the party under RltdPties, the bank named in full under Svcr. */
function statement(rows: Row[] = ROWS): string {
  const entries = rows.map(([date, d, amount, who, text], i) => `
<Ntry><Amt Ccy="CHF">${amount.toFixed(2)}</Amt><CdtDbtInd>${d}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt>
<NtryDtls><TxDtls><Refs><AcctSvcrRef>RB-2026-${String(i + 1).padStart(4, '0')}</AcctSvcrRef></Refs><Amt Ccy="CHF">${amount.toFixed(2)}</Amt><CdtDbtInd>${d}</CdtDbtInd>
<RltdPties>${d === 'CRDT' ? `<Dbtr><Nm>${who}</Nm></Dbtr>` : `<Cdtr><Nm>${who}</Nm></Cdtr>`}</RltdPties><RmtInf><Ustrd>${text}</Ustrd></RmtInf></TxDtls></NtryDtls>
<AddtlNtryInf>${d === 'CRDT' ? 'Gutschrift' : 'Belastung'} ${who}</AddtlNtryInf></Ntry>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>RB-STMT-Q3</Id>
<Acct><Ccy>CHF</Ccy><Ownr><Nm>Malerei Beispiel GmbH</Nm></Ownr><Svcr><FinInstnId><Nm>Raiffeisenbank Wil und Umgebung</Nm></FinInstnId></Svcr></Acct>${entries}
</Stmt></BkToCstmrStmt></Document>`;
}

const parse = (xml: string): BankTransaction[] => readCamt(xml).statements.flatMap((s) => transactionsOf(s, { bank: 'Raiffeisen', statements: 'camt053' }));

/** New books of a trades firm as the setup makes them: effective method, quarterly; `employees` as answered. */
function firm(employees: Answers['employees'] = 'staff'): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'first-statement-'));
  const { answers, vat } = checkAnswers({ ...PRESETS.trades.answers, employees } as Answers);
  applyPlan(root, planWorkspace({ name: 'Malerei Beispiel GmbH', uid: 'CHE-153.004.184' as Uid, owner: 'Sandra Huber', preset: 'trades', answers, vat, banks: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020' }] }, loadChart(), '2026'));
  return workspaceAt(join(root, APP_FOLDER));
}

const booksOf = (transactions: BankTransaction[]): Books => ({ transactions, receipts: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as unknown as Books;

/** The model: a wage on 5000, the bank's fee on 6940, anything else an expense with input tax (which the wait holds back). */
const model = async (prompt: string) => {
  const answers: Record<string, unknown> = {};
  for (const [, ref] of prompt.matchAll(/^### Transaction \d+: (RB-2026-\d{4})$/gm)) {
    const [, direction, amount, , text] = ROWS[Number(ref.slice(-4)) - 1];
    const account = /Lohn/.test(text) ? '5000' : /Kontoführung/.test(text) ? '6940' : '6500';
    answers[ref] = { entries: [direction === 'CRDT' ? { accountDebit: '', accountCredit: '3400', amount, vatCode: 'V81', description: text } : { accountDebit: account, accountCredit: '', amount, vatCode: '', description: text }], reason: text };
  }
  return JSON.stringify(answers);
};

async function run(ws: Workspace, books: Books, ask?: typeof model) {
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  return (await classifyStep()({ ws, books: port, ask, progress: () => {}, log: () => {} })).notes;
}

const waiting = (books: Books) => books.transactions.filter((t) => t.waitsForReceipt).map((t) => t.description);
const booked = (books: Books) => books.transactions.filter((t) => books.journalEntries.some((e) => e.transactionRef === t.ref)).map((t) => t.description);

test('the bank\'s fee row is one although the statement has no code for charges and names the bank by the first words of its name', () => {
  const txs = parse(statement());
  assert.deepEqual(txs.filter(isBankFee).map((t) => t.description), ['Kontoführung Q3']);
  const other = parse(statement([['2026-09-30', 'DBIT', 480, 'Raiffeisenbank Wil Immobilien AG', 'Miete Lager'], ['2026-09-30', 'DBIT', 12, 'Wil', 'Parkgebühr'], ['2026-09-30', 'CRDT', 3, 'Raiffeisenbank', 'Zins']]));
  assert.deepEqual(other.filter(isBankFee), [], 'another firm whose name begins like the bank\'s, a word from the middle of it, and money in are no fee row');
});

test('without an AI: the fee row and the wages do not wait for a receipt; the supplier payments do', async () => {
  const books = booksOf(parse(statement()));
  const notes = await run(firm(), books);
  assert.deepEqual(waiting(books), ['Rechnung FM-77812', 'Rechnung August Natel']);
  assert.deepEqual(notes.filter((n) => n.code === 'waitingReceipt').map((n) => (n as { count: number }).count), [2]);
});

test('with an AI: the fee row and the wages are booked in the first run, the supplier payments wait for their receipts', async () => {
  const books = booksOf(parse(statement()));
  await run(firm(), books, model);
  assert.deepEqual(booked(books), ['Rechnung 2026-028 Malerarbeiten Wohnzimmer', 'Lohn Juli 2026', 'Lohn Juli 2026', 'Lohn August 2026', 'Kontoführung Q3']);
  assert.deepEqual(waiting(books), ['Rechnung FM-77812', 'Rechnung August Natel']);
  const wage = books.journalEntries.find((e) => e.accountDebit === '5000')!;
  assert.deepEqual([wage.accountCredit, wage.amount, wage.vatCode ?? ''], ['1020', 5200, '']);
});

test('a firm that says it has no employees: a payment worded as a wage waits like any other', async () => {
  const books = booksOf(parse(statement()));
  await run(firm('none'), books);
  assert.deepEqual(waiting(books), ['Rechnung FM-77812', 'Lohn Juli 2026', 'Lohn Juli 2026', 'Rechnung August Natel', 'Lohn August 2026']);
});

test('the shipped wage wording holds only for a firm that pays wages, in any language, never for a purchase that names wages', () => {
  const k = loadKnowledge(APP_ROOT, firm().paths.root);
  const free = (s: string, employer = true) => receiptWordings(k, employer).some((w) => w.test(s));
  for (const s of ['Lohn Juli 2026', 'LOHNZAHLUNG 09/2026', 'Löhne September', '13. Monatslohn', 'Nettolohn August', 'Salär Oktober', 'Gehalt Juli', 'Salaire juillet 2026', 'Stipendio luglio', 'Salary July']) assert.ok(free(s), s);
  for (const s of ['Lohnbuchhaltung Treuhand Beispiel AG Rechnung 4411', 'Lohnausweis Software Abo', 'Rechnung FM-77812', 'Salaris Restaurant', 'Belohnung Wettbewerb']) assert.equal(free(s), false, s);
  assert.equal(free('Lohn Juli 2026', false), false, 'a firm without employees');
  assert.equal(employs(undefined), false, 'books without the setup\'s answers have not said so');
  assert.deepEqual(parseReceiptApply({ receipt: 'none', text: 'Lohn', firm: 'employer' }, 'guide'), { ok: true, text: 'Lohn', firm: 'employer' });
  assert.match((parseReceiptApply({ receipt: 'none', text: 'Lohn', firm: 'gmbh' }, 'guide') as { problem: string }).problem, /apply\.firm must be employer/);
  assert.match((parseReceiptApply({ receipt: 'none', firm: 'employer' }) as { problem: string }).problem, /apply\.firm is for a guide/);
});

test('«Braucht keinen Beleg» on a waiting payment: the booking step books it in the same go with an AI; without one it says that no model was there', async () => {
  const ws = firm();
  const [, supplier] = parse(statement());
  const marked = { ...supplier, noReceiptNeeded: true };
  const step = (tx: BankTransaction, ask?: typeof model) => ACTIONS['accounting.expenses.classification'].run!({ books: booksOf([tx]), transaction: tx }, {}, { ws, ask } as never);
  const withAi = await step(marked, model);
  assert.equal(withAi.outcome, 'decided');
  assert.deepEqual((withAi.output!.entries as Array<{ accountDebit: string; accountCredit: string; amount: number }>).map((e) => [e.accountDebit, e.accountCredit, e.amount]), [['6500', '1020', 1243.55]]);
  assert.deepEqual(await step(marked), { outcome: 'undecided', output: { why: 'noModel' } });
  const held = await step(supplier, model);
  assert.deepEqual([held.outcome, held.output], ['held', { why: 'waitsForReceipt' }], 'unmarked, it is the receipt it waits for');
});
