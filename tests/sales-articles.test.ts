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
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { checkJurisdiction } from '../src/core/modules/check.js';
import {
  convertDocument, createArticle, createCustomer, createDraft, issueInvoice, parseDraftPatch, removeArticle, removeDraft, updateArticle, updateContact, updateDraft, type Printer,
} from '../src/invoices/service.js';
import { loadInvoices } from '../src/invoices/store.js';
import { InvoiceRuleError, lineAmounts, revenueSplit, totals, warningsForIssue } from '../src/invoices/rules.js';
import { articleLine, draftArticleLines, findArticle, priceOn, searchArticles } from '../src/invoices/articles.js';
import { importArticles, previewArticleImport, vatKindOf } from '../src/invoices/article-import.js';
import { ambiguousNumber, tableNumber } from '../src/invoices/table-import.js';
import { groupsLeftBehind, offered } from '../src/invoices/chain.js';
import { issuedSheet } from '../src/invoices/documents.js';
import { sheetBlocks } from '../src/invoices/sheet.js';
import { withGroups, type Draft, type InvoiceLine, type Issued } from '../src/invoices/model.js';
import { contactOn } from '../src/invoices/dated-values.js';
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
  updateContact(ws, c.id, { revenueAccount: '3210', discount: 5 }, '2026-11-19');
  const book = loadInvoices(ws);
  const contact = contactOn(book.contacts.find((x) => x.id === c.id)!, '2026-11-19');
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

const G = (text: string): InvoiceLine => ({ kind: 'group', text });
const P = (text: string, inGroup = false): InvoiceLine => ({ text, quantity: 1, price: 10, vatRate: 8.1, ...(inGroup ? { inGroup: true as const } : {}) });
const T = (text: string): InvoiceLine => ({ kind: 'text', text });
const R = (text: string): InvoiceLine => ({ kind: 'discount', text, percent: 10 });
/** «[G] a* b X»: a group's title in brackets, a sub-position starred. */
const show = (ls: readonly InvoiceLine[] | undefined) => ls?.map((l) => (l.kind === 'group' ? `[${l.text}]` : `${(l as { text: string }).text}${(l as { inGroup?: true }).inGroup ? '*' : ''}`)).join(' ');
const mv = (ls: InvoiceLine[], from: number, to: number, how: 'step' | 'drop' = Math.abs(to - from) === 1 ? 'step' : 'drop') => { const m = moveLine(ls, from, to, how); return m && `${show(m.lines)} @${m.at}`; };

test('a Gruppe moves whole: by a step it passes the whole block or line beside it, dropped it lands before or after the block it is dropped on', () => {
  assert.equal(mv([G('G'), P('a', true), P('b', true), P('X'), P('Y')], 0, 1), 'X [G] a* b* Y @1', 'Alt+↓ on a title of two: past the next line, its sub-positions with it');
  assert.equal(mv([G('G'), P('a', true), P('X'), P('Y')], 0, 1), 'X [G] a* Y @1', 'a group of one moves too');
  assert.equal(mv([P('P'), G('G'), P('a', true), P('b', true), P('c', true), P('X')], 1, 2), 'P X [G] a* b* c* @2');
  assert.equal(mv([P('P'), G('G'), P('a', true)], 1, 0), '[G] a* P @0', 'Alt+↑ past the line above');
  const two = [G('G1'), P('a', true), G('G2'), P('b', true)];
  assert.equal(mv(two, 2, 1), '[G2] b* [G1] a* @0', 'Alt+↑ on G2 passes the whole of G1');
  assert.equal(mv(two, 0, 1), '[G2] b* [G1] a* @2', 'Alt+↓ on G1 passes the whole of G2');
  assert.equal(mv(two, 0, 3), '[G2] b* [G1] a* @2', 'dropped on a sub-position of G2: after the whole of G2');
  assert.equal(mv(two, 0, 2), '[G2] b* [G1] a* @2', 'dropped on G2\'s title: after the whole of G2');
  assert.equal(mv(two, 2, 0), '[G2] b* [G1] a* @0', 'dropped up on G1: before it');
  assert.equal(mv(two, 0, 1), mv(two, 0, 1), 'stable');
  assert.equal(moveLine([G('G'), P('a', true)], 0, 1), undefined, 'onto its own sub-position: nothing moves');
  assert.equal(moveLine([P('X'), G('G'), P('a', true)], 1, 2), undefined, 'the last block: nothing below to pass');
});

