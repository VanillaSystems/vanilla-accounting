/**
 * A credit card's monthly statement among the receipts (#401): the app reads none as a bank
 * statement (issue #94); it is the receipt of the card's debit on the bank account, and its row and
 * detail say so, with the day of that debit and whether its lines were booked one by one.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCardStatement } from '../src/books/statement-facts.js';
import { cardStatementOf } from '../src/app/areas/receipts/model.js';
import { documents } from '../src/engines/index.js';
import type { Index, JournalEntry } from '../src/types/index.js';

const CARD = `Alpencard AG
Kreditkartenabrechnung Visa Business ****3307
Muster Beratung GmbH
Abrechnung 01.08.2026 – 31.08.2026
Datum
07.08.2026
19.08.2026
Beschreibung
LINKLY ADS DUBLIN IE, USD 180.00
HOTEL PILATUSBLICK LUZERN
Total zu Ihren Lasten, Belastung per LSV am 10.09.2026
Betrag CHF
146.62
164.00
310.62`;
const HOTEL = `Hotel Pilatusblick
MWST-Nr. CHE-123.456.789 MWST
Rechnung 26-08-4471
Datum: 19.08.2026 bezahlt mit Visa ****3307
Übernachtung Einzelzimmer 18.–19.08.2026
Total CHF 164.00`;

test('a card statement is told by its title and period; a bill paid by card is none', () => {
  assert.equal(isCardStatement(CARD, documents()), true);
  assert.equal(isCardStatement(HOTEL, documents()), false);
  assert.equal(isCardStatement(CARD.replace(/Abrechnung 01.08.2026 – 31.08.2026\n/, ''), documents()), false, 'without its period: a letter that names one');
});

test('its row and detail name the debit it is the receipt of, and whether its lines were booked one by one', () => {
  const r = { id: 'card', extractedText: CARD };
  const entry = (id: string, amount: number): JournalEntry => ({ id, transactionRef: 'P-10', date: '2026-09-10', accountDebit: '6640', accountCredit: '1020', amount });
  const books = (entries: JournalEntry[], linked = true): Pick<Index, 'mappings' | 'transactions' | 'journalEntries'> => ({
    mappings: linked ? [{ transactionRef: 'P-10', receiptId: 'card' }] : [],
    transactions: [{ ref: 'P-10', bank: 'ZKB', date: '2026-09-10', amount: 310.62, currency: 'CHF', direction: 'DBIT', description: 'LSV Alpencard' }],
    journalEntries: entries,
  });
  assert.deepEqual(cardStatementOf(r, books([entry('a', 146.62), entry('b', 164)])), { debit: '2026-09-10', lines: 2 });
  assert.deepEqual(cardStatementOf(r, books([], false)), { lines: 0 }, 'not linked yet');
  assert.equal(cardStatementOf({ id: 'hotel', extractedText: HOTEL }, books([])), undefined);
});
