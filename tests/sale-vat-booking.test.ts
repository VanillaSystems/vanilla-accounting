/**
 * The classifier books a sale's output tax in code where code can decide
 * (src/accounting/sales-without-vat.ts saleCodeOf): a customer payment without an invoice gets the
 * app's proposal (domestic: the normal rate, Liechtenstein included), never a zero code for want of
 * a paper; an invoice that places its service abroad gets the abroad code; a card-terminal payout
 * without its report is a domestic sale; books not registered for VAT get none. A document that
 * shows Swiss VAT, and the model's reading of an order page or a payout report, stand. Persona test
 * 2026-10-15 corner-2, 13, 37, 38, 40. The model is a stub that answers what the persona test saw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyDeps } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import { whySeen } from '../src/app/areas/journal/model.js';
import { setJurisdiction } from '../src/engines/index.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';
import './support/jurisdiction.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Malerei' }] };

const fx = loadFxResolver();
const context = {
  companyName: 'Malerei Test GmbH', chartOfAccounts: '', historicEntries: '',
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank' }, { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR' }],
};
const pay = (ref: string, amount: number, o: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-08-14', amount, currency: 'CHF', direction: 'CRDT', description: `Gutschrift ${ref}`, ...o });
const sale = (amount: number, vatCode = 'V0', account = '3400'): ClassifyEntry => ({ accountDebit: '', accountCredit: account, amount, vatCode, description: 'Kunde, Malerarbeiten' });

/** The model answers each ref with its lines and the persona test's reason. */
const model = (answers: Record<string, ClassifyEntry[]>): ClassifyDeps['ask'] => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: answers[ref], reason: 'ohne Beleg und ohne MWST-Angabe gilt V0' }])));
};

/** Books `txs` as a firm set up as `setup` (the engines compute for it, as the workspace would set them). */
async function book(txs: BankTransaction[], answers: Record<string, ClassifyEntry[]>, receipts: Array<Partial<Receipt> & { id: string; ref: string }> = [], setup: VatSetup = EFFECTIVE_QUARTERLY): Promise<Map<string, JournalEntry[]>> {
  const books = {
    transactions: txs, bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' },
    receipts: receipts.map(({ ref, ...r }) => ({ filename: `${r.id}.pdf`, ...r }) as Receipt),
    mappings: receipts.map((r) => ({ transactionRef: r.ref, receiptId: r.id })),
  } as unknown as Books;
  setJurisdiction(ch, setup);
  const outcome = await classifyTransactions(books, txs, { ask: model(answers), fx, context: { ...context, vat: setup } });
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  assert.deepEqual(outcome.failed, []);
  const by = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries) by.set(e.transactionRef, [...(by.get(e.transactionRef) ?? []), e]);
  return by;
}
const codes = (entries: JournalEntry[] | undefined) => entries?.map((e) => e.vatCode ?? '');

test('a domestic customer payment without an invoice is booked at the normal rate, never V0, and says why', async () => {
  const booked = await book([
    pay('KELLER', 4860, { counterparty: 'Familie Keller', description: 'Rechnung 2026-028 Malerarbeiten Wohnzimmer' }),
    pay('MEIER', 3275, { counterparty: 'Hans Meier', counterpartyIban: 'CH0000762011623852957' }),
  ], { KELLER: [sale(4860)], MEIER: [sale(3275)] });
  assert.deepEqual(codes(booked.get('KELLER')), ['V81'], 'no IBAN, the books\' currency: domestic');
  assert.deepEqual(codes(booked.get('MEIER')), ['V81'], 'a Swiss IBAN: domestic');
  const [keller] = booked.get('KELLER')!;
  assert.deepEqual([keller.accountDebit, keller.accountCredit, keller.amount, keller.origin], ['1020', '3400', 4860, 'classify']);
  assert.match(keller.reason!, /Kundenzahlung ohne Rechnung.*Inlandumsatz mit V81/);
  assert.doesNotMatch(keller.reason!, /gilt V0/, 'the model\'s wrong reason is not kept');
});

test('a client in Vaduz is domestic: Liechtenstein is in the Swiss VAT territory', async () => {
  const booked = await book([pay('RHEINPARK', 2162, { counterparty: 'Hotel Rheinpark AG', counterpartyIban: 'LI0008810000232401300', description: 'Rechnung 2026-033 Malerarbeiten Lobby' })], { RHEINPARK: [sale(2162)] });
  assert.deepEqual(codes(booked.get('RHEINPARK')), ['V81']);
});

