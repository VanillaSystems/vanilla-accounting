/**
 * Invoices of a firm not registered for VAT (persona round 5, r5f-10): no VAT on the sheet, no
 * rate to pick, no «MWST» after the UID, no reason needed for a line without VAT; on the net tax
 * rate method a sale is booked with the firm's code. VAT shown on an invoice is owed (Art. 27 Abs. 2
 * MWSTG), so a firm that charges none must print none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { invoiceRates, setJurisdiction } from '../src/engines/index.js';
import { missingForIssue, revenueVatCode } from '../src/invoices/rules.js';
import { assembleSheets, paginate, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { DEFAULT_LAYOUT } from '../src/invoices/model.js';
import type { Draft, InvoiceLine, Sender } from '../src/invoices/model.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] };

const sender: Sender = {
  name: 'Salon Beispiel', uid: 'CHE-975.310.864',
  address: { street: 'Dorfstrasse', number: '3', postcode: '8000', town: 'Zürich', country: 'CH' },
  payTo: { account: '1020', iban: 'CH6580808000000000001', bank: 'Raiffeisen' },
};
const customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual' as const, deleted: false,
  name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' },
  language: 'de' as const, paymentTermsDays: 30,
};
const line = (price: number, vatRate: InvoiceLine['vatRate']): InvoiceLine => ({ text: 'Haarschnitt', quantity: 1, price, vatRate });
const draft = (lines: InvoiceLine[]): Draft => ({
  id: 'in_d', createdAt: '2026-10-01T09:00:00Z', origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_1', date: '2026-10-05', currency: 'CHF', language: 'de', lines, comments: [],
});
const html = (lines: InvoiceLine[]): string => {
  const d: SheetData = { kind: 'invoice', language: 'de', number: '2026-001', date: '2026-10-05', dueDate: '2026-11-04', currency: 'CHF', customer, sender, lines, intro: '', closing: 'Danke', layout: DEFAULT_LAYOUT };
  const blocks = sheetBlocks(d);
  return assembleSheets(d, blocks, paginate(blocks, blocks.map(() => 10), { footer: true, qrBill: false }));
};

test('not registered: the only rate is 0, a line at 0 needs no exemption, the sheet prints no VAT and no «MWST» after the UID', () => {
  setJurisdiction(ch, NOT_REGISTERED);
  assert.deepEqual(invoiceRates(), [0]);
  assert.deepEqual(missingForIssue(draft([line(50, 0)]), { customer, sender, invoices: [] }), [], 'no reason asked for a line without VAT');
  assert.equal(revenueVatCode(0, undefined), undefined);
  const out = html([line(50, 0)]);
  assert.ok(out.includes('CHE-975.310.864'), 'the UID stays');
  assert.ok(!out.includes('CHE-975.310.864 MWST'), 'no VAT number');
  assert.ok(!/MWST-Nr\./.test(out), 'no VAT number label');
  assert.ok(!/MWST \d/.test(out), 'no VAT line');
  assert.ok(!/<th class="r">MWST<\/th>/.test(out), 'no VAT column');
});

test('registered: the jurisdiction\'s rates, the VAT number and the VAT line as before; the net tax rate method books a sale with F1', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  assert.deepEqual(invoiceRates(), [8.1, 2.6, 3.8, 0]);
  assert.deepEqual(missingForIssue(draft([line(50, 0)]), { customer, sender, invoices: [] }).map((m) => m.field), ['exemption']);
  const out = html([line(50, 8.1)]);
  assert.ok(out.includes('CHE-975.310.864 MWST'));
  assert.ok(/MWST 8.1 % auf/.test(out));
  assert.equal(revenueVatCode(8.1, undefined), 'V81');
  setJurisdiction(ch, NET_RATE);
  assert.equal(revenueVatCode(8.1, undefined), 'F1');
});
