/**
 * A firm without input tax (not registered: demo-coiffeur; on the net tax rate method:
 * demo-schreinerei) claims none and takes none back: no correction, year-end entry, evidence check
 * or hand form proposes an input-tax code there, and a typed one is refused. The effective method
 * (demo) keeps them. On the demo workspaces' own filed purchases and receipts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { ownerAccount } from '../src/accounting/bank-accounts.js';
import { accountCorrectionCode, claimCode, correctionKinds, correctionOf, correctionReceipts, receiptRate } from '../src/accounting/correction.js';
import { yearEndTemplates } from '../src/accounting/year-close.js';
import { evidenceCheck } from '../src/accounting/evidence-check.js';
import { inputTaxWithoutReceipt } from '../src/accounting/manual-booking.js';
import { codeForRate, formTakes } from '../src/accounting/vat-codes.js';
import { entriesForReturn } from '../src/accounting/declarations.js';
import { filing, vat, withoutInputTax } from '../src/engines/index.js';
import type { JournalEntry, Receipt } from '../src/types/index.js';

/** Opens a demo; its first filed purchase of an expense, a receipt of it with Swiss VAT, and its owner's private account. */
function demo(name: string) {
  const ws = workspaceAt(join(APP_ROOT, name));
  const books = loadBooks(ws);
  const closed = books.config.closedThrough!;
  const banks = new Set(ws.bankAccounts.filter((a) => a.bank !== 'manual').map((a) => a.account));
  const purchase = books.journalEntries.find((e) => e.date <= closed && banks.has(e.accountCredit) && /^6\d{3}$/.test(e.accountDebit))!;
  const receipt = books.receipts.find((r) => r.hasSwissVat && r.vatSummary?.some((g) => g.ratePercent === 8.1 && g.vat > 0))!;
  const late: Receipt = { ...receipt, id: 'late', filedPayment: purchase.transactionRef };
  const owner = ownerAccount(ws).split(' ')[0];
  return { ws, books, purchase, late, owner, isPrivate: (a: string) => a === owner };
}
const isBank = (a: string) => a.startsWith('102');

for (const [name, kind] of [['demo-coiffeur', 'none'], ['demo-schreinerei', 'net-rate']] as const) {
  test(`${name}: a correction of a filed purchase carries no input-tax code, onto the private account neither`, () => {
    const { purchase, late, owner, isPrivate } = demo(name);
    assert.equal(withoutInputTax(), kind);
    assert.equal(purchase.vatCode, undefined, 'the purchase was booked gross');
    assert.deepEqual(correctionKinds(purchase), ['account', 'storno'], 'no code to correct');
    const draft = correctionOf(purchase, 'account', '2026-10-16', 'Korrektur', isBank);
    assert.equal(draft.vatCode, undefined);
    assert.equal(accountCorrectionCode(purchase, owner, isPrivate), undefined, 'no K81-B onto the private account');
    const rate = receiptRate(correctionReceipts(purchase, [], [late]));
    assert.equal(rate, 8.1, 'the late receipt shows Swiss VAT');
    assert.equal(claimCode(purchase, purchase.accountDebit, rate), undefined, 'and still claims none');
    assert.equal(claimCode({ ...purchase, vatCode: 'I0' }, purchase.accountDebit, rate), undefined, 'not even from a stray I0');
  });

  test(`${name}: the year close's private share has no K81-B; no evidence check, no hand-form proposal, a typed input-tax code is refused`, () => {
    const { purchase, late } = demo(name);
    const privateUse = yearEndTemplates().find((t) => t.id === 'privateUse')!;
    assert.deepEqual([privateUse.accountDebit, privateUse.vatCode], ['2451', undefined]);
    assert.equal(evidenceCheck({ ...purchase, date: '2026-12-01', vatCode: 'I0' }, [late], undefined), undefined);
    assert.equal(evidenceCheck({ ...purchase, date: '2026-12-01', vatCode: 'I81' }, [], undefined), undefined);
    assert.equal(inputTaxWithoutReceipt('I81'), undefined, 'no «I0 instead» either: the form refuses I81 itself');
    for (const code of ['I81', 'M81', 'K81-B', 'I0']) assert.equal(formTakes(code), false, code);
    assert.equal(codeForRate(8.1, '6200', '1020'), null, 'a typed 8.1 on a purchase is no code');
  });
}