test('a priced position changes its Gruppe only when moved into or out of one; a last sub-position leaves in place', () => {
  const g = [G('G'), P('a', true), P('b', true), P('X')];
  assert.equal(mv(g, 1, 2), '[G] b* a* X @2', 'within the group: a sub-position still');
  assert.equal(mv(g, 2, 3), '[G] a* b X @2', 'Alt+↓ on the last sub-position: out of the group, where it stands');
  assert.equal(mv(g, 1, 0), 'a [G] b* X @0', 'Alt+↑ on the first: above the title, out of the group');
  assert.equal(mv(g, 3, 2), '[G] a* b* X* @3', 'Alt+↑ just below a group: its last sub-position, where it stands');
  assert.equal(mv([P('X'), G('G'), P('a', true)], 0, 1), '[G] X* a* @1', 'Alt+↓ onto a title: its first sub-position');
  assert.equal(mv([P('X'), P('Y'), G('G'), P('a', true)], 0, 3), 'Y [G] a* X* @3', 'dropped down on a sub-position: in the group, after it');
  assert.equal(mv([P('X'), G('G'), P('a', true)], 0, 1), '[G] X* a* @1', 'dropped down on a title: its first sub-position');
  assert.equal(mv([G('G'), P('a', true), P('X')], 2, 0), 'X [G] a* @0', 'dropped up on a title: above it, outside');
  assert.equal(mv([G('G'), P('a', true), P('b', true), P('X')], 3, 1), '[G] X* a* b* @1', 'dropped up on a sub-position: in the group, before it');
  assert.equal(mv([G('G'), P('a', true), P('b', true), P('X'), P('Y')], 1, 4), '[G] b* X Y a @4', 'dropped out of the group onto an ordinary line: ordinary');
});

test('a text, Rabatt or Zwischentotal never goes inside a Gruppe: moved or inserted there, it lands before or after the block', () => {
  const g = [G('G'), P('a', true), P('b', true), T('T')];
  assert.equal(mv(g, 3, 2), 'T [G] a* b* @0', 'Alt+↑ below a group: past the whole block');
  assert.equal(mv([T('T'), G('G'), P('a', true)], 0, 1), '[G] a* T @2', 'Alt+↓ above a group: past the whole block');
  assert.equal(mv([T('T'), G('G'), P('a', true), P('b', true), P('X')], 0, 2), '[G] a* b* T X @3', 'dropped on a sub-position: after the block');
  assert.equal(mv([G('G'), P('a', true), P('b', true), T('T')], 3, 1), 'T [G] a* b* @0', 'dropped up into a block: before it');
  assert.equal(show(insertLine(g, T('N'), 1).lines), '[G] a* b* N T', 'a text added in the group: after it');
  assert.equal(show(insertLine(g, R('R'), 1).lines), '[G] a* b* R T', 'a Rabatt too');
  assert.equal(show(insertLine(g, { kind: 'subtotal', text: 'S' }, 0).lines), '[G] a* b* S T', 'a Zwischentotal after the title too');
  assert.equal(show(insertLine(g, G('H'), 1).lines), '[G] a* b* [H] T', 'a new group after the block');
  assert.equal(show(insertLine(g, P('n'), 1).lines), '[G] a* n* b* T', 'a priced position in the group: one of its sub-positions');
  assert.equal(show(insertLine(g, P('n'), 0).lines), '[G] n* a* b* T', 'after the title: its first sub-position');
  assert.equal(show(insertLine(g, P('n'), 3).lines), '[G] a* b* T n', 'after an ordinary line: ordinary');
  assert.equal(show(insertLine(g.slice(0, 3), P('n'), -1).lines), '[G] a* b* n', 'at the end, with no position named: ordinary');
  assert.equal((withGroups([P('b'), P('a', true)])[1] as { inGroup?: true }).inGroup, undefined);
  assert.equal((parseDraftPatch({ lines: [P('b'), P('a', true)] }, loadInvoices(tempWorkspace())).lines![1] as { inGroup?: true }).inGroup, undefined, 'the API drops a mark without a group');
});

