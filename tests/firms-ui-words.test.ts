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
import { codeExplanation } from '../src/app/areas/codes/model.js';

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

test('the catalogue explains F1 to a net-rate firm as its own code: named with its label and rate, declared in 200 and 323 of form 0553, as the sale it books; the effective firm keeps the catalogue\'s kind (r9n-25)', () => {
  try {
    setJurisdiction(jurisdiction, NET_RATE);
    const own = codeExplanation('F1');
    assert.deepEqual(own.own, { name: '1. Saldosteuersatz (Schreinerei)', rate: 4.5 });
    assert.deepEqual(own.ziffern, ['200', '323']);
    assert.equal(own.rate, 4.5);
    assert.deepEqual(own.when, { key: 'vatCodes.netRate.when', vars: { code: 'F1', turned: '-F1', rate: '4.5', ziffer: '323', form: '0553' } });
    assert.equal(own.notWhen.key, 'vatCodes.netRate.notWhen');
    assert.deepEqual(codeExplanation('-F1').own, own.own, 'the minus code is the same rate');
    assert.equal(codeExplanation('F2').own, undefined, 'the second rate the firm has not is the catalogue\'s kind');
  } finally {
    setJurisdiction(jurisdiction);
  }
  const catalogue = codeExplanation('F1');
  assert.deepEqual([catalogue.own, catalogue.ziffern, catalogue.when.key], [undefined, null, 'vatCodes.kind.flatRate.when'], 'the effective method declares no F code');
  assert.equal(codeExplanation('V81').ziffern?.includes('303'), true);
});
