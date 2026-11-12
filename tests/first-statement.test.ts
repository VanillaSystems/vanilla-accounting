/**
 * The first statement of a new firm with staff (issue #340): the bank's own fee row and the wages
 * need no receipt, so the run does not hold them back for one. The statement is the one of the
 * persona tests (.claude/skills/verify/persona-files.mjs): a made-up painting firm, a camt.053
 * with a bank transaction code on every entry, the fee row with the code for charges. A row is
 * never taken as the bank's fee by a part of the bank's name, and a wage's wording never ends the
 * search for a receipt: both would book a purchase with VAT without its input tax, silently.
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
import { noReceiptOfItsOwn, parseReceiptApply, receiptKnowledge, receiptWait, type WaitContext } from '../src/booking/receipt-wait.js';
import { loadClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { applyPlan, planWorkspace } from '../src/workspace/scaffold.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_FOLDER, APP_ROOT, workspaceAt, type Uid, type Workspace } from '../src/workspace/workspace.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import './support/jurisdiction.js';

/** `code`: the entry's bank transaction code as domain/family/sub-family; absent: a credit transfer out or in. `iban`: the other party's account. */
type Row = [date: string, direction: 'DBIT' | 'CRDT', amount: number, who: string, text: string, code?: string, iban?: string];
const CARD = 'PMNT/CCRD/POSD';
const ROWS: Row[] = [
  ['2026-07-02', 'CRDT', 4860.00, 'Familie Keller', 'Rechnung 2026-028 Malerarbeiten Wohnzimmer'],
  ['2026-07-03', 'DBIT', 1243.55, 'Farbmix AG', 'Rechnung FM-77812'],
  ['2026-07-25', 'DBIT', 5200.00, 'Marco Rossi', 'Lohn Juli 2026'],
  ['2026-07-25', 'DBIT', 4800.00, 'Sandra Huber', 'Lohn Juli 2026'],
  ['2026-08-15', 'DBIT', 89.00, 'Swisscom (Schweiz) AG', 'Rechnung August Natel'],
  ['2026-08-25', 'DBIT', 5200.00, 'Marco Rossi', 'Lohn August 2026'],
  ['2026-09-30', 'DBIT', 12.00, 'Raiffeisenbank', 'Kontoführung Q3', 'ACMT/MDOP/FEES'],
];
const BANK = 'Raiffeisenbank Wil und Umgebung';