test('issuing warns of a Gruppe without a title or without sub-positions; a conversion names the group it leaves behind', () => {
  const w = warningsForIssue({ lines: [G(''), P('a', true), G('Leer'), P('b')] });
  assert.deepEqual(w.map((m) => [m.field, m.line]), [['line.groupTitle', 0], ['line.groupEmpty', 2]]);
  const source = { lines: [G('Bern'), P('a', true), P('b', true), G('Thun'), P('c', true), P('d')] };
  assert.deepEqual(groupsLeftBehind(source, [{ line: 1, quantity: 1 }, { line: 5, quantity: 1 }]), [{ line: 3, text: 'Thun' }]);
  assert.deepEqual(groupsLeftBehind(source, [{ line: 4, quantity: 0 }, { line: 2, quantity: 1 }]), [{ line: 3, text: 'Thun' }], 'a quantity of 0 takes nothing');
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

test('a VAT cell is read before any number: a code, a rate with or without its point, a word', () => {
  const kinds = Object.fromEntries(['UN81', 'UN26', 'UN38', 'V81', 'V0', '81', '26', '8.1 %', '2,6 %', '3.8', '0', 'reduziert', 'Beherbergung', 'befreit', '7.7', 'X'].map((c) => [c, vatKindOf(c, '2026-11-19') ?? null]));
  assert.deepEqual(kinds, {
    UN81: 'normal', UN26: 'reduced', UN38: 'accommodation', V81: 'normal', V0: 'none', 81: 'normal', 26: 'reduced', '8.1 %': 'normal', '2,6 %': 'reduced', '3.8': 'accommodation',
    0: 'none', reduziert: 'reduced', Beherbergung: 'accommodation', befreit: 'none', '7.7': null, X: null,
  });
});

test('a number of a table: thousands marks, a decimal comma, a currency before or after; one that reads two ways is named, not guessed', () => {
  const read = Object.fromEntries(["1'200", '1 200', '1’200.50', '1.200,50', '1,200.50', '12.50 CHF', 'CHF 12.50', '12.–', '-12.50', '0.125', '1,5', '1,200', '1.200', 'zwölf'].map((x) => [x, tableNumber(x) ?? null]));
  assert.deepEqual(read, {
    "1'200": 1200, '1 200': 1200, '1’200.50': 1200.5, '1.200,50': 1200.5, '1,200.50': 1200.5, '12.50 CHF': 12.5, 'CHF 12.50': 12.5, '12.–': 12, '-12.50': -12.5, '0.125': 0.125, '1,5': 1.5,
    '1,200': null, '1.200': null, zwölf: null,
  });
  assert.deepEqual([ambiguousNumber('1,200'), ambiguousNumber('1.200'), ambiguousNumber('0.125'), ambiguousNumber('1.20')], [true, true, false, false]);
  const p = previewArticleImport('Code;Name;Preis;MWST\nA;Alpha;1,200;UN26\nB;Beta;12.50 CHF;V81', undefined, [], undefined, '2026-11-19');
  assert.deepEqual(p.rows.map((r) => [r.problems, r.choice, r.article?.vatKind, r.article?.price]), [[['priceUnclear'], 'skip', 'reduced', 0], [[], 'new', 'normal', 12.5]]);
});

test('the AI\'s Artikel draft is priced as createDraft prices it: the prices it names, else the firm\'s default for its kind', () => {
  const ws = tempWorkspace('sales-articles-gross-');
  writeFileSync(ws.paths.manifest, readFileSync(ws.paths.manifest, 'utf8').replace(/^invoicing:\n/m, 'invoicing:\n  prices: { invoice: gross }\n'));
  const gross = workspaceAt(ws.paths.root);
  assert.equal(gross.invoicing?.prices.invoice, 'gross');
  createArticle(gross, { code: 'K1', name: 'Kurs', price: 100, vatKind: 'normal' });
  const c = createCustomer(gross, CUSTOMER);
  const made = (draft: Record<string, unknown>) => {
    const lines = draftArticleLines(loadInvoices(gross), { ...draft, lines: [{ article: 'K1', quantity: 1 }] }, gross.invoicing, (n) => { throw new Error(n); });
    const d = createDraft(gross, { customerId: c.id, ...parseDraftPatch({ ...draft, lines }, loadInvoices(gross), gross.invoicing?.units) });
    return [d.kind, d.prices, (d.lines[0] as { price: number }).price, totals(d).gross];
  };
  assert.deepEqual(made({}), ['invoice', 'gross', 108.1, 108.1], 'the firm\'s Rechnungen are gross: the net Artikel price with its VAT');
  assert.deepEqual(made({ prices: 'net' }), ['invoice', 'net', 100, 108.1], 'net named: as named');
  assert.deepEqual(made({ kind: 'quote' }), ['quote', 'net', 100, 108.1], 'an Angebot takes the firm\'s default for Angebote (net)');
  assert.throws(() => draftArticleLines(loadInvoices(gross), { lines: [{ article: 'Gibt es nicht' }] }, gross.invoicing, (n) => { throw new Error(`missing ${n}`); }), /missing Gibt es nicht/);
});

test('the module check wants each VAT kind\'s rates newest first', () => {
  const j = structuredClone(loadJurisdiction(APP_ROOT, 'ch').jurisdiction);
  assert.deepEqual(checkJurisdiction(j).filter((x) => x.file === 'invoicing.yaml'), []);
  j.invoicing.rateKinds.normal = [{ rate: 7.7, from: '2018-01-01' }, { rate: 8.1, from: '2024-01-01' }];
  j.invoicing.rates.push(7.7);
  assert.match(JSON.stringify(checkJurisdiction(j)), /rateKinds\.normal.*newest first/);
});
