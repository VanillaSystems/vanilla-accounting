/**
 * Closing, reopening and correcting a payslip on a workspace (src/payroll/service.ts, docs/specs/payroll.md
 * §6.2 step 6, §6.5, §15.1 checkpoints 4, 7, 8, 9): the warning first, «Trotzdem abschliessen» books
 * exactly the preview through the write door, the PDF lies in Belege, the close is appended; reopening only
 * the latest month takes back exactly its entries; a closed period is never closed or reopened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClosedPeriodError, loadBooks, moduleActor, PERSON, receiptFile, saveBooks, updateSaved, type Books } from '../src/books/store.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readStep } from '../src/intake/read.js';
import { addCorrection, closePayslip, payrollContext, reopenPayslip, type BooksWriter } from '../src/payroll/service.js';
import { bookingOf } from '../src/payroll/booking.js';
import { computePayslip } from '../src/payroll/compute.js';
import { savePayroll, payslipEvents } from '../src/payroll/store.js';
import { PayrollRefusal } from '../src/payroll/close.js';
import { yearPaths } from '../src/workspace/workspace.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { firm, owner, dated } from './support/payroll.js';

function setup(employees = [owner()]) {
  const ws = tempWorkspace('payroll-close-');
  writeIndex(ws, { journalEntries: [], config: {} });
  savePayroll(ws, firm(employees));
  const write: BooksWriter = <T>(fn: (b: Books) => T) => updateSaved(ws, PERSON, fn);
  return { ws, write };
}

test('a close with something to say writes nothing without confirm; with it, it books exactly the preview, adds the accounts, files the PDF and appends the close', async () => {
  const { ws, write } = setup();
  const before = await closePayslip(ws, write, 'e1', '2026-09');
  assert.equal(before.closed, false);
  assert.ok(before.warnings.some((w) => w.key === 'accountMissing' && w.account === '1091'), 'the empty chart lacks 1091');
  assert.equal(loadBooks(ws).journalEntries.length, 0);
  assert.equal(payslipEvents(ws, '2026').length, 0);

  const ctx = payrollContext(ws);
  const preview = bookingOf(computePayslip(ctx, 'e1', '2026-09')!, ctx.data, ctx.store);
  const out = await closePayslip(ws, write, 'e1', '2026-09', { confirm: true, now: '2026-09-28T10:00:00.000Z' });
  assert.equal(out.closed, true);
  const books = loadBooks(ws);
  const booked = books.journalEntries.filter((e) => e.transactionRef === 'LR-2026-09-e1');
  const key = (x: [string, string, number, string]) => x.join('|');
  assert.deepEqual(booked.map((e) => key([e.accountDebit, e.accountCredit, e.amount, e.date])).sort(), preview.postings.map((p) => key([p.debit, p.credit, p.amount, '2026-09-30'])).sort(), 'the preview is what closing books');
  assert.ok(booked.every((e) => e.by?.kind === 'code' && e.by.check === 'payroll' && !e.vatCode));
  if (out.closed) assert.ok(out.accountsAdded.includes('1091') && out.accountsAdded.includes('2271'));
  const receipt = books.receipts.find((r) => r.kind === 'payslip')!;
  assert.ok(books.mappings.some((m) => m.receiptId === receipt.id && m.transactionRef === 'LR-2026-09-e1'));
  const file = receiptFile(ws, books, receipt);
  assert.ok(readFileSync(file).subarray(0, 5).toString() === '%PDF-');
  assert.ok(!/756/.test(receipt.filename), 'no social security number in a file name');
  const events = payslipEvents(ws, '2026');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'close');

  await assert.rejects(closePayslip(ws, write, 'e1', '2026-09', { confirm: true }), (e: Error) => e instanceof PayrollRefusal && e.code === 'alreadyClosed');
});

test('«Trotzdem abschliessen» with a line «unvollständig»: the close lists it in left and carries no flag', async () => {
  const { ws, write } = setup([owner({ recurring: [{ wageType: 'privatanteil-fahrzeug', value: [dated('2026-01-01', { rate: 0.009 })] }] })]);
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const close = payslipEvents(ws, '2026').find((e) => e.event === 'close')!;
  assert.ok(close.event === 'close');
  if (close.event !== 'close') return;
  assert.deepEqual(close.left.map((l) => l.wageType), ['privatanteil-fahrzeug']);
  assert.ok(!('override' in close) && !('despite' in close) && !('warned' in close), 'no override flag');
});

test('reopening: only the latest closed month; it takes back exactly its entries and PDF; closing again books the same ref once', async () => {
  const { ws, write } = setup();
  await closePayslip(ws, write, 'e1', '2026-08', { confirm: true });
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  assert.throws(() => reopenPayslip(ws, write, '2026-08-e1'), (e: Error) => e instanceof PayrollRefusal && e.code === 'notLatest');
  const books = loadBooks(ws);
  const aug = books.journalEntries.filter((e) => e.transactionRef === 'LR-2026-08-e1').map((e) => e.id).sort();
  const sepReceipt = books.receipts.find((r) => r.filename.includes('2026-09'))!;
  const sepFile = receiptFile(ws, books, sepReceipt);
  const out = reopenPayslip(ws, write, '2026-09-e1');
  const after = loadBooks(ws);
  assert.equal(after.journalEntries.filter((e) => e.transactionRef === 'LR-2026-09-e1').length, 0);
  assert.deepEqual(after.journalEntries.filter((e) => e.transactionRef === 'LR-2026-08-e1').map((e) => e.id).sort(), aug, 'August stays');
  assert.equal(out.removed.length, 13);
  assert.ok(!existsSync(sepFile) && !after.receipts.some((r) => r.id === sepReceipt.id));
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'LR-2026-09-e1').length, 13, 'booked once');
});

test('a payslip whose posting date lies in a closed period is neither closed nor reopened; a correction lands in the next open month', async () => {
  const { ws, write } = setup();
  await closePayslip(ws, write, 'e1', '2026-06', { confirm: true });
  const books = loadBooks(ws);
  books.config.closedThrough = '2026-06-30';
  saveBooks(ws, books);
  assert.throws(() => reopenPayslip(ws, write, '2026-06-e1'), ClosedPeriodError);
  await assert.rejects(closePayslip(ws, write, 'e1', '2026-05', { confirm: true }), ClosedPeriodError);
  addCorrection(ws, '2026-06-e1', { wageType: 'bvg-an', amount: 19, text: 'BVG-Satz' });
  const jul = computePayslip(payrollContext(ws), 'e1', '2026-07')!;
  assert.deepEqual(jul.lines.filter((l) => l.corrects).map((l) => [l.wageType, l.amount, l.corrects]), [['bvg-an', 19, '2026-06-e1']]);
  assert.ok(existsSync(join(yearPaths(ws.paths, '2026').payroll, 'payslips.jsonl')));
});

test('a correction entered before its month is reopened is void once the month closes again', async () => {
  const { ws, write } = setup();
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true, now: '2026-09-28T10:00:00.000Z' });
  addCorrection(ws, '2026-09-e1', { wageType: 'bvg-an', amount: 19 }, '2026-10-02T10:00:00.000Z');
  reopenPayslip(ws, write, '2026-09-e1', '2026-10-03T10:00:00.000Z');
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true, now: '2026-10-03T11:00:00.000Z' });
  const oct = computePayslip(payrollContext(ws), 'e1', '2026-10')!;
  assert.equal(oct.lines.filter((l) => l.corrects).length, 0);
});

test('the next intake read keeps the payslip\'s receipt as it is: its id, its kind, its link, its text without salary', async () => {
  const { ws, write } = setup([owner({ socialSecurityNumber: ['756', '1234', '5678', '97'].join('.') })]);
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const before = loadBooks(ws).receipts.find((r) => r.kind === 'payslip')!;
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), steps: [['read', readStep]] });
  const after = loadBooks(ws);
  assert.deepEqual(after.receipts.map((r) => [r.id, r.kind, r.extractedText]), [[before.id, 'payslip', before.extractedText]]);
  assert.ok(after.mappings.some((m) => m.receiptId === before.id && m.transactionRef === 'LR-2026-09-e1'));
  assert.ok(after.journalEntries.filter((e) => e.transactionRef === 'LR-2026-09-e1').every((e) => e.receipts?.[0] === before.id));
});

test('closing again after a reopen names an entry a person changed, and «Trotzdem» replaces it: the ref is booked once', async () => {
  const { ws, write } = setup();
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  write((b) => { const e = b.journalEntries.find((x) => x.transactionRef === 'LR-2026-09-e1')!; e.by = { kind: 'person', at: '2026-10-01T00:00:00Z' }; e.accountDebit = '5001'; });
  const out = reopenPayslip(ws, write, '2026-09-e1');
  assert.equal(out.kept.length, 1);
  const warned = await closePayslip(ws, write, 'e1', '2026-09');
  assert.equal(warned.closed, false);
  assert.ok(warned.warnings.some((w) => w.key === 'handEntries'));
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'LR-2026-09-e1').length, 13);
});

test('a refused save leaves no PDF in receipts/, and entries without their close event are replaced by the next close', async () => {
  const { ws, write } = setup();
  const refusing: BooksWriter = <T>(fn: (b: Books) => T) => updateSaved(ws, PERSON, (b) => { fn(b); throw new Error('stale'); });
  await assert.rejects(closePayslip(ws, refusing, 'e1', '2026-09', { confirm: true }), /stale/);
  assert.equal(existsSync(join(yearPaths(ws.paths, '2026').receipts, '20260930-lohnabrechnung-2026-09-e1.pdf')), false);
  // A close whose event was lost after the books were saved: its entries stand, nothing in payslips.jsonl.
  const lost: BooksWriter = <T>(fn: (b: Books) => T) => { const r = updateSaved(ws, PERSON, fn); throw Object.assign(new Error('crash'), { r }); };
  await assert.rejects(closePayslip(ws, lost, 'e1', '2026-09', { confirm: true }), /crash/);
  assert.equal(loadBooks(ws).journalEntries.length, 13);
  assert.equal(payslipEvents(ws, '2026').length, 0);
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  assert.equal(loadBooks(ws).journalEntries.length, 13, 'replaced, not booked twice');
  assert.equal(payslipEvents(ws, '2026').length, 1);
});

test('reopening a paid payslip keeps its PDF linked to the payment; closing again hands the link to the new PDF', async () => {
  const { ws, write } = setup();
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const first = loadBooks(ws).receipts.find((r) => r.kind === 'payslip')!;
  write((b) => {
    b.transactions.push({ ref: 'BANK-9', bank: 'Bank', date: '2026-09-25', amount: -8910, currency: 'CHF', direction: 'DBIT', description: 'Lohn' });
    b.journalEntries.push({ id: 'p1', transactionRef: 'BANK-9', date: '2026-09-25', accountDebit: '1091', accountCredit: '1020', amount: 8910, by: { kind: 'code', check: 'payroll' }, receipts: [first.id] });
    b.mappings.push({ transactionRef: 'BANK-9', receiptId: first.id, by: 'rule', rule: 'payroll' });
  });
  reopenPayslip(ws, write, '2026-09-e1');
  assert.ok(loadBooks(ws).mappings.some((m) => m.transactionRef === 'BANK-9' && m.receiptId === first.id), 'the payment keeps its proof');
  savePayroll(ws, firm([owner({ recurring: [{ wageType: 'pauschalspesen', value: [dated('2026-01-01', { amount: 100 })] }] })]));
  await closePayslip(ws, write, 'e1', '2026-09', { confirm: true });
  const books = loadBooks(ws);
  const now = books.receipts.filter((r) => r.kind === 'payslip');
  assert.equal(now.length, 1);
  assert.notEqual(now[0].id, first.id);
  assert.ok(books.mappings.some((m) => m.transactionRef === 'BANK-9' && m.receiptId === now[0].id));
  assert.deepEqual(books.journalEntries.find((e) => e.id === 'p1')?.receipts, [now[0].id]);
});
