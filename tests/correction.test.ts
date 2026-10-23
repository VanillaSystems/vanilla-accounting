/**
 * The correction of a filed entry by what was wrong (persona round 3, corner-29): a VAT code taken
 * back leaves the bank where the statement has it, an account moved leaves bank and VAT, and only
 * the storno reverses the bank side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { accountCorrectionCode, banksMoved, correctionKinds, correctionOf, correctionReceipts, privateUseCode, receiptRate, receiptVat } from '../src/accounting/correction.js';
import { entriesForReturn } from '../src/accounting/declarations.js';
import { bookBalanceNative } from '../src/accounting/reconcile-bank.js';
import { filing, vat } from '../src/engines/index.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import type { BookChange } from '../src/types/assistant.js';
import { changesIn } from '../src/assistant/changes.js';
import { applyAnswer } from '../src/server/edits.js';
import { reconcileCases } from '../src/accounting/correction-cases.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { startApi } from './support/api-server.js';

/** The changes an answer of the AI asks for, as its ```vanilla-changes block says them. */
const asked = (json: string) => changesIn('```vanilla-changes\n' + json + '\n```') as BookChange[];

const isBank = (a: string) => a === '1020';
const natel: JournalEntry = { id: 'natel', transactionRef: 'RB-13', date: '2026-08-15', accountDebit: '6510', accountCredit: '1020', amount: 89, vatCode: 'I81', description: 'Natel August' };
const entry = (d: ReturnType<typeof correctionOf>): JournalEntry => ({ id: 'corr', transactionRef: 'M2026-001', corrects: '2026-Q3', ...d });
const bank = (es: JournalEntry[]) => bookBalanceNative(es, '1020', 'CHF', '2026', '2026-12-31', 0);
const tax = (e: JournalEntry) => Math.round((vat().vatLine(e)?.tax ?? 0) * 100) / 100;

test('a VAT code taken back: the expense against itself, the code turned; the bank stays, the input tax goes', () => {
  const d = correctionOf(natel, 'vat', '2026-10-16', 'Korrektur', isBank);
  assert.deepEqual(d, { date: '2026-10-16', accountDebit: '6510', accountCredit: '6510', amount: 89, vatCode: '-I81', description: 'Korrektur' });
  assert.equal(bank([natel, entry(d)]), bank([natel]), 'the payment happened: the bank is as the statement says');
  assert.equal(tax(natel), 6.67);
  assert.equal(tax(entry(d)), -6.67, 'the 0535 takes the input tax back');
  assert.deepEqual(banksMoved(d, isBank), []);
});

test('the storno moves the bank, and says so; it is offered last', () => {
  const d = correctionOf(natel, 'storno', '2026-10-16', 'Storno', isBank);
  assert.deepEqual([d.accountDebit, d.accountCredit, d.vatCode], ['1020', '6510', '-I81']);
  assert.equal(bank([natel, entry(d)]), bank([natel]) + 89, 'CHF 89 back on the bank in the books');
  assert.deepEqual(banksMoved(d, isBank), ['1020']);
  assert.deepEqual(correctionKinds(natel), ['vat', 'account', 'storno']);
  assert.deepEqual(correctionKinds({ ...natel, vatCode: undefined }), ['account', 'storno'], 'no code, nothing to take back');
});

test('an account moved: from the old to a new one the person types, bank and VAT untouched; a sale moves its revenue side', () => {
  const d = correctionOf(natel, 'account', '2026-10-16', 'Konto', isBank);
  assert.deepEqual([d.accountDebit, d.accountCredit, d.vatCode], ['', '6510', undefined]);
  const sale: JournalEntry = { ...natel, accountDebit: '1020', accountCredit: '3400', vatCode: 'V81' };
  const s = correctionOf(sale, 'account', '2026-10-16', 'Konto', isBank);
  assert.deepEqual([s.accountDebit, s.accountCredit], ['3400', '']);
  const v = correctionOf(sale, 'vat', '2026-10-16', 'MWST', isBank);
  assert.deepEqual([v.accountDebit, v.accountCredit, v.vatCode], ['3400', '3400', '-V81']);
  assert.equal(tax(entry(v)), -tax(sale), 'the output tax taken back exactly');
});

test('a one-sided VAT entry is turned whole: it has no bank side to keep', () => {
  const shopify: JournalEntry = { ...natel, accountDebit: '', accountCredit: '6580', amount: 12.4, vatCode: 'M81-2' };
  const d = correctionOf(shopify, 'vat', '2026-10-16', 'MWST', isBank);
  assert.deepEqual([d.accountDebit, d.accountCredit, d.vatCode], ['6580', '', '-M81-2']);
});