test('money from abroad without an invoice is proposed as an export; the model\'s V81 there is not kept either', async () => {
  const booked = await book([
    pay('DE', 900, { counterpartyIban: 'DE00370400440532013000' }),
    pay('EUR', 500, { bank: 'Wise', currency: 'EUR' }),
  ], { DE: [sale(900, 'V81')], EUR: [sale(500, 'V81')] });
  assert.deepEqual([codes(booked.get('DE')), codes(booked.get('EUR'))], [['V0'], ['V0']]);
});

test('a card-terminal payout without its report is a domestic sale at the normal rate', async () => {
  const booked = await book([pay('SUMUP', 1412.35, { counterparty: 'SumUp Payments Ltd', description: 'SumUp Auszahlung PO-88213' })], { SUMUP: [sale(1412.35)] });
  assert.deepEqual(codes(booked.get('SUMUP')), ['V81']);
});

test('an invoice that places its service abroad gets the abroad code (Ziffer 221), not the export code', async () => {
  const text = 'Rechnung 2026-031\nBeratung Fassadenplanung\nLeistungsort Deutschland: nicht der schweizerischen MWST unterstellt\nTotal EUR 1200.00';
  const booked = await book([pay('OKT', 1200, { bank: 'Wise', currency: 'EUR' })], { OKT: [sale(1200)] }, [{ id: 'r-okt', ref: 'OKT', hasSwissVat: false, extractedText: text }]);
  const [e] = booked.get('OKT')!;
  assert.deepEqual([e.vatCode, e.receipts], ['V0-E', ['r-okt']]);
  assert.match(e.reason!, /Leistungsort im Ausland/);
});

test('a document decides where it can: Swiss VAT on it, and the model\'s reading of an order page or a payout report, stand', async () => {
  const booked = await book([pay('INV', 4860), pay('SHOP', 120), pay('REPORT', 1412.35)], {
    INV: [sale(4860, 'V81')],
    SHOP: [sale(120, 'V0')],
    REPORT: [sale(1480, 'V81'), sale(-40, '-V81'), { accountDebit: '6840', accountCredit: '', amount: 27.65, vatCode: 'I0', description: 'SumUp, Gebühren' }],
  }, [
    { id: 'r-inv', ref: 'INV', hasSwissVat: true, extractedText: 'Rechnung 2026-028, MWST 8.1 %, CHE-123.456.789' },
    { id: 'r-shop', ref: 'SHOP', hasSwissVat: false, extractedText: 'Order #1201, shipping address: Berlin, Germany' },
    { id: 'r-report', ref: 'REPORT', hasSwissVat: false, extractedText: 'SumUp Auszahlungsbericht PO-88213: 3 Kartenzahlungen 1480.00, Rückerstattung -40.00, Gebühren -27.65' },
  ]);
  assert.deepEqual(codes(booked.get('INV')), ['V81']);
  assert.deepEqual(codes(booked.get('SHOP')), ['V0'], 'an export the order page shows is the model\'s to read');
  assert.deepEqual(codes(booked.get('REPORT')), ['V81', '-V81', 'I0'], 'the report\'s split as the model booked it');
});

test('a credit that is no sale keeps the model\'s code: a refund of a purchase, money with no code, a payment out', async () => {
  const booked = await book([pay('REFUND', 98.14), pay('LOAN', 5000), pay('OUT', 40, { direction: 'DBIT' })], {
    REFUND: [sale(98.14, '', '8510')],
    LOAN: [{ accountDebit: '', accountCredit: '2400', amount: 5000, vatCode: '', description: 'Darlehen' }],
    OUT: [{ accountDebit: '3400', accountCredit: '', amount: 40, vatCode: '-V81', description: 'Rückerstattung Kunde' }],
  });
  assert.deepEqual([codes(booked.get('REFUND')), codes(booked.get('LOAN')), codes(booked.get('OUT'))], [[''], [''], ['-V81']]);
});

