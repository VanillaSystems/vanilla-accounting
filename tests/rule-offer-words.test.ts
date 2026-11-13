/**
 * #383: a text rule is offered under a payment only on words that say what the payments are. A
 * document's word («Rechnung»), a statement's («Belastung», «Gutschrift») or the bank's wording of
 * the payment («Zahlung», «E-Banking Auftrag», «Karte») alone is no such word; «Lohn» is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentWordsOnly } from '../src/saving/hand-rule.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { EFFECTIVE_QUARTERLY } from '../src/workspace/vat-setup.js';

setJurisdiction(loadJurisdiction(APP_ROOT, 'ch').jurisdiction, EFFECTIVE_QUARTERLY);

test('words that only say it is a payment, of which document, or how it went', () => {
  for (const words of ['Rechnung', 'Belastung E-Banking Auftrag', 'Gutschrift', 'Zahlung', 'Karte', 'Facture', 'Invoice', 'Dauerauftrag', 'Rechnung Nr', 'Paiement carte']) {
    assert.equal(paymentWordsOnly(words), true, words);
  }
});

test('words that say what the payments are', () => {
  for (const words of ['Lohn', 'Miete', 'Treppenhaus', 'Rechnung Malerarbeiten', 'Tanken', 'Salaire']) {
    assert.equal(paymentWordsOnly(words), false, words);
  }
});
