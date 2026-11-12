/**
 * Booking by hand on a Mac without an AI (#344, the first-run persona test): the hand form opens with
 * what code knows and says where each proposal comes from, the account field finds what a layperson
 * types, the code picker lists what fits the chosen account, a photo no AI read is «not read», and a
 * CLI that is not signed in is said in the app's words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { isUnreadScan } from '../src/accounting/receipt-due.js';
import { rankAccounts, type AccountContext } from '../src/app/lib/account-filter.js';
import { fittingGroup, pickGroups } from '../src/app/areas/codes/model.js';
import { stableWords } from '../src/knowledge/gaps.js';
import { isPlanLimit, isSignedOut } from '../src/llm/provider.js';
import { noAnswerWhy } from '../src/assistant/conversations.js';
import { AI_OFF_MESSAGE } from '../src/llm/off.js';
import { chart, setJurisdiction } from '../src/engines/index.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { APP_ROOT, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { NOT_REGISTERED } from '../src/workspace/vat-setup.js';
import type { BankTransaction, Index, Receipt } from '../src/types/index.js';
import './support/jurisdiction.js';

const BANK = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF', role: 'bank' }] as unknown as LedgerBankAccount[];
const DEFAULTS = { sales: '3400', purchase: '4000' };
const tx = (ref: string, direction: 'CRDT' | 'DBIT', amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-08-04', direction, amount, currency: 'CHF', counterparty, description }) as unknown as BankTransaction;
const receipt = (id: string, over: Partial<Receipt>): Receipt => ({ id, filename: `${id}.pdf`, extractedText: 'Rechnung', location: 'archived', ...over }) as unknown as Receipt;
type Books = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts'>;
const books = (over: Partial<Books>): Books => ({ transactions: [], journalEntries: [], mappings: [], receipts: [], ...over });

test('money in without a rule, precedent or receipt: the firm\'s default revenue account and the sale code the app proposes, each named as a proposal', () => {
  const b = books({ transactions: [tx('IN', 'CRDT', 12450, 'Immo Verwaltung AG', 'Rechnung 2026-029 Treppenhaus')] });
  const [line] = bookingDraft(b, 'IN', BANK, undefined, { defaults: DEFAULTS })!.lines;
  assert.deepEqual([line.accountDebit, line.accountCredit, line.vat, line.amount], ['1020', '3400', 'V81', 12450]);
  assert.deepEqual(line.source, { account: { from: 'sales' }, vat: { from: 'sale', choice: 'saleDomestic' } });
  // Without the setup's defaults the other side stays empty, as before: no account is guessed.
  const [bare] = bookingDraft(b, 'IN', BANK)!.lines;
  assert.deepEqual([bare.accountCredit, bare.vat, bare.source], ['', '', undefined]);
});

test('money out with a linked receipt that shows Swiss VAT: the default purchase account and the receipt\'s rate as that account\'s code', () => {
  const b = books({
    transactions: [tx('OUT', 'DBIT', 1120, 'Gerüstbau AG', 'Miete Gerüst August')],
    receipts: [receipt('r1', { date: '2026-08-01', amount: 1120, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 1036.1, vat: 83.9, gross: 1120 }] })],
    mappings: [{ transactionRef: 'OUT', receiptId: 'r1' }],
  });
  const [line] = bookingDraft(b, 'OUT', BANK, undefined, { defaults: DEFAULTS })!.lines;
  assert.deepEqual([line.accountDebit, line.accountCredit, line.vat], ['4000', '1020', 'M81']);
  assert.deepEqual(line.source, { account: { from: 'purchase' }, vat: { from: 'receipt' } });
});

test('money out without a receipt: no account from the defaults and no rate (no receipt, no input tax)', () => {
  const b = books({ transactions: [tx('WAGE', 'DBIT', 5200, 'Marco Rossi', 'Lohn Juli 2026')] });
  const [line] = bookingDraft(b, 'WAGE', BANK, undefined, { defaults: DEFAULTS })!.lines;
  assert.deepEqual([line.accountDebit, line.accountCredit, line.vat, line.source], ['', '1020', '', undefined]);
});

test('the business\'s last booking comes before the defaults, and a company rule that decides the payment before both', () => {
  const earlier = { ...tx('OLD', 'CRDT', 900, 'Immo Verwaltung AG', 'Rechnung 2026-011'), date: '2026-07-01' };
  const b = books({
    transactions: [earlier, tx('IN', 'CRDT', 12450, 'Immo Verwaltung AG', 'Rechnung 2026-029 Treppenhaus')],
    journalEntries: [{ id: 'e1', transactionRef: 'OLD', date: '2026-07-01', accountDebit: '1020', accountCredit: '3000', amount: 900, vatCode: 'V81', description: 'x' }] as Index['journalEntries'],
  });
  const [byPrecedent] = bookingDraft(b, 'IN', BANK, undefined, { defaults: DEFAULTS })!.lines;
  assert.deepEqual([byPrecedent.accountCredit, byPrecedent.vat], ['3000', 'V81']);
  assert.deepEqual(byPrecedent.source, { account: { from: 'precedent', date: '2026-07-01' }, vat: { from: 'precedent' } });

  const ruled = bookingDraft(b, 'IN', BANK, undefined, { defaults: DEFAULTS, rule: { id: 'immo', lines: [{ account: '3200', vat: 'V81', amount: 12450 }] } })!.lines;
  assert.deepEqual(ruled.map((l) => [l.accountDebit, l.accountCredit, l.vat, l.amount]), [['1020', '3200', 'V81', 12450]]);
  assert.deepEqual(ruled[0].source, { account: { from: 'rule', rule: 'immo' }, vat: { from: 'rule' } });
  // A rule whose lines do not add up to what is open (the payment is booked in part) proposes nothing of its own.
  const off = bookingDraft(b, 'IN', BANK, undefined, { defaults: DEFAULTS, rule: { id: 'immo', lines: [{ account: '3200', amount: 100 }] } })!.lines;
  assert.equal(off[0].accountCredit, '3000');
});

test('a firm not registered for VAT gets the revenue account and no code', () => {
  const jurisdiction = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
  try {
    setJurisdiction(jurisdiction, NOT_REGISTERED);
    const b = books({ transactions: [tx('IN', 'CRDT', 80, 'Kundin', 'Haarschnitt')] });
    const [line] = bookingDraft(b, 'IN', BANK, undefined, { defaults: DEFAULTS })!.lines;
    assert.deepEqual([line.accountCredit, line.vat, line.source], ['3400', '', { account: { from: 'sales' } }]);
  } finally {
    setJurisdiction(jurisdiction);
  }
});

const ACCOUNTS = [
  { number: '1170', name: 'Vorsteuer Material und Dienstleistungen' },
  { number: '1301', name: 'Noch nicht erhaltener Ertrag' },
  { number: '2301', name: 'Erhaltener Ertrag des Folgejahres' },
  { number: '3000', name: 'Produktionserlöse' },
  { number: '3200', name: 'Handelserlöse' },
  { number: '3400', name: 'Dienstleistungserlöse' },
  { number: '4400', name: 'Aufwand für bezogene Dienstleistungen' },
  { number: '6510', name: 'Telefon' },
  { number: '6950', name: 'Finanzertrag' },
];
const ctx = (prefer?: 'revenue' | 'expense'): AccountContext => ({
  typeOf: (n) => chart().typeOf(n), prefer, defaults: ['3400', '3000', '4000'],
  words: { revenue: ['ertrag', 'erlös', 'einnahme'], expense: ['aufwand', 'ausgabe', 'kosten'] },
});
const ranked = (q: string, prefer?: 'revenue' | 'expense') => rankAccounts(ACCOUNTS, q, ctx(prefer)).map((m) => m.account.number);

test('«Ertrag» for money in lists the firm\'s revenue accounts first, its default accounts on top, though no revenue account is named so', () => {
  assert.deepEqual(ranked('Ertrag', 'revenue').slice(0, 3), ['3400', '3000', '3200']);
  assert.ok(ranked('Ertrag', 'revenue').indexOf('1301') > 2 && ranked('Ertrag', 'revenue').includes('6950'), 'the accounts named «Ertrag» follow');
  assert.deepEqual(ranked('Einnahme von Kunde', 'revenue').slice(0, 3), ['3400', '3000', '3200'], 'a phrase whose word names the class');
});

test('«Dienst» for money in: the first row, which Enter takes, is the revenue account, not 1170 Vorsteuer', () => {
  assert.deepEqual(ranked('Dienst', 'revenue'), ['3400', '1170', '4400']);
  assert.deepEqual(ranked('Dienst', 'expense')[0], '4400', 'for money out the expense account');
  assert.deepEqual(ranked('Dienst'), ['3400', '1170', '4400'], 'without a side: a name that starts with the word before one a later word of which does');
});

test('a typed number keeps chart order, and an empty field lists the side\'s class first', () => {
  assert.deepEqual(ranked('1'), ['1170', '1301']);
  assert.deepEqual(ranked('', 'revenue').slice(0, 4), ['3400', '3000', '3200', '1170']);
  assert.deepEqual(ranked(''), ACCOUNTS.map((a) => a.number));
});

const name = (code: string) => code;
const codes = (q: string, fit?: ReturnType<typeof fittingGroup>) => pickGroups(q, name, fit).flatMap((g) => g.options.map((o) => o.code));

test('the code picker: a typed rate lists only the codes of the chosen account\'s kind; without accounts every group as before', () => {
  assert.equal(fittingGroup('1020', '3400'), 'sale');
  assert.equal(fittingGroup('4000', '1020'), 'material');
  assert.equal(fittingGroup('6510', '1020'), 'expense');
  assert.equal(fittingGroup('1020', ''), undefined);
  const all = codes('81');
  const sale = codes('81', 'sale');
  assert.ok(all.length > 10 && all.includes('M81') && all.includes('V81'), all.join(' '));
  assert.ok(sale.length <= 4 && sale[0] === 'V81' && !sale.some((c) => /^[MIB]/.test(c)), sale.join(' '));
});

test('the code picker: words list every match, the fitting group first; an empty field too', () => {
  assert.equal(pickGroups('', name, 'sale')[0].group, 'sale');
  assert.equal(pickGroups('', name, 'sale').flatMap((g) => g.options).length, pickGroups('', name).flatMap((g) => g.options).length, 'nothing is left out');
  assert.deepEqual(codes('M81', 'sale').slice(0, 1), ['M81'], 'a code typed in full is found whatever the account');
});

test('the lasting words of a payment\'s text: without the month, the year and the numbers', () => {
  assert.equal(stableWords('Lohn Juli 2026'), 'Lohn');
  assert.equal(stableWords('Karte 5412 Tanken'), 'Tanken');
  assert.equal(stableWords('Rechnung 2026-028 Malerarbeiten Wohnzimmer'), 'Malerarbeiten Wohnzimmer');
  assert.equal(stableWords('Miete Gerüst August'), 'Miete Gerüst');
  assert.equal(stableWords('2026-07 4711'), '');
});

test('a photo or scan nobody read is not «gelesen»; one with text, or with a person\'s date or amount, is', () => {
  assert.equal(isUnreadScan({ needsVisionReview: true, extractedText: '' }), true);
  assert.equal(isUnreadScan({ needsVisionReview: true, extractedText: '', date: '2026-07-05' }), false);
  assert.equal(isUnreadScan({ needsVisionReview: true, extractedText: '', amount: 86.4 }), false);
  assert.equal(isUnreadScan({ extractedText: 'Tankstelle Wil Ost' }), false);
});

test('the CLI\'s own words for «not signed in», its limit, missing and switched off become the app\'s refusal, never its text', () => {
  assert.ok(isSignedOut('Not logged in · Please run /login'));
  assert.ok(!isSignedOut('Die Rechnung ist gebucht.') && !isPlanLimit('Not logged in · Please run /login'));
  assert.deepEqual(noAnswerWhy('Not logged in · Please run /login', 'claude'), { reason: 'signedOut', cli: 'claude' });
  assert.deepEqual(noAnswerWhy('codex: Please log in with codex login', 'codex'), { reason: 'signedOut', cli: 'codex' });
  assert.deepEqual(noAnswerWhy('claude exited 1: You have hit your usage limit', 'claude'), { reason: 'limit', cli: 'claude', said: 'You have hit your usage limit' });
  assert.deepEqual(noAnswerWhy(AI_OFF_MESSAGE, 'claude'), { reason: 'off' });
  assert.equal(noAnswerWhy('claude exited 1: something else', 'claude'), undefined);
});
