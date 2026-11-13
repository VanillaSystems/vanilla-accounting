/**
 * The small points of #398 (round 3 of the first-run score): a document beside an invoice shows no
 * amount of its own and is made a receipt with words for what it is; an amount a reader wrote into a
 * receipt's text reads in the app's one money format; the drop names both places that hold what
 * waits; an unregistered firm's invoice has no VAT line in its head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markLabel, ownAmount } from '../src/app/areas/receipts/model.js';
import { moneyInText } from '../src/app/lib/utils.js';

test('an order confirmation (a document beside an invoice) has no amount of its own, and its action says what it does', () => {
  assert.equal(ownAmount({ kind: 'supporting', amount: 0 }), undefined, 'no «0.00»');
  assert.equal(ownAmount({ kind: 'invoice', amount: 0 }), 0, 'a receipt worth 0.00 keeps its amount');
  assert.equal(ownAmount({ kind: 'invoice', amount: 88.98 }), 88.98);
  assert.equal(markLabel({ kind: 'supporting' }), 'receipts.asOwnReceipt');
  assert.equal(markLabel({ kind: 'noise' }), 'receipts.isReceipt');
  const de = readFileSync('src/app/i18n/locales/de.ts', 'utf8');
  assert.match(de, /'receipts\.asOwnReceipt': 'Als eigenen Beleg führen'/);
  for (const f of ['src/app/areas/receipts/receipts.tsx', 'src/app/areas/receipts/Detail.tsx']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /\{r\.amount != null && (<>|\()/, `${f}: the amount shown goes through ownAmount`);
  }
});

test('an amount written into a receipt\'s text reads in the app\'s money format: «CHF 3\'200.00», never «CHF 3200.00»', () => {
  assert.match(moneyInText('Malerarbeiten Konstanz, CHF 3200.00'), /CHF 3.200\.00$/);
  assert.equal(moneyInText('EUR 412.30 inkl. 19 %'), 'EUR 412.30 inkl. 19 %', 'below a thousand as it was');
  assert.equal(moneyInText('Rechnung 2026-031'), 'Rechnung 2026-031', 'a number without a currency stays');
});

test('the drop names where what waits is: the receipts under Belege, the tasks under Automatisierung › Aufgaben, each with its count', () => {
  const src = readFileSync('src/app/shell/DropDialog.tsx', 'utf8');
  assert.doesNotMatch(src, /drop\.waitsHint/);
  assert.match(src, /t\('drop\.waitsReceipts', \{ n: receiptsWait \}\)/);
  assert.match(src, /t\('drop\.waitsTasks', \{ n: tasksWait \}\)/);
});

test('an invoice of a firm not in the VAT register has no VAT line in its head', () => {
  assert.match(readFileSync('src/app/areas/invoices/Detail.tsx', 'utf8'), /\{chargesVat\(\) \|\| t0\.vat \? <span data-testid="invoice-head-vat">/);
});
