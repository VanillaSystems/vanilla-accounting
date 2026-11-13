/**
 * What the hand form proposes on each kind of firm (#344, review of #356): a payment of an issued
 * invoice is never revenue a second time, a sale on the net tax rate method takes the firm's rate,
 * money in that is no sale proposes no revenue, a receipt gives a rate and only a purchase document
 * does, an account is proposed only where a rule, a precedent or the business's file names one,
 * and a rule that asks first brings its proposal, its question and its tags.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingDraft, followedVat, withoutProposal, type DraftKnowledge } from '../src/accounting/manual-booking.js';
import { vatCodeOf } from '../src/accounting/vat-codes.js';
import { setJurisdiction } from '../src/engines/index.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { APP_ROOT, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';
import type { Invoice } from '../src/invoices/model.js';
import './support/jurisdiction.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] };
const AGREED: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
const KINDS: Array<[string, VatSetup]> = [['effective', EFFECTIVE_QUARTERLY], ['net-rate', NET_RATE], ['not registered', NOT_REGISTERED], ['agreed basis', AGREED]];

function on<T>(setup: VatSetup, fn: () => T): T {
  setJurisdiction(ch, setup);
  try { return fn(); } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
}

const BANK = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF', role: 'bank' }] as unknown as LedgerBankAccount[];
const KNOWN: DraftKnowledge = { defaults: { sales: '3400', purchase: '4000' }, invoiceRevenue: '3400', chart: ['1020', '1100', '2000', '3400', '6960'], ownUid: 'CHE-111.222.333' };
const tx = (ref: string, direction: 'CRDT' | 'DBIT', amount: number, counterparty: string, description: string, date = '2026-08-04'): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, direction, amount, currency: 'CHF', counterparty, description }) as unknown as BankTransaction;
const receipt = (id: string, over: Partial<Receipt>): Receipt => ({ id, filename: `${id}.pdf`, extractedText: 'Rechnung', location: 'archived', ...over }) as unknown as Receipt;
type Books = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts'>;
const books = (over: Partial<Books>): Books => ({ transactions: [], journalEntries: [], mappings: [], receipts: [], ...over });
const entry = (over: Partial<JournalEntry>): JournalEntry => ({ id: 'e', transactionRef: '', date: '2026-07-01', accountDebit: '', accountCredit: '', amount: 0, description: 'x', ...over }) as JournalEntry;
const firstLine = (b: Books, ref: string, known: DraftKnowledge = KNOWN, invoices?: Invoice[]) => bookingDraft(b, ref, BANK, invoices, known)!;
const sideOf = (l: { accountDebit: string; accountCredit: string; vat: string }) => [l.accountDebit, l.accountCredit, l.vat];

const invoice = { id: 'i5', status: 'issued', kind: 'invoice', deleted: false, number: '2026-005', reference: 'RF492026005', currency: 'CHF', date: '2026-07-20', payments: [], lines: [{ text: 'Malerarbeiten', quantity: 1, price: 1000, vatRate: 8.1 }], customer: { name: 'Immo AG' } } as unknown as Invoice;
const paysInvoice = tx('P', 'CRDT', 1081, 'Immo AG', 'Zahlung Rechnung 2026-005');

test('M1: a payment of an issued invoice whose event the books carry settles the receivable, without a code, and names the invoice', () => {
  for (const [kind, setup] of KINDS) {
    on(setup, () => {
      const b = books({ transactions: [paysInvoice], journalEntries: [entry({ id: 'ev', transactionRef: 'RE-2026-005', date: '2026-07-20', accountDebit: '1100', accountCredit: '3400', amount: 1081, vatCode: setup.registered ? (setup.method === 'net-rate' ? 'F1' : 'V81') : undefined })] });
      const d = firstLine(b, 'P', KNOWN, [invoice]);
      assert.deepEqual(d.invoice, { id: 'i5', number: '2026-005', settles: true }, kind);
      assert.deepEqual(d.lines.map(sideOf), [['1020', '1100', '']], `${kind}: never revenue a second time`);
      assert.deepEqual(d.lines[0].source, { account: { from: 'receivable', number: '2026-005' } }, kind);
      assert.ok(!d.notes.some((n) => n.kind === 'sale'), `${kind}: not taken for a sale without an invoice`);
    });
  }
});

test('M1: without its event (cash basis) the invoice\'s own accounts and codes are the proposal, for every kind of firm', () => {
  const expected: Record<string, string> = { effective: 'V81', 'net-rate': 'F1', 'not registered': '', 'agreed basis': 'V81' };
  for (const [kind, setup] of KINDS) {
    on(setup, () => {
      const d = firstLine(books({ transactions: [paysInvoice] }), 'P', KNOWN, [invoice]);
      assert.deepEqual(d.invoice, { id: 'i5', number: '2026-005', settles: false }, kind);
      assert.deepEqual(d.lines.map(sideOf), [['1020', '3400', expected[kind]]], kind);
      assert.deepEqual(d.lines[0].source?.account, { from: 'invoice', number: '2026-005' }, kind);
      assert.equal(d.lines[0].source?.vat?.from, expected[kind] ? 'invoice' : undefined, kind);
    });
  }
});

const sale = tx('IN', 'CRDT', 540, 'Familie Keller', 'Malerarbeiten Wohnzimmer');
const linked = (r: Receipt) => books({ transactions: [sale], receipts: [r], mappings: [{ transactionRef: 'IN', receiptId: r.id }] });
const photo = receipt('ph', { extractedText: '', extractionMethod: 'tesseract' } as Partial<Receipt>);
const readInvoice = receipt('rd', { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 499.54, vat: 40.46, gross: 540 }], vatId: 'CHE-111.222.333' });

test('M2: money in with a linked document on the net tax rate method is gross with the firm\'s net-rate code where the document proves a domestic sale; one not read asks (#382)', () => {
  on(NET_RATE, () => {
    const d = firstLine(linked(readInvoice), 'IN');
    assert.deepEqual(sideOf(d.lines[0]), ['1020', '3400', 'F1']);
    assert.deepEqual(d.lines[0].source?.vat, { from: 'netRate' });
    const p = firstLine(linked(photo), 'IN');
    assert.deepEqual(sideOf(p.lines[0]), ['1020', '3400', '']);
    assert.ok(p.notes.some((n) => n.kind === 'saleVat'));
  });
});

test('M2: on the effective method a document not read leaves the code empty and says why; one that shows the VAT gives its rate', () => {
  for (const setup of [EFFECTIVE_QUARTERLY, AGREED]) {
    on(setup, () => {
      const unread = firstLine(linked(photo), 'IN');
      assert.deepEqual(sideOf(unread.lines[0]), ['1020', '3400', '']);
      assert.ok(unread.notes.some((n) => n.kind === 'saleVat' && n.why === 'notRead'), JSON.stringify(unread.notes));
      const read = firstLine(linked(readInvoice), 'IN');
      assert.deepEqual(sideOf(read.lines[0]), ['1020', '3400', '8.1']);
      assert.equal(vatCodeOf(read.lines[0].vat, '1020', '3400')?.code, 'V81');
    });
  }
  on(NOT_REGISTERED, () => {
    const d = firstLine(linked(photo), 'IN');
    assert.deepEqual(sideOf(d.lines[0]), ['1020', '3400', '']);
    assert.ok(!d.notes.some((n) => n.kind === 'saleVat'), 'no code to miss');
  });
});

test('S1: money between own accounts, from an authority or with a business\'s document proposes no revenue and no code, and says what it is', () => {
  for (const [kind, setup] of KINDS) {
    on(setup, () => {
      const b = books({ transactions: [sale] });
      const own = firstLine(b, 'IN', { ...KNOWN, nature: { kind: 'ownTransfer' } });
      assert.deepEqual(sideOf(own.lines[0]), ['1020', '', ''], kind);
      assert.ok(own.notes.some((n) => n.kind === 'ownTransfer'), kind);
      const tax = firstLine(b, 'IN', { ...KNOWN, nature: { kind: 'authority', name: 'Steueramt' } });
      assert.deepEqual(sideOf(tax.lines[0]), ['1020', '', ''], kind);
      assert.ok(tax.notes.some((n) => n.kind === 'authority' && n.name === 'Steueramt'), kind);
      const owner = firstLine(b, 'IN', { ...KNOWN, nature: { kind: 'owner', account: '2850' } });
      assert.deepEqual(sideOf(owner.lines[0]), ['1020', '2850', ''], `${kind}: the owner's deposit on her account, no code`);
      const credit = firstLine(linked(receipt('cn', { vatId: 'CHE-999.888.777', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 40.46, gross: 540 }] })), 'IN');
      assert.deepEqual(sideOf(credit.lines[0]), ['1020', '', ''], `${kind}: a supplier's document is no sale`);
      assert.ok(credit.notes.some((n) => n.kind === 'supplierDocument'), kind);
    });
  }
});

test('S1: a provider\'s payout that waits proposes nothing and says what it waits for; one code books proposes its clearing account without a code (#404)', () => {
  const d = firstLine(books({ transactions: [sale] }), 'IN', { ...KNOWN, nature: { kind: 'payout', provider: 'Shop', why: 'clearing' } });
  assert.deepEqual(sideOf(d.lines[0]), ['1020', '', '']);
  assert.equal(d.lines[0].source, undefined);
  assert.deepEqual(d.notes, [{ kind: 'payout', provider: 'Shop', why: 'clearing' }]);
  const ready = firstLine(books({ transactions: [sale] }), 'IN', { ...KNOWN, nature: { kind: 'payout', provider: 'Shop', why: 'ready', account: '1093' } });
  assert.deepEqual(sideOf(ready.lines[0]), ['1020', '1093', '']);
  assert.deepEqual(ready.lines[0].source, { account: { from: 'clearing', provider: 'Shop' } });
});

test('S1: money back from a business the firm buys from: the account of its last purchase, the zero code inverted, or the credit note\'s rate', () => {
  const bought = tx('OUT', 'DBIT', 89, 'Farben Müller AG', 'Rechnung 4711', '2026-07-01');
  const back = tx('BACK', 'CRDT', 30, 'Farben Müller AG', 'Gutschrift Retoure');
  const b = books({ transactions: [bought, back], journalEntries: [entry({ transactionRef: 'OUT', accountDebit: '4000', accountCredit: '1020', amount: 89, vatCode: 'M81' })] });
  const plain = firstLine(b, 'BACK');
  assert.deepEqual(sideOf(plain.lines[0]), ['1020', '4000', '-M0'], 'no credit note: no input tax to take back');
  assert.ok(!plain.notes.some((n) => n.kind === 'sale'));
  const note = receipt('gs', { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 2.25, gross: 30 }], vatId: 'CHE-999.888.777' });
  const withNote = firstLine({ ...b, receipts: [note], mappings: [{ transactionRef: 'BACK', receiptId: 'gs' }] }, 'BACK');
  assert.deepEqual(sideOf(withNote.lines[0]), ['1020', '4000', '8.1']);
  assert.equal(vatCodeOf(withNote.lines[0].vat, '1020', '4000')?.code, '-M81', 'the rate on the expense\'s credit side is the refund\'s code');
  on(NET_RATE, () => assert.deepEqual(sideOf(firstLine(b, 'BACK').lines[0]), ['1020', '4000', ''], 'net tax rate: no input tax was claimed'));
});

test('S1: other money in is taken for a sale, and the form says so', () => {
  const d = firstLine(books({ transactions: [sale] }), 'IN');
  assert.deepEqual(sideOf(d.lines[0]), ['1020', '3400', 'V81']);
  assert.deepEqual(d.notes, [{ kind: 'sale' }]);
});

const rent = tx('R', 'DBIT', 1120, 'Gerüstbau AG', 'Miete Gerüst August');
const bill = receipt('r1', { date: '2026-08-01', amount: 1120, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 1036.1, vat: 83.9, gross: 1120 }] });
const rentBooks = (r: Receipt) => books({ transactions: [rent], receipts: [r], mappings: [{ transactionRef: 'R', receiptId: r.id }] });

test('S2: money out with a receipt and no rule, precedent or account of the business: no account, the receipt\'s rate, and the form says so', () => {
  const d = firstLine(rentBooks(bill), 'R');
  assert.deepEqual(sideOf(d.lines[0]), ['', '1020', '8.1']);
  assert.deepEqual(d.lines[0].source, { vat: { from: 'receipt' } });
  assert.ok(d.notes.some((n) => n.kind === 'chooseAccount'));
  const known = firstLine(rentBooks(bill), 'R', { ...KNOWN, account: '6100' });
  assert.deepEqual(sideOf(known.lines[0]), ['6100', '1020', '8.1'], 'the business\'s file names its account');
  assert.deepEqual(known.lines[0].source?.account, { from: 'business' });
  assert.equal(vatCodeOf('8.1', '6100', '1020')?.code, 'I81');
});

test('S2: a delivery note or the firm\'s own document gives no rate on money out', () => {
  for (const kind of ['supporting', 'sales-record'] as const) {
    assert.deepEqual(sideOf(firstLine(rentBooks({ ...bill, kind }), 'R').lines[0]), ['', '1020', ''], kind);
  }
});

test('S2: on the agreed basis a receipt dated in another quarter proposes the account as always and says the line goes on its day over the payable (#360); on the cash basis it is the payment\'s date that counts', () => {
  const earlier = { ...bill, date: '2026-06-20' };
  const b = { ...rentBooks(earlier), transactions: [rent, tx('R0', 'DBIT', 900, 'Gerüstbau AG', 'Miete Juli', '2026-07-02')], journalEntries: [entry({ transactionRef: 'R0', accountDebit: '6100', accountCredit: '1020', amount: 900, vatCode: 'I81' })] };
  on(AGREED, () => {
    const d = firstLine(b, 'R');
    assert.deepEqual(sideOf(d.lines[0]), ['6100', '1020', '8.1']);
    assert.ok(d.notes.some((n) => n.kind === 'taxPoint' && n.date === '2026-06-20' && n.account === '2000'), JSON.stringify(d.notes));
  });
  const cash = firstLine(b, 'R');
  assert.deepEqual(sideOf(cash.lines[0]), ['6100', '1020', '8.1']);
  assert.ok(!cash.notes.some((n) => n.kind === 'taxPoint'));
});

test('S3: a rule that asks first brings its proposal, its question and its tags', () => {
  const d = firstLine(books({ transactions: [rent] }), 'R', { ...KNOWN, rule: { id: 'barbezug', ask: 'Wofür war der Barbezug?', tags: { projekt: 'alpha' }, lines: [{ account: '6100', vat: 'I0', amount: 1120 }] } });
  assert.deepEqual(sideOf(d.lines[0]), ['6100', '1020', 'I0']);
  assert.deepEqual(d.lines[0].tags, { projekt: 'alpha' });
  assert.ok(d.notes.some((n) => n.kind === 'ask' && n.question === 'Wofür war der Barbezug?'));
});

test('M3: a proposed code follows the account she chooses; a receipt\'s rate stays a rate, whose code the account gives', () => {
  const deposit = { accountDebit: '1020', accountCredit: '3400', vat: 'V81' };
  assert.equal(followedVat(deposit, '1020', '3400'), 'V81', 'the proposal\'s own accounts keep its code');
  assert.equal(followedVat(deposit, '1020', '2850'), '', 'the owner\'s deposit: no sale, no code');
  assert.equal(followedVat(deposit, '1020', '3000'), 'V81', 'another revenue account keeps the sale\'s code');
  const scaffold = { accountDebit: '4000', accountCredit: '1020', vat: 'M81' };
  assert.equal(followedVat(scaffold, '6100', '1020'), 'I81', 'material to an operating cost: the family follows');
  assert.equal(followedVat(scaffold, '2850', '1020'), '', 'onto the owner\'s account: no input tax');
  const fromReceipt = { accountDebit: '4000', accountCredit: '1020', vat: '8.1' };
  assert.equal(followedVat(fromReceipt, '6100', '1020'), '8.1');
  assert.equal(vatCodeOf('8.1', '6100', '1020')?.code, 'I81');
  assert.equal(vatCodeOf('8.1', '4000', '1020')?.code, 'M81');
});

// ─── Re-review of #356 ───────────────────────────────────────────────────────

const huber = (amount: number, description: string, vatCode = 'M81') => books({
  transactions: [tx('BUY', 'DBIT', 890, 'Huber AG', 'Farbe Juli', '2026-07-01'), tx('IN', 'CRDT', amount, 'Huber AG', description)],
  journalEntries: [entry({ transactionRef: 'BUY', accountDebit: '4000', accountCredit: '1020', amount: 890, vatCode })],
});

test('A: money in from a business the firm buys from is a refund only when it is plausible, and the form says it assumes one', () => {
  const refund = firstLine(huber(120, 'Gutschrift Retoure'), 'IN');
  assert.deepEqual(sideOf(refund.lines[0]), ['1020', '4000', '-M0']);
  assert.ok(refund.notes.some((n) => n.kind === 'refund'), JSON.stringify(refund.notes));
  const more = firstLine(huber(5000, 'Rechnung 77 Malerarbeiten'), 'IN');
  assert.deepEqual(sideOf(more.lines[0]), ['1020', '3400', 'V81'], 'more than the firm ever paid that business: a sale');
  assert.ok(more.notes.some((n) => n.kind === 'sale') && !more.notes.some((n) => n.kind === 'refund'));
  const two = [{ ...invoice, id: 'a', number: '2026-007' }, { ...invoice, id: 'b', number: '2026-008' }] as unknown as Invoice[];
  const named = bookingDraft(huber(108.1, 'Zahlung 2026-007 und 2026-008'), 'IN', BANK, two, KNOWN)!;
  assert.ok(!named.notes.some((n) => n.kind === 'refund'), 'a text that names an invoice of the firm is no refund');
});

test('A nit: a refund of a purchase booked with a zero code carries that code with the minus', () => {
  assert.deepEqual(sideOf(firstLine(huber(120, 'Retoure', 'I0'), 'IN').lines[0]), ['1020', '4000', '-I0']);
  assert.deepEqual(sideOf(firstLine(huber(120, 'Retoure', 'M0'), 'IN').lines[0]), ['1020', '4000', '-M0']);
});

test('B: an owner\'s deposit is proposed with a note that it is taken for one', () => {
  const d = firstLine(books({ transactions: [sale] }), 'IN', { ...KNOWN, nature: { kind: 'owner', account: '2850' } });
  assert.ok(d.notes.some((n) => n.kind === 'owner'), JSON.stringify(d.notes));
});

const paidInvoice = (paid: number) => ({ ...invoice, payments: paid ? [{ transactionRef: 'X', date: '2026-07-25', amount: paid, by: 'confirmed' }] : [] }) as unknown as Invoice;

test('D: an invoice paid already proposes no revenue again; an overpayment proposes revenue up to what is open and says what the rest may be', () => {
  for (const setup of [EFFECTIVE_QUARTERLY, NET_RATE]) {
    on(setup, () => {
      const full = firstLine(books({ transactions: [paysInvoice] }), 'P', KNOWN, [paidInvoice(1081)]);
      assert.deepEqual(full.lines.map(sideOf), [['1020', '', '']]);
      assert.equal(full.lines[0].source, undefined);
      assert.ok(full.notes.some((n) => n.kind === 'invoicePaid' && n.number === '2026-005' && n.surplus === 1081), JSON.stringify(full.notes));
      const part = firstLine(books({ transactions: [paysInvoice] }), 'P', KNOWN, [paidInvoice(581)]);
      assert.deepEqual(part.lines.map((l) => [l.accountCredit, l.amount]), [['3400', 500], ['', 581]]);
      assert.ok(part.notes.some((n) => n.kind === 'invoicePaid' && n.surplus === 581));
    });
  }
});

test('E: on the agreed basis a payment before its invoice\'s date is a prepayment: no booking proposed, confirmed on the invoice', () => {
  on(AGREED, () => {
    const early = { ...paysInvoice, date: '2026-07-10' };
    const b = books({ transactions: [early], journalEntries: [entry({ id: 'ev', transactionRef: 'RE-2026-005', date: '2026-07-20', accountDebit: '1100', accountCredit: '3400', amount: 1081, vatCode: 'V81' })] });
    const d = firstLine(b, 'P', KNOWN, [invoice]);
    assert.deepEqual(d.lines.map(sideOf), [['1020', '', '']]);
    assert.equal(d.lines[0].source, undefined);
    assert.ok(d.notes.some((n) => n.kind === 'prepayment' && n.number === '2026-005'), JSON.stringify(d.notes));
    assert.equal(d.invoice?.number, '2026-005');
  });
});

test('nit: without the server\'s answer the form opens with no proposal and says so', () => {
  const d = withoutProposal(firstLine(books({ transactions: [sale] }), 'IN'));
  assert.deepEqual(d.lines.map(sideOf), [['1020', '', '']]);
  assert.ok(d.lines.every((l) => !l.source));
  assert.deepEqual(d.notes, [{ kind: 'unloaded' }]);
});
