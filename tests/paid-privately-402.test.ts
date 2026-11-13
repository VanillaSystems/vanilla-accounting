/**
 * #402: a receipt the owner paid privately is read so by code, without a model call: its payment
 * line marks it private («Bezahlt mit Mastercard ****1150 (privat)»), or the card that paid it is one
 * the books know as his (a receipt of it paid privately already, or marked private), never one that
 * paid a payment of the firm's own statements (its business card, its debit card). The receipt then
 * offers «Als Auslage buchen» first, in one click, and several at once from a selection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf, paidCards, paidPrivately, readsPrivately } from '../src/accounting/paid-how.js';
import { likelyReceipt, likelySelection, type ReceiptFacts } from '../src/app/selection/likely.js';

const SBB = 'SBB CFF FFS\nBillett / Quittung\nTotal CHF 72.40\ninkl. MWST 8.1%\n\nBezahlt mit Mastercard ****1150 (privat)';
const RESTO = 'Restaurantquittung\nRistorante Lago Zug\nTOTAL CHF 146.50\ninkl. MWST 8.1%: 10.98\nMastercard ****1150\nDanke für Ihren Besuch';
const HOTEL = 'Hotel Pilatusblick\nRechnung 26-08-4471\nDatum: 19.08.2026 bezahlt mit Visa ****3307\nTotal CHF 164.00';
const CARD_STATEMENT = 'Alpencard AG\nKreditkartenabrechnung Visa Business ****3307\nTotal zu Ihren Lasten 313.19';

test('the payment line marked private: paid privately, whatever card paid; the mark only in the card\'s line', () => {
  assert.equal(paidPrivately(SBB), true);
  assert.equal(paidPrivately('Paid by Visa xxxx 4242 (private card)'), true);
  assert.equal(paidPrivately(RESTO), false, 'a card alone says nothing of whose');
  assert.equal(paidPrivately('Total 80.00\nKartenzahlung Visa ****1234\nPrivatparkplatz'), false, 'a «privat» that is no payment\'s');
  assert.equal(paidPrivately('Thank you for your payment of last month (personal account manager: J. Doe).'), false, 'running text, no card line');
});

test('the card a receipt names, by its last four digits', () => {
  assert.equal(cardOf(SBB), '1150');
  assert.equal(cardOf(HOTEL), '3307');
  assert.equal(cardOf('Visa XXXX XXXX XXXX 4242'), '4242');
  assert.equal(cardOf('Total 18.00'), undefined);
  assert.equal(cardOf('IBAN CH93 **** **** **** 1234 5\nKundennummer ****8812'), undefined, 'masked IBAN or customer number: no card');
});

test('his card is known from a receipt marked private, or from two receipts paid privately; the firm\'s card from its statements', () => {
  const cards = paidCards([
    { text: SBB, file: 'sbb.pdf', date: '2026-07-08' },
    { text: CARD_STATEMENT, paidBy: 'firm', file: 'alpencard.pdf' },
    { text: HOTEL, file: 'hotel.pdf' },
  ]);
  assert.deepEqual([...cards.private.keys()], ['1150']);
  assert.deepEqual([...cards.firm], ['3307']);
  assert.deepEqual(readsPrivately(RESTO, cards), { by: 'card', card: '1150', seen: { file: 'sbb.pdf', date: '2026-07-08' } }, 'the restaurant, with the receipt that showed his card');
  assert.equal(readsPrivately(HOTEL, cards), false, 'the hotel, paid with the firm\'s card');
  // One outlay alone proves nothing; two do.
  const park = 'Parkhaus\nTOTAL CHF 18.00\nMastercard ****1150';
  assert.equal(readsPrivately(RESTO, paidCards([{ text: park, paidBy: 'owner', file: 'p1.pdf' }])), false);
  assert.equal(readsPrivately(RESTO, paidCards([{ text: park, paidBy: 'owner', file: 'p1.pdf' }, { text: park, paidBy: 'owner', file: 'p2.pdf' }])) !== false, true);
  // A card seen on both sides is no proof either way.
  const both = paidCards([{ text: SBB, file: 'a.pdf' }, { text: RESTO, paidBy: 'firm', file: 'b.pdf' }]);
  assert.equal(readsPrivately(RESTO, both), false);
});

const receipt = (f: Partial<ReceiptFacts> = {}): ReceiptFacts => ({ none: false, linked: false, locked: false, suggestion: false, paidPrivately: false, dated: true, ...f });

test('a receipt read as paid privately offers it first; without its day the day comes first', () => {
  assert.equal(likelyReceipt(receipt({ paidPrivately: true })), 'private');
  assert.equal(likelyReceipt(receipt({ paidPrivately: true, dated: false })), 'edit');
});

test('a selection mostly paid privately offers «Als Auslagen buchen» first', () => {
  assert.equal(likelySelection('receipt', { n: 6, open: 6, unbooked: 0, noReceipt: 0, privately: 6 }), 'private');
  assert.equal(likelySelection('receipt', { n: 6, open: 6, unbooked: 0, noReceipt: 0, privately: 1 }), 'findPayment');
});
