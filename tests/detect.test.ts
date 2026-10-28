/**
 * Receipt or not (src/intake/document-kind.ts) and the same receipt twice (src/intake/duplicates.ts),
 * on the made-up documents of the painting firm's supplier (the persona of .claude/skills/verify):
 * invoice FM-77812 as a PDF and as a re-download, its order confirmation, a newsletter, the terms.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents } from '../src/engines/index.js';
import { documentKind } from '../src/intake/document-kind.js';
import { duplicatesIn, twinFinder, type Comparable } from '../src/intake/duplicates.js';
import { classifyInput } from '../src/booking/classify.js';
import type { Books } from '../src/books/store.js';

const W = documents();

const invoice = (no: string, date: string, lines: Array<[string, number]>) => {
  const net = lines.reduce((s, [, a]) => s + a, 0);
  const vat = Math.round(net * 8.1) / 100;
  return [
    'Farbmix AG', 'Farbweg 3, 9000 St. Gallen',
    `Rechnung ${no}`, `Rechnungsdatum: ${date}`, 'Malerei Huber GmbH, Wil SG',
    ...lines.map(([what, a]) => `${what} ${a.toFixed(2)}`),
    `Total exkl. MWST ${net.toFixed(2)}`, `MWST 8.1 % ${vat.toFixed(2)}`, `Total CHF ${(net + vat).toFixed(2)}`,
    'Zahlbar innert 30 Tagen', 'Zahlteil',
    'Es gelten unsere AGB.',
  ].join('\n');
};
const FM77812 = invoice('FM-77812', '28.06.2026', [['Dispersionsfarbe weiss 15 l, 8 Stk', 682.4], ['Abdeckvlies 50 m², 4 Rollen', 196], ['Malerkrepp 50 mm, 24 Stk', 271.95]]);
const FM78230 = invoice('FM-78230', '30.07.2026', [['Fassadenfarbe Silikon 12.5 l, 10 Stk', 1890], ['Grundierung tiefenwirksam 10 l, 3 Stk', 340.2]]);
const ORDER = 'Farbmix AG\nFarbweg 3, 9000 St. Gallen\nAuftragsbestätigung AB-5521\nDatum: 24.07.2026\nVielen Dank für Ihre Bestellung. Wir liefern am 30.07.2026:\nFassadenfarbe Silikon 12.5 l, 10 Stk\nGrundierung tiefenwirksam 10 l, 3 Stk\nDie Rechnung folgt mit der Lieferung.';
const NEWSLETTER = 'Farbmix Herbstaktion\nLiebe Kundinnen und Kunden\nBis 31. Oktober 20 % auf alle Fassadenfarben. Jetzt im Laden oder online bestellen!\nSie erhalten diesen Newsletter, weil Sie Kundin bei Farbmix sind. Abmelden: farbmix.example/abmelden';
const TERMS = 'Allgemeine Geschäftsbedingungen\nFarbmix AG, gültig ab 1. Januar 2026\n1. Geltungsbereich. Diese AGB gelten für alle Lieferungen ...\n2. Preise und Zahlung. Alle Preise in CHF inkl. MWST ...\n3. Lieferung und Gefahrübergang ...';

test('receipt or not: an invoice is one (its terms line notwithstanding), a newsletter and terms are none, an order confirmation is kept beside its invoice', () => {
  assert.equal(documentKind(FM77812, W).is, 'receipt');
  assert.deepEqual(documentKind(NEWSLETTER, W), { is: 'other', why: 'newsletter' });
  assert.deepEqual(documentKind(TERMS, W), { is: 'other', why: 'terms' });
  assert.deepEqual(documentKind(ORDER, W), { is: 'supporting', why: 'order-confirmation' });
  assert.deepEqual(documentKind('Lieferschein LS-301\nFarbmix AG\n30.07.2026\nFassadenfarbe Silikon 12.5 l, 10 Stk', W), { is: 'supporting', why: 'delivery-note' });
  assert.equal(documentKind('Facture 2026-114\nPeintures Léman SA\nTotal CHF 324.30\nTVA 8.1 % 24.30\nPayable jusqu\'au 30.09.2026', W).is, 'receipt', 'in French too');
  assert.deepEqual(documentKind('Colori Ticino\nNovità d\'autunno: sconti su tutte le vernici\nDisiscriviti', W), { is: 'other', why: 'newsletter' }, 'an Italian newsletter');
  assert.equal(documentKind('Kassenbon\nBaucenter Gossau\nTotal CHF 312.90\nMWST 8.1 % 23.46', W).is, 'receipt', 'a till receipt');
  // A newsletter word in the footer of a mailed invoice does not make it one.
  assert.equal(documentKind(`${FM77812}\nNewsletter abbestellen`, W).is, 'receipt');
});

const r = (id: string, text: string, facts: Partial<Comparable> = {}): Comparable => ({ id, extractedText: text, indexedAt: `2026-07-0${id.length}T00:00:00Z`, ...facts });
const FACTS = { date: '2026-06-28', amount: 1243.55, currency: 'CHF' };

test('the same invoice twice: renamed or downloaded again (the same text), or read once from a PDF and once from a photo (the same number and total)', () => {
  const pdf = r('pdf', FM77812, FACTS);
  const finder = twinFinder([pdf, r('other', FM78230, { date: '2026-07-30', amount: 2410.8, currency: 'CHF' })], W);
  assert.deepEqual(finder.find(r('again', FM77812, FACTS)), { of: 'pdf', why: 'same-text', relation: 'duplicate' });
  const photo = 'Farbmix AG St. Gallen\nRechnung FM-77812 vom 28.06.2026\nDispersionsfarbe weiss 682.40\nAbdeckvlies 196.00\nMalerkrepp 271.95\nTotal CHF 1243.55';
  assert.deepEqual(finder.find(r('photo', photo, FACTS)), { of: 'pdf', why: 'same-number', relation: 'duplicate' });
  assert.equal(finder.find(r('next', FM78230, { date: '2026-06-29', amount: 1243.55, currency: 'CHF' })), undefined, 'another invoice number is another invoice, whatever its total');
});

test('not the same: a monthly bill of the same amount, two postage receipts of one day, a pair a person said differs', () => {
  const bill = (month: string, no: string) => `Swisscom (Schweiz) AG\nRechnung ${no}\nNatel Abo ${month}\nTotal CHF 89.00`;
  const july = r('jul', bill('Juli', '2026-07-4471'), { date: '2026-07-15', amount: 89, currency: 'CHF' });
  assert.equal(twinFinder([july], W).find(r('aug', bill('August', '2026-08-4471'), { date: '2026-08-15', amount: 89, currency: 'CHF' })), undefined);
  const postage = (no: string) => `Post CH AG\nQuittung\nPaketetikette ${no}\nTotal CHF 9.00`;
  assert.equal(twinFinder([r('p1', postage('260811400001'), { date: '2026-08-19', amount: 9 })], W).find(r('p2', postage('260811400002'), { date: '2026-08-19', amount: 9 })), undefined);
  const pdf = r('pdf', FM77812, FACTS);
  assert.equal(twinFinder([pdf], W).find(r('again', FM77812, { ...FACTS, distinctFrom: ['pdf'] })), undefined);
  assert.equal(twinFinder([{ ...pdf, distinctFrom: ['again'] }], W).find(r('again', FM77812, FACTS)), undefined, 'remembered on either side');
});

test('among a year of other receipts, a copy is found up to 7 days apart and a companion up to 31, to the day; one without a day by its text (#258)', () => {
  const year = Array.from({ length: 300 }, (_, i) => r(`f${i}`, `Lieferant ${i}\nRechnung R-${100000 + i}\nTotal CHF ${i}.50`, { date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), amount: i + 0.5, currency: 'CHF' }));
  const photo = 'Farbmix AG St. Gallen\nRechnung FM-77812 vom 28.06.2026\nDispersionsfarbe weiss 682.40\nAbdeckvlies 196.00\nMalerkrepp 271.95\nTotal CHF 1243.55';
  const copies = twinFinder([...year, r('pdf', FM77812, FACTS)], W);
  assert.equal(copies.find(r('photo', photo, { ...FACTS, date: '2026-07-05' }))?.of, 'pdf', '7 days apart');
  assert.equal(copies.find(r('photo', photo, { ...FACTS, date: '2026-07-06' })), undefined, '8 days apart');
  assert.equal(copies.find(r('again', FM77812, { amount: FACTS.amount }))?.of, 'pdf', 'no day: the same text');
  const bill = 'Restaurant Beispielhof Zürich\nTisch vier, bedient von Anna\nzwei Menus, ein Mineral\nTotal CHF 64.50';
  const meal = twinFinder([...year, r('meal', bill, { date: '2026-08-14', amount: 64.5, currency: 'CHF' })], W);
  assert.equal(meal.find(r('scan', `${bill}\nKopie`, { date: '2026-08-15', amount: 64.5, currency: 'CHF' }))?.of, 'meal', 'by its words a day apart');
  assert.equal(meal.find(r('scan', `${bill}\nKopie`, { date: '2026-08-16', amount: 64.5, currency: 'CHF' })), undefined, 'two days apart');
  const companions = twinFinder([...year, r('inv', FM78230, { date: '2026-07-30', amount: 2410.8, currency: 'CHF' })], W);
  assert.equal(companions.find(r('ab', ORDER, { date: '2026-06-29', kind: 'supporting' }))?.of, 'inv', '31 days before');
  assert.equal(companions.find(r('ab', ORDER, { date: '2026-06-28', kind: 'supporting' })), undefined, '32 days before');
});

test('an order confirmation is the companion of its invoice, not a copy; of a pair the copy is the one without a link', () => {
  const books = [r('inv', FM78230, { date: '2026-07-30', amount: 2410.8, currency: 'CHF' }), r('old', FM77812, FACTS), r('ab', ORDER, { date: '2026-07-24', kind: 'supporting' })];
  assert.deepEqual(twinFinder(books, W).find(books[2]), { of: 'inv', why: 'same-facts', relation: 'companion' });
  const copy = r('copy-later', FM77812, FACTS);
  const found = duplicatesIn([...books, copy], new Set(['copy-later']), W);
  assert.deepEqual(found.get('old'), { of: 'copy-later', why: 'same-text', relation: 'duplicate' }, 'the linked one is the original');
  assert.equal(found.has('copy-later'), false);
  assert.equal(found.get('ab')?.relation, 'companion');
});

test('a receipt marked as a copy never feeds the booking: no second input tax', () => {
  const receipt = (id: string, kind?: 'duplicate') => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: FM77812, extractionMethod: 'pdftotext' as const, fileSize: 1, indexedAt: '', location: 'archived' as const, ...FACTS, hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 93.15 }], ...(kind ? { kind } : {}) });
  const books = {
    receipts: [receipt('a'), receipt('b', 'duplicate')],
    mappings: [{ transactionRef: 'T', receiptId: 'a' }, { transactionRef: 'T', receiptId: 'b' }],
    transactions: [{ ref: 'T', date: '2026-07-03', amount: 1243.55, currency: 'CHF', direction: 'DBIT', description: 'Farbmix AG', bank: 'Raiffeisen' }],
  } as unknown as Books;
  assert.equal(classifyInput(books, books.transactions[0]).receipts.length, 1);
});
