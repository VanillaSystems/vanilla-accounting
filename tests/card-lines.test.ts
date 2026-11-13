/**
 * A card statement's lines as parts a receipt can be linked to (#409): code reads the lines off the
 * statement and keeps them on its receipt; the bill behind one line is linked to the settlement with
 * the line's index when exactly one bill fits it; never in a filed period.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOffers, lineOfReceipt, linkCardLines, parseCardLines, readCardLines } from '../src/books/card-lines.js';
import { documents } from '../src/engines/index.js';
import { link, unlink } from '../src/server/edits.js';
import { matchStep } from '../src/intake/match.js';
import type { Books as StoreBooks } from '../src/books/store.js';
import type { Workspace } from '../src/workspace/workspace.js';
import type { BankTransaction, Mapping, Receipt } from '../src/types/index.js';

/** The consultancy persona's statement as pdf.js reads it for the books (reading order: column by column). */
export const READING = 'Alpencard AG\nKreditkartenabrechnung Visa Business ****3307\n\nKälin Advisory GmbH\nBaarerstrasse 41\n6300 Zug\nAbrechnung 01.08.2026 – 31.08.2026\nDatum\n07.08.2026\n07.08.2026\n19.08.2026\n\nBeschreibung\nLINKLY ADS DUBLIN IE, USD 180.00\nBearbeitungsgebühr Fremdwährung 1.75%\nHOTEL PILATUSBLICK LUZERN\nTotal zu Ihren Lasten, Belastung per LSV am 10.09.2026\n\nBetrag CHF\n146.62\n2.57\n164.00\n313.19\f';
/** The same statement laid out by its columns, as a model's read gives it too. */
const LAYOUT = `    Alpencard AG
        Kreditkartenabrechnung Visa Business ****3307
    Abrechnung 01.08.2026 – 31.08.2026
     Datum         Beschreibung                                          Betrag CHF
      07.08.2026      LINKLY ADS DUBLIN IE, USD 180.00                               146.62
      07.08.2026      Bearbeitungsgebühr Fremdwährung 1.75%                             2.57
     19.08.2026      HOTEL PILATUSBLICK LUZERN                                164.00
      Total zu Ihren Lasten, Belastung per LSV am 10.09.2026                              313.19`;
export const HOTEL = 'Hotel Pilatusblick\nPilatusstrasse 30, 6003 Luzern\nMWST-Nr. CHE-123.456.789 MWST\nRechnung 26-08-4471\nDatum: 19.08.2026 bezahlt mit Visa ****3307\nTotal CHF 164.00\ndarin MWST 3.8% (Beherbergung) auf 158.00 5.78';
export const LINKLY = 'Linkly Ads Ireland Ltd\nWilton Place, Dublin 2, Ireland\nInvoice LA-2608-77012\nDate: 07.08.2026 Charged to Visa ****3307\nVAT: reverse charge, customer to account USD 0.00\nTotal USD 180.00';

const LINES = [
  { day: '2026-08-07', merchant: 'LINKLY ADS DUBLIN IE', amount: 146.62, currency: 'CHF', original: { amount: 180, currency: 'USD' } },
  { day: '2026-08-07', merchant: 'Bearbeitungsgebühr Fremdwährung 1.75%', amount: 2.57, currency: 'CHF' },
  { day: '2026-08-19', merchant: 'HOTEL PILATUSBLICK LUZERN', amount: 164, currency: 'CHF' },
];

test('the lines are read by code from the statement\'s text, in reading order and laid out by columns alike', () => {
  assert.deepEqual(parseCardLines(READING), LINES);
  assert.deepEqual(parseCardLines(LAYOUT), LINES);
});

test('a balance carried and the card\'s own payment are no merchant lines, in any of the four languages', () => {
  const rows = (prev: string, paid: string, next: string) => `Kreditkartenabrechnung Visa ****3307\nAbrechnung 01.08.2026 – 31.08.2026\n01.08.2026 ${prev} 500.00\n05.08.2026 ${paid} 500.00-\n19.08.2026 HOTEL PILATUSBLICK LUZERN 144.00\n31.08.2026 ${next} 144.00`;
  for (const [prev, paid, next] of [['Saldo Vormonat', 'Ihre Zahlung - Danke', 'Neuer Saldo'], ['Previous balance', 'Payment received - thank you', 'New balance'],
    ['Solde précédent', 'Votre paiement - merci', 'Nouveau solde'], ['Saldo precedente', 'Il vostro pagamento - grazie', 'Nuovo saldo']]) {
    assert.deepEqual(parseCardLines(rows(prev, paid, next), documents()), [{ day: '2026-08-19', merchant: 'HOTEL PILATUSBLICK LUZERN', amount: 144 }], prev);
  }
});

