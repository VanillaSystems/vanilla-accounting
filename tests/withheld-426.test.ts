/**
 * #426: wages booked gross put each payslip's deductions on the deductions account (2270); the
 * compensation fund's Akonto bill states its contributions by kind, not by party, so only the books
 * say how much of the payment is the employees' share. The model is told what 2270 holds on the
 * payment's day (src/booking/withheld.ts), without the payment's own lines, never for a wage, a
 * purchase with Swiss VAT or money in, and nothing when wages are booked net.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { unclearedContributions, withheldFor } from '../src/booking/withheld.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const pay = (ref: string, date: string, amount: number, counterparty: string, description: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description, ...over });
const entry = (ref: string, date: string, debit: string, credit: string, amount: number, over: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id: `e-${ref}-${debit}-${credit}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, description: ref, origin: 'classify', by: { kind: 'model', model: 'test' }, ...over }) as JournalEntry;

// The webshop persona: two people, 599.20 deducted a month (owner 500.00 with her pension, helper 99.20), the pension fund paid in advance on 10.07.
const MONTHS = ['07', '08', '09'];
const WAGES = MONTHS.flatMap((m) => [pay(`LO-${m}`, `2026-${m}-24`, 4200, 'Nora Wyss', `Lohn ${m} 2026`), pay(`LH-${m}`, `2026-${m}-24`, 1450.8, 'Lea Brunner', `Lohn ${m} 2026`)]);
const gross = MONTHS.flatMap((m) => [entry(`LO-${m}`, `2026-${m}-24`, '5000', '1020', 4200), entry(`LO-${m}`, `2026-${m}-24`, '5000', '2270', 500), entry(`LH-${m}`, `2026-${m}-24`, '5000', '1020', 1450.8), entry(`LH-${m}`, `2026-${m}-24`, '5000', '2270', 99.2)]);
const PENSION = pay('PK', '2026-07-10', 1195.2, 'Pensionskasse Zentral', 'Beiträge Q3 2026 PK-26-3-1180');
const pension = [entry('PK', '2026-07-10', '2270', '1020', 597.6), entry('PK', '2026-07-10', '5720', '1020', 597.6)];
const AKONTO = pay('AK', '2026-09-28', 2683.5, 'Ausgleichskasse Luzern', 'Akonto AHV/IV/EO/ALV Q3 2026 AK-26-Q3-30871');
const PRINTER = pay('DR', '2026-09-20', 540, 'Druckerei Brun AG', 'Rechnung 2026-118');
const BILL: Receipt = { id: 'ak', filename: 'ak.pdf', extractedText: 'Ausgleichskasse Luzern\nAkontorechnung AK-26-Q3-30871\nDatum: 07.07.2026\nLohnsumme gemäss Meldung: CHF 18\'750.00\nAHV/IV/EO 10.6%\nALV 2.2%\nFamilienausgleichskasse FAK 1.3%\nVerwaltungskosten 2% der AHV/IV/EO-Beiträge\nTotal CHF\n1987.50\n412.50\n243.75\n39.75\n2683.50', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date: '2026-07-07', amount: 2683.5, currency: 'CHF', hasSwissVat: false } as Receipt;
const PRINT_BILL: Receipt = { id: 'dr', filename: 'dr.pdf', extractedText: 'Druckerei Brun AG\nRechnung 2026-118\nTotal CHF 540.00\nMWST 8.1% 40.47', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date: '2026-09-10', amount: 540, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 40.47, gross: 540 }] } as Receipt;

function firm(entries: JournalEntry[], extra: BankTransaction[] = [], config: Record<string, unknown> = { closedThrough: '2026-06-30' }): Workspace {
  const made = tempWorkspace('withheld-426-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: no\n  imports: no\n  employees: staff\n  ownerPaysPrivately: no\n  privateUse: []\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  const mappings: Mapping[] = [{ transactionRef: 'AK', receiptId: 'ak', by: 'human' }, { transactionRef: 'DR', receiptId: 'dr', by: 'human' }];
  writeIndex(ws, { transactions: [...WAGES, PENSION, AKONTO, PRINTER, ...extra], journalEntries: entries, receipts: [BILL, PRINT_BILL], mappings, config: config as never });
  return ws;
}

/** A model that books a wage gross over 2270 (the payslip's deductions) and every other payment as `answer` says; it keeps what it was told, by ref. */
function model(answer: (ref: string, amount: number, said: string) => unknown[] = (_r, amount) => [{ accountDebit: '5700', accountCredit: '', amount, vat: 'none' }]) {
  const said: Record<string, string> = {};
  const deductions: Record<string, number> = { LO: 500, LH: 99.2 };
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const out: Record<string, unknown> = {};
    for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
      const ref = part.split(/\s/)[0];
      said[ref] = part.split('\n\n')[0];
      const amount = Number(/Amount: -?([\d.]+)/.exec(part)![1]);
      const wage = deductions[ref.split('-')[0]];
      out[ref] = { entries: wage ? [{ accountDebit: '5000', accountCredit: '', amount, vat: 'none' }, { accountDebit: '5000', accountCredit: '2270', amount: wage, vat: 'none' }] : answer(ref, amount, said[ref]).map((e) => ({ description: ref, ...(e as object) })) };
    }
    return JSON.stringify(out);
  };
  return { ask, said };
}

