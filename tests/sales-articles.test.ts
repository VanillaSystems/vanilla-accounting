/**
 * Artikel of invoicing phase 2 (docs/specs/invoicing.md 4.3, 4.4.3, P2.4): an Artikel position
 * filled from the Artikel and editable, the account chain Artikel → contact → settings, the rate of
 * the VAT kind on the supply day, net and gross Artikel on net and gross documents, Gruppen in the
 * totals, the revenue split, the sheet and the conversions, archive and delete and the CSV import.
 * On temp workspaces with the demo's settings (the AI's draft by code: tests/assistant-app.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { tempWorkspace } from './support/workspace.js';
import type { Workspace } from '../src/workspace/workspace.js';
import {
  convertDocument, createArticle, createCustomer, createDraft, issueInvoice, parseDraftPatch, removeArticle, removeDraft, updateArticle, updateContact, updateDraft, type Printer,
} from '../src/invoices/service.js';
import { loadInvoices } from '../src/invoices/store.js';
import { InvoiceRuleError, lineAmounts, revenueSplit, totals } from '../src/invoices/rules.js';
import { articleLine, findArticle, priceOn, searchArticles } from '../src/invoices/articles.js';
import { importArticles, previewArticleImport } from '../src/invoices/article-import.js';
import { offered } from '../src/invoices/chain.js';
import { issuedSheet } from '../src/invoices/documents.js';
import { sheetBlocks } from '../src/invoices/sheet.js';
import { withGroups, type Draft, type InvoiceLine, type Issued } from '../src/invoices/model.js';
import { insertLine, moveLine, sheetEdit } from '../src/app/areas/invoices/edit.js';
import { kindOfRate, rateOfKind } from '../src/engines/index.js';

const PDF = Buffer.from('%PDF-1.4 stand-in');
const printer: Printer = { pdf: async (d) => ({ html: '', pages: 1, pdf: Buffer.concat([PDF, Buffer.from(` ${d.number ?? ''}`)]) }), html: async () => ({ html: '', pages: 1 }) };
const CUSTOMER = { name: 'Café Kette AG', address: { street: 'Marktgasse', number: '4', postcode: '3011', town: 'Bern', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };
const find = (ws: Workspace, id: string) => loadInvoices(ws).invoices.find((i) => i.id === id)!;
const html = (inv: Issued, ws: Workspace) => sheetBlocks(issuedSheet(loadInvoices(ws), inv)).map((b) => b.html).join('');

function shop(): { ws: Workspace; beans: string; mill: string; course: string } {
  const ws = tempWorkspace('sales-articles-');
  const beans = createArticle(ws, { code: 'HM-1', type: 'goods', name: 'Hausmischung 1 kg', unit: 'kg', price: 28, vatKind: 'reduced', account: '3200' }).id;
  const mill = createArticle(ws, { code: 'MU-7', type: 'goods', name: 'Kaffeemühle', text: 'Kaffeemühle Modell 7', unit: 'pcs', price: 324.25, prices: 'gross', vatKind: 'normal' }).id;
  const course = createArticle(ws, { code: 'KU-1', type: 'service', name: 'Barista-Kurs', unit: 'h', price: 120, vatKind: 'normal', group: 'Kurse' }).id;
  return { ws, beans, mill, course };
}

test('the rate of a VAT kind comes from the jurisdiction for the supply day; none is 0 %', () => {
  assert.equal(rateOfKind('normal', '2026-11-19'), 8.1);
  assert.equal(rateOfKind('reduced', '2026-11-19'), 2.6);
  assert.equal(rateOfKind('accommodation', '2026-11-19'), 3.8);
  assert.equal(rateOfKind('none', '2026-11-19'), 0);
  assert.equal(kindOfRate(2.6, '2026-11-19'), 'reduced');
  assert.equal(kindOfRate(5, '2026-11-19'), undefined);
});

test('P2.4: a wholesale Rechnung from the Artikel list: code, text, unit, price, rate and account from the Artikel, each changeable on the position', async () => {
  const { ws, beans, mill, course } = shop();
  const c = createCustomer(ws, CUSTOMER);
  const book = loadInvoices(ws);
  const doc = { date: '2026-11-19', prices: 'net' as const };
  const lines = [beans, mill, course].map((id) => articleLine(book.articles.find((a) => a.id === id)!, doc, undefined, ws.invoicing?.units));
  assert.deepEqual(lines[0], { kind: 'article', articleId: beans, code: 'HM-1', text: 'Hausmischung 1 kg', quantity: 1, unit: 'kg', price: 28, vatRate: 2.6, account: '3200' });
  assert.equal(lines[1].text, 'Kaffeemühle Modell 7', 'the Artikel\'s text, else its name');
  assert.equal(lines[1].price, 299.95, 'a gross Artikel on a net document: its price without the VAT, to the Rappen');
  assert.equal(lines[1].account, undefined, 'no account of its own: the settings\' (none on the position)');
  assert.equal(lines[2].vatRate, 8.1);

  const draft = createDraft(ws, { customerId: c.id, date: '2026-11-19', lines: parseDraftPatch({ lines: [{ ...lines[0], quantity: 40 }, lines[1], lines[2]] }, book).lines! }, '2026-11-19T08:00:00Z');
  // Every field stays the position's own: the person changes the price, the text, the account, the code.
  const edits: Array<[string, string]> = [['l:0:price', '26.50'], ['l:0:text', 'Hausmischung 1 kg, Grosshandel'], ['l:0:account', '3400'], ['l:0:code', 'HM-1G'], ['l:0:vatRate', '8.1']];
  let d: Draft = draft;
  for (const [key, value] of edits) {
    const r = sheetEdit(d, key, value, { contacts: loadInvoices(ws).contacts, defaultTexts: { intro: '', closing: '' } });
    assert.ok(r && 'change' in r, key);
    d = updateDraft(ws, d.id, parseDraftPatch(r.change, loadInvoices(ws), ws.invoicing?.units, d.id));
  }
  assert.deepEqual(d.lines[0], { kind: 'article', articleId: beans, code: 'HM-1G', text: 'Hausmischung 1 kg, Grosshandel', quantity: 40, unit: 'kg', price: 26.5, vatRate: 8.1, account: '3400' });
  // A change of the Artikel later changes no position made from it.
  updateArticle(ws, beans, { price: 30 });
  assert.equal((find(ws, d.id).lines[0] as { price: number }).price, 26.5);

  const inv = await issueInvoice(ws, d.id, { now: '2026-11-19T09:00:00Z', printer });
  const sheet = html(inv, ws);
  assert.match(sheet, /<span class="lcode">HM-1G<\/span> Hausmischung 1 kg, Grosshandel/, 'the code prints before the text');
  assert.equal(revenueSplit(inv, totals(inv).gross, ws.invoicing!.revenueAccount).find((l) => l.account === '3400')?.vatCode, 'V81', 'its revenue books on the position\'s account with the code of its rate');
  // A layout without article codes prints none.
  const plain = sheetBlocks({ ...issuedSheet(loadInvoices(ws), inv), layout: { ...inv.layout, show: { ...inv.layout.show, articleCode: false } } }).map((b) => b.html).join('');
  assert.doesNotMatch(plain, /lcode/);
});

test('the account chain of a position: the Artikel\'s, else the contact\'s revenue account, else the settings\'', () => {
  const { ws, beans, mill } = shop();
  const c = createCustomer(ws, CUSTOMER);
  updateContact(ws, c.id, { revenueAccount: '3210', discount: 5 });
  const book = loadInvoices(ws);
  const contact = book.contacts.find((x) => x.id === c.id)!;
  const a = (id: string) => book.articles.find((x) => x.id === id)!;
  assert.equal(articleLine(a(beans), { date: '2026-11-19' }, contact).account, '3200', 'the Artikel names one');
  assert.equal(articleLine(a(mill), { date: '2026-11-19' }, contact).account, '3210', 'else the contact\'s');
  assert.equal(articleLine(a(mill), { date: '2026-11-19' }, contact).discount, 5, 'the contact\'s standing discount as on any position');
  assert.equal(articleLine(a(mill), { date: '2026-11-19' }).account, undefined, 'else none: the settings\' account books it');
  // On a draft made with it, createDraft fills the contact's account where the Artikel names none.
  const d = createDraft(ws, { customerId: c.id, lines: [articleLine(a(mill), { date: '2026-11-19' })] });
  assert.equal((d.lines[0] as { account?: string }).account, '3210');
});

test('a net and a gross Artikel on net and gross documents: converted at the rate to the Rappen, never at 0 %', () => {
  assert.equal(priceOn({ price: 100, prices: 'net' }, 'gross', 8.1), 108.1);
  assert.equal(priceOn({ price: 108.1, prices: 'gross' }, 'net', 8.1), 100);
  assert.equal(priceOn({ price: 100 }, 'net', 8.1), 100);
  assert.equal(priceOn({ price: 100, prices: 'gross' }, 'net', 0), 100);
});

test('a Gruppe: its sub-positions in the totals once, its sum printed, a Rabatt below takes them in, the revenue split by their accounts', async () => {
  const { ws } = shop();
  const c = createCustomer(ws, CUSTOMER);
  const lines: InvoiceLine[] = [
    { kind: 'group', text: 'Filiale Bern' },
    { text: 'Espresso', quantity: 10, price: 30, vatRate: 2.6, account: '3200', inGroup: true },
    { text: 'Service', quantity: 2, price: 100, vatRate: 8.1, account: '3400', inGroup: true },
    { text: 'Lieferung', quantity: 1, price: 50, vatRate: 8.1 },
    { kind: 'discount', text: 'Rabatt', percent: 10 },
  ];
  const flat = lines.filter((l) => l.kind !== 'group').map((l) => { const { inGroup: _, ...rest } = l as { inGroup?: true }; return rest as InvoiceLine; });
  assert.deepEqual(totals({ lines }), totals({ lines: flat }), 'the group adds nothing of its own');
  assert.equal(totals({ lines }).net, 495, '(300 + 200 + 50) less 10 %');
  assert.deepEqual(lineAmounts({ lines }).slice(0, 4), [500, 300, 200, 50], 'the group prints the sum of its sub-positions');
  const d = createDraft(ws, { customerId: c.id, date: '2026-11-19', lines });
  const inv = await issueInvoice(ws, d.id, { now: '2026-11-19T09:00:00Z', printer });
  const split = revenueSplit(inv, totals(inv).gross, '3300');
  assert.deepEqual(split.map((l) => [l.account, l.vatCode]).sort(), [['3200', 'V26'], ['3300', 'V81'], ['3400', 'V81']]);
  assert.equal(split.reduce((s, l) => Math.round((s + l.amount) * 100) / 100, 0), totals(inv).gross);
  const sheet = html(inv, ws);
  assert.match(sheet, /class="lgroup"><td colspan="\d">Filiale Bern<\/td><td class="r">500\.00/);
  assert.equal((sheet.match(/litem lingrp/g) ?? []).length, 2, 'its sub-positions print below it');
});

test('a Gruppe in a conversion: open quantities per sub-position, the group comes with what is ticked of it', async () => {
  const { ws } = shop();
  const c = createCustomer(ws, CUSTOMER);
  const order = createDraft(ws, { customerId: c.id, kind: 'sales-order', date: '2026-11-02', lines: [
    { kind: 'group', text: 'Filiale Bern' },
    { text: 'Espresso', quantity: 10, price: 30, vatRate: 2.6, unit: 'kg', inGroup: true },
    { text: 'Mühle', quantity: 2, price: 300, vatRate: 8.1, unit: 'pcs', inGroup: true },
    { kind: 'group', text: 'Filiale Thun' },
    { text: 'Espresso', quantity: 5, price: 30, vatRate: 2.6, unit: 'kg', inGroup: true },
  ] });
  const au = await issueInvoice(ws, order.id, { now: '2026-11-02T09:00:00Z', printer });
  const ls = convertDocument(ws, au.id, { to: 'delivery-note', lines: [{ line: 1, quantity: 6 }] }, '2026-11-05T08:00:00Z');
  assert.deepEqual(ls.lines, [{ kind: 'group', text: 'Filiale Bern' }, { text: 'Espresso', quantity: 6, price: 30, vatRate: 2.6, unit: 'kg', inGroup: true, ofLine: 1 }], 'Thun stays behind: none of it ticked');
  await issueInvoice(ws, ls.id, { now: '2026-11-05T09:00:00Z', printer });
  const open = offered(find(ws, au.id), 'delivery-note', loadInvoices(ws).invoices);
  assert.deepEqual(open.map((o) => [o.line, o.open]), [[1, 4], [2, 2], [4, 5]], 'what is open, per sub-position');
  const re = convertDocument(ws, au.id, { to: 'invoice', lines: open.map((o) => ({ line: o.line, quantity: o.item.quantity })) }, '2026-11-06T08:00:00Z');
  assert.equal(re.lines.filter((l) => l.kind === 'group').length, 2);
  assert.equal(totals(re).net, totals(find(ws, au.id)).net, 'the Rechnung of every position: the Auftrag\'s total, the groups counted once');
});

test('positions join and leave a Gruppe where they are put; a sub-position with no group above it is an ordinary one', () => {
  const g: InvoiceLine = { kind: 'group', text: 'G' };
  const a: InvoiceLine = { text: 'a', quantity: 1, price: 1, vatRate: 8.1, inGroup: true };
  const b: InvoiceLine = { text: 'b', quantity: 1, price: 1, vatRate: 8.1 };
  const added: InvoiceLine = { text: 'new', quantity: 1, price: 0, vatRate: 8.1 };
  assert.equal((insertLine([g, a, b], added, 1).lines[2] as { inGroup?: true }).inGroup, true, 'added after a sub-position: in the group');
  assert.equal((insertLine([g, a, b], added, 2).lines[3] as { inGroup?: true }).inGroup, undefined, 'after an ordinary one: not');
  const moved = moveLine([g, a, b], 2, 1)!;
  assert.deepEqual(moved.map((l) => (l as { text: string }).text), ['G', 'b', 'a']);
  assert.equal((moved[1] as { inGroup?: true }).inGroup, true, 'moved right below the title: in the group');
  const out = moveLine([g, a, b], 1, 2)!;
  assert.deepEqual(out.map((l) => [(l as { text: string }).text, (l as { inGroup?: true }).inGroup ?? false]), [['G', false], ['b', false], ['a', false]], 'moved out below an ordinary one: out of it');
  const groupMoved = moveLine([b, g, a], 1, 0)!;
  assert.deepEqual(groupMoved.map((l) => (l as { text: string }).text), ['G', 'a', 'b'], 'a group moves with its sub-positions');
  assert.equal((withGroups([b, a])[1] as { inGroup?: true }).inGroup, undefined);
  assert.equal((parseDraftPatch({ lines: [b, a] }, loadInvoices(tempWorkspace())).lines![1] as { inGroup?: true }).inGroup, undefined, 'the API drops a mark without a group');
});

test('an Artikel a document names is archived, one no document names is deleted; a code names one Artikel', () => {
  const { ws, beans, mill } = shop();
  const c = createCustomer(ws, CUSTOMER);
  const d = createDraft(ws, { customerId: c.id, lines: [articleLine(loadInvoices(ws).articles.find((a) => a.id === beans)!, { date: '2026-11-19' })] });
  assert.equal(removeArticle(ws, beans).outcome, 'archived', 'a draft names it');
  assert.equal(removeArticle(ws, mill).outcome, 'deleted');
  const book = loadInvoices(ws);
  assert.equal(book.articles.find((a) => a.id === mill)!.deleted, true);
  assert.equal(findArticle(book, 'HM-1'), undefined, 'an archived Artikel is in no picker');
  assert.equal(searchArticles(book.articles, 'haus').length, 0);
  assert.equal(updateArticle(ws, beans, { archived: false }).archived, undefined, 'restored');
  assert.throws(() => createArticle(ws, { code: 'hm-1', name: 'Doppelt' }), (e: Error) => e instanceof InvoiceRuleError && e.code === 'codeTaken');
  // The draft is gone: the Artikel no document names any more is deleted.
  removeDraft(ws, d.id);
  assert.equal(removeArticle(ws, beans).outcome, 'deleted');
});

test('the picker and the AI find an Artikel by code or name', () => {
  const { ws, course } = shop();
  const book = loadInvoices(ws);
  assert.equal(findArticle(book, 'ku-1')?.id, course);
  assert.equal(findArticle(book, 'Barista-Kurs')?.id, course);
  assert.equal(findArticle(book, 'barista')?.id, course, 'one name that contains it');
  assert.equal(findArticle(book, 'k'), undefined, 'two names contain it: none');
  assert.deepEqual(searchArticles(book.articles, 'mu').map((a) => a.code), ['MU-7'], 'by code');
  assert.deepEqual(searchArticles(book.articles, 'kurs').map((a) => a.code), ['KU-1'], 'by name or group');
});

test('the CSV import of Artikel: the mapping proposed from the header, the rows with their problems, a code already there proposed as the same Artikel', () => {
  const { ws } = shop();
  const csv = [
    'Artikelnummer;Bezeichnung;Einheit;Verkaufspreis;MWST;Ertragskonto;Produktgruppe',
    'HM-1;Hausmischung 1 kg;kg;28.00;2.6;3200;Kaffee',
    'EX-2;Espresso-Tasse;Stk.;1\'250.50;UN81;3200;Geschirr',
    ';Ohne Preis;Stk.;zwölf;8.1;;',
    'BE-1;Beherbergung;Nacht;180;3.8 %;32;',
    ';;;;;;',
    'EX-2;Espresso-Tasse doppelt;Stk.;3;8.1;;',
  ].join('\n');
  const p = previewArticleImport(csv, undefined, loadInvoices(ws).articles, ws.invoicing?.units, '2026-11-19');
  assert.deepEqual(p.mapping, { code: 'Artikelnummer', name: 'Bezeichnung', unit: 'Einheit', price: 'Verkaufspreis', vat: 'MWST', account: 'Ertragskonto', group: 'Produktgruppe' });
  const by = (line: number) => p.rows.find((r) => r.line === line)!;
  assert.equal(by(2).choice, 'same', 'HM-1 is there already');
  assert.deepEqual(by(3).article, { code: 'EX-2', type: 'service', name: 'Espresso-Tasse', unit: 'pcs', price: 1250.5, vatKind: 'normal', account: '3200', group: 'Geschirr' });
  assert.deepEqual([by(4).problems, by(4).choice], [['price'], 'skip'], 'a price that cannot be read: not imported');
  assert.deepEqual([by(5).problems, by(5).article?.vatKind, by(5).article?.unit, by(5).choice], [['unit', 'account'], 'accommodation', undefined, 'new'], 'a unit and an account not read are named and left out');
  assert.equal(p.rows.some((r) => r.line === 6), false, 'an empty row is no row');
  assert.equal(by(7).choice, 'same', 'the code of an earlier row');
  const plan = importArticles(csv, undefined, { 7: 'new' }, loadInvoices(ws).articles, ws.invoicing?.units, '2026-11-19');
  assert.deepEqual(plan.articles.map((a) => [a.name, a.code ?? null]), [['Espresso-Tasse', 'EX-2'], ['Beherbergung', 'BE-1'], ['Espresso-Tasse doppelt', null]], 'taken as new, the doubled code is left out');
  assert.equal(plan.skipped, 2, 'the code already there and the row without a price');
  assert.throws(() => previewArticleImport(csv, { name: 'Name' }, []), /Name/, 'a mapping to a column the table lacks is refused');
});