test('the AI turns that storno into a VAT-only correction: the same account on both sides is a change it can ask for (corner-30)', () => {
  const storno: JournalEntry = { ...entry(correctionOf(natel, 'storno', '2026-10-16', 'Korrektur', isBank)), origin: 'manual' };
  const books = () => ({
    receipts: [], transactions: [], mappings: [], bankStatements: [],
    journalEntries: [natel, structuredClone(storno)], config: { closedThrough: '2026-09-30' },
  });
  const ctx = { bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen', role: 'bank' as const }], chart: new Set(['1020', '6510']), earlier: [], conversation: 'c' };
  for (const set of ['{"accountDebit":"6510"}', '{"accountDebit":6510,"accountCredit":6510}', '{"accountDebit":"6510","accountCredit":"6510","vatCode":"-I81"}']) {
    const b = books();
    applyAnswer(b, asked('[{"kind":"entry","id":"corr","set":' + set + '}]'), ctx);
    const corr = b.journalEntries.find((e) => e.id === 'corr')!;
    assert.deepEqual([corr.accountDebit, corr.accountCredit, corr.vatCode, corr.corrects], ['6510', '6510', '-I81', '2026-Q3'], set);
    assert.equal(bank(b.journalEntries), bank([natel]), `${set}: the bank is as the statement says`);
  }
  const added = books();
  applyAnswer(added, asked('[{"kind":"newEntry","entry":{"date":"2026-10-16","accountDebit":"6510","accountCredit":"6510","amount":89,"vatCode":"-I81","description":"nur die Vorsteuer","corrects":"2026-Q3"}}]'), ctx);
  assert.equal(tax(added.journalEntries.at(-1)!), -6.67, 'a new VAT-only correction as well');
  assert.throws(() => applyAnswer(books(), asked('[{"kind":"entry","id":"corr","set":{"accountDebit":"","accountCredit":""}}]'), ctx), /Soll- oder Habenkonto fehlt/);
});

test('a side left empty is refused with the way that works: the account on both sides', () => {
  const b = { receipts: [], transactions: [], mappings: [], bankStatements: [], journalEntries: [natel, { ...entry(correctionOf(natel, 'storno', '2026-10-16', 'K', isBank)), origin: 'manual' as const }], config: { closedThrough: '2026-09-30' } };
  const ctx = { bankAccounts: [], chart: new Set<string>(), earlier: [], conversation: 'c' };
  assert.throws(() => applyAnswer(b, asked('[{"kind":"entry","id":"corr","set":{"accountDebit":"6510","accountCredit":""}}]'), ctx), /6510\/6510/);
});

/** Ziffern 405, 415 and the payable tax of Q3 as its 0535 declares them from these entries. */
const q3 = (es: JournalEntry[]) => {
  const f = vat().figures(entriesForReturn(es, '2026-Q3', filing().length), '2026-Q3', []);
  return { 405: f.ziffern['405'] ?? 0, 415: f.ziffern['415'] ?? 0, payable: Math.round(f.payable * 100) / 100 };
};
test('a filed purchase moved onto the owner\'s private account takes its input tax back: K81-B, 0535 Ziffer 415 (r4t-7)', () => {
  const tank: JournalEntry = { id: 'tank', transactionRef: 'RB-7', date: '2026-08-12', accountDebit: '6200', accountCredit: '1020', amount: 74.2, vatCode: 'I81', description: 'Karte 5412 Tanken' };
  const isPrivate = (a: string) => a === '2451';
  assert.equal(accountCorrectionCode(tank, '2451', isPrivate), 'K81-B');
  assert.equal(accountCorrectionCode(tank, '6210', isPrivate), undefined, 'onto another expense the VAT stays as declared');
  assert.equal(accountCorrectionCode({ ...tank, vatCode: 'I0' }, '2451', isPrivate), undefined, 'no input tax claimed, none to take back');
  assert.equal(privateUseCode('M26'), 'K26-B', 'at the purchase\'s own rate');
  const draft = correctionOf(tank, 'account', '2026-10-16', 'Korrektur', isBank);
  const corr = entry({ ...draft, accountDebit: '2451', vatCode: accountCorrectionCode(tank, '2451', isPrivate) });
  assert.deepEqual([corr.accountDebit, corr.accountCredit, corr.amount, corr.vatCode], ['2451', '6200', 74.2, 'K81-B']);
  assert.deepEqual(q3([tank]), { 405: 5.56, 415: 0, payable: -5.56 }, 'as filed: 5.56 input tax claimed');
  assert.deepEqual(q3([tank, corr]), { 405: 5.56, 415: 5.56, payable: 0 }, 'the 0535: the input tax taken back at Ziffer 415');
  assert.equal(bank([tank, corr]), bank([tank]), 'the bank stays');
  assert.equal(tax(corr), tax(tank), 'the tax put back on 6200 is the input tax it had claimed: the expense nets to 0, the owner owes 74.20');
});

test('a filed purchase without input tax whose receipt shows Swiss VAT: the MWST-Code correction claims it, 0535 Ziffer 405 (r4c-37)', () => {
  const geruest: JournalEntry = { id: 'g', transactionRef: 'RB-8', date: '2026-08-20', accountDebit: '6000', accountCredit: '1020', amount: 1120, vatCode: 'I0', description: 'Gerüst August' };
  assert.equal(receiptRate([{ hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 83.92 }] }]), 8.1);
  assert.equal(receiptRate([{ hasSwissVat: false, vatSummary: [{ ratePercent: 19, vat: 5 }] }]), undefined, 'a foreign VAT is no Swiss input tax');
  const d = correctionOf(geruest, 'vat', '2026-10-16', 'Korrektur', isBank, 8.1);
  assert.deepEqual([d.accountDebit, d.accountCredit, d.amount, d.vatCode], ['6000', '6000', 1120, 'I81']);
  assert.deepEqual(q3([geruest]), { 405: 0, 415: 0, payable: 0 });
  assert.deepEqual(q3([geruest, entry(d)]), { 405: 83.92, 415: 0, payable: -83.92 }, 'the 0535 claims the receipt\'s input tax');
  assert.equal(bank([geruest, entry(d)]), bank([geruest]), 'the bank stays');
  assert.equal(correctionOf(geruest, 'vat', '2026-10-16', 'Korrektur', isBank).vatCode, '-I0', 'without a receipt with Swiss VAT nothing to claim');
  assert.equal(correctionOf(natel, 'vat', '2026-10-16', 'Korrektur', isBank, 8.1).vatCode, '-I81', 'a code with tax is still taken back');
});

