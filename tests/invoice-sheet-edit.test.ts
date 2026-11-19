/**
 * A choice made on a draft's sheet reaches the stored invoice (persona test «invoices» #6, #17):
 * the <select>s the sheet renders (unit, VAT rate, customer, exemption) are read back by
 * src/app/areas/invoices/edit.ts into the change the API saves, and the API stores it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LAYOUT, DEFAULT_UNITS, type Customer, type Draft, type ItemLine } from '../src/invoices/model.js';
import { browserPath } from './support/browser.js';
import { POSITION_WORDS } from './support/sheet-words.js';
import { assembleSheets, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { insertLine, sheetEdit } from '../src/app/areas/invoices/edit.js';
import { startApi, type ApiServer } from './support/api-server.js';
import './support/jurisdiction.js';

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(() => api?.stop());

const address = { street: 'Rosenweg', number: '5', postcode: '9500', town: 'Wil', country: 'CH' };
const words = { newCustomer: 'Neuer Kunde', chooseCustomer: 'Kunde wählen', addLine: 'Position', removeLine: 'Entfernen', intro: 'Intro', closing: 'Gruss', desc: 'Beschreibung', noExemption: 'Grund', supplied: 'wie Datum', ...POSITION_WORDS };

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
  assert.equal((d.lines[0] as ItemLine).unit, 'flat');
  d = await pick(d, customers, 'l:0:unit', '');
  assert.equal((d.lines[0] as ItemLine).unit, undefined, 'no unit');
  d = await pick(d, customers, 'l:0:vatRate', '2.6');
  assert.equal((d.lines[0] as ItemLine).vatRate, 2.6);
  d = await pick(d, customers, 'customer', keller.id);
  assert.equal(d.customerId, keller.id);
  d = await pick(d, customers, 'l:0:vatRate', '0');
  d = await pick(d, customers, 'exemption', 'export');
  assert.deepEqual([(d.lines[0] as ItemLine).vatRate, d.exemption], [0, 'export']);

  assert.deepEqual(sheetEdit(d, 'l:0:vatRate', '7.7', { customers, defaultTexts: { intro: '', closing: '' } }), { refused: 'value' }, 'a rate the jurisdiction does not have is refused');
  assert.equal(sheetEdit(d, 'customer', keller.id, { customers, defaultTexts: { intro: '', closing: '' } }), undefined, 'the same customer changes nothing');
});

test('«Trotzdem ausstellen»: a position without amount is refused with its warning, then issued on the person\'s word with no mark of it', { skip: browserPath ? false : 'no Chromium-based browser installed' }, async () => {
  const c = (await api.send('POST', '/api/customers', { name: 'Familie Huber', address, language: 'de' })).json as unknown as Customer;
  const d = (await api.send('POST', '/api/invoices', { customerId: c.id, lines: [{ text: 'Wand', quantity: 10, unit: 'm2', price: 18.5, vatRate: 8.1 }, { text: 'Kulanz', quantity: 1, price: 0, vatRate: 8.1 }] })).json as unknown as Draft;
  const refused = await api.send('POST', `/api/invoices/${d.id}/issue`);
  assert.equal(refused.status, 409);
  assert.deepEqual([refused.json.invoiceRefusal, refused.json.missing], ['unconfirmed', [{ field: 'line.price', line: 1 }]]);
  const issued = await api.send('POST', `/api/invoices/${d.id}/issue`, { confirm: 'unconfirmed' });
  assert.equal(issued.status, 200, String(issued.json.error));
  assert.deepEqual(Object.keys(issued.json).filter((k) => /confirm|force|override/i.test(k)), []);
  assert.deepEqual(issued.json.units, [{ id: 'm2', de: 'm²', fr: 'm²', it: 'm²', en: 'm²' }], 'the units it names, frozen with it');
});

test('Firma › Rechnungslayout › Einheiten: a unit is added with its four words; one a draft uses is not removed', async () => {
  const c = (await api.send('POST', '/api/customers', { name: 'Familie Frei', address, language: 'de' })).json as unknown as Customer;
  const units = [...DEFAULT_UNITS, { id: 'pal', de: 'Palette', fr: 'palette', it: 'paletta', en: 'pallet' }];
  assert.equal((await api.send('PATCH', '/api/workspace', { invoicing: { units } })).status, 200);
  const d = (await api.send('POST', '/api/invoices', { customerId: c.id, lines: [{ text: 'Holz', quantity: 2, unit: 'pal', price: 80, vatRate: 8.1 }] })).json as unknown as Draft;
  assert.equal((d.lines[0] as ItemLine).unit, 'pal');
  const kept = await api.send('PATCH', '/api/workspace', { invoicing: { units: DEFAULT_UNITS } });
  assert.deepEqual([kept.status, kept.json.code, kept.json.params], [409, 'unitInUse', { id: 'pal' }]);
  const word = await api.send('PATCH', '/api/workspace', { invoicing: { units: [...units, { id: 'sack', de: 'Sack', fr: 'sac', it: '', en: 'bag' }] } });
  assert.deepEqual([word.status, word.json.code], [400, 'unitWord']);
  assert.equal((await api.send('DELETE', `/api/invoices/${d.id}`)).status, 200);
  assert.equal((await api.send('PATCH', '/api/workspace', { invoicing: { units: DEFAULT_UNITS } })).status, 200, 'with no draft naming it, it goes');
});

test('P1.2: an added position goes after the one the person is in; a new draft\'s untouched first item gives way to a title', () => {
  const empty: ItemLine = { text: '', quantity: 1, price: 0, vatRate: 8.1 };
  const title = { kind: 'text' as const, text: '', style: 'title' as const };
  assert.deepEqual(insertLine([empty], title, -1), { lines: [title], at: 0 }, 'a painter starts with the room\'s title');
  assert.deepEqual(insertLine([empty], title, 0), { lines: [empty, title], at: 1 }, 'not while she types into the first item');
  const a: ItemLine = { text: 'Wände', quantity: 42, unit: 'm2', price: 18.5, vatRate: 8.1 };
  const b: ItemLine = { text: 'Decke', quantity: 20, unit: 'm2', price: 21, vatRate: 8.1 };
  const sub = { kind: 'subtotal' as const, text: 'Zwischentotal' };
  assert.deepEqual(insertLine([a, b], sub, 0), { lines: [a, sub, b], at: 1 }, 'after the focused position, not at the end');
  assert.deepEqual(insertLine([a, b], sub, -1), { lines: [a, b, sub], at: 2 }, 'no position focused: at the end');
  assert.deepEqual(insertLine([a], title, -1), { lines: [a, title], at: 1 }, 'a first item with text stays');
  const fresh: ItemLine = { text: 'Neue Position', quantity: 1, price: 0, vatRate: 8.1 };
  assert.deepEqual(insertLine([fresh], title, -1, 'Neue Position'), { lines: [title], at: 0 }, 'the new draft\'s own first item, untouched, gives way');
  assert.deepEqual(insertLine([{ ...fresh, price: 120 }], title, -1, 'Neue Position'), { lines: [{ ...fresh, price: 120 }, title], at: 1 }, 'not once it has a price');
});
