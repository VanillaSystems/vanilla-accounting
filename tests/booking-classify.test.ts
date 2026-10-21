/**
 * src/booking/classify.ts turns the model's answer into journal entries, for `npm run classify`
 * and the UI's re-classify route. The model is replaced by a stub: in-process for
 * classifyTransactions, and by tests/support/stub-bin/claude on PATH for the API route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransactions, entriesFor, moneyAccounts, type ClassifyDeps } from '../src/booking/classify.js';
import { chartFor, loadChart } from '../src/workspace/chart.js';
import { chartNames } from '../src/booking/rule-book.js';
import { bankAccountFor } from '../src/accounting/bank-accounts.js';
import { workspaceAt, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { ClosedPeriodError, periodLock, type Books } from '../src/books/store.js';
import { buildBatchClassifyPrompt, type ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { startApi } from './support/api-server.js';
import { booksOnDisk } from './support/workspace.js';
import { loadBooks } from '../src/books/store.js';
import './support/jurisdiction.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';

const REPO = process.cwd();
const fx = loadFxResolver();
const lock = periodLock({ config: { closedThrough: '2026-06-30' } });
// ESTV daily sell rates valid on 2026-08-14 (reference/estv-daily-rates-2026.json); the legacy flat rates are 0.91 / 0.78.
const EUR_2026_08_14 = 0.94711;
const USD_2026_08_14 = 0.82194;

const tx = (t: Partial<BankTransaction> & Pick<BankTransaction, 'ref'>): BankTransaction =>
  ({ bank: 'Wise', date: '2026-08-14', amount: 50, currency: 'CHF', direction: 'DBIT', description: 'Bank text', ...t });
const expense = (amount: number): ClassifyEntry => ({ accountDebit: '6570', accountCredit: '', amount, vatCode: 'I0', description: 'Shop, Ware' });

function books(txs: BankTransaction[], receipts: Array<Partial<Receipt> & { id: string; ref: string }> = []): Books {
  return {
    transactions: txs,
    receipts: receipts.map(({ ref, ...r }) => ({ filename: `${r.id}.pdf`, extractedText: 'Beleg mit genug Text', ...r }) as Receipt),
    mappings: receipts.map((r) => ({ transactionRef: r.ref, receiptId: r.id })),
    bankStatements: [],
    journalEntries: [],
    config: { closedThrough: '2026-06-30' },
  } as unknown as Books;
}

function stubAsk(answer: (ref: string) => ClassifyEntry[]) {
  const prompts: string[] = [];
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    prompts.push(prompt);
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: answer(ref) }])));
  };
  return { ask, prompts };
}

const bankAccounts: LedgerBankAccount[] = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank' },
  { bank: 'Wise', currency: 'CHF', account: '1022', label: 'Wise CHF' },
  { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR' },
  { bank: 'Wise', currency: 'USD', account: '1024', label: 'Wise USD' },
  { bank: 'manual', currency: 'CHF', account: '2451', label: 'Kontokorrent' },
  { bank: 'manual', currency: 'EUR', account: '2451', label: 'Kontokorrent' },
];
const context = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', vatCodes: '', bankAccounts };

test('a foreign entry carries the ESTV daily sell rate of the payment date, not the flat rate', () => {
  const ctx = { fx, receiptDate: undefined, receipts: [], bankAccount: '1023', lock, by: { kind: 'model', model: 'sonnet' } as const };
  const [eur] = entriesFor(tx({ ref: 'E', currency: 'EUR' }), [expense(50)], ctx);
  const [usd] = entriesFor(tx({ ref: 'U', currency: 'USD' }), [expense(50)], { ...ctx, bankAccount: '1024' });
  assert.deepEqual([eur.exchangeCurrency, eur.exchangeRate], ['EUR', EUR_2026_08_14]);
  assert.deepEqual([usd.exchangeCurrency, usd.exchangeRate], ['USD', USD_2026_08_14]);
  const [chf] = entriesFor(tx({ ref: 'C' }), [expense(50)], ctx);
  assert.equal(chf.exchangeRate, undefined);
});

test('a transfer between the company\'s own money accounts carries no VAT code, whoever proposed one (r4w-9)', () => {
  const money = moneyAccounts(bankAccounts, loadChart().accounts);
  assert.ok(['1000', '1021', '1022', '1090'].every((a) => money.has(a)), 'cash, the banks, the transfer account');
  assert.ok(!money.has('2451') && !money.has('1510'), 'the owner\'s account and a fixed asset are no money');
  const ctx = { fx, receiptDate: undefined, receipts: [], bankAccount: '1021', lock, by: { kind: 'model', model: 'sonnet' } as const, money };
  const [cash] = entriesFor(tx({ ref: 'ATM', bank: 'Raiffeisen', amount: 800 }), [{ accountDebit: '1000', accountCredit: '', amount: 800, vatCode: 'I0', description: 'Bargeldbezug' }], ctx);
  assert.deepEqual([cash.accountDebit, cash.accountCredit, cash.vatCode], ['1000', '1021', undefined]);
  const [tool] = entriesFor(tx({ ref: 'T', bank: 'Raiffeisen', amount: 900 }), [{ accountDebit: '1510', accountCredit: '', amount: 900, vatCode: 'I81', description: 'Maschine' }], ctx);
  assert.equal(tool.vatCode, 'I81', 'a fixed asset bought keeps its input tax');
});

test('a VAT code from the model follows the money: a supplier credit (bank debited, the expense credited) takes the minus code, the zero code too (r9h-11)', () => {
  const ctx = { fx, receiptDate: undefined, receipts: [], bankAccount: '1021', lock, by: { kind: 'model', model: 'sonnet' } as const };
  const credit = tx({ ref: 'GS', bank: 'Raiffeisen', direction: 'CRDT', amount: 408.6 });
  const [m0] = entriesFor(credit, [{ accountDebit: '1021', accountCredit: '4400', amount: 408.6, vatCode: 'M0', description: 'Gutschrift GS-1207' }], ctx);
  assert.deepEqual([m0.accountDebit, m0.accountCredit, m0.vatCode], ['1021', '4400', '-M0']);
  const [m81] = entriesFor(credit, [{ accountDebit: '', accountCredit: '4400', amount: 408.6, vatCode: 'M81', description: 'Gutschrift GS-1207' }], ctx);
  assert.equal(m81.vatCode, '-M81');
  const [purchase] = entriesFor(tx({ ref: 'FM', bank: 'Raiffeisen', amount: 408.6 }), [{ accountDebit: '4400', accountCredit: '', amount: 408.6, vatCode: '-M0', description: 'Rechnung FM-78230' }], ctx);
  assert.equal(purchase.vatCode, 'M0', 'a minus the model put on a purchase goes');
  const [refund] = entriesFor(tx({ ref: 'RF', bank: 'Raiffeisen', amount: 50 }), [{ accountDebit: '3400', accountCredit: '', amount: 50, vatCode: 'V81', description: 'Rückerstattung' }], ctx);
  assert.equal(refund.vatCode, '-V81', 'a customer refund takes -V81');
});

test('a Stripe payout books its 1093 entries on the order date and adds the payout leg', () => {
  const payout = tx({ ref: 'P', direction: 'CRDT', amount: 95, currency: 'EUR', bank: 'Wise' });
  const llm: ClassifyEntry[] = [
    { accountDebit: '1093', accountCredit: '3200', amount: 100, vatCode: 'V81', description: 'Shopify, Umsatz' },
    { accountDebit: '6580', accountCredit: '1093', amount: 5, vatCode: '', description: 'Stripe, Gebühr' },
  ];
  const entries = entriesFor(payout, llm, { fx, receiptDate: '2026-08-02', receipts: [], bankAccount: '1023', lock, by: { kind: 'model', model: 'sonnet' } });
  assert.deepEqual(
    entries.map((e) => [e.date, e.accountDebit, e.accountCredit, e.amount, e.description]),
    [
      ['2026-08-02', '1093', '3200', 100, 'Shopify, Umsatz'],
      ['2026-08-02', '6580', '1093', 5, 'Stripe, Gebühr'],
      ['2026-08-14', '1023', '1093', 95, 'Stripe, Auszahlung'],
    ],
  );
  assert.ok(entries.every((e) => e.exchangeRate === EUR_2026_08_14));
});

test('no entry is ever dated in a closed period', () => {
  const payout = tx({ ref: 'P', direction: 'CRDT', amount: 95, date: '2026-07-03' });
  const llm: ClassifyEntry[] = [{ accountDebit: '1093', accountCredit: '3200', amount: 95, vatCode: 'V81', description: 'Shopify, Umsatz' }];
  const entries = entriesFor(payout, llm, { fx, receiptDate: '2026-06-28', receipts: [], bankAccount: '1021', lock, by: { kind: 'model', model: 'sonnet' } });
  assert.deepEqual(entries.map((e) => e.date), ['2026-07-03', '2026-07-03']);
  assert.throws(
    () => entriesFor(tx({ ref: 'C', date: '2026-06-30' }), [expense(5)], { fx, receiptDate: undefined, receipts: [], bankAccount: '1021', lock, by: { kind: 'model', model: 'sonnet' } }),
    ClosedPeriodError,
  );
});

test('the bank side the model leaves empty is the transaction\'s account, manual ones on 2451', async () => {
  assert.deepEqual(
    [
      bankAccountFor({ bank: 'Raiffeisen', currency: 'CHF' }, bankAccounts),
      bankAccountFor({ bank: 'Wise', currency: 'USD' }, bankAccounts),
      bankAccountFor({ bank: 'manual', currency: 'EUR' }, bankAccounts),
      bankAccountFor({ bank: 'Wise', currency: 'GBP' }, bankAccounts),
    ],
    ['1021', '1024', '2451', '1021'],
  );
  const b = books([
    tx({ ref: 'M', bank: 'manual', currency: 'EUR' }),
    tx({ ref: 'R', bank: 'Raiffeisen', direction: 'CRDT' }),
  ]);
  const { ask } = stubAsk((ref) => ref === 'R'
    ? [{ accountDebit: '', accountCredit: '3200', amount: 50, vatCode: 'V0', description: 'Ertrag' }]
    : [expense(50)]);
  await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual(
    b.journalEntries.map((e) => [e.transactionRef, e.accountDebit, e.accountCredit]),
    [['M', '6570', '2451'], ['R', '1021', '3200']],
  );
});

test('every classified entry is stamped origin classify', async () => {
  const b = books([tx({ ref: 'A' }), tx({ ref: 'B', currency: 'USD' })]);
  const { ask } = stubAsk(() => [expense(20), expense(30)]);
  const { classified, failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual([classified, failed], [['A', 'B'], []]);
  assert.equal(b.journalEntries.length, 4);
  assert.ok(b.journalEntries.every((e) => e.origin === 'classify'));
});

test('the prompt carries each receipt\'s VAT facts', async () => {
  const b = books([tx({ ref: 'V' })], [{ id: 'r1', ref: 'V', hasSwissVat: true, vatId: 'CHE-111.222.333', vatSummary: [{ ratePercent: 8.1, vat: 3.75, gross: 50 }] }]);
  const { ask, prompts } = stubAsk(() => [expense(50)]);
  await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.match(prompts[0], /VAT facts: Swiss MWST CHE-111\.222\.333 — 8\.1% → suffix 81, gross 50, vat 3\.75/);
});

test('ten transactions per model call, and an unanswered one stays unbooked', async () => {
  const b = books(Array.from({ length: 12 }, (_, i) => tx({ ref: `T${i}` })));
  const { ask, prompts } = stubAsk((ref) => (ref === 'T11' ? [] : [expense(50)]));
  const { failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.equal(prompts.length, 2);
  assert.deepEqual(failed, [{ ref: 'T11', reason: 'no entries in response' }]);
  assert.ok(!b.journalEntries.some((e) => e.transactionRef === 'T11'));
});

test('an answer with an entry without an account, or one that does not add up to the payment, never lands', async () => {
  const b = books([tx({ ref: 'NOACC', amount: 100 }), tx({ ref: 'SHORT', amount: 100 }), tx({ ref: 'OK', amount: 100 })]);
  const { ask } = stubAsk((ref) => ref === 'NOACC'
    ? [{ accountDebit: '', accountCredit: '', amount: 100, vatCode: 'I0', description: 'Leer' }]
    : ref === 'SHORT' ? [expense(60)] : [expense(100)]);
  const { classified, failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual(classified, ['OK']);
  assert.deepEqual(failed.map((f) => [f.ref, f.refusal?.code]), [['NOACC', 'classifyAccount'], ['SHORT', 'classifyBalance']]);
  assert.deepEqual(failed[1].refusal, { code: 'classifyBalance', params: { date: '2026-08-14', currency: 'CHF', paid: 100, booked: 60 } });
  assert.match(failed[1].reason, /nichts gebucht, die Zahlung bleibt/);
  assert.deepEqual([...new Set(b.journalEntries.map((e) => e.transactionRef))], ['OK']);
});

test('Skonto answered as the model did (invoice total, and a discount line with the bank left empty) books balanced on the bank', async () => {
  const b = books([tx({ ref: 'FM', bank: 'Raiffeisen', amount: 1506.45 })], [{ id: 'r1', ref: 'FM', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 115.18, gross: 1537.22 }] }]);
  const { ask } = stubAsk(() => [
    { accountDebit: '4400', accountCredit: '', amount: 1537.22, vatCode: 'M81', description: 'Farbmix, Material' },
    { accountDebit: '', accountCredit: '4400', amount: 30.77, vatCode: '-M81', description: 'Farbmix, Skonto 2 %' },
  ]);
  const { failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual(failed, []);
  assert.deepEqual(
    b.journalEntries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode]),
    [['4400', '1021', 1537.22, 'M81'], ['1021', '4400', 30.77, '-M81']],
  );
});

test('a Wise card fee is booked once, on its FEE-CARD payment, never again inside the card charge (#24)', async () => {
  // As Wise's camt053 has them (tests/fixtures/camt053/uuid_statement_wise_USD.xml): the charge is the converted amount without the fee; the fee is its own debit.
  const charge = tx({ ref: 'CARD-7200000001', currency: 'USD', amount: 9.5, description: 'Card transaction of 7.60 CHF issued by Example Hosting INTERNET (fee: 0.02 USD)' });
  const fee = tx({ ref: 'FEE-CARD-7200000001', currency: 'USD', amount: 0.02, description: 'Wise Charges for: CARD-7200000001', type: 'wise-fee' });
  const b = books([charge, fee]);
  // The model as the Q3 replay saw it: a fee its payment's text names becomes a 6940 line of that payment.
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const blocks = [...prompt.matchAll(/^### Transaction \d+: (\S+)\n[\s\S]*?Amount: ([\d.]+)[\s\S]*?Bank description: (.*)$/gm)];
    return JSON.stringify(Object.fromEntries(blocks.map(([, ref, amount, text]) => {
      const named = /\(fee: ([\d.]+)/.exec(text)?.[1];
      const feeLine = (a: number): ClassifyEntry => ({ accountDebit: '6940', accountCredit: '', amount: a, vatCode: 'I0', description: 'Wise, Kartengebühren' });
      if (text.startsWith('Wise Charges')) return [ref, { entries: [feeLine(Number(amount))] }];
      const rest = Math.round((Number(amount) - Number(named ?? 0)) * 100) / 100;
      return [ref, { entries: [{ ...expense(rest), accountDebit: '6570' }, ...(named ? [feeLine(Number(named))] : [])] }];
    })));
  };
  const { classified, failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual([classified.sort(), failed], [['CARD-7200000001', 'FEE-CARD-7200000001'], []]);
  const on = (account: string) => b.journalEntries.filter((e) => e.accountDebit === account).map((e) => [e.transactionRef, e.amount]);
  assert.deepEqual(on('6940'), [['FEE-CARD-7200000001', 0.02]], 'the fee once, on its own payment');
  assert.deepEqual(on('6570'), [['CARD-7200000001', 9.5]], 'the charge whole on the expense');
  assert.match(b.journalEntries.find((e) => e.transactionRef === 'CARD-7200000001')?.reason ?? '', /separat \(FEE-CARD-7200000001\)/, 'the booking says why the fee line went');
});

test('any bank: a payment whose fee is its own movement keeps no fee line, the fee goes back to the expense at its code (#24)', async () => {
  // Not Wise: a CHF card payment on another bank, whose card fee the bank debits apart, linked to it as the books link a separate fee.
  const charge = tx({ ref: 'KART-48151623', bank: 'Raiffeisen', amount: 86.4, description: 'Kartenzahlung Seminarhaus Beispiel Basel, Kartenzuschlag 1.30 CHF' });
  const fee = tx({ ref: 'FEE-KART-48151623', bank: 'Raiffeisen', amount: 1.3, description: 'Spesen Kartenzahlung KART-48151623', type: 'wise-fee' });
  const b = books([charge, fee], [{ id: 'r1', ref: 'KART-48151623', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 6.38, gross: 85.1 }] }]);
  const { ask, prompts } = stubAsk((ref) => ref === 'KART-48151623'
    ? [{ ...expense(85.1), accountDebit: '6640', vatCode: 'I81', description: 'Seminarhaus Beispiel, Kurs' }, { accountDebit: '6900', accountCredit: '', amount: 1.3, vatCode: '', description: 'Bank, Kartenspesen' }]
    : [{ accountDebit: '6900', accountCredit: '', amount: 1.3, vatCode: '', description: 'Bank, Kartenspesen' }]);
  const { classified, failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual([classified.sort(), failed], [['FEE-KART-48151623', 'KART-48151623'], []]);
  assert.match(prompts[0], /Fee: 1\.3 CHF, debited separately as FEE-KART-48151623/, 'the model is told the fee is its own movement');
  const lines = (ref: string) => b.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountDebit, e.amount, e.vatCode]);
  assert.deepEqual(lines('KART-48151623'), [['6640', 86.4, 'I81']], 'the whole payment on the expense, at its code');
  assert.deepEqual(lines('FEE-KART-48151623'), [['6900', 1.3, undefined]], 'the fee once, on its own movement');
});

test('a line of the fee\'s amount the code cannot tell apart or put back is refused: nothing booked, the payment waits (#24)', async () => {
  const charge = tx({ ref: 'KART-1', bank: 'Raiffeisen', amount: 60 });
  const fee = tx({ ref: 'FEE-KART-1', bank: 'Raiffeisen', amount: 2, type: 'wise-fee' });
  const feeLine: ClassifyEntry = { accountDebit: '6900', accountCredit: '', amount: 2, vatCode: 'I0', description: 'Bank, Spesen' };
  const feeBooked = { id: 'f', transactionRef: 'FEE-KART-1', date: '2026-08-14', accountDebit: '6900', accountCredit: '1021', amount: 2, description: 'Bank, Spesen', origin: 'classify' };
  for (const [why, answer, booked] of [
    ['two expense lines it could go back to', [expense(40), { ...expense(18), accountDebit: '6500' }, feeLine], [feeBooked]],
    ['a fee line with a VAT rate', [{ ...expense(58), vatCode: 'I81' }, { ...feeLine, vatCode: 'I81' }], [feeBooked]],
    ['the fee\'s amount on another account than the fee\'s: maybe a real item', [expense(58), { ...feeLine, accountDebit: '6500' }], [feeBooked]],
    ['the fee movement booked nowhere yet: its account unknown', [expense(58), feeLine], []],
  ] as const) {
    const b = books([charge]);
    b.transactions.push(fee);
    b.journalEntries.push(...(booked as unknown as Books['journalEntries']));
    const { ask } = stubAsk(() => [...answer]);
    const { classified, failed } = await classifyTransactions(b, [charge], { ask, fx, context });
    assert.deepEqual(classified, [], why);
    assert.deepEqual(failed.map((f) => [f.ref, f.refusal]), [['KART-1', { code: 'classifySeparateFee', params: { fee: 'FEE-KART-1', currency: 'CHF', amount: 2 } }]], why);
    assert.deepEqual(b.journalEntries.filter((e) => e.transactionRef === 'KART-1'), [], why);
  }
});

test('a payment without a separate fee movement keeps a fee line of the same amount as the model gave it', async () => {
  const charge = tx({ ref: 'KART-2', bank: 'Raiffeisen', amount: 60 });
  const b = books([charge, tx({ ref: 'FEE-KART-3', bank: 'Raiffeisen', amount: 2, type: 'wise-fee' })]);
  const { ask } = stubAsk(() => [expense(58), { accountDebit: '6900', accountCredit: '', amount: 2, vatCode: 'I0', description: 'Bank, Spesen' }]);
  await classifyTransactions(b, [charge], { ask, fx, context });
  assert.deepEqual(b.journalEntries.map((e) => [e.accountDebit, e.amount]), [['6570', 58], ['6900', 2]]);
});

test('a VAT-amount code (M81-2) keeps its one empty leg: the code is its other side', async () => {
  const b = books([tx({ ref: 'SH', amount: 50 })]);
  const { ask } = stubAsk(() => [expense(50), { accountDebit: '', accountCredit: '6580', amount: 3.75, vatCode: 'M81-2', description: 'Shopify, Vorsteuer' }]);
  const { failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual(failed, []);
  assert.deepEqual(b.journalEntries.map((e) => [e.accountDebit, e.accountCredit]), [['6570', '1022'], ['', '6580']]);
});

test('the model\'s reason is stamped on every entry of its payment', async () => {
  const b = books([tx({ ref: 'R' })]);
  const ask: ClassifyDeps['ask'] = async () => JSON.stringify({ R: { entries: [expense(20), expense(30)], reason: 'Beleg zeigt keine MWST: I0.' } });
  await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual(b.journalEntries.map((e) => e.reason), ['Beleg zeigt keine MWST: I0.', 'Beleg zeigt keine MWST: I0.']);
});

test('UI re-classify books through the classifier: daily rate, VAT facts, origin', async () => {
  const stubBin = join(REPO, 'tests/support/stub-bin');
  const promptLog = join(mkdtempSync(join(tmpdir(), 'classify-prompts-')), 'prompts.txt');
  const api = await startApi('tests/fixtures/classify-index.json', {
    PATH: `${stubBin}:${process.env.PATH}`,
    CLAUDE_STUB_PROMPTS: promptLog,
  });
  try {
    const { status, json } = await api.send('POST', '/api/journal-entries/classify/W1');
    assert.equal(status, 200, String(json.error));
    const saved = loadBooks(workspaceAt(api.ws.paths.root)) as Books;
    const entries = saved.journalEntries.filter((e) => e.transactionRef === 'W1');
    assert.deepEqual(
      entries.map(({ id, ...e }) => e),
      [{
        transactionRef: 'W1', date: '2026-08-14', accountDebit: '6570', accountCredit: '1023', amount: 50, vatCode: 'I81',
        description: 'Stub, Aufwand', exchangeCurrency: 'EUR', exchangeRate: EUR_2026_08_14, origin: 'classify', receipts: ['rw'], by: { kind: 'model', model: 'sonnet' },
      }],
    );
    assert.match(readFileSync(promptLog, 'utf8'), /VAT facts: Swiss MWST CHE-123\.456\.789/);

    const before = JSON.stringify(booksOnDisk(api.ws));
    const closed = await api.send('POST', '/api/journal-entries/classify/C1');
    assert.equal(closed.status, 403);
    assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'closed transaction: index byte-identical');
  } finally {
    await api.stop();
  }
});

/** The standard KMU chart of a new goods-selling GmbH (npm run init), in the layout classify reads. */
const kmuChart = ['Konto\tBeschreibung', ...chartFor(loadChart(), 'goods', 'GmbH').map((a) => `${a.number}\t${a.name}`)].join('\n');