test('a late receipt for a filed payment claims its input tax: the receipt points at the payment, not linked, and the correction reads it (corner-33, r4c-37)', () => {
  const geruest: JournalEntry = { id: 'g', transactionRef: 'RB-8', date: '2026-08-20', accountDebit: '6000', accountCredit: '1020', amount: 1120, vatCode: 'I0', description: 'Gerüst August' };
  const late: Receipt = { id: 'late', filename: 'geruest-august.pdf', filedPayment: 'RB-8', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 83.92 }] } as Receipt;
  const other: Receipt = { ...late, id: 'other', filedPayment: 'RB-9' };
  const rate = receiptRate(correctionReceipts(geruest, [], [late, other]));
  assert.equal(rate, 8.1, 'the receipt that pays the payment counts though it is not linked');
  const d = correctionOf(geruest, 'vat', '2026-10-16', 'Korrektur', isBank, rate);
  assert.deepEqual([d.accountDebit, d.accountCredit, d.vatCode], ['6000', '6000', 'I81'], 'I81, not the -I0 that books nothing');
  assert.deepEqual(q3([geruest, entry(d)]), { 405: 83.92, 415: 0, payable: -83.92 }, 'the 0535 claims CHF 83.92 at Ziffer 405');
  assert.equal(receiptRate(correctionReceipts(geruest, [], [other])), undefined, 'a receipt of another payment is not read');
  const unpointed = { ...late, filedPayment: undefined };
  assert.equal(receiptRate(correctionReceipts(geruest, [], [unpointed], 'late')), 8.1, 'opened from a receipt («Zahlung verknüpfen» on a filed payment): that receipt is read');
  assert.equal(correctionReceipts(geruest, [late], [late], 'late').length, 1, 'a linked receipt is read once');
});