test('demo-schreinerei: the sale codes stay (F1, V0, B81), and a private-account correction leaves the H1 return as filed', () => {
  const { books, purchase, owner } = demo('demo-schreinerei');
  for (const code of ['F1', '-F1', 'V0', 'B81-1']) assert.equal(formTakes(code), true, code);
  assert.equal(codeForRate(4.5, '1020', '3400'), 'F1');
  const corr: JournalEntry = { id: 'corr', transactionRef: 'M2026-099', date: '2026-10-16', accountDebit: owner, accountCredit: purchase.accountDebit, amount: purchase.amount, corrects: '2026-H1', description: 'Korrektur' };
  const h1 = (es: JournalEntry[]) => vat().figures(entriesForReturn(es, '2026-H1', filing().length), '2026-H1', []);
  assert.deepEqual(h1([...books.journalEntries, corr]).ziffern, h1(books.journalEntries).ziffern, 'nothing to declare on the correction return');
});

test('demo (effective method): the same corrections take the input tax back and claim it', () => {
  const { purchase, late, isPrivate, owner } = demo('demo');
  assert.equal(withoutInputTax(), undefined);
  const claimed: JournalEntry = { ...purchase, vatCode: 'I81' };
  assert.equal(accountCorrectionCode(claimed, owner, isPrivate), 'K81-B');
  assert.equal(claimCode({ ...purchase, vatCode: 'I0' }, purchase.accountDebit, receiptRate(correctionReceipts(purchase, [], [late]))), 'I81');
  assert.equal(yearEndTemplates().find((t) => t.id === 'privateUse')?.vatCode, 'K81-B');
  assert.equal(inputTaxWithoutReceipt('I81'), 'I0');
  assert.equal(formTakes('K81-B'), true);
});

test('demo-schreinerei: a filed sale moved off the revenue accounts («kein Verkauf») carries -F1, so the correction return takes turnover and tax back; onto another revenue account it keeps its code (r9n-24)', () => {
  const { books, owner, isPrivate } = demo('demo-schreinerei');
  const closed = books.config.closedThrough!;
  const sale = books.journalEntries.find((e) => e.date <= closed && e.vatCode === 'F1')!;
  assert.ok(sale, 'the demo has a filed net-rate sale');
  assert.equal(accountCorrectionCode(sale, owner, isPrivate), '-F1', 'onto the owner\'s account');
  assert.equal(accountCorrectionCode(sale, '2140', isPrivate), '-F1', 'onto a loan: no sale either');
  assert.equal(accountCorrectionCode(sale, '3200', isPrivate), undefined, 'onto another revenue account the sale stays declared');
  assert.equal(accountCorrectionCode(sale, '', isPrivate), undefined, 'no target yet');
  const corr: JournalEntry = { id: 'corr', transactionRef: 'M2026-098', date: '2026-10-16', accountDebit: sale.accountCredit, accountCredit: owner, amount: sale.amount, vatCode: '-F1', corrects: '2026-H1', description: 'kein Verkauf' };
  const h1 = (es: JournalEntry[]) => vat().figures(entriesForReturn(es, '2026-H1', filing().length), '2026-H1', []);
  const was = h1(books.journalEntries);
  const now = h1([...books.journalEntries, corr]);
  assert.equal(Math.round((was.ziffern['200'] - now.ziffern['200']) * 100) / 100, sale.amount, 'the turnover leaves Ziffer 200');
  assert.ok(now.payable < was.payable, 'and the tax at the rate goes down');
});

test('demo (effective method): an account correction of a sale carries no code: the form is another round\'s', () => {
  const { books, owner, isPrivate } = demo('demo');
  const sale = books.journalEntries.find((e) => e.vatCode === 'V81')!;
  assert.equal(accountCorrectionCode(sale, owner, isPrivate), undefined);
});