async function run(ws: Workspace, txs: string[], m = model()) {
  const books = loadBooks(ws);
  const outcome = await classifyTransactions(books, books.transactions.filter((t) => txs.includes(t.ref)), { ask: m.ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  return { books, outcome, said: m.said };
}
const line = (s: string | undefined) => /Withheld from wages: account 2270 holds ([\d.]+)/.exec(s ?? '')?.[1];

test('the Akonto payment is told what 2270 holds on its day: the employees\' AHV/ALV of the three payslips, the pension fund\'s share already paid', async () => {
  const { said } = await run(firm([...gross, ...pension]), ['AK']);
  assert.match(said.AK, /Withheld from wages: account 2270 holds 1200 CHF, deducted on the payslips booked so far/);
});

test('the first drop: the six wages and the Akonto payment unbooked in one run; the payment is asked after the wages are booked', async () => {
  const { said, books } = await run(firm([...pension]), [...WAGES.map((w) => w.ref), 'AK']);
  assert.equal(line(said.AK), '1200');
  assert.equal(books.journalEntries.filter((e) => e.accountCredit === '2270').length, 6);
});

test('the year\'s opening of 2270 counts as a credit, in the account\'s natural direction: Q4\'s share paid in January', () => {
  const jan = [entry('LO-27', '2027-01-24', '5000', '2270', 500), entry('LH-27', '2027-01-24', '5000', '2270', 99.2)];
  const config = { openingBalances: { '2027': { '2270': 1797.6 } } };
  assert.equal(withheldFor({ journalEntries: jan, config }, { ref: 'AK27', date: '2027-01-28', direction: 'DBIT' }, '2270'), 2396.8);
  assert.equal(withheldFor({ journalEntries: [], config }, { ref: 'AK27', date: '2027-01-10', direction: 'DBIT' }, '2270'), 1797.6);
});

test('a payment booked again is told what was open before it, not after its own lines', () => {
  const own = [entry('AK', '2026-09-28', '2270', '1020', 1200), entry('AK', '2026-09-28', '5700', '1020', 1483.5)];
  const books = { journalEntries: [...gross, ...pension, ...own] };
  assert.equal(withheldFor(books, AKONTO, '2270'), 1200);
  assert.equal(withheldFor(books, { ...AKONTO, ref: 'later', date: '2026-09-30' }, '2270'), undefined, 'after the Akonto payment 2270 holds nothing');
});

test('only a contribution payment is told: not a wage (whatever its text), a supplier, a purchase with Swiss VAT, money in, nor anything when wages are booked net', async () => {
  const plain = { ...WAGES.find((w) => w.ref === 'LO-09')!, description: 'Überweisung' };
  const RENT = pay('RENT', '2026-09-01', 1800, 'Immobilien Muster AG', 'Miete September');
  const ws = firm([...gross.filter((e) => e.transactionRef !== 'LO-09'), ...pension], [RENT]);
  const books = loadBooks(ws);
  books.transactions = books.transactions.map((t) => (t.ref === 'LO-09' ? plain : t));
  const m = model();
  await classifyTransactions(books, books.transactions.filter((t) => ['LO-09', 'DR', 'RENT'].includes(t.ref)), { ask: m.ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  for (const ref of ['LO-09', 'DR', 'RENT']) assert.equal(line(m.said[ref]), undefined, ref);
  const net = MONTHS.flatMap((mo) => [entry(`LO-${mo}`, `2026-${mo}-24`, '5000', '1020', 4200), entry(`LH-${mo}`, `2026-${mo}-24`, '5000', '1020', 1450.8)]);
  const none = await run(firm([...net, entry('PK', '2026-07-10', '5720', '1020', 1195.2)]), ['AK']);
  assert.equal(line(none.said.AK), undefined, 'wages booked net: 2270 holds nothing');
  assert.equal(withheldFor({ journalEntries: gross }, { ...AKONTO, direction: 'CRDT' }, '2270'), undefined, 'money in');
});

test('a payee booked on the contribution accounts before is told too: the pension fund\'s next payment', async () => {
  const PK2 = pay('PK2', '2026-09-30', 1195.2, 'Pensionskasse Zentral', 'Beiträge Q4 2026 PK-26-4-1180');
  const { said } = await run(firm([...gross, ...pension], [PK2]), ['PK2']);
  assert.equal(line(said.PK2), '1200');
});

test('code holds the cap: two contribution payments that each take the whole credit off 2270, the second is not booked', async () => {
  const AK2 = pay('AK2', '2026-09-28', 2683.5, 'Ausgleichskasse Luzern', 'Akonto Nachtrag');
  const greedy = model((_ref, amount, said) => { const open = Number(line(said) ?? 0); return [{ accountDebit: '2270', accountCredit: '', amount: open, vat: 'none' }, { accountDebit: '5700', accountCredit: '', amount: Math.round((amount - open) * 100) / 100, vat: 'none' }]; });
  const { books, outcome } = await run(firm([...gross, ...pension], [AK2]), ['AK', 'AK2'], greedy);
  assert.deepEqual(outcome.classified, ['AK']);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].refusal?.code, 'classifyWithheldOver');
  assert.equal(books.journalEntries.filter((e) => e.transactionRef === 'AK2').length, 0);
});

const PAYEES = new Set(['AK']);
const Q3 = ['2026-07-01', '2026-09-30'] as const;

test('the task: a payment to the compensation fund booked without a line on 2270 while 2270 still holds a credit at the period\'s end; none once it clears it', () => {
  const whole = [entry('AK', '2026-09-28', '5700', '1020', 2683.5)];
  const books = { transactions: [...WAGES, PENSION, AKONTO], journalEntries: [...gross, ...pension, ...whole] };
  assert.deepEqual(unclearedContributions(books, ...Q3, PAYEES).map((u) => [u.tx.ref, u.account, u.open]), [['AK', '2270', 1200]]);
  const split = [entry('AK', '2026-09-28', '2270', '1020', 1200), entry('AK', '2026-09-28', '5700', '1020', 1483.5)];
  assert.deepEqual(unclearedContributions({ ...books, journalEntries: [...gross, ...pension, ...split] }, ...Q3, PAYEES), []);
  assert.deepEqual(unclearedContributions({ ...books, journalEntries: [...pension, ...whole] }, ...Q3, PAYEES), [], 'wages booked net');
});

test('cleared by hand later on a ref of its own: the task is gone; cleared in part: it names what is still open at the period\'s end', () => {
  const whole = [entry('AK', '2026-09-28', '5700', '1020', 2683.5)];
  const fix = (amount: number) => entry('FIX', '2026-09-30', '2270', '5700', amount, { origin: 'manual', by: { kind: 'person', at: '2026-10-02T08:00:00Z' } } as never);
  const books = (amount: number) => ({ transactions: [...WAGES, PENSION, AKONTO], journalEntries: [...gross, ...pension, ...whole, fix(amount)] });
  assert.deepEqual(unclearedContributions(books(1200), ...Q3, PAYEES), []);
  assert.deepEqual(unclearedContributions(books(1000), ...Q3, PAYEES).map((u) => u.open), [200]);
});

test('no task for a payment the employer pays alone: a family compensation fund billing on its own, booked whole on 5710', () => {
  const FAK = pay('FAK', '2026-09-28', 243.75, 'Familienausgleichskasse Luzern', 'FAK Q3 2026');
  const books = { transactions: [...WAGES, PENSION, AKONTO, FAK], journalEntries: [...gross, ...pension, entry('FAK', '2026-09-28', '5710', '1020', 243.75)] };
  assert.deepEqual(unclearedContributions(books, ...Q3, new Set(['FAK'])), [], 'even when its business collects contributions: 5710 carries no employees\' share');
});

test('a payee is one that collects the share: by the business files (the server\'s refs) or an earlier payment that took something off 2270; a supplier booked on 5700 by mistake is none', () => {
  const whole = [entry('AK', '2026-09-28', '5700', '1020', 2683.5)];
  const books = { transactions: [...WAGES, PENSION, AKONTO], journalEntries: [...gross, ...pension, ...whole] };
  assert.deepEqual(unclearedContributions(books, ...Q3), [], 'no payee known');
  const PK2 = pay('PK2', '2026-09-29', 1195.2, 'Pensionskasse Zentral', 'Beiträge Q4 2026');
  const later = { transactions: [...books.transactions, PK2], journalEntries: [...books.journalEntries, entry('PK2', '2026-09-29', '5720', '1020', 1195.2)] };
  assert.deepEqual(unclearedContributions(later, ...Q3).map((u) => u.tx.ref), ['PK2'], 'the pension fund took its share off 2270 in July');
});

test('the task stands under «Noch offen» of the period and is counted, with the refs the server sends', async () => {
  const { periodIssues, countIssues } = await import('../src/app/areas/automation/period-issues.js');
  const books = { transactions: [...WAGES, PENSION, AKONTO], journalEntries: [...gross, ...pension, entry('AK', '2026-09-28', '5700', '1020', 2683.5)], receipts: [], mappings: [], bankStatements: [], config: { closedThrough: '2026-06-30' } };
  const issues = periodIssues(books as never, [], ...Q3, [], new Map(), '2026-11-13' as never, new Map(), { held: [], bills: [], payouts: {}, withheldPayees: ['AK'] });
  assert.deepEqual(issues.flatMap((i) => (i.kind === 'withheld' ? [[i.uncleared.tx.ref, i.uncleared.open]] : [])), [['AK', 1200]]);
  assert.equal(countIssues(issues).withheld, 1);
});

test('the server names the payments to the compensation fund by its business file', async () => {
  const { withheldPayeesOf } = await import('../src/booking/withheld.js');
  assert.deepEqual(withheldPayeesOf([AKONTO, PRINTER], (t) => (t.ref === 'AK' ? 'ausgleichskasse' : 'druckerei')), ['AK']);
});
