/**
 * What the other kinds of firm read in the UI, the parts node can load: the receipt chip of a
 * firm not registered (r7f-4) and the boxes of the net tax rate method's correction form (r6f-26).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction, vat } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import type { VatSetup } from '../src/workspace/vat-setup.js';
import { vatChipOf } from '../src/app/areas/receipts/model.js';
import { correctionBoxes } from '../src/app/areas/vat/model.js';

const { jurisdiction } = loadJurisdiction(APP_ROOT, 'ch');
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] };

test('a receipt not read for VAT shows «MWST noch nicht gelesen» in a registered firm and no chip in a firm not registered; one read without VAT shows «keine CH-MWST» in both (r7f-4)', () => {
  assert.equal(vatChipOf(undefined, undefined), 'unread');
  assert.equal(vatChipOf(undefined, 'net-rate'), 'unread');
  assert.equal(vatChipOf(undefined, 'none'), undefined, 'no VAT step ran: nothing to say about the paper');
  assert.equal(vatChipOf(false, 'none'), 'none');
  assert.equal(vatChipOf(false, undefined), 'none');
});

test('the correction form of the net tax rate method has the firm\'s rate row and no input-tax section; the effective form keeps its boxes (r6f-26)', () => {
  try {
    setJurisdiction(jurisdiction, NET_RATE);
    const b = correctionBoxes(vat().form);
    assert.deepEqual([b.inputTax, b.inputTaxTotals], [[], []], 'no input tax on the net tax rate method');
    assert.deepEqual(b.turnover, ['200', '205', '220', '221', '225', '230', '235', '280']);
    assert.deepEqual([b.turnoverTotals, b.taxTotals, b.settlement], [['289', '299'], ['399'], ['500', '510']]);
    assert.deepEqual(vat().rateRows.filter((r) => r.kind === 'net-rate').map((r) => [r.ziffer, r.code, r.name]), [['323', 'F1', '1. Saldosteuersatz (Schreinerei)']], 'one approved rate: one row, named with the firm\'s label');
  } finally {
    setJurisdiction(jurisdiction);
  }
  const e = correctionBoxes(vat().form);
  assert.deepEqual(e.inputTax, ['400', '405', '410', '415', '420']);
  assert.deepEqual(e.inputTaxTotals, ['479']);
});
