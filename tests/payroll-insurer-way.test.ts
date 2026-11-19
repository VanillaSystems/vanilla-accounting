/**
 * «Immer so» on a payroll insurer's payment (docs/specs/payroll.md §22 decision 126): the hand form's choice kept in
 * the company's file of the fund (`payroll: { payments }`, src/knowledge/payroll-way.ts), honoured by insurerPaymentOf
 * so an Akonto paid ahead is booked against the liability by code; undone by taking the section out of the file. Such a
 * payment needs no receipt. Invented firm.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { loadChart } from '../src/workspace/chart.js';
import { handStart } from '../src/saving/hand-rule.js';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadBooks } from '../src/books/store.js';
import { savePayroll } from '../src/payroll/store.js';
import { insurerPaymentOf } from '../src/payroll/insurers.js';
import { forgetPayrollWay, keepPayrollWay, wayTarget, withPayrollWay, withoutPayrollWay } from '../src/payroll/insurer-way.js';
import { parsePayrollSection } from '../src/knowledge/payroll-way.js';
import { mergeCounterparty } from '../src/knowledge/layers.js';
import type { BankTransaction } from '../src/types/index.js';
import type { Workspace } from '../src/workspace/workspace.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { ch, firm, owner } from './support/payroll.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const pay = (ref: string, date: string, amount: number, counterparty: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description: `Akonto ${date.slice(0, 7)}` });

/** Payroll runs here from October (the opening holds January to September); the BVG Akonto of October is paid before October closes. */
function books(): Workspace {
  const ws = tempWorkspace('payroll-insurer-way-');
  roots.push(ws.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  savePayroll(ws, firm([owner({ opening: { 2026: { through: '2026-09', bases: { ahv: 90000 } } } })]));
  writeIndex(ws, { transactions: [pay('BVG-OCT', '2026-10-15', 600, 'Pensionskasse Beispiel')], journalEntries: [], receipts: [], mappings: [], config: { closedThrough: '2026-06-30' } as never });
  return ws;
}

test('the business file\'s payroll section: only the liability way, company only; «davor» is never kept', () => {
  assert.deepEqual(parsePayrollSection({ payments: 'liability', source: 'hand 2026-11-19' }), { section: { payments: 'liability', source: 'hand 2026-11-19' } });
  assert.match((parsePayrollSection({ payments: 'contributions' }) as { problem: string }).problem, /contributions cannot be kept/);
  assert.match((parsePayrollSection({ payments: 'later' }) as { problem: string }).problem, /must be liability/);
  assert.match((parsePayrollSection({ payments: 'liability', how: 1 }) as { problem: string }).problem, /payroll\.how/);
  assert.throws(() => mergeCounterparty({ id: 'x', name: 'X', match: { payee: ['X'] }, payroll: { payments: 'liability' } }, undefined, { vendor: 'processes/suppliers/x.yaml' }, 'supplier'), /one company's choice/);
  const own = mergeCounterparty(undefined, { id: 'x', name: 'X', match: { payee: ['X'] }, payroll: { payments: 'liability' } }, { binding: 'knowledge/suppliers/x.yaml' }, 'supplier');
  assert.deepEqual(own.payroll, { payments: 'liability' });
  assert.throws(() => mergeCounterparty(undefined, { id: 'x', name: 'X', match: { payee: ['X'] }, payroll: { payments: 'contributions' } }, { binding: 'knowledge/suppliers/x.yaml' }, 'supplier'), /contributions cannot be kept/);
});

test('insurerPaymentOf honours the kept way only while the accruals do not cover the payment, never for a shared payee', () => {
  const store = firm([owner({ opening: { 2026: { through: '2026-09', bases: { ahv: 90000 } } } })]);
  const tx = pay('BVG-OCT', '2026-10-15', 600, 'Pensionskasse Beispiel');
  const of = (way?: 'liability') => insurerPaymentOf(tx, [], ch.payroll!, store, () => 'pk-file', 'CHF', (b) => (b === 'pk-file' ? way : undefined));
  assert.deepEqual([of()?.covered, of()?.books, of()?.kept], [false, false, undefined], 'asked as before');
  assert.deepEqual([of('liability')?.covered, of('liability')?.books, of('liability')?.business], [false, true, 'pk-file'], 'booked at once by code');
  const accrued = [{ id: 'a', transactionRef: 'LR-2026-10-e1', date: '2026-10-31', accountDebit: '5720', accountCredit: '2275', amount: 700, by: { kind: 'code' as const, check: 'payroll' as const } }];
  const covered = insurerPaymentOf(tx, accrued, ch.payroll!, store, () => 'pk-file', 'CHF');
  assert.deepEqual([covered?.covered, covered?.books], [true, true], 'covered: the liability without any kept way');
  const both = { ...store, insurances: store.insurances.map((i) => ({ ...i, business: 'fund' })) };
  const shared = insurerPaymentOf(tx, [], ch.payroll!, both, () => 'fund', 'CHF', () => 'liability');
  assert.deepEqual([shared?.shared, shared?.books], [true, false], 'a payee of several insurances is never booked by code');
});

test('«Immer so»: kept in a new file of the fund, the classifier then books bank / liability without the model; «Rückgängig» asks again', async () => {
  const ws = books();
  const context = loadClassifyContext(ws);
  const b0 = loadBooks(ws);
  const tx = b0.transactions[0];
  const ins = firm().insurances.find((i) => i.kind === 'bvg')!;
  const target = wayTarget(ins, undefined, context.counterparties ?? [], ch.payroll!.insurances.bvg.role ?? 'supplier');
  assert.deepEqual([target.id, target.role, target.created], ['pensionskasse-beispiel', 'supplier', true]);
  assert.equal(ch.payroll!.insurances.ahv.role, 'authority', 'a compensation fund\'s own file goes with the authorities');
  const path = keepPayrollWay(ws, target, 'liability', tx, '2026-11-19');
  const written = parse(readFileSync(join(ws.paths.root, path), 'utf8'));
  assert.deepEqual(written, { id: 'pensionskasse-beispiel', name: 'Pensionskasse Beispiel', match: { payee: ['Pensionskasse Beispiel'] }, payroll: { payments: 'liability', source: 'hand 2026-11-19' } });
  const kept = loadClassifyContext(ws);
  assert.equal(kept.payrollInsurer!(tx, 'pensionskasse-beispiel', [])?.books, true);
  let asked = 0;
  const b = loadBooks(ws);
  const out = await classifyTransactions(b, [b.transactions[0]], { ask: async () => { asked++; return '{}'; }, fx: loadFxResolver(), context: kept });
  assert.equal(asked, 0, 'never the model');
  assert.deepEqual(out.classified, ['BVG-OCT']);
  assert.deepEqual(b.journalEntries.map((e) => [e.accountDebit, e.amount, e.by?.kind]), [['2275', 600, 'code']]);
  // Undo: the section leaves the file, the next payment asks again.
  assert.equal(forgetPayrollWay(ws, { id: target.id, role: target.role }), path);
  assert.ok(existsSync(join(ws.paths.root, path)) && !readFileSync(join(ws.paths.root, path), 'utf8').includes('payroll'));
  assert.equal(loadClassifyContext(ws).payrollInsurer!(tx, 'pensionskasse-beispiel', [])?.books, false);
  assert.equal(handStart(ws, 'BVG-OCT')?.nature?.kind, 'payrollInsurer');
  // The compensation fund's app file gets a binding of the company's: the knowledge still loads, with the way on it.
  const ak = firm().insurances.find((i) => i.kind === 'ahv')!;
  const akTarget = wayTarget({ ...ak, business: 'ausgleichskasse' }, undefined, loadClassifyContext(ws).counterparties ?? [], 'authority');
  assert.deepEqual([akTarget.path, akTarget.created], ['knowledge/authorities/ausgleichskasse.yaml', false]);
  keepPayrollWay(ws, akTarget, 'liability', pay('AK', '2026-10-28', 3300, 'Ausgleichskasse Beispiel'), '2026-11-19');
  assert.deepEqual(loadClassifyContext(ws).counterparties!.find((c) => c.id === 'ausgleichskasse')?.payroll, { payments: 'liability', source: 'hand 2026-11-19' });
});

test('the way goes into an existing file without touching the rest; taking it out gives back the same text', () => {
  const text = '# Our fund\nid: ak   # the id\nname: "AK"\nmatch:\n    iban: [ "CH00 1234" ]   # odd indent\n    tx:\n    - Ausgleich\nsteps:\n  booking.guide.yaml#classify:\n    - id: r1\n      then: { account: "5700", vat: none }\n';
  const withIt = withPayrollWay(text, 'liability', 'hand 2026-11-19', 'ak');
  assert.ok(withIt.startsWith(text), 'the rest stays byte for byte');
  assert.deepEqual(parse(withIt).payroll, { payments: 'liability', source: 'hand 2026-11-19' });
  assert.equal(withoutPayrollWay(withIt), text, 'Rückgängig gives back the file as it was');
  assert.equal(withoutPayrollWay(text), undefined);
  // A second keep replaces the block in place: one payroll section, never two.
  const again = withPayrollWay(withIt, 'liability', 'hand 2026-11-20', 'ak');
  assert.equal(again.match(/^payroll:/gm)?.length, 1);
  assert.match(again, /source: hand 2026-11-20/);
  // Windows line ends stay as they are.
  const crlf = withPayrollWay('id: ak\r\nname: AK\r\n', 'liability', 's', 'ak');
  assert.ok(!/[^\r]\n/.test(crlf), crlf);
  // A binding of an app file the company had none of yet: its id first, else the knowledge would not load; a comment-only file keeps its comment.
  assert.deepEqual(parse(withPayrollWay('', 'liability', 'hand 2026-11-19', 'ausgleichskasse')), { id: 'ausgleichskasse', payroll: { payments: 'liability', source: 'hand 2026-11-19' } });
  const commented = withPayrollWay('# nothing yet\n', 'liability', 's', 'ak');
  assert.ok(commented.startsWith('# nothing yet\n'));
  assert.deepEqual(parse(commented), { id: 'ak', payroll: { payments: 'liability', source: 's' } });
  // A broken file or a list is refused with a code, never overwritten.
  for (const bad of ['id: ak\n  bad: [', '- a\n- b\n']) {
    assert.throws(() => withPayrollWay(bad, 'liability', 's', 'ak'), (e: Error & { code?: string }) => e.code === 'badInput', bad);
  }
  const known = wayTarget({ business: 'ausgleichskasse', name: 'AK' }, undefined, [{ id: 'ausgleichskasse', role: 'authority', name: 'Ausgleichskasse' }], 'authority');
  assert.deepEqual([known.path, known.created], ['knowledge/authorities/ausgleichskasse.yaml', false]);
  const taken = wayTarget({ name: 'Pensionskasse Beispiel' }, undefined, [{ id: 'pensionskasse-beispiel', role: 'supplier', name: 'other' }], 'supplier');
  assert.equal(taken.id, 'pensionskasse-beispiel-2');
});

test('the bank page drops «kein Beleg» and «Beleg suchen» for a payroll insurer\'s payment: its proof is the payslips', () => {
  const model = readFileSync('src/app/areas/bank/model.ts', 'utf8');
  assert.match(model, /&& !proofElsewhere\.has\(t\.ref\)/);
  assert.match(readFileSync('src/app/areas/bank/state.ts', 'utf8'), /bankOf\(books, list, localToday\(\), proof\)/);
  assert.match(readFileSync('src/app/hooks/use-index.ts', 'utf8'), /setInsurerPayments\(insurerPayments\)/);
  const form = readFileSync('src/app/areas/journal/PaymentBooking.tsx', 'utf8');
  assert.match(form, /way === 'after' \? <KeepWay /, '«Immer so» only for «ab dem Lohnstart»');
  assert.match(form, /data-testid="insurer-way-books"/, 'the payments it books are named before the click');
  assert.equal(form.match(/nav\.refresh\(\);\n  \};/g)?.length, 2, 'the page reads the books again after every keep and undo');
  assert.match(readFileSync('src/app/areas/payroll/Payments.tsx', 'utf8'), /data-testid="insurer-kept-undo"/, 'the kept way and its undo on the insurer\'s page');
});

test('a kept payment no bank account of the firm takes waits for the person: never the model', async () => {
  const ws = books();
  const ins = firm().insurances.find((i) => i.kind === 'bvg')!;
  const b = loadBooks(ws);
  keepPayrollWay(ws, wayTarget(ins, undefined, loadClassifyContext(ws).counterparties ?? [], 'supplier'), 'liability', b.transactions[0], '2026-11-19');
  let asked = 0;
  const out = await classifyTransactions(b, [b.transactions[0]], { ask: async () => { asked++; return '{}'; }, fx: loadFxResolver(), context: { ...loadClassifyContext(ws), bankAccounts: [] } });
  assert.equal(asked, 0);
  assert.deepEqual(out.failed.map((f) => f.ref), ['BVG-OCT']);
  assert.deepEqual(b.journalEntries, []);
});
