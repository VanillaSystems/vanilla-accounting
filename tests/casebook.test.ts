/**
 * The casebook (examples/cases/) cannot drift from the engine: every case is booked into a copy
 * of the demo workspace, and its declared Ziffern are what computeVatReport / figuresFromBooks
 * then add to its quarter. Selection (selectCases) and the classify prompt are tested on
 * synthetic transactions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { computeVatReport } from '../src/accounting/vat-report.js';
import { figuresFromBooks } from '../src/accounting/return-figures.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadBooks, mutateJournal } from '../src/books/store.js';
import {
  CASE_TOKEN_LIMIT, caseEntries, casePeriod, caseTokens, loadCaseChart, loadCases, selectCases, validateCase,
  type BookingCase, type SelectionReceipt,
} from '../src/knowledge/cases.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import { inventoryMarkdown, minePatterns } from '../tools/cases/mine.js';

const cases = loadCases();
const byId = (id: string) => cases.find((c) => c.id === id)!;
const fx = loadFxResolver();
const chart = loadCaseChart();
const ruleIds = new Set(readdirSync(join(APP_ROOT, 'processes')).filter((f) => f.endsWith('.guide.yaml'))
  .flatMap((f) => Object.values((parse(readFileSync(join(APP_ROOT, 'processes', f), 'utf8')) as { steps?: Record<string, { gates?: { id: string }[]; rules?: { id: string }[] }> }).steps ?? {}))
  .flatMap((s) => [...(s.gates ?? []), ...(s.rules ?? [])].map((r) => r.id)));
const validate = (c: BookingCase) => validateCase(c, { chart, ruleIds, fx });

test('the casebook has 25 to 40 cases, services first, and every case is sound', () => {
  assert.ok(cases.length >= 25 && cases.length <= 40, `${cases.length} cases`);
  const firstGoods = cases.findIndex((c) => c.segment === 'goods');
  assert.ok(cases.slice(firstGoods).every((c) => c.segment === 'goods'), 'services cases come before goods cases');
  assert.deepEqual(cases.flatMap(validate), []);
});

test('every case fits the prompt budget', () => {
  for (const c of cases) assert.ok(caseTokens(c) <= CASE_TOKEN_LIMIT, `${c.id}: ~${caseTokens(c)} tokens`);
});

test('booked into the demo books, each case adds exactly its declared Ziffern to its quarter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belege-casebook-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const books = loadBooks(workspaceAt(dir));
  const base = books.journalEntries.slice();
  const adjustments = books.config.vatAdjustments ?? [];
  const figures = (entries: JournalEntry[], c: BookingCase) => figuresFromBooks(entries, casePeriod(c), adjustments);

  for (const c of cases) {
    books.journalEntries = base.slice();
    // The period lock of the demo (Q1 filed) holds: a case only ever adds to an open quarter.
    mutateJournal(books, (b) => { b.journalEntries.push(...caseEntries(c)); });
    const before = figures(base, c);
    const after = figures(books.journalEntries, c);
    const delta: Record<string, number> = {};
    for (const z of new Set([...Object.keys(before.ziffern), ...Object.keys(after.ziffern)])) {
      if (z === '500' || z === '510') continue;
      const d = Math.round(((after.ziffern[z] ?? 0) - (before.ziffern[z] ?? 0)) * 100) / 100;
      if (d !== 0) delta[z] = d;
    }
    // 399 and the payable are the eCH tax on each rate's total, rounded once: a case can shift them by a Rappen.
    for (const z of new Set([...Object.keys(delta), ...Object.keys(c.ziffern)])) {
      const tolerance = z === '399' ? 0.011 : 0.001;
      assert.ok(Math.abs((delta[z] ?? 0) - (c.ziffern[z] ?? 0)) < tolerance, `${c.id}: Ziffer ${z} moved ${delta[z] ?? 0}, the case says ${c.ziffern[z] ?? 0}`);
    }
    assert.ok(Math.abs(after.payable - before.payable - c.payable) < 0.011, `${c.id}: payable moved ${after.payable - before.payable}, the case says ${c.payable}`);

    // The per-entry report (MWST tab, npm run vat-report) agrees on the source Ziffern.
    const rep = (entries: JournalEntry[]) => Object.fromEntries(computeVatReport(entries, casePeriod(c), adjustments).ziffern.map((z) => [z.number, z.amount]));
    const [r0, r1] = [rep(base), rep(books.journalEntries)];
    for (const z of ['200', '220', '221', '400', '405', '415']) {
      assert.equal(Math.round(((r1[z] ?? 0) - (r0[z] ?? 0)) * 100) / 100, c.ziffern[z] ?? 0, `${c.id}: report Ziffer ${z}`);
    }
  }
});

test('validation catches a case that drifted from the engine or breaks a booking rule', () => {
  const c = byId('expense-swiss-vat');
  const drifted = { ...c, ziffern: { ...c.ziffern, '405': 9 } };
  assert.match(validate(drifted).join('\n'), /declared effect differs from the engine — write ziffern: \{"405":8.1,"479":8.1\}/);
  const oneLeg = { ...c, lines: [{ ...c.lines[0], credit: '' }] };
  assert.match(validate(oneLeg).join('\n'), /single-leg row needs a -2 code/);
  const flatRate = byId('bezugsteuer-foreign-service');
  assert.match(validate({ ...flatRate, lines: [{ ...flatRate.lines[0], rate: 0.78 }] }).join('\n'), /not the ESTV daily sell rate/);
  const correction = byId('correction-private-purchase');
  assert.match(validate({ ...correction, date: '2026-02-10' }).join('\n'), /dated in a later, open quarter/);
  assert.match(validate({ ...c, rules: ['no-such-rule'] }).join('\n'), /rule "no-such-rule" is in no processes/);
  assert.match(validate({ ...c, lines: [{ ...c.lines[0], debit: '6999' }] }).join('\n'), /account 6999 is not in examples\/kmu-chart.yaml/);
});

// ─── Selection ────────────────────────────────────────────────────────────────

const tx = (t: Partial<BankTransaction>): BankTransaction =>
  ({ ref: 'T', bank: 'Raiffeisen', date: '2026-08-14', amount: 100, currency: 'CHF', direction: 'DBIT', description: '', ...t });
const receipt = (r: Partial<SelectionReceipt>): SelectionReceipt => ({ extractedText: '', ...r });
const top = (t: BankTransaction, receipts: SelectionReceipt[] = []) => selectCases(t, receipts, cases).map((c) => c.id);

test('a salary payment selects the salary case', () => {
  assert.equal(top(tx({ amount: 5200, description: 'Lohn September 2026 B. Muster' }))[0], 'salary-payment');
});

test('a US software subscription without Swiss VAT selects Bezugsteuer, one with Swiss VAT does not', () => {
  const usd = tx({ currency: 'USD', description: 'PIXELHUB.IO', amount: 15 });
  assert.equal(top(usd, [receipt({ extractedText: 'Pixelhub Inc., pixelhub.io. Pro plan, monthly subscription. Sales tax 0.00', hasSwissVat: false })])[0], 'bezugsteuer-foreign-service');
  const eur = tx({ currency: 'EUR', description: 'DESKFLOW LTD', amount: 20 });
  const ids = top(eur, [receipt({ extractedText: 'Deskflow Ltd, Dublin. Subscription. Swiss VAT 8.1% included', hasSwissVat: true, vatId: 'CHE' })]);
  assert.equal(ids[0], 'foreign-supplier-swiss-vat');
  assert.ok(!ids.includes('bezugsteuer-foreign-service'), ids.join(', '));
});

test('a Swiss client paying an invoice selects Swiss consulting revenue; one abroad paying in EUR selects Ziffer 221', () => {
  assert.equal(top(tx({ direction: 'CRDT', amount: 5405, description: 'Bergsicht AG Rechnung 2026-040 Beratung' }), [receipt({ extractedText: 'Rechnung 2026-040, Beratung, MWST 8.1%', hasSwissVat: true })])[0], 'consulting-revenue-ch');
  assert.equal(top(tx({ direction: 'CRDT', currency: 'EUR', amount: 3000, description: 'Fjord Data AS Invoice 2026-041' }), [receipt({ extractedText: 'Invoice 2026-041, consulting, reverse charge', hasSwissVat: false })])[0], 'consulting-revenue-abroad');
});

test('bank fees, the VAT payment, the AHV advance and a customs bill find their cases', () => {
  assert.equal(top(tx({ amount: 5, description: 'Kontoführung Gebühr Q3' }))[0], 'bank-fees');
  assert.equal(top(tx({ amount: 900, description: 'ESTV MWST 3. Quartal' }))[0], 'vat-payment');
  assert.equal(top(tx({ amount: 1800, description: 'Ausgleichskasse Akonto AHV' }))[0], 'ahv-akonto');
  assert.equal(top(tx({ amount: 60, description: 'Kurier Zollrechnung' }), [receipt({ extractedText: 'Zollrechnung: Zoll, Einfuhrsteuer, Vorlageprovision', hasSwissVat: true })])[0], 'import-vat-evv');
});

test('selection is deterministic and returns at most k cases, none without any link', () => {
  const t = tx({ amount: 108.1, description: 'Papeterie Kartenzahlung' });
  const r = [receipt({ extractedText: 'Büromaterial, MWST 8.1%', hasSwissVat: true })];
  assert.deepEqual(top(t, r), top(t, r));
  assert.ok(top(t, r).length <= 4);
  assert.deepEqual(selectCases(tx({ direction: 'DBIT', description: 'zzz' }), [], cases), []);
});

test('docs/casebook.md lists every case', () => {
  const doc = readFileSync(join(APP_ROOT, 'docs', 'casebook.md'), 'utf8');
  for (const c of cases) assert.ok(doc.includes(`examples/cases/${c.id}.yaml`), `${c.id} is missing from docs/casebook.md`);
});

test('mine-cases groups the demo journal into patterns and prints no name, amount or ref of it', () => {
  const ws = workspaceAt(DEMO_ROOT);
  const books = loadBooks(ws);
  const inv = minePatterns(books, ws.bankAccounts);
  assert.equal(inv.rows.reduce((s, r) => s + r.count, 0), books.journalEntries.length);
  assert.ok(inv.rows.some((r) => r.pattern.vat === 'V81' && r.pattern.debit === 'bank'), 'a sale into the bank');
  assert.ok(inv.rows.some((r) => r.pattern.corrects), 'the demo correction of Q1');
  const md = inventoryMarkdown(inv);
  // A single word (the demo has a transaction called Sammelzahlung) is vocabulary, not an item of the books.
  const leaks = [
    ...books.journalEntries.flatMap((e) => [e.description ?? '', e.transactionRef, String(e.amount)]),
    ...books.transactions.map((t) => t.description),
  ].filter((s) => /[\d\s]/.test(s) && s.length > 3 && !/^\d{1,3}$/.test(s) && md.includes(s));
  assert.deepEqual(leaks, []);
});
