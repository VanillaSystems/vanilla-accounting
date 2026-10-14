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
import { classifyTransactions, entriesFor, type ClassifyDeps } from '../src/booking/classify.js';
import { bankAccountFor } from '../src/accounting/bank-accounts.js';
import { workspaceAt, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { ClosedPeriodError, periodLock, type Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { startApi } from './support/api-server.js';
import { booksOnDisk } from './support/workspace.js';
import { loadBooks } from '../src/books/store.js';
import './support/jurisdiction.js';

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
  const ctx = { fx, receiptDate: undefined, bankAccount: '1023', lock };
  const [eur] = entriesFor(tx({ ref: 'E', currency: 'EUR' }), [expense(50)], ctx);
  const [usd] = entriesFor(tx({ ref: 'U', currency: 'USD' }), [expense(50)], { ...ctx, bankAccount: '1024' });
  assert.deepEqual([eur.exchangeCurrency, eur.exchangeRate], ['EUR', EUR_2026_08_14]);
  assert.deepEqual([usd.exchangeCurrency, usd.exchangeRate], ['USD', USD_2026_08_14]);
  const [chf] = entriesFor(tx({ ref: 'C' }), [expense(50)], ctx);
  assert.equal(chf.exchangeRate, undefined);
});

test('a Stripe payout books its 1093 entries on the order date and adds the payout leg', () => {
  const payout = tx({ ref: 'P', direction: 'CRDT', amount: 95, currency: 'EUR', bank: 'Wise' });
  const llm: ClassifyEntry[] = [
    { accountDebit: '1093', accountCredit: '3200', amount: 100, vatCode: 'V81', description: 'Shopify, Umsatz' },
    { accountDebit: '6580', accountCredit: '1093', amount: 5, vatCode: '', description: 'Stripe, Gebühr' },
  ];
  const entries = entriesFor(payout, llm, { fx, receiptDate: '2026-08-02', bankAccount: '1023', lock });
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
  const entries = entriesFor(payout, llm, { fx, receiptDate: '2026-06-28', bankAccount: '1021', lock });
  assert.deepEqual(entries.map((e) => e.date), ['2026-07-03', '2026-07-03']);
  assert.throws(
    () => entriesFor(tx({ ref: 'C', date: '2026-06-30' }), [expense(5)], { fx, receiptDate: undefined, bankAccount: '1021', lock }),
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
  const { ask, prompts } = stubAsk((ref) => (ref === 'T11' ? [] : [expense(1)]));
  const { failed } = await classifyTransactions(b, b.transactions, { ask, fx, context });
  assert.equal(prompts.length, 2);
  assert.deepEqual(failed, [{ ref: 'T11', reason: 'no entries in response' }]);
  assert.ok(!b.journalEntries.some((e) => e.transactionRef === 'T11'));
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
        description: 'Stub, Aufwand', exchangeCurrency: 'EUR', exchangeRate: EUR_2026_08_14, origin: 'classify',
      }],
    );
    assert.match(readFileSync(promptLog, 'utf8'), /VAT facts: Swiss MWST CHE-123\.456\.789/);

    const before = JSON.stringify(booksOnDisk(api.ws));
    const closed = await api.send('POST', '/api/journal-entries/classify/C1');
    assert.equal(closed.status, 403);
    assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'closed transaction: index byte-identical');
  } finally {
    api.stop();
  }
});