/** The persona's statement: a code on every entry, the party under RltdPties, the bank named in full under Svcr. */
function statement(rows: Row[] = ROWS, bank = BANK): string {
  const entries = rows.map(([date, d, amount, who, text, code = d === 'CRDT' ? 'PMNT/RCDT/DMCT' : 'PMNT/ICDT/DMCT', iban], i) => {
    const [domain, family, sub] = code.split('/');
    const account = iban ? `<${d === 'CRDT' ? 'DbtrAcct' : 'CdtrAcct'}><Id><IBAN>${iban}</IBAN></Id></${d === 'CRDT' ? 'DbtrAcct' : 'CdtrAcct'}>` : '';
    return `
<Ntry><Amt Ccy="CHF">${amount.toFixed(2)}</Amt><CdtDbtInd>${d}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt>
<BkTxCd><Domn><Cd>${domain}</Cd><Fmly><Cd>${family}</Cd><SubFmlyCd>${sub}</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><Refs><AcctSvcrRef>RB-2026-${String(i + 1).padStart(4, '0')}</AcctSvcrRef></Refs><Amt Ccy="CHF">${amount.toFixed(2)}</Amt><CdtDbtInd>${d}</CdtDbtInd>
<RltdPties>${d === 'CRDT' ? `<Dbtr><Nm>${who}</Nm></Dbtr>` : `<Cdtr><Nm>${who}</Nm></Cdtr>`}${account}</RltdPties><RmtInf><Ustrd>${text}</Ustrd></RmtInf></TxDtls></NtryDtls>
<AddtlNtryInf>${d === 'CRDT' ? 'Gutschrift' : 'Belastung'} ${who}</AddtlNtryInf></Ntry>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>RB-STMT-Q3</Id>
<Acct><Ccy>CHF</Ccy><Ownr><Nm>Malerei Beispiel GmbH</Nm></Ownr><Svcr><FinInstnId><Nm>${bank}</Nm></FinInstnId></Svcr></Acct>${entries}
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

test('the bank\'s fee row is one by its code for charges; a part of the bank\'s name, a card payment and a row with an account are none', () => {
  assert.deepEqual(parse(statement()).filter(isBankFee).map((t) => t.description), ['Kontoführung Q3']);
  const day = '2026-09-30';
  const none = (rows: Row[], bank: string, why: string) => assert.deepEqual(parse(statement(rows, bank)).filter(isBankFee).map((t) => t.description), [], why);
  none([[day, 'DBIT', 12, 'Raiffeisenbank', 'Kontoführung Q3']], BANK, 'the first word of the bank\'s name under a payment\'s code: no fee row by a part of the name');
  none([[day, 'DBIT', 180, 'Raiffeisenbank', 'Schrankfachmiete inkl. 8.1% MWST']], BANK, 'a safe-deposit box with VAT');
  none([[day, 'DBIT', 64.3, 'Migros', 'Karte 5412 Einkauf', CARD]], 'Migros Bank AG', 'a card purchase at a merchant called like the bank');
  none([[day, 'DBIT', 64.3, 'Migros Bank AG', 'Karte 5412', CARD]], 'Migros Bank AG', 'a card payment is no fee row even under the bank\'s whole name');
  none([[day, 'DBIT', 980, 'Baloise', 'Betriebshaftpflicht 2026/27']], 'Baloise Bank AG', 'an insurer');
  none([[day, 'DBIT', 30, 'Bank', 'Zahlung']], 'Bank Cler AG', 'one common word');
  none([[day, 'DBIT', 412, 'UBS', 'Kreditkartenabrechnung']], 'UBS Switzerland AG', 'a card\'s bill');
  none([[day, 'DBIT', 55, 'Zürcher', 'Karte 5412', CARD]], 'Zürcher Kantonalbank', 'a merchant with the bank\'s first word');
  none([[day, 'DBIT', 500, BANK, 'Amortisation', undefined, 'BE00967000000002']], BANK, 'a debit to an account at the bank, under its whole name');
  none([[day, 'DBIT', 15, 'Beispiel AG', 'Zahlung mit Spesen', 'PMNT/ICDT/CHRG', 'BE00967000000002']], BANK, 'a charge paid to another party\'s account');
  none([[day, 'CRDT', 3, BANK, 'Zins']], BANK, 'money in');
  assert.deepEqual(parse(statement([[day, 'DBIT', 15, BANK, 'Kontoführung Oktober']])).filter(isBankFee).length, 1, 'as before: a debit to the bank under its whole name and a payment\'s code is its fee row');
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

test('the shipped wage wording: a wage by the payment\'s own text, in any language, on a firm that pays wages; never a purchase that names wages', () => {
  const ws = firm();
  const k = loadKnowledge(APP_ROOT, ws.paths.root);
  const { wages, wordings } = receiptKnowledge(k, ws);
  const wage = (s: string) => wages.some((w) => w.test(s));
  for (const s of ['Lohn Juli 2026', 'LOHNZAHLUNG 09/2026', 'Löhne September', '13. Monatslohn', 'Nettolohn August', 'Salär Oktober', 'Gehalt Juli', 'Salaire septembre', 'Salaire juillet 2026', 'Stipendio luglio', 'Stipendi settembre 2026', 'Salary July', 'Zahlung Lohn 2026', 'Lohn']) assert.ok(wage(s), s);
  for (const s of [
    'Lohn Aushilfe KW 36 Rechnung 88121 Adecco', 'Lohn- und Finanzbuchhaltung Q3 Treuhand', 'bexio Lohn Abo', 'Landi Lohn SH', 'Peter Lohn Elektro', 'Lohn AG Rechnung 12',
    'Gestion des salaires facture 2026-118', 'BVG Beiträge Lohn Juli', 'AHV Lohn Juli 2026', 'Quellensteuer Lohn August',
    'Lohnbuchhaltung Treuhand Beispiel AG Rechnung 4411', 'Lohnausweis Software Abo', 'Lohnsoftware Lizenz 2026', 'Rechnung FM-77812', 'Salaris Restaurant', 'Belohnung Wettbewerb', 'Material Lohn', 'Lohn GmbH',
  ]) assert.equal(wage(s), false, s);
  assert.equal(wordings.some((w) => w.test('Lohn Juli 2026')), false, 'no wording that ends the search for a receipt');
  assert.deepEqual(receiptKnowledge(k, firm('none')).wages, [], 'a firm without employees');
  assert.equal(employs(undefined), false, 'books without the setup\'s answers have not said so');

  const ctx: WaitContext = { free: new Set(), wordings, wages, assumesUnread: new Set(), ownIbans: new Set(), settles: () => false, inputTax: true };
  const out = (description: string, counterparty: string): BankTransaction => ({ ref: 'W', bank: 'Raiffeisen', date: '2026-07-25', amount: 5200, currency: 'CHF', direction: 'DBIT', description, counterparty });
  assert.deepEqual(receiptWait(out('Lohn Juli 2026', 'Marco Rossi'), { linked: 'none' }, ctx), { wait: false, why: 'wage' });
  assert.deepEqual(receiptWait(out('Zahlung 4411', 'Lohn AG'), { linked: 'none' }, ctx), { wait: true }, 'the counterparty\'s name is never read: a firm, a place or a surname may be called so');
  assert.deepEqual(receiptWait(out('Montage Juli', 'Peter Lohn Elektro'), { linked: 'none' }, ctx), { wait: true });

  assert.deepEqual(parseReceiptApply({ receipt: 'none', text: 'Lohn', not: 'Rechnung', firm: 'employer' }, 'guide'), { ok: true, text: 'Lohn', not: 'Rechnung', firm: 'employer' });
  assert.match((parseReceiptApply({ receipt: 'none', text: 'Lohn', firm: 'gmbh' }, 'guide') as { problem: string }).problem, /apply\.firm must be employer/);
  assert.match((parseReceiptApply({ receipt: 'none', text: 'Lohn', not: '(' }, 'guide') as { problem: string }).problem, /apply\.not/);
  assert.match((parseReceiptApply({ receipt: 'none', firm: 'employer' }) as { problem: string }).problem, /apply\.firm is for a guide/);
});

test('a wage is freed from the wait only: it stays a candidate for a receipt, and one linked later books it again with what it shows', async () => {
  const ws = firm();
  const [, , wage] = parse(statement());
  const withdrawal: BankTransaction = { ...wage, ref: 'ATM-1', description: 'Bancomat Bezug Wil' };
  const books = booksOf([wage, withdrawal]);
  const none = () => noReceiptOfItsOwn(books, loadClassifyContext(ws), receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws), loadFxResolver());
  assert.equal(none()(withdrawal), true, 'a cash withdrawal has no receipt of its own');
  assert.equal(none()(wage), false, 'the matching chain still pairs a receipt with a payment worded as a wage');

  // A temp agency's bill worded as a wage: booked at once without input tax, then again from its receipt.
  const wageModel = async () => JSON.stringify({ [wage.ref]: { entries: [{ accountDebit: '5000', accountCredit: '', amount: wage.amount, vatCode: '', description: 'Lohn' }], reason: 'Lohn' } });
  const billModel = async () => JSON.stringify({ [wage.ref]: { entries: [{ accountDebit: '4400', accountCredit: '', amount: wage.amount, vatCode: 'I81', description: 'Temporärpersonal' }], reason: 'Rechnung Personalverleih' } });
  await run(ws, books, wageModel);
  assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === wage.ref).map((e) => [e.accountDebit, e.vatCode ?? '']), [['5000', '']]);
  assert.equal(none()(wage), false, 'booked by the app without a receipt: still a candidate');
  books.receipts.push({ id: 'bill', filename: '20260725-personalverleih.pdf', location: 'archived', kind: 'invoice', date: '2026-07-25', amount: wage.amount, currency: 'CHF', extractedText: 'Rechnung Personalverleih inkl. 8.1% MWST', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: wage.amount, vat: 389.64 }] } as Receipt);
  books.mappings.push({ transactionRef: wage.ref, receiptId: 'bill' });
  await run(ws, books, billModel);
  assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === wage.ref && e.accountDebit !== '').map((e) => [e.accountDebit, e.vatCode ?? '']), [['4400', 'M81']], 'booked again from the receipt, with its input tax (the account gives the code)');
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
