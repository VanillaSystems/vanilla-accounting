/**
 * #476 (consulting-ai-r4-10): with its Akonto bill linked, the compensation fund's payment of CHF 4'078.92 was
 * booked whole as the employer's expense (5700 3'708.42 + 5710 370.50, «nichts auf 2270») while 2270 held
 * CHF 1'824.00 of the payslips' deductions for that fund: the employees' share expensed twice. The model was
 * told what 2270 held (the line is handed over on the receipt's path too) and left it; code only cut an answer
 * that took more off 2270 than it held, never one that took less. Now code reads the payslips' deductions per
 * fund (setup.yaml wages.withholds) and books exactly what they withheld for this fund on 2270, never more than
 * 2270 holds; where it cannot tell, the answer stands and the open item offers «2270 ausgleichen».
 *
 * The texts are the consultancy persona's files as pdftotext read them in the round 6 walk
 * (.claude/skills/verify/persona-files/consulting.mjs): the three payslips, the pension fund's bill paid on 10.07.,
 * the Akonto bill AK-2026-Q3-4471 and the camt.053 rows.
 */
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { clearingProposal, fundShare, payslipDeductions, unclearedContributions } from '../src/booking/withheld.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadChart } from '../src/workspace/chart.js';
import { setup } from '../src/engines/index.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import type { BankTransaction, JournalEntry, Mapping, Receipt } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const payslip = (month: string, day: string) => `Kälin Advisory GmbH\nBaarerstrasse 41, 6300 Zug\nLohnabrechnung ${month} 2026\nMatthias Kälin, Geschäftsführer\n\nBruttolohn\nAHV/IV/EO 5.3%\nALV 1.1%\nPensionskasse (BVG), Arbeitnehmerbeitrag\nNettolohn, Auszahlung am ${day}. ${month}\nDie Arbeitgeberbeiträge stehen in der Akontorechnung der Ausgleichskasse Zug und in der Beitragsrechnung der Vorsorgestiftung Zentralschweiz.\n\n9500.00\n-503.50\n-104.50\n-290.00\n8602.00`;
const AKONTO_TEXT = `Ausgleichskasse Zug\nBaarerstrasse 11, 6300 Zug\n\nKälin Advisory GmbH\nBaarerstrasse 41\n6300 Zug\nAkontorechnung AK-2026-Q3-4471\nDatum: 06.07.2026 Periode: 3. Quartal 2026 Lohnsumme gemäss Meldung: CHF 28'500.00\n\nAHV/IV/EO 10.6%\nALV 2.2%\nFamilienausgleichskasse FAK 1.3%\nVerwaltungskosten 2% der AHV/IV/EO-Beiträge\nTotal CHF\nBeiträge von Arbeitgeber und Arbeitnehmenden zusammen. Sozialversicherungsbeiträge unterliegen nicht der MWST.\n\n3021.00\n627.00\n370.50\n60.42\n4078.92`;
const BVG_TEXT = `Vorsorgestiftung Zentralschweiz\nPilatusstrasse 20, 6003 Luzern\n\nKälin Advisory GmbH\nBaarerstrasse 41\n6300 Zug\nBeitragsrechnung BVG-26-3-0918\nDatum: 02.07.2026 Beiträge 3. Quartal 2026, im Voraus\n\nVersicherte Person\nMatthias Kälin\nTotal CHF 1740.00\n\nArbeitnehmer\n870.00\n870.00\n\nArbeitgeber\n870.00\n870.00`;

const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description, reference: description });
const doc = (id: string, date: string, amount: number, text: string): Receipt =>
  ({ id, filename: `${id}.pdf`, extractedText: text, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '', location: 'archived', date, amount, currency: 'CHF', hasSwissVat: false, vatSummary: [] } as unknown as Receipt);
const entry = (ref: string, date: string, debit: string, credit: string, amount: number, receipts: string[]): JournalEntry =>
  ({ id: `e-${ref}-${debit}-${credit}`, transactionRef: ref, date, accountDebit: debit, accountCredit: credit, amount, description: ref, origin: 'classify', receipts, by: { kind: 'model', model: 'test' } }) as JournalEntry;

const WAGES = [['0008', '2026-07-27', 'Juli', '25'], ['0016', '2026-08-25', 'August', '25'], ['0025', '2026-09-25', 'September', '25']] as const;
const BVG = pay('ZGKB-26-0005', '2026-07-10', 1740, 'Vorsorgestiftung Zentralschweiz', 'Beitrag Q3 2026 BVG-26-3-0918');
const AKONTO = pay('ZGKB-26-0026', '2026-09-25', 4078.92, 'Ausgleichskasse Zug', 'Akonto Q3 2026 AK-2026-Q3-4471');

