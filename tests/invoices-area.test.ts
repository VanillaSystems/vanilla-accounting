/**
 * Verkauf as the UI lists it (src/app/areas/invoices/model.ts, table.ts, address.ts): each document's
 * status and sent state, the status tabs with count and total, the facts line, sorting and pages,
 * «Nicht gesendet» (P1.11), Offene Posten equal to the year end's receivables (P1.10), the link ids, a
 * draft following its customer, and the customer form's rules per country. On the demo's invoices,
 * on 20.10.2026, and on fixtures where the demo has too few states.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePeriod } from '../src/accounting/periods.js';
import type { InvoiceBook } from '../src/invoices/model.js';
import { openItemGroups, openItems } from '../src/invoices/lists.js';
import { byRouteId, customerChange, routeId, sentRows } from '../src/app/areas/invoices/model.js';
import { PAGE_SIZE, docRows, factsOf, inTab, sortRows, tabCounts, tabOf } from '../src/app/areas/invoices/table.js';
import { SEND_LIMIT, bulkPdfPlan, bulkSendPlan } from '../src/app/areas/invoices/bulk-plan.js';
import { addressRule, countryOf, languageFor, numberFirst, vatRule } from '../src/app/areas/invoices/address.js';
import { receivablesOf, ratesOf } from '../src/books/year-close.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import { issued, sentDoc } from './support/invoice-fixtures.js';
import { saveInvoices } from '../src/invoices/store.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import './support/jurisdiction.js';
import { invoiceBookOf } from '../src/invoices/store.js';

const TODAY = '2026-10-20';
const book = invoiceBookOf(JSON.parse(readFileSync(join(DEMO_ROOT, 'invoices.json'), 'utf8')) as Record<string, unknown>, 'invoices.json');
const d = { today: TODAY, invoices: book.invoices, contacts: book.contacts, articles: [], sent: book.sent };
const year = parsePeriod('2026', TODAY)!;
const no = (r: { id: string }) => r.id.startsWith('draft-') ? 'draft' : r.id;

test('Rechnungen: each status from facts, Überfällig with its days beside Offen, the tabs with count and total, the facts line per currency', () => {
  const rows = docRows(d, 'invoice', year, undefined, TODAY);
  assert.deepEqual(rows.map((r) => `${no(r)} ${r.status}${r.overdue ? ` +${r.overdue}` : ''}`), [
    '2026-001 paid', '2026-002 paid', '2026-003 paid', '2026-004 paid', '2026-005 paid', '2026-006 open +34', '2026-007 partly-paid +37', '2026-008 paid',
    '2026-010 paid', '2026-011 paid', '2026-013 open', '2026-014 open', '2026-015 cancelled', '2026-016 paid', 'draft draft', 'draft draft', '2026-017 open', '2026-018 open', '2026-019 open', '2026-020 open',
  ], 'the credit notes 2026-009 and 2026-012 are in Gutschriften, not here');
  const tabs = Object.fromEntries(tabCounts(rows, 'invoice').map((c) => [c.tab, c.n]));
  assert.deepEqual(tabs, { all: 20, draft: 2, open: 7, overdue: 2, 'partly-paid': 1, paid: 9, cancelled: 1, unsent: 2 }, 'Überfällig overlaps Offen and Teilbezahlt; two issued demo invoices did not go out yet');
  const open = tabCounts(rows, 'invoice').find((c) => c.tab === 'open')!;
  assert.deepEqual(open.sums, [{ currency: 'CHF', gross: 6959.78, open: 6959.78 }, { currency: 'EUR', gross: 865, open: 865 }], 'the total of a tab per currency, the EUR invoice in its own: 861.84 + 965.19 + 810 + 590 + 1662.12 (the café chain, from its Auftrag) + 2070.63 (from the Artikel)');
  assert.deepEqual(tabCounts(rows, 'invoice').find((c) => c.tab === 'overdue')!.sums, [{ currency: 'CHF', gross: 1674.43, open: 1274.43 }], '2026-006 whole, 2026-007 less its CHF 400 paid');
  assert.deepEqual(tabCounts(rows, 'invoice').find((c) => c.tab === 'unsent')!.sums, [{ currency: 'CHF', gross: 1400, open: 1400 }], '2026-017 and 2026-018');
  assert.deepEqual(tabCounts(rows, 'invoice').find((c) => c.tab === 'cancelled')!.sums, [{ currency: 'CHF', gross: 406.3, open: 0 }], 'Storniert sums what it holds');
  assert.equal(tabCounts(rows, 'invoice').find((c) => c.tab === 'all')!.sums[0].gross, 17036.06, 'a cancelled invoice is left out of Alle\'s total');
  assert.deepEqual(factsOf(rows), [{ currency: 'CHF', open: 7372.37, overdue: 1274.43 }, { currency: 'EUR', open: 865, overdue: 0 }]);
  const r3 = rows.find((r) => r.id === '2026-006')!;
  assert.deepEqual([r3.level, r3.levelTitle, r3.sent.reminder?.title, r3.sent.last?.kind], [3, '2. Mahnung', '2. Mahnung', 'invoice'], 'its Mahnstufe and the last Mahnung sent, by name');
  assert.equal(tabOf('invoice', 'settled'), 'all', 'a Gutschriften tab in Rechnungen shows Alle');
});

test('Gutschriften: their own table, the Rechnung each credits, Offen while money is still to go back', () => {
  const rows = docRows(d, 'credit-note', year, undefined, TODAY);
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.target?.number, r.open]), [['2026-009', 'open', '2026-002', 33.86], ['2026-012', 'settled', '2026-011', 0]],
    '2026-002 was paid: the credit goes back; 2026-012 is applied to its open Rechnung (Verrechnung)');
  assert.deepEqual(factsOf(rows), [{ currency: 'CHF', open: 33.86, overdue: 0 }]);
  assert.ok(inTab(rows[0], 'open') && !inTab(rows[0], 'settled'));
  assert.ok(inTab(rows[1], 'settled') && !inTab(rows[1], 'open'));
});

test('a period shows the documents dated in it, every draft and the earlier ones still open; the search finds number, contact and subject', () => {
  const q2 = docRows(d, 'invoice', parsePeriod('2026-Q2', TODAY)!, undefined, TODAY);
  assert.deepEqual(q2.map((r) => r.status), ['draft', 'draft']);
  assert.deepEqual(docRows(d, 'invoice', year, '2026-006', TODAY).map((r) => r.id), ['2026-006']);
  assert.ok(docRows(d, 'invoice', year, 'bistro', TODAY).every((r) => r.customer.includes('Bistro')));
  assert.deepEqual(docRows(d, 'credit-note', year, '2026-002', TODAY).map((r) => r.id), ['2026-009'], 'a Gutschrift is found by its Rechnung\'s number');
});

test('every column sorts, both ways, the same order every time', () => {
  const rows = docRows(d, 'invoice', year, undefined, TODAY).filter((r) => r.inv.status === 'issued');
  assert.deepEqual(sortRows(rows, { key: 'gross', dir: 1 }).map((r) => r.gross), [...rows.map((r) => r.gross)].sort((a, b) => a - b));
  assert.deepEqual(sortRows(rows, { key: 'number', dir: -1 }).map((r) => r.id), [
    '2026-020', '2026-019', '2026-018', '2026-017', '2026-016', '2026-015', '2026-014', '2026-013', '2026-011', '2026-010', '2026-008', '2026-007', '2026-006', '2026-005', '2026-004', '2026-003', '2026-002', '2026-001',
  ]);
  assert.equal(sortRows(rows, { key: 'open', dir: -1 })[0].id, '2026-020');
  assert.equal(sortRows(rows, { key: 'level', dir: -1 })[0].id, '2026-006');
  assert.equal(sortRows(rows, { key: 'sent', dir: -1 })[0].id, '2026-020', 'the newest send first');
  assert.equal(PAGE_SIZE, 50);
});

test('P1.11: eight issued Rechnungen, five sent by mail, one downloaded, two not sent: «Nicht gesendet» shows the two with count and total, «Versand» date and channel for the six', () => {
  const invs = Array.from({ length: 8 }, (_, i) => issued(`i${i + 1}`, `2026-10${i + 1}`, { date: `2026-10-0${i + 1}`, lines: [{ text: 'x', quantity: 1, price: 100 * (i + 1), vatRate: 0 }] }));
  const sent = [
    ...invs.slice(0, 5).map((inv, i) => sentDoc(`m${i}`, inv, { sentAt: `2026-10-1${i}T09:0${i}:00Z`, to: `k${i}@kunde.example` })),
    sentDoc('dl', invs[5], { sentAt: '2026-10-16T14:00:00Z', to: 'download', channel: 'download', messageId: undefined }),
  ];
  const fx = { today: '2026-10-20', invoices: invs, contacts: [], articles: [], sent };
  const rows = docRows(fx, 'invoice', parsePeriod('2026-Q4', '2026-10-20')!, undefined, '2026-10-20');
  const unsent = tabCounts(rows, 'invoice').find((c) => c.tab === 'unsent')!;
  assert.deepEqual([unsent.n, unsent.sums], [2, [{ currency: 'CHF', gross: 1500, open: 1500 }]], '700 + 800');
  assert.deepEqual(rows.filter((r) => inTab(r, 'unsent')).map((r) => r.id), ['2026-107', '2026-108']);
  const versand = rows.filter((r) => r.sent.last).map((r) => [r.id, r.sent.last!.sentAt.slice(0, 10), r.sent.last!.channel]);
  assert.deepEqual(versand, [
    ['2026-101', '2026-10-10', 'email'], ['2026-102', '2026-10-11', 'email'], ['2026-103', '2026-10-12', 'email'], ['2026-104', '2026-10-13', 'email'], ['2026-105', '2026-10-14', 'email'],
    ['2026-106', '2026-10-16', 'download'],
  ]);
  // The detail lists each send with recipient and checksum: the entries of the log it reads, nothing set by hand.
  const one = rows.find((r) => r.id === '2026-101')!;
  assert.deepEqual(one.sent.all.map((x) => [x.to, x.sha256.slice(0, 2), x.messageId]), [['k0@kunde.example', 'm0', '<m0@mail>']]);
  assert.equal(rows.every((r) => r.sent.sent === !r.unsent), true);
  // «Senden» on the tab: both go out by e-mail; a document without an address is named and left out, as is one over the limit.
  const noMail = { ...invs[7], customer: { ...invs[7].customer, email: undefined } };
  const plan = bulkSendPlan([invs[6], noMail]);
  assert.deepEqual([plan.take.map((x) => x.number), plan.left.map((x) => [x.inv.id, x.why])], [['2026-107'], [['i8', 'noEmail']]]);
  const many = Array.from({ length: SEND_LIMIT + 2 }, (_, i) => issued(`b${i}`, `2026-2${String(i).padStart(2, '0')}`));
  assert.deepEqual(bulkSendPlan(many).left.map((x) => x.why), ['limit', 'limit'], 'the limit per run is named for what it leaves out');
  const draft = { ...invs[0], status: 'draft' } as unknown as typeof invs[0];
  assert.deepEqual(bulkPdfPlan([draft, invs[1]]).left.map((x) => x.why), ['draft'], 'a draft has no PDF to save');
});

test('Versendet: the log newest first, filtered by contact, kind and channel', () => {
  const all = sentRows(d, undefined);
  assert.equal(all.length, book.sent.length);
  assert.ok(all.every((x, i) => i === 0 || all[i - 1].sentAt >= x.sentAt));
  assert.deepEqual(sentRows(d, undefined, { kind: 'reminder' }).map((x) => x.title), ['2. Mahnung · Rechnung 2026-006', '1. Mahnung · Rechnung 2026-006', 'Zahlungserinnerung · Rechnung 2026-006']);
  const bistro = book.contacts.find((c) => c.name.includes('Bistro'))!;
  assert.ok(sentRows(d, undefined, { customer: bistro.id }).every((x) => book.invoices.find((i) => i.id === x.invoiceId)?.customerId === bistro.id));
  assert.deepEqual([sentRows(d, undefined, { channel: 'email' }).length, sentRows(d, undefined, { channel: 'download' }).length], [20, 6],
    'the demo sent its documents by e-mail; 2026-014 and 2026-016 were downloaded, and so were the three Mahnungen, the Storno notice and the two Lieferscheine');
});

test('P1.10: Offene Posten on 31.12. equals the year end\'s receivables proposal to the Rappen, invoice by invoice and in total', () => {
  const ws = workspaceAt(DEMO_ROOT);
  const proposal = receivablesOf(ws, '2026', ratesOf(), loadBooks(ws));
  const items = openItems(book.invoices.filter((i) => !i.deleted), '2026-12-31');
  assert.ok(items.length > 0, 'the demo has invoices open at the year end');
  assert.deepEqual(items.map((x) => [x.inv.number, x.inv.currency, x.open]).sort(), proposal.invoices.map((x) => [x.number, x.currency, x.open]).sort());
  const { totals } = openItemGroups(items);
  for (const t of totals) {
    const sum = Math.round(proposal.invoices.filter((x) => x.currency === t.currency).reduce((s, x) => s + x.open * 100, 0)) / 100;
    assert.equal(t.total, sum, `the ${t.currency} total`);
  }
});

test('P1.10 on harder cases: a part paid before and the rest after 31.12., a Gutschrift, one cancelled only in the new year, one issued in the new year', () => {
  const ws = tempWorkspace('op-yearend-');
  writeIndex(ws, {});
  const a = issued('a', '2026-001', { date: '2026-11-02', dueDate: '2026-12-02', lines: [{ text: 'x', quantity: 1, price: 1234.55, vatRate: 8.1 }],
    payments: [{ transactionRef: 'T1', date: '2026-12-10', amount: 500, by: 'reference' }, { transactionRef: 'T2', date: '2027-01-08', amount: 834.55, by: 'reference' }] });
  const b = issued('b', '2026-002', { date: '2026-12-01', dueDate: '2026-12-31', customerId: 'c2', customer: { ...a.customer, name: 'Beta AG' } });
  const cn = issued('n', '2026-003', { kind: 'credit-note', creditFor: 'b', date: '2026-12-15', lines: [{ text: 'Gutschrift', quantity: 1, price: -200, vatRate: 0 }] });
  const late = issued('c', '2026-004', { date: '2026-12-20', cancelled: { date: '2027-01-03', reason: 'x' } });
  const next = issued('e', '2027-001', { date: '2027-01-02' });
  saveInvoices(ws, { schema: 2, contacts: [], invoices: [a, b, cn, late, next], articles: [], sent: [] });
  const proposal = receivablesOf(ws, '2026', ratesOf(), loadBooks(ws));
  const items = openItems([a, b, cn, late, next], '2026-12-31');
  assert.deepEqual(items.map((x) => [x.inv.number, x.open]), [['2026-001', 834.55], ['2026-002', 800], ['2026-004', 1000]]);
  assert.deepEqual(items.map((x) => [x.inv.number, x.open]), proposal.invoices.map((x) => [x.number, x.open]));
  assert.equal(openItemGroups(items).totals[0].total, proposal.total, 'CHF: the list\'s total is the proposal\'s, to the Rappen');
});

test('links: an issued invoice by its number, a draft by draft-<id>; another id finds nothing', () => {
  const draft = d.invoices.find((i) => i.status === 'draft')!;
  assert.equal(byRouteId(d.invoices, routeId(draft)), draft);
  assert.equal(routeId(byRouteId(d.invoices, '2026-005')!), '2026-005');
  assert.equal(byRouteId(d.invoices, '2026-099'), undefined);
  assert.equal(byRouteId(d.invoices, `draft-${d.invoices.find((i) => i.status === 'issued')!.id}`), undefined, 'an issued invoice is no draft');
});

test('a draft follows its customer: abroad 0 % for a service abroad (EUR for the neighbours), back home the normal rate', () => {
  const lines = [{ text: 'Beratung', quantity: 2, price: 100, vatRate: 8.1 as const }];
  const at = (country: string) => [{ id: 'a-1', postcode: '1', town: 'X', country }];
  const de = { id: 'c1', language: 'de' as const, addresses: at('DE') };
  const us = { id: 'c2', language: 'en' as const, addresses: at('US') };
  const ch = { id: 'c3', language: 'fr' as const, addresses: at('CH') };
  // Another contact: none of the person and address of the one before.
  const fresh = { personId: null, addressId: null };
  assert.deepEqual(customerChange({ lines, currency: 'CHF' }, de), { customerId: 'c1', language: 'de', ...fresh, lines: [{ ...lines[0], vatRate: 0 }], exemption: 'abroad', currency: 'EUR' });
  assert.equal(customerChange({ lines, currency: 'CHF' }, us).currency, undefined, 'a US customer keeps the currency');
  assert.deepEqual(customerChange({ lines: [{ ...lines[0], vatRate: 0 }], currency: 'EUR' }, ch), { customerId: 'c3', language: 'fr', ...fresh, lines, exemption: null, currency: 'CHF' });
  assert.deepEqual(customerChange({ lines, currency: 'CHF' }, ch), { customerId: 'c3', language: 'fr', ...fresh }, 'a Swiss draft keeps its rates');
  assert.equal(customerChange({ lines, currency: 'CHF' }, { ...ch, currency: 'EUR' }).currency, 'EUR', 'a contact of its own currency gives it to the draft');
});

test('the customer form per country: the postcode\'s name and shape, a state, the number first, the VAT number, the language', () => {
  assert.deepEqual([addressRule('US').postcode, addressRule('US').state, addressRule('US').townFirst, numberFirst('US')], ['zip', 'state', true, true]);
  assert.ok(addressRule('GB').pattern.test('E1 6QR'));
  assert.ok(!addressRule('CH').pattern.test('80000'));
  assert.equal(addressRule('XK').postcode, 'generic');
  assert.ok(vatRule('DE').pattern!.test('DE123456789'));
  assert.ok(vatRule('GR').pattern!.test('EL123456789'), 'Greece writes EL');
  assert.ok(vatRule('CH').pattern!.test('CHE-123.456.789 MWST'));
  assert.equal(vatRule('US').pattern, undefined);
  assert.deepEqual([languageFor('CH', '1204'), languageFor('CH', '6900'), languageFor('CH', '8000'), languageFor('AT', ''), languageFor('US', '')], ['fr', 'it', 'de', 'de', 'en']);
  assert.deepEqual([countryOf('Schweiz'), countryOf('Suisse'), countryOf('usa'), countryOf('Vereinigtes Königreich'), countryOf('Atlantis')], ['CH', 'CH', 'US', 'GB', undefined]);
});

test('linking from either side (r9c-3): a payment\'s page offers the open invoices of its currency, the named one first; an invoice\'s page offers the open period\'s incoming payments not yet allocated, a prepayment before its date included', async () => {
  const { linkableInvoices, linkablePayments } = await import('../src/app/areas/invoices/model.js');
  const issued = (id: string, number: string, currency: string, over: Record<string, unknown> = {}) => ({
    id, status: 'issued', kind: 'invoice', deleted: false, number, reference: `RF${number}`, currency, date: '2026-10-16', payments: [], reminders: [],
    customer: { name: 'Kunde' }, lines: [{ text: 'x', quantity: 1, price: 4200, vatRate: 0 }], ...over,
  }) as unknown as InvoiceBook['invoices'][number];
  const invoices = [issued('a', '2026-001', 'CHF'), issued('b', '2026-002', 'EUR'), issued('c', '2026-003', 'EUR'), issued('d', '2026-004', 'EUR', { cancelled: { date: '2026-10-17', reason: 'x' } }), issued('e', '2026-005', 'EUR', { payments: [{ transactionRef: 'W9', date: '2026-10-01', amount: 4200, by: 'reference' }] })];
  const tx = (ref: string, currency: string, date: string, description: string, direction: 'CRDT' | 'DBIT' = 'CRDT') => ({ ref, currency, date, description, direction, amount: 3000, source: 'camt053' }) as never;
  const wise = tx('W1', 'EUR', '2026-10-12', 'Rechnung 2026-003 Teilzahlung');
  assert.deepEqual(linkableInvoices(invoices, wise).map((i) => i.number), ['2026-003', '2026-002'], 'EUR only, the named one first; cancelled and paid left out');
  assert.deepEqual(linkableInvoices(invoices, tx('W2', 'EUR', '2026-10-12', 'x', 'DBIT')), [], 'money out pays no invoice');
  assert.deepEqual(linkableInvoices(invoices, tx('W9', 'EUR', '2026-10-01', 'x')), [], 'allocated already');
  const books = { transactions: [wise, tx('W9', 'EUR', '2026-10-01', 'x'), tx('R1', 'CHF', '2026-10-14', 'x'), tx('W0', 'EUR', '2026-03-03', 'alt')], config: { closedThrough: '2026-03-31' } };
  assert.deepEqual(linkablePayments(books, invoices, invoices[2] as never).map((t) => t.ref), ['W1'], 'W9 is allocated, R1 is CHF, W0 lies in a filed quarter');
});