test('a late receipt that states its tax: the correction claims that figure as a tax-amount line, not the tax recomputed from the gross (r10h-6)', () => {
  // A receipt states CHF 11.89 on CHF 158.60 gross; 8.1 % recomputed from the gross gives 11.88.
  const baucenter: JournalEntry = { id: 'b', transactionRef: 'RB-9', date: '2026-09-09', accountDebit: '6100', accountCredit: '1020', amount: 158.6, vatCode: 'I0', description: 'Baucenter' };
  const stated: Receipt[] = [{ id: 'late', filename: 'baucenter.pdf', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 11.89 }] } as Receipt];
  assert.equal(receiptVat(stated, 8.1), 11.89);
  assert.equal(receiptVat(stated, 2.6), undefined, 'no figure at another rate');
  assert.equal(receiptVat([{ hasSwissVat: false, vatSummary: [{ ratePercent: 8.1, vat: 11.89 }] } as Receipt], 8.1), undefined, 'a receipt without Swiss VAT states none');
  const d = correctionOf(baucenter, 'vat', '2026-10-16', 'Korrektur', isBank, 8.1, 11.89);
  assert.deepEqual(d, { date: '2026-10-16', accountDebit: '', accountCredit: '6100', amount: 11.89, vatCode: 'I81-2', description: 'Korrektur' }, 'the tax itself, off the expense, one-legged like the Shopify Vorsteuer line');
  assert.deepEqual(q3([baucenter, entry(d)]), { 405: 11.89, 415: 0, payable: -11.89 }, 'the 0535 claims the receipt\'s figure');
  const gross = correctionOf(baucenter, 'vat', '2026-10-16', 'Korrektur', isBank, 8.1);
  assert.deepEqual([gross.accountDebit, gross.accountCredit, gross.amount, gross.vatCode], ['6100', '6100', 158.6, 'I81'], 'without a stated figure the gross line as before');
  assert.equal(q3([baucenter, entry(gross)])[405], 11.88, 'which the engine rounds to 11.88');
  assert.equal(bank([baucenter, entry(d)]), bank([baucenter]), 'the bank stays');
  const foreign: JournalEntry = { ...baucenter, exchangeCurrency: 'EUR', exchangeRate: 0.95 };
  assert.equal(correctionOf(foreign, 'vat', '2026-10-16', 'Korrektur', isBank, 8.1, 11.89).vatCode, 'I81', 'a foreign-currency entry keeps the gross correction in its currency');
});

test('the correction booked from a late receipt links the receipt, which then points at its filed payment (r10h-6)', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const at = () => loadBooks(workspaceAt(api.ws.paths.root));
    // The fixture's receipts are all linked: free one to stand for the late receipt of the filed payment C1.
    assert.equal((await api.send('POST', '/api/mapping/remove', { transactionRef: 'O1', receiptId: 'ro' })).status, 200);
    const jc = at().journalEntries.find((e) => e.id === 'jc')!;
    const body = { date: '2026-08-15', accountDebit: '', accountCredit: jc.accountDebit, amount: 0.75, vatCode: 'I81-2', description: `Korrektur zu ${jc.transactionRef}`, corrects: '2026-Q2', correctsEntry: 'jc', correction: 'vat', receipt: 'ro' };
    const { status, json } = await api.send('POST', '/api/journal-entries', body);
    assert.equal(status, 200, String(json.error));
    const entry = (json as { entry: JournalEntry }).entry;
    const books = at();
    assert.deepEqual(books.mappings.filter((m) => m.receiptId === 'ro').map((m) => m.transactionRef), [entry.transactionRef], 'the receipt is linked to the correction');
    assert.equal(books.receipts.find((r) => r.id === 'ro')!.filedPayment, 'C1', 'and points at the filed payment it pays');
    assert.ok(!books.mappings.some((m) => m.transactionRef === 'C1' && m.receiptId === 'ro'), 'the filed payment itself gets no link (its quarter is sealed)');
    const gone = await api.send('POST', '/api/journal-entries', { ...body, receipt: 'nope' });
    assert.equal(gone.status, 404, 'a receipt the books lack is refused');
  } finally {
    await api.stop();
  }
});