test('days with slashes and amounts with a comma for the cents are read; what is not read says why', () => {
  const text = 'Relevé de carte Visa ****3307\nPériode 01/08/2026 – 31/08/2026\n12/08/2026 HOTEL DU LAC GENEVE 1.234,50\n14/08/2026 TAXI GENEVE 32,00\nTotal 1.266,50';
  assert.deepEqual(parseCardLines(text, documents()), [{ day: '2026-08-12', merchant: 'HOTEL DU LAC GENEVE', amount: 1234.5 }, { day: '2026-08-14', merchant: 'TAXI GENEVE', amount: 32 }]);
  assert.deepEqual(readCardLines(text.replace('Total 1.266,50', 'Total 1.300,00'), documents()), { why: 'noTotal' });
  assert.deepEqual(readCardLines('Kreditkartenabrechnung\nAbrechnung 01.08.2026 – 31.08.2026\nKeine Bewegungen', documents()), { why: 'noTable' });
});

test('lines that do not add up to a total the statement prints are not kept', () => {
  assert.equal(parseCardLines(LAYOUT.replace('313.19', '320.00')), undefined);
  assert.equal(parseCardLines('Kreditkartenabrechnung\nAbrechnung 01.08.2026 – 31.08.2026\nKeine Bewegungen'), undefined);
});

type Books = { receipts: Receipt[]; mappings: Mapping[]; transactions: BankTransaction[] };
const receipt = (id: string, r: Partial<Receipt>): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-09-12', location: 'archived', ...r });
const settlement: BankTransaction = { ref: 'ZGKB-26-0030', bank: 'ZKB', date: '2026-09-10', amount: 313.19, currency: 'CHF', direction: 'DBIT', description: 'Kartenabrechnung August 2026 LSV', counterparty: 'Alpencard AG' };

function books(extra: Receipt[] = [], closedThrough = '2026-06-30'): { books: Books; isOpen: (d: string) => boolean } {
  return {
    books: {
      receipts: [
        receipt('card', { extractedText: READING, date: '2026-08-31', amount: 313.19, currency: 'CHF' }),
        receipt('hotel', { extractedText: HOTEL, date: '2026-08-19', amount: 164, currency: 'CHF', hasSwissVat: true }),
        receipt('linkly', { extractedText: LINKLY, date: '2026-08-07', amount: 180, currency: 'USD', hasSwissVat: false }),
        ...extra,
      ],
      mappings: [{ transactionRef: settlement.ref, receiptId: 'card', by: 'llm' }],
      transactions: [settlement],
    },
    isOpen: (d) => d > closedThrough,
  };
}

test('the statement keeps its lines, and each line\'s one bill is linked to the settlement with the line\'s index; the card fee has none', () => {
  const { books: b, isOpen } = books();
  const done = linkCardLines(b, isOpen, documents());
  assert.deepEqual(done.read, ['card']);
  assert.deepEqual(b.receipts.find((r) => r.id === 'card')!.cardLines, LINES);
  assert.deepEqual(b.mappings.filter((m) => m.line !== undefined), [
    { transactionRef: settlement.ref, receiptId: 'linkly', by: 'rule', rule: 'card-line', line: 0 },
    { transactionRef: settlement.ref, receiptId: 'hotel', by: 'rule', rule: 'card-line', line: 2 },
  ]);
  assert.deepEqual(lineOfReceipt(b, 'hotel'), { payment: settlement.ref, statement: 'card', index: 2, line: LINES[2] });
  const again = linkCardLines(b, isOpen, documents());
  assert.deepEqual(again, { read: [], linked: [] }, 'a second run changes nothing');
});

test('two bills that fit one line: neither is linked, both are offered for it', () => {
  const twin = receipt('hotel-2', { extractedText: HOTEL.replace('26-08-4471', '26-08-4472'), date: '2026-08-18', amount: 164, currency: 'CHF', hasSwissVat: true });
  const { books: b, isOpen } = books([twin]);
  const done = linkCardLines(b, isOpen, documents());
  assert.deepEqual(done.linked.map((l) => l.receipt), ['linkly']);
  assert.equal(b.mappings.some((m) => m.receiptId === 'hotel' || m.receiptId === 'hotel-2'), false);
  for (const id of ['hotel', 'hotel-2']) assert.deepEqual(lineOffers(b, id, isOpen).map((o) => [o.payment, o.index]), [[settlement.ref, 2]]);
  assert.deepEqual(lineOffers(b, 'linkly', isOpen), [], 'a linked bill is offered no line');
});

test('a bill still in the inbox (no AI filed it) is offered for its line, never linked by code', () => {
  const { books: b, isOpen } = books();
  b.receipts.find((r) => r.id === 'hotel')!.location = 'staged';
  linkCardLines(b, isOpen, documents());
  assert.equal(b.mappings.some((m) => m.receiptId === 'hotel'), false);
  assert.deepEqual(lineOffers(b, 'hotel', isOpen).map((o) => o.index), [2]);
});