test('a model booking on an account missing from the chart never lands: the payment waits, unbooked, with the account named (#37)', async () => {
  assert.ok(!chartNames(kmuChart).has('3450'), 'the standard chart has no 3450');
  const b = books([tx({ ref: 'SHOP', direction: 'CRDT', amount: 100 }), tx({ ref: 'OK', amount: 100 })]);
  const { ask } = stubAsk((ref) => ref === 'SHOP'
    ? [{ accountDebit: '', accountCredit: '3450', amount: 100, vatCode: 'V81', description: 'Webshop Bestellung #1001, M. Muster, CH' }]
    : [expense(100)]);
  const { classified, failed } = await classifyTransactions(b, b.transactions, { ask, fx, context: { ...context, chartOfAccounts: kmuChart } });
  assert.deepEqual(classified, ['OK']);
  assert.deepEqual(failed.map((f) => [f.ref, f.refusal]), [['SHOP', { code: 'classifyUnknownAccount', params: { account: '3450', description: 'Webshop Bestellung #1001, M. Muster, CH' } }]]);
  assert.match(failed[0].reason, /3450.*nichts gebucht/);
  assert.ok(!b.journalEntries.some((e) => e.accountDebit === '3450' || e.accountCredit === '3450'), 'nothing on 3450');
});

