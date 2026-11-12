/**
 * A split nobody can derive is a question, not a guess (#362, first-ai-28): the model split a
 * social-insurance payment 996.07 / 894.28 «nach dem Verhältnis des Beispielfalls». A model's answer
 * that spreads one payment over accounts by parts nothing states waits for the person, its lines the
 * proposal; one whose parts the payment or its receipt states, or that leaves one line as the rest,
 * is booked; the casebook's examples come with the warning never to take their amounts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import { amountsIn, UNSTATED_SPLIT } from '../src/booking/unstated-split.js';
import { buildBatchClassifyPrompt } from '../src/llm/prompts.js';
import { loadCases } from '../src/knowledge/cases.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const tx = (t: Partial<BankTransaction> & Pick<BankTransaction, 'ref'>): BankTransaction =>
  ({ bank: 'Raiffeisen', date: '2026-07-30', amount: 1890.35, currency: 'CHF', direction: 'DBIT', description: 'Beiträge Q2', counterparty: 'Kasse Muster', ...t });

/** The model answers each transaction with `lines` (account, amount). */
const model = (lines: Array<[string, number]>): NonNullable<ClassifyDeps['ask']> => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, {
    reason: 'Die Aufteilung folgt dem Verhältnis des Beispielfalls.',
    entries: lines.map(([account, amount]) => ({ accountDebit: account, accountCredit: '', amount, description: 'Beiträge' })),
  }])));
};

async function run(lines: Array<[string, number]>, t: BankTransaction, receipts: Receipt[] = []) {
  const context = loadClassifyContext(workspaceAt(DEMO_ROOT));
  const books = { transactions: [t], receipts, mappings: receipts.map((r) => ({ transactionRef: t.ref, receiptId: r.id })), bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  const outcome = await classifyTransactions(books, [t], { ask: model(lines), fx: loadFxResolver(), context });
  return { outcome, booked: books.journalEntries };
}

test('a split by a ratio nothing states waits for the person, with the model\'s lines as the proposal', async () => {
  const { outcome, booked } = await run([['6000', 996.07], ['2800', 894.28]], tx({ ref: 'SVA' }));
  assert.deepEqual(booked, [], 'nothing booked');
  assert.deepEqual(outcome.classified, []);
  assert.equal(outcome.asked.length, 1);
  assert.equal(outcome.asked[0].rule, UNSTATED_SPLIT);
  assert.match(outcome.asked[0].question, /Aufteilung/);
  assert.deepEqual(outcome.asked[0].entries.map((e) => [e.accountDebit, e.amount]), [['6000', 996.07], ['2800', 894.28]], 'the proposal is the model\'s');
});

test('the whole payment on one account is booked', async () => {
  const { outcome, booked } = await run([['6000', 1890.35]], tx({ ref: 'WHOLE' }));
  assert.deepEqual(outcome.classified, ['WHOLE']);
  assert.equal(booked.length, 1);
});

test('a split whose parts the receipt or the payment states is booked; one line may be the rest', async () => {
  const statement = { id: 'r1', filename: 'kasse.pdf', extractedText: "Akontorechnung Q2\nAnteil Arbeitnehmer 894.28\nAnteil Arbeitgeber 996.07\nTotal 1'890.35", amount: 1890.35 } as Receipt;
  const byReceipt = await run([['6000', 996.07], ['2800', 894.28]], tx({ ref: 'STATED' }), [statement]);
  assert.deepEqual(byReceipt.outcome.classified, ['STATED'], 'the statement names both shares');
  const byText = await run([['6000', 1500], ['2800', 390.35]], tx({ ref: 'TEXT', description: 'Beiträge Q2, Arbeitnehmer 390.35' }));
  assert.deepEqual(byText.outcome.classified, ['TEXT'], 'the text names one part, the other is the rest');
});

test('the amounts a text shows, with the Swiss thousands mark', () => {
  assert.deepEqual(amountsIn("Total 1'890.35, Anteil 894,28"), [1890.35, 894.28]);
});

test('the casebook comes with the warning never to take an example\'s amounts or ratio', () => {
  const context = loadClassifyContext(workspaceAt(DEMO_ROOT));
  const prompt = buildBatchClassifyPrompt([], context, loadCases().slice(0, 1));
  assert.match(prompt, /never take an amount, a share or a ratio from an example/);
});