test('a line in EUR: a EUR card\'s statement and its bill in EUR', () => {
  const statement = 'Alpencard AG\nKreditkartenabrechnung Mastercard EUR ****9012\nAbrechnung 01.08.2026 – 31.08.2026\nDatum Beschreibung Betrag EUR\n12.08.2026 HOTEL ADLON BERLIN 240.00\n14.08.2026 TAXI BERLIN 32.50\nTotal 272.50';
  const eur: BankTransaction = { ...settlement, ref: 'WISE-EUR-1', currency: 'EUR', amount: 272.5 };
  const b: Books = {
    receipts: [receipt('card-eur', { extractedText: statement, date: '2026-08-31' }), receipt('adlon', { extractedText: 'Hotel Adlon Kempinski Berlin\nRechnung 12.08.2026\nGesamt EUR 240.00', date: '2026-08-13', amount: 240, currency: 'EUR' })],
    mappings: [{ transactionRef: eur.ref, receiptId: 'card-eur' }],
    transactions: [eur],
  };
  linkCardLines(b, () => true, documents());
  assert.deepEqual(b.receipts[0].cardLines?.[0], { day: '2026-08-12', merchant: 'HOTEL ADLON BERLIN', amount: 240, currency: 'EUR' });
  assert.deepEqual(b.mappings.find((m) => m.receiptId === 'adlon'), { transactionRef: eur.ref, receiptId: 'adlon', by: 'rule', rule: 'card-line', line: 0 });
});

test('a bill a person took apart from the settlement is linked to no line again', () => {
  const { books: b, isOpen } = books();
  b.receipts.find((r) => r.id === 'hotel')!.notPaidBy = [settlement.ref];
  linkCardLines(b, isOpen, documents());
  assert.equal(b.mappings.some((m) => m.receiptId === 'hotel'), false);
  assert.deepEqual(lineOffers(b, 'hotel', isOpen), []);
});

test('a filed card statement keeps every byte: no lines read, no bill linked', () => {
  const { books: b, isOpen } = books([], '2026-09-30');
  const before = structuredClone(b);
  assert.deepEqual(linkCardLines(b, isOpen, documents()), { read: [], linked: [] });
  assert.deepEqual(b, before);
});

test('the inbox run reads the lines and links the bills by code; with a model the app\'s booking of the settlement that saw no bill goes, to be booked again by its lines; a person\'s stays, and without a model the app\'s too', async () => {
  const run = async (origin: 'classify' | 'manual', model: boolean) => {
    const { books: b } = books();
    const full = { ...b, bankStatements: [], config: { closedThrough: '2026-06-30' }, journalEntries: [{ id: 'e1', transactionRef: settlement.ref, date: settlement.date, accountDebit: '6640', accountCredit: '1020', amount: 313.19, vatCode: 'I0', origin, receipts: ['card'] }] } as unknown as StoreBooks;
    await matchStep({ ws: { paths: { inbox: '/nowhere' } } as Workspace, books: { read: () => full, update: <T>(fn: (x: StoreBooks) => T) => fn(full) }, progress: () => {}, log: () => {}, ...(model ? { ask: async () => '{}' } : {}) });
    return full;
  };
  const app = await run('classify', true);
  assert.deepEqual(app.receipts.find((r) => r.id === 'card')?.cardLines, LINES);
  assert.deepEqual(app.mappings.filter((m) => m.line !== undefined).map((m) => [m.receiptId, m.line]), [['linkly', 0], ['hotel', 2]]);
  assert.deepEqual(app.journalEntries, [], 'booked again by the booking step, by its lines');
  assert.equal((await run('manual', true)).journalEntries.length, 1, 'a person\'s booking is hers');
  const noModel = await run('classify', false);
  assert.equal(noModel.mappings.filter((m) => m.line !== undefined).length, 2, 'linked all the same');
  assert.equal(noModel.journalEntries.length, 1, 'never taken away for a booking nobody can make (r8f-41)');
});

test('by hand: a bill linked to a free line, refused on a taken or missing one; «Lösen» frees the line, its undo links it again, and code never links it back', () => {
  const { books: b, isOpen } = books();
  linkCardLines(b, isOpen, documents());
  const full = { ...b, journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Parameters<typeof link>[0];
  full.receipts.push(receipt('fee', { extractedText: 'Gebühr', date: '2026-08-07', amount: 2.57 }));
  assert.throws(() => link(full, 'fee', settlement.ref, 2), /Zeile 3 der Kartenabrechnung gehört schon ein Beleg/);
  assert.throws(() => link(full, 'fee', settlement.ref, 7), /keine Kartenabrechnung mit einer Zeile 8/);
  assert.deepEqual(link(full, 'fee', settlement.ref, 1), { kind: 'unlink', receipt: 'fee', payment: settlement.ref });
  assert.equal(full.mappings.find((m) => m.receiptId === 'fee')?.line, 1);

  const undo = unlink(full, 'hotel', settlement.ref);
  assert.deepEqual(undo, { kind: 'link', receipt: 'hotel', payment: settlement.ref, line: 2 }, 'the undo names the line');
  assert.equal(lineOfReceipt(full, 'hotel'), undefined);
  assert.deepEqual(linkCardLines(full, isOpen, documents()).linked, [], 'the person took it apart: code links it no more');
  link(full, 'hotel', settlement.ref, undo?.kind === 'link' ? undo.line : undefined);
  assert.equal(lineOfReceipt(full, 'hotel')?.index, 2);
});