test('books not registered for VAT book a sale without a VAT code, whatever the model proposed, and a purchase gross', async () => {
  const buy: ClassifyEntry = { accountDebit: '6510', accountCredit: '', amount: 108.1, vatCode: 'I81', description: 'Swisscom, Telefon' };
  const booked = await book([pay('KELLER', 4860), pay('INV', 300), pay('TEL', 108.1, { direction: 'DBIT' })], { KELLER: [sale(4860, 'V0')], INV: [sale(300, 'V81')], TEL: [buy] },
    [{ id: 'r-inv', ref: 'INV', hasSwissVat: true, extractedText: 'Rechnung, MWST 8.1 %' }, { id: 'r-tel', ref: 'TEL', hasSwissVat: true, extractedText: 'Swisscom, MWST 8.1 %' }], NOT_REGISTERED);
  assert.deepEqual([codes(booked.get('KELLER')), codes(booked.get('INV')), codes(booked.get('TEL'))], [[''], [''], ['']]);
  assert.match(booked.get('KELLER')![0].reason!, /nicht steuerpflichtig/);
  assert.equal(booked.get('TEL')![0].amount, 108.1, 'the purchase is booked gross');
});

test('the net tax rate method: a sale gets the approved rate\'s code at gross, an export or a service abroad keeps its code, a purchase carries none', async () => {
  const buy: ClassifyEntry = { accountDebit: '6510', accountCredit: '', amount: 108.1, vatCode: 'I81', description: 'Swisscom, Telefon' };
  const abroad: ClassifyEntry = { accountDebit: '6570', accountCredit: '', amount: 50, vatCode: 'B81', description: 'Example SaaS, Software' };
  const text = 'Rechnung 2026-031\nLeistungsort Deutschland: nicht der schweizerischen MWST unterstellt\nTotal EUR 1200.00';
  const booked = await book(
    [pay('KELLER', 4860), pay('INV', 2162), pay('DE', 900, { counterpartyIban: 'DE00370400440532013000' }), pay('OKT', 1200, { bank: 'Wise', currency: 'EUR' }), pay('TEL', 108.1, { direction: 'DBIT' }), pay('SAAS', 50, { direction: 'DBIT' })],
    { KELLER: [sale(4860, 'V0')], INV: [sale(2162, 'V81')], DE: [sale(900, 'V81')], OKT: [sale(1200)], TEL: [buy], SAAS: [abroad] },
    [{ id: 'r-inv', ref: 'INV', hasSwissVat: true, extractedText: 'Rechnung 2026-028, MWST 8.1 %, CHE-123.456.789' }, { id: 'r-okt', ref: 'OKT', hasSwissVat: false, extractedText: text }, { id: 'r-tel', ref: 'TEL', hasSwissVat: true, extractedText: 'Swisscom, MWST 8.1 %' }],
    NET_RATE,
  );
  assert.deepEqual(codes(booked.get('KELLER')), ['F1'], 'no paper, francs, no account named: the domestic proposal at the approved rate, never V0 for want of a paper');
  assert.deepEqual(codes(booked.get('INV')), ['F1'], 'an invoice at 8.1 % is booked at the approved rate, gross');
  assert.match(booked.get('INV')![0].reason!, /Saldosteuersatz: Umsatz brutto mit F1/);
  assert.deepEqual(codes(booked.get('DE')), ['V0'], 'money from abroad without a paper: the export proposal');
  assert.deepEqual(codes(booked.get('OKT')), ['V0-E']);
  assert.deepEqual(codes(booked.get('TEL')), [''], 'no input tax on a purchase');
  assert.deepEqual(codes(booked.get('SAAS')), ['B81'], 'Bezugsteuer is owed on the net tax rate method too');
});

test('the entry says a sale without an invoice was coded by its payment, never «no receipt, no input tax»', async () => {
  const [keller] = (await book([pay('KELLER', 4860)], { KELLER: [sale(4860)] })).get('KELLER')!;
  assert.deepEqual(whySeen(keller, []), [{ kind: 'noReceipt', sale: true }]);
  const expense: JournalEntry = { ...keller, accountDebit: '6570', accountCredit: '1020', vatCode: 'I0' };
  assert.deepEqual(whySeen(expense, []), [{ kind: 'noReceipt', sale: false }]);
  assert.deepEqual(whySeen({ ...keller, vatCode: 'V0', rule: 'sale-q-x' }, []), [{ kind: 'noReceipt', sale: true, untaxed: 'V0' }], 'a sale at V0 says it carries no domestic tax (r4c-35)');
});