test('a model booking with a VAT code the engine does not know never lands: the payment waits, unbooked, with the code named (#56)', async () => {
  const b = books([tx({ ref: 'Z', amount: 100 }), tx({ ref: 'OK', amount: 100 })]);
  const { ask } = stubAsk((ref) => ref === 'Z'
    ? [{ accountDebit: '6570', accountCredit: '', amount: 100, vatCode: 'Z0', description: 'Shop, Ware' }]
    : [expense(100)]);
  const { classified, failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.deepEqual(classified, ['OK']);
  assert.deepEqual(failed.map((f) => [f.ref, f.refusal]), [['Z', { code: 'classifyUnknownVatCode', params: { code: 'Z0', description: 'Shop, Ware' } }]]);
  assert.match(failed[0].reason, /Z0.*nichts gebucht/);
  assert.deepEqual(b.journalEntries.map((e) => e.transactionRef), ['OK'], 'nothing booked for Z');
});

test('a code the firm\'s form does not take is left off, not refused: a firm not registered and one on the net tax rate method book the payment without it (#56)', async () => {
  const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
  const netRate: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] };
  try {
    for (const setup of [NOT_REGISTERED, netRate]) {
      setJurisdiction(ch, setup);
      const b = books([tx({ ref: 'I', amount: 100 }), tx({ ref: 'Z', amount: 100 })]);
      const { ask } = stubAsk((ref) => [{ accountDebit: '6570', accountCredit: '', amount: 100, vatCode: ref === 'I' ? 'I81' : 'Z0', description: 'Shop, Ware' }]);
      const { classified, failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
      assert.deepEqual([classified, failed], [['I', 'Z'], []], `${setup.registered ? 'net rate' : 'not registered'}: both booked`);
      assert.deepEqual(b.journalEntries.map((e) => e.vatCode), [undefined, undefined], 'without a code');
    }
  } finally {
    setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  }
});

test('the classify prompt names no account the standard chart lacks (#37)', () => {
  const prompt = buildBatchClassifyPrompt([{ tx: tx({ ref: 'X' }), receipts: [] }], { companyName: 'Test GmbH', chartOfAccounts: kmuChart, historicEntries: '', vatCodes: '' });
  const instructions = prompt.slice(prompt.indexOf('## Instructions'));
  const named = [...instructions.matchAll(/(?<![#\d.])\b([1-9]\d{3})\b(?![.\d])/g)].map((m) => m[1]).filter((n) => !/^(19|20)\d\d$/.test(n));
  const chart = chartNames(kmuChart);
  assert.ok(named.length > 0, 'the instructions name accounts');
  assert.deepEqual([...new Set(named.filter((n) => !chart.has(n)))], []);
});