/** The consultancy after its drop: wages booked gross with their payslips, the pension fund paid with its bill; the Akonto payment with its bill linked, not booked. */
function consultancy({ payslips = true } = {}): Workspace {
  const made = tempWorkspace('withheld-476-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: yes\n  imports: no\n  employees: owner\n  ownerPaysPrivately: yes\n  privateUse: []\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  const wages = WAGES.map(([n, date, month]) => pay(`ZGKB-26-${n}`, date, 8602, 'Matthias Kälin', `Lohn ${month} 2026`));
  const slips = WAGES.map(([n, date, month, day]) => doc(`slip-${n}`, date, 8602, payslip(month, day)));
  const gross = WAGES.flatMap(([n, date]) => [entry(`ZGKB-26-${n}`, date, '5000', '1020', 8602, [`slip-${n}`]), entry(`ZGKB-26-${n}`, date, '5000', '2270', 898, [`slip-${n}`])]);
  const bvg = [entry(BVG.ref, BVG.date, '2270', '1020', 870, ['bvg']), entry(BVG.ref, BVG.date, '5720', '1020', 870, ['bvg'])];
  const mappings: Mapping[] = [
    ...(payslips ? WAGES.map(([n]) => ({ transactionRef: `ZGKB-26-${n}`, receiptId: `slip-${n}`, by: 'llm' }) as Mapping) : []),
    { transactionRef: BVG.ref, receiptId: 'bvg', by: 'llm' } as Mapping, { transactionRef: AKONTO.ref, receiptId: 'akonto', by: 'rule' } as Mapping,
  ];
  writeIndex(ws, {
    transactions: [...wages, BVG, AKONTO],
    journalEntries: [...(payslips ? gross : gross.map((e) => ({ ...e, receipts: [] }))), ...bvg],
    receipts: [...(payslips ? slips : []), doc('bvg', '2026-07-02', 1740, BVG_TEXT), doc('akonto', '2026-07-06', 4078.92, AKONTO_TEXT)],
    mappings, config: { closedThrough: '2026-06-30' },
  });
  return ws;
}

/** The model of the walk: the whole payment the employer's, by the bill's lines, nothing on 2270; or `answer`. */
const WALK = [{ accountDebit: '5700', accountCredit: '', amount: 3708.42, vat: 'none' }, { accountDebit: '5710', accountCredit: '', amount: 370.5, vat: 'none' }];
async function book(ws: Workspace, answer: unknown[] = WALK) {
  const books = loadBooks(ws);
  let said = '';
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const part = prompt.split(/^### Transaction \d+: /m)[1];
    said = part.split('\n\n')[0];
    return JSON.stringify({ [part.split(/\s/)[0]]: { entries: answer, reason: 'ganze Zahlung ist Arbeitgeberaufwand, nichts auf 2270' } });
  };
  const outcome = await classifyTransactions(books, books.transactions.filter((t) => t.ref === AKONTO.ref), { ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  const on = (account: string) => books.journalEntries.filter((e) => e.transactionRef === AKONTO.ref && e.accountDebit === account).reduce((s, e) => s + e.amount, 0);
  return { outcome, said, on: (a: string) => Math.round(on(a) * 100) / 100, lines: books.journalEntries.filter((e) => e.transactionRef === AKONTO.ref) };
}

test('#476 the payslips read per fund: AHV/IV/EO and ALV the compensation fund\'s, BVG the pension fund\'s; the deductions add up to what the wage put on 2270', () => {
  const kinds = setup().wages!.withholds!;
  assert.deepEqual([...payslipDeductions(payslip('Juli', '25'), 898, kinds)!], [['ausgleichskasse', 608], ['pension', 290]]);
  assert.equal(payslipDeductions(payslip('Juli', '25'), 900, kinds), undefined, 'deductions that do not add up to the wage\'s are not read');
  assert.deepEqual([...payslipDeductions('Lohnabrechnung März\nBruttolohn 6000.00\nAHV/IV/EO 5.3% -318.00\nALV 1.1% -66.00\nNBU -42.00\nNettolohn 5574.00', 426, kinds)!], [['ausgleichskasse', 384], ['accident', 42]], 'a label and its amount on one line');
  assert.equal(payslipDeductions('Lohnabrechnung\nBruttolohn\nAHV/IV/EO\nAbzug Diverses\n6000.00\n-318.00\n-50.00\n5632.00', 368, kinds), undefined, 'a deduction of no known kind: not sure');
});

test('#476 the walk: the Akonto payment with its bill linked, the model books it whole as the employer\'s; code books the 1\'824.00 the payslips withheld for the fund on 2270', async () => {
  const ws = consultancy();
  const { outcome, said, on, lines } = await book(ws);
  assert.deepEqual(outcome.classified, [AKONTO.ref]);
  assert.equal(on('2270'), 1824);
  assert.equal(on('5700'), 1884.42);
  assert.equal(on('5710'), 370.5, 'the family allowances stay the employer\'s');
  assert.match(said, /Withheld from wages: account 2270 holds 1824 CHF; of it, the payslips booked so far withheld 1824 CHF for this payee's contributions/, 'the model is told the fund\'s share, with the bill');
  assert.match(said, /Receipt \(4078\.92 CHF/);
  assert.ok(lines.every((e) => !e.vatCode), 'contributions carry no code');
  assert.match(lines.find((e) => e.accountDebit === '2270')!.reason ?? '', /Lohnabrechnungen haben für diese Kasse CHF 1824\.00 abgezogen/);
});

test('#476 an answer that takes all of 2270 (the pension fund\'s share too) is booked with the fund\'s share only', async () => {
  const ws = consultancy();
  const { on } = await book(ws, [{ accountDebit: '2270', accountCredit: '', amount: 2694, vat: 'none' }, { accountDebit: '5700', accountCredit: '', amount: 1014.42, vat: 'none' }, { accountDebit: '5710', accountCredit: '', amount: 370.5, vat: 'none' }]);
  assert.equal(on('2270'), 1824);
  assert.equal(on('5700'), 1884.42);
});

test('#476 the fund\'s share is what its payslips withheld less what it was paid, never more than 2270 holds', () => {
  const ws = consultancy();
  const books = loadBooks(ws);
  const businessOf = (t: BankTransaction) => (/Ausgleichskasse/.test(t.counterparty ?? '') ? 'ausgleichskasse' : /Vorsorge/.test(t.counterparty ?? '') ? 'pension' : undefined);
  assert.equal(fundShare(books, AKONTO, 'ausgleichskasse', businessOf), 1824);
  assert.equal(fundShare(books, AKONTO, 'pension', businessOf), 0, 'the pension fund\'s 870 is paid already');
  assert.equal(fundShare(books, { ...AKONTO, date: '2026-08-31' }, 'ausgleichskasse', businessOf), 926, 'two payslips withheld 1216 for it by then, but 2270 holds 926 after the pension fund\'s 870: never more');
  assert.equal(fundShare(books, AKONTO, 'druckerei', businessOf), undefined, 'a business that collects no deduction kind');
  books.config = { ...books.config, openingBalances: { 2026: { 2270: 500 } } };
  assert.equal(fundShare(books, AKONTO, 'ausgleichskasse', businessOf), undefined, 'an opening on 2270: whose it is, nothing says');
});

test('#476 without the payslips code cannot tell the fund\'s part of 2270: the model\'s answer stands, and the open item stays', async () => {
  const ws = consultancy({ payslips: false });
  const { said, on } = await book(ws);
  assert.match(said, /Withheld from wages: account 2270 holds 1824 CHF, deducted on the payslips/);
  assert.doesNotMatch(said, /for this payee's contributions/);
  assert.equal(on('2270'), 0);
  assert.equal(on('5700'), 3708.42);
});

test('#476 where code cannot tell, «2270 ausgleichen» proposes what 2270 holds, from the shared contribution line, never FAK; booked so, the open item is gone', () => {
  const ws = consultancy({ payslips: false });
  const books = loadBooks(ws);
  const walk = [entry(AKONTO.ref, AKONTO.date, '5700', '1020', 3708.42, ['akonto']), entry(AKONTO.ref, AKONTO.date, '5710', '1020', 370.5, ['akonto'])];
  books.journalEntries.push(...walk);
  const [u] = unclearedContributions(books, '2026-07-01', '2026-09-30', new Set([AKONTO.ref]));
  assert.deepEqual([u.tx.ref, u.open], [AKONTO.ref, 1824], 'the open list names it');
  const p = clearingProposal(walk, u.open)!;
  assert.deepEqual([p.account, p.amount, p.from], ['2270', 1824, ['5700']]);
  assert.deepEqual(p.changed.map((c) => [c.before.accountDebit, c.after.amount]), [['5700', 1884.42]]);
  assert.deepEqual(p.added.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.transactionRef]), [['2270', '1020', 1824, AKONTO.ref]]);
  books.journalEntries = [...books.journalEntries.filter((e) => e.transactionRef !== AKONTO.ref), p.changed[0].after, walk[1], ...p.added];
  assert.deepEqual(unclearedContributions(books, '2026-07-01', '2026-09-30', new Set([AKONTO.ref])), []);
  assert.equal(clearingProposal([walk[1]], 1824), undefined, 'a payment on FAK alone: the employer pays it alone');
  assert.equal(clearingProposal(walk, 0), undefined);
  assert.equal(clearingProposal(walk, 5000)!.amount, 3708.42, 'never more than the shared lines');
});
