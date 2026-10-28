/**
 * A receipt whose words say it was paid in cash or privately (#216, src/accounting/paid-how.ts):
 * code reads it in four languages, and a card's lines outweigh a till's cash words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidPrivately } from '../src/accounting/paid-how.js';

test('cash or private words in de, fr, it and en', () => {
  for (const text of [
    'Total CHF 12.50\nBar bezahlt',
    'Summe 18.40\nBAR CHF 20.00\nRückgeld 1.60',
    'Zahlungsart: Bar',
    'Betrag privat ausgelegt von M. Muster',
    'Total 45.00 payé en espèces',
    'Totale 9.80 pagato in contanti',
    'Paid in cash, thank you',
    'Ticket 4.20 · Change due 0.80',
  ]) assert.equal(paidPrivately(text), true, text);
});

test('a card, an invoice to pay, or no words: not cash', () => {
  for (const text of [
    'Total CHF 12.50\nKartenzahlung Visa ****1234',
    'Summe 30.00\nTWINT\nBargeldlos bezahlt',
    'Rechnung 2026-09, zahlbar innert 30 Tagen',
    'Barcode 7610000123456',
    'Café Bar Central · Espresso 4.20',
    'Total 18.00',
  ]) assert.equal(paidPrivately(text), false, text);
});

test('«privat ausgelegt» wins over the card that paid at the till', () => {
  assert.equal(paidPrivately('Mastercard ****9876\nprivat ausgelegt, bitte erstatten'), true);
});
