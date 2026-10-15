/**
 * A choice made on a draft's sheet reaches the stored invoice (persona test «invoices» #6, #17):
 * the <select>s the sheet renders (unit, VAT rate, customer, exemption) are read back by
 * src/app/areas/invoices/edit.ts into the change the API saves, and the API stores it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LAYOUT, type Customer, type Draft } from '../src/invoices/model.js';
import { assembleSheets, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { sheetEdit } from '../src/app/areas/invoices/edit.js';
import { startApi, type ApiServer } from './support/api-server.js';
import './support/jurisdiction.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(() => api?.stop());

const address = { street: 'Rosenweg', number: '5', postcode: '9500', town: 'Wil', country: 'CH' };
const words = { newCustomer: 'Neuer Kunde', chooseCustomer: 'Kunde wählen', addLine: 'Position', removeLine: 'Entfernen', intro: 'Intro', closing: 'Gruss', desc: 'Beschreibung', noExemption: 'Grund' };

/** The sheet's HTML as the screen shows a draft, with its select fields. */
function sheetOf(d: Draft, customers: Customer[]): string {
  const c = customers.find((x) => x.id === d.customerId)!;
  const data: SheetData = {
    kind: d.kind, language: d.language, date: d.date, currency: d.currency, customer: c, lines: d.lines, intro: '', closing: '', layout: DEFAULT_LAYOUT,
    sender: { name: 'Malerei AG', address, uid: 'CHE-123.456.789' }, ...(d.exemption ? { exemption: d.exemption } : {}),
    screen: { qrPlaceholder: '', edit: { scope: 'draft', customers: customers.map((x) => ({ id: x.id, name: x.name })), customerId: d.customerId, words } },
  };
  const blocks = sheetBlocks(data);
  return assembleSheets(data, blocks, { pages: [blocks.map((_, i) => i)], qrOwnPage: false });
}

/** The options of the select named `key`: what a person can pick there. */
function options(html: string, key: string): string[] {
  const m = new RegExp(`<select[^>]*data-ed="${key}">(.*?)</select>`).exec(html);
  assert.ok(m, `the sheet has a select ${key}`);
  return [...m[1].matchAll(/value="([^"]*)"/g)].map((x) => x[1]);
}

async function pick(d: Draft, customers: Customer[], key: string, value: string): Promise<Draft> {
  assert.ok(options(sheetOf(d, customers), key).includes(value), `${value} is offered in ${key}`);
  const r = sheetEdit(d, key, value, { customers, defaultTexts: { intro: '', closing: '' } });
  assert.ok(r && 'change' in r, `${key} → ${value} is a change`);
  const res = await api.send('PATCH', `/api/invoices/${d.id}`, r.change);
  assert.equal(res.status, 200, String(res.json.error));
  return (await api.send('GET', `/api/invoices/${d.id}`)).json as unknown as Draft;
}

test('unit, VAT rate, customer and exemption picked on the sheet are stored on the draft', async () => {
  const keller = (await api.send('POST', '/api/customers', { name: 'Familie Keller', address, language: 'de' })).json as unknown as Customer;
  const meier = (await api.send('POST', '/api/customers', { name: 'Hans Meier', address: { ...address, street: 'Garagenweg', number: '3' }, language: 'de' })).json as unknown as Customer;
  const customers = [keller, meier];
  let d = (await api.send('POST', '/api/invoices', { customerId: meier.id, lines: [{ text: 'Material', quantity: 1, unit: 'h', price: 312.5, vatRate: 8.1 }] })).json as unknown as Draft;

  d = await pick(d, customers, 'l:0:unit', 'flat');
  assert.equal(d.lines[0].unit, 'flat');
  d = await pick(d, customers, 'l:0:unit', '');
  assert.equal(d.lines[0].unit, undefined, 'no unit');
  d = await pick(d, customers, 'l:0:vatRate', '2.6');
  assert.equal(d.lines[0].vatRate, 2.6);
  d = await pick(d, customers, 'customer', keller.id);
  assert.equal(d.customerId, keller.id);
  d = await pick(d, customers, 'l:0:vatRate', '0');
  d = await pick(d, customers, 'exemption', 'export');
  assert.deepEqual([d.lines[0].vatRate, d.exemption], [0, 'export']);

  assert.deepEqual(sheetEdit(d, 'l:0:vatRate', '7.7', { customers, defaultTexts: { intro: '', closing: '' } }), { refused: 'value' }, 'a rate the jurisdiction does not have is refused');
  assert.equal(sheetEdit(d, 'customer', keller.id, { customers, defaultTexts: { intro: '', closing: '' } }), undefined, 'the same customer changes nothing');
});