test('a correction booked by hand gets its case (r8c-6): the 0535 explains it, no orphan; an entry put back without the original gets none', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const at = () => loadBooks(workspaceAt(api.ws.paths.root));
    const jc = at().journalEntries.find((e) => e.id === 'jc')!;
    const body = { date: '2026-08-15', accountDebit: jc.accountDebit, accountCredit: jc.accountDebit, amount: jc.amount, vatCode: '-I81', description: `Korrektur zu ${jc.transactionRef}`, corrects: '2026-Q2' };
    const { status, json } = await api.send('POST', '/api/journal-entries', { ...body, correctsEntry: 'jc', correction: 'vat' });
    assert.equal(status, 200, String(json.error));
    const entry = (json as { entry: JournalEntry }).entry;
    const cases = at().config.correctionCases ?? [];
    const c = cases.find((x) => x.correctionEntryIds.includes(entry.id))!;
    assert.ok(c, 'the correction has a case');
    assert.deepEqual([c.period, c.originalEntryIds], ['2026-Q2', ['jc']]);
    assert.match(c.title, /Steuercode/);
    assert.match(c.wrong, /jc/);
    assert.match(c.fix, /-I81/);
    const filed = { period: '2026-Q2' as const, ziffern: {} };
    assert.deepEqual(reconcileCases(cases, at().journalEntries, filed, filed).orphans, [], 'the 0535 lists no orphan');
    const plain = await api.send('POST', '/api/journal-entries', { ...body, description: 'Korrektur ohne Fall' });
    assert.equal(plain.status, 200);
    assert.equal((at().config.correctionCases ?? []).length, 1, 'without the original named, no case is invented');
    const unknown = await api.send('POST', '/api/journal-entries', { ...body, correctsEntry: 'nope', correction: 'vat' });
    assert.equal(unknown.status, 404);
  } finally {
    await api.stop();
  }
});

test('r8k-10: a private outlay for a receipt dated in a filed quarter corrects that quarter; a bank payment never does', async () => {
  const { correctsFor } = await import('../src/accounting/correction.js');
  const { entriesFor } = await import('../src/booking/classify.js');
  const { periodLock } = await import('../src/books/store.js');
  const lock = periodLock({ config: { closedThrough: '2026-06-30' } });
  const kiosk = { id: 'k', date: '2026-06-20' } as Receipt;
  const outlay: BankTransaction = { ref: 'M2026-002', bank: 'manual', source: 'manual', date: '2026-07-01', amount: 12.5, currency: 'CHF', direction: 'DBIT', description: 'Kiosk' };
  const byBank: BankTransaction = { ...outlay, bank: 'Raiffeisen', source: undefined };
  assert.equal(correctsFor(outlay, [kiosk], lock.isClosed, 'quarter'), '2026-Q2');
  assert.equal(correctsFor(byBank, [kiosk], lock.isClosed, 'quarter'), undefined, 'a March invoice paid by bank in July is a July booking, no correction');
  assert.equal(correctsFor(outlay, [{ id: 'j', date: '2026-07-01' } as Receipt], lock.isClosed, 'quarter'), undefined, 'a receipt of the open period corrects nothing');
  const fx = { daily: () => undefined, flat: () => undefined } as unknown as Parameters<typeof entriesFor>[2]['fx'];
  const [e] = entriesFor(outlay, [{ accountDebit: '6500', accountCredit: '', amount: 12.5, vatCode: 'I0', description: 'Kiosk' }], { fx, receiptDate: '2026-06-20', receipts: ['k'], bankAccount: '2451', lock, by: { kind: 'model', model: 'stub' }, corrects: '2026-Q2' });
  assert.deepEqual([e.date, e.corrects, e.accountCredit], ['2026-07-01', '2026-Q2', '2451'], 'the classifier stamps the correction too');
});

test('a correction of a foreign-currency entry carries its currency and rate: the 0535 takes back exactly the input tax claimed (r9c-1)', () => {
  const software: JournalEntry = { id: 'sw', transactionRef: 'WISE-1', date: '2026-05-04', accountDebit: '6570', accountCredit: '1021', amount: 32.43, vatCode: 'I81', exchangeCurrency: 'EUR', exchangeRate: 0.93222, description: 'Beispiel Software' };
  assert.equal(tax(software), 2.27, 'claimed on CHF 30.23, not on the EUR figure');
  const d = correctionOf(software, 'vat', '2026-10-16', 'Korrektur', isBank);
  assert.deepEqual([d.exchangeCurrency, d.exchangeRate, d.amount], ['EUR', 0.93222, 32.43], 'the amount stays the EUR figure, with the rate it was booked at');
  assert.equal(tax(entry(d)), -2.27, 'the 0535 reverses 2.27, not 2.43');
  const storno = correctionOf(software, 'storno', '2026-10-16', 'Storno', isBank);
  assert.deepEqual([storno.exchangeCurrency, storno.exchangeRate], ['EUR', 0.93222]);
  const moved = correctionOf(software, 'account', '2026-10-16', 'Konto', isBank);
  assert.deepEqual([moved.exchangeCurrency, moved.exchangeRate], ['EUR', 0.93222], 'the account moved: the CHF value moves with it');
  assert.equal(correctionOf(natel, 'vat', '2026-10-16', 'K', isBank).exchangeCurrency, undefined, 'a CHF entry carries no currency');
});
