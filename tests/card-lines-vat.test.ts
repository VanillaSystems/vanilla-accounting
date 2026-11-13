/**
 * A card's settlement split by its statement's lines (#409): a line with its own bill linked takes
 * that bill's VAT (a rate only when the bill shows Swiss VAT, Bezugsteuer for a foreign service), the
 * lines without one the zero code, as before; with no bill linked to a line the settlement is booked
 * as before, the statement its one receipt.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactions, type ClassifyDeps } from '../src/booking/classify.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { removeReceipt } from '../src/accounting/classify-force.js';
import { bookByReceipt, link, unlink } from '../src/server/edits.js';
import { journalOf } from '../src/app/areas/journal/model.js';
import type { Index } from '../src/types/index.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, CardLine, Mapping, Receipt } from '../src/types/index.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';

const fx = loadFxResolver();
const bankAccounts: LedgerBankAccount[] = [{ bank: 'ZKB', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }];
const context = { companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '', bankAccounts };

const LINES: CardLine[] = [
  { day: '2026-08-07', merchant: 'LINKLY ADS DUBLIN IE', amount: 146.62, currency: 'CHF', original: { amount: 180, currency: 'USD' } },
  { day: '2026-08-07', merchant: 'Bearbeitungsgebühr Fremdwährung 1.75%', amount: 2.57, currency: 'CHF' },
  { day: '2026-08-19', merchant: 'HOTEL PILATUSBLICK LUZERN', amount: 164, currency: 'CHF' },
];
const tx: BankTransaction = { ref: 'P-30', bank: 'ZKB', date: '2026-09-10', amount: 313.19, currency: 'CHF', direction: 'DBIT', description: 'Kartenabrechnung August 2026 LSV', counterparty: 'Alpencard AG' };
const r = (id: string, x: Partial<Receipt>): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: `${id}: ein Beleg mit genug Text`, extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-09-12', location: 'archived', ...x });

function books(mappings: Mapping[], hotelVat = true): Books {
  return {
    transactions: [tx],
    receipts: [
      r('card', { date: '2026-08-31', amount: 313.19, currency: 'CHF', hasSwissVat: false, cardLines: LINES }),
      r('hotel', { date: '2026-08-19', amount: 164, currency: 'CHF', ...(hotelVat ? { hasSwissVat: true, vatSummary: [{ ratePercent: 3.8, vat: 5.78, gross: 158 }, { ratePercent: 0, vat: 0, gross: 6 }] } : { hasSwissVat: false }) }),
      r('linkly', { date: '2026-08-07', amount: 180, currency: 'USD', hasSwissVat: false }),
    ],
    mappings,
    bankStatements: [],
    journalEntries: [],
    config: { closedThrough: '2026-06-30' },
  } as unknown as Books;
}
const card: Mapping = { transactionRef: tx.ref, receiptId: 'card' };
const lined = (receiptId: string, line: number): Mapping => ({ transactionRef: tx.ref, receiptId, by: 'rule', rule: 'card-line', line });

/** The model answers each key the prompt asks with `answers[key]`; the keys it was asked come back too. */
async function run(b: Books, answers: Record<string, ClassifyEntry[]>) {
  const asked: string[] = [];
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    const keys = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    asked.push(...keys);
    return JSON.stringify(Object.fromEntries(keys.map((k) => [k, { entries: answers[k] }])));
  };
  const outcome = await classifyTransactions(b, b.transactions, { ask, fx, context });
  return { asked: asked.sort(), outcome, lines: b.journalEntries.map((e) => [e.accountDebit, e.amount, e.vatCode ?? '']) };
}
const line = (accountDebit: string, amount: number, e: Partial<ClassifyEntry>): ClassifyEntry => ({ accountDebit, accountCredit: '', amount, description: 'Karte', ...e });

test('a line with its bill takes the bill\'s VAT; a foreign service without Swiss VAT Bezugsteuer; the card fee no code', async () => {
  const { asked, outcome, lines } = await run(books([card, lined('linkly', 0), lined('hotel', 2)]), {
    'P-30#1': [line('6570', 146.62, { vat: 'acquisition' })],
    'P-30#3': [line('6640', 158, { vat: 'charged', vatRate: 3.8 }), line('6640', 6, { vat: 'none' })],
    'P-30': [line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(asked, ['P-30', 'P-30#1', 'P-30#3'], 'each line with a bill on its own, the rest together');
  assert.deepEqual(lines.sort(), [['6570', 146.62, 'B81-1'], ['6640', 158, 'I38'], ['6640', 6, 'I0'], ['6940', 2.57, '']].sort());
});

test('a line\'s bill without Swiss VAT: the line takes no rate, whatever the model says', async () => {
  const { lines } = await run(books([card, lined('hotel', 2)], false), {
    'P-30#3': [line('6640', 164, { vat: 'charged', vatRate: 3.8 })],
    'P-30': [line('6570', 146.62, { vat: 'acquisition' }), line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(lines.find((l) => l[0] === '6640'), ['6640', 164, 'I0']);
});

test('a line without its bill does not take the VAT of another line\'s bill', async () => {
  const { lines } = await run(books([card, lined('hotel', 2)]), {
    'P-30#3': [line('6640', 164, { vat: 'charged', vatRate: 3.8 })],
    'P-30': [line('6570', 146.62, { vat: 'charged', vatRate: 3.8 }), line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(lines.find((l) => l[0] === '6570'), ['6570', 146.62, 'I0']);
});

test('no bill linked to a line: the settlement goes to the model whole, its statement the one receipt, as before', async () => {
  const { asked, lines } = await run(books([card]), {
    'P-30': [line('6570', 146.62, { vat: 'acquisition' }), line('6940', 2.57, { vat: 'none' }), line('6640', 164, { vat: 'none' })],
  });
  assert.deepEqual(asked, ['P-30']);
  assert.equal(lines.length, 3);
});

test('a booking of the whole settlement is not told its bill of one line shows VAT; the booking of that line is', () => {
  const entry = (id: string, amount: number) => ({ id, transactionRef: tx.ref, date: tx.date, accountDebit: '6640', accountCredit: '1020', amount, vatCode: 'I0', origin: 'manual' as const });
  const whole = { ...books([card, lined('hotel', 2)]), journalEntries: [entry('w', 313.19)] } as unknown as Index;
  assert.equal(journalOf(whole).views[0].evidence, undefined);
  const split = { ...books([card, lined('hotel', 2)]), journalEntries: [entry('a', 146.62), entry('b', 2.57), entry('c', 164)] } as unknown as Index;
  assert.deepEqual(journalOf(split).views.map((v) => v.evidence?.kind), [undefined, undefined, 'receiptGroups']);
});

test('by hand: the form for the whole settlement proposes no rate from a bill of one line', () => {
  const draft = bookingDraft(books([card, lined('hotel', 2)]), tx.ref, bankAccounts)!;
  assert.ok(draft.lines.every((l) => !l.vat || !/38|3\.8/.test(l.vat)), `proposed ${draft.lines.map((l) => l.vat).join(', ')}`);
});

test('a credit line keeps its sign: the bank moves by what the settlement paid, never by the lines\' sum without signs', async () => {
  const lines: CardLine[] = [
    { day: '2026-08-19', merchant: 'HOTEL PILATUSBLICK LUZERN', amount: 164 },
    { day: '2026-08-21', merchant: 'GUTSCHRIFT HOTEL PILATUSBLICK', amount: -20 },
    { day: '2026-08-22', merchant: 'Bearbeitungsgebühr', amount: 2.57 },
  ];
  const b = books([card, lined('hotel', 0)]);
  b.transactions[0] = { ...tx, amount: 146.57 };
  b.receipts[0] = { ...b.receipts[0], amount: 146.57, cardLines: lines };
  const { outcome } = await run(b, {
    'P-30#1': [line('6640', 158, { vat: 'charged', vatRate: 3.8 }), line('6640', 6, { vat: 'none' })],
    'P-30#2': [{ accountDebit: '', accountCredit: '6640', amount: 20, description: 'Gutschrift', vat: 'none' }],
    'P-30': [line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(outcome.failed, []);
  const bank = b.journalEntries.reduce((s, e) => s + (e.accountCredit === '1020' ? e.amount : 0) - (e.accountDebit === '1020' ? e.amount : 0), 0);
  assert.equal(Math.round(bank * 100) / 100, 146.57);
});

test('a bill smaller than its line (a tip on the card): the rate only on what the bill taxes at it, the rest of the line the zero code', async () => {
  const lines: CardLine[] = [{ ...LINES[0] }, { ...LINES[1] }, { ...LINES[2], amount: 174 }];
  const b = books([card, lined('hotel', 2)]);
  b.transactions[0] = { ...tx, amount: 323.19 };
  b.receipts[0] = { ...b.receipts[0], amount: 323.19, cardLines: lines };
  const { lines: booked } = await run(b, {
    'P-30#3': [line('6640', 174, { vat: 'charged', vatRate: 3.8 })],
    'P-30': [line('6570', 146.62, { vat: 'acquisition' }), line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(booked.filter((l) => l[0] === '6640').sort(), [['6640', 158, 'I38'], ['6640', 16, 'I0']]);
});

test('a line\'s bill whose line has no statement any more is no bill of the whole settlement: the model\'s rate on the whole becomes the zero code', async () => {
  // The statement's link gone with the line link left behind (an older path), or a second receipt with lines on the same payment.
  const second = r('card-2', { date: '2026-08-31', amount: 313.19, currency: 'CHF', hasSwissVat: false, cardLines: LINES });
  const two = books([card, { transactionRef: tx.ref, receiptId: 'card-2' }, lined('hotel', 2)]);
  two.receipts.push(second);
  for (const [what, b] of [['statement gone', books([lined('hotel', 2)])], ['two statements', two]] as const) {
    const { lines } = await run(b, { 'P-30': [line('6640', 313.19, { vat: 'charged', vatRate: 3.8 })] });
    assert.deepEqual(lines, [['6640', 313.19, 'I0']], what);
  }
});

test('the statement leaves the payment («Lösen», deleted): its lines\' bills go with it, and the undo of «Lösen» puts them back', () => {
  const b = books([card, lined('hotel', 2), lined('linkly', 0)]);
  const undo = unlink(b, 'card', tx.ref);
  assert.deepEqual(b.mappings, [], 'no line bill stays without its statement');
  assert.equal(undo?.kind, 'link');
  link(b, 'card', tx.ref, undefined, undo?.kind === 'link' ? undo.bills : undefined);
  assert.deepEqual((b.mappings as Mapping[]).map((m) => `${m.receiptId}:${m.line ?? ''}`).sort(), ['card:', 'hotel:2', 'linkly:0']);
  const d = books([card, lined('hotel', 2)]);
  removeReceipt(d, 'card');
  assert.deepEqual(d.mappings, []);
});

// ─── #455: the evidence check by the card's lines ────────────────────────────────────────────────

/** The persona's books (consulting-ai r3-14): the hotel bill as its reader read it, the room at 3.8 % and the Kurtaxe «ohne MWST» only the rest of its total. */
function persona(): Books {
  const b = books([card, lined('linkly', 0), lined('hotel', 2)]);
  b.receipts = b.receipts.map((x) => (x.id === 'hotel' ? { ...x, vatSummary: [{ ratePercent: 3.8, vat: 5.78, gross: 158 }] } : x));
  return b;
}
const booked = (id: string, amount: number, vatCode: string | undefined, receipts: string[], over: Record<string, unknown> = {}) =>
  ({ id, transactionRef: tx.ref, date: tx.date, accountDebit: '6640', accountCredit: '1020', amount, ...(vatCode ? { vatCode } : {}), receipts, origin: 'classify', by: { kind: 'model', model: 'sonnet' }, ...over });
const findings = (b: Books) => journalOf(b as unknown as Index).views.map((v) => [v.e.amount, v.e.vatCode ?? '', v.evidence?.kind]);

test('#455: the hotel\'s line booked room I38 and Kurtaxe I0 by its bill: no task on the Kurtaxe', async () => {
  const b = persona();
  await run(b, {
    'P-30#1': [line('6570', 146.62, { vat: 'acquisition' })],
    'P-30#3': [line('6640', 158, { vat: 'charged', vatRate: 3.8 }), line('6640', 6, { vat: 'none' })],
    'P-30': [line('6940', 2.57, { vat: 'none' })],
  });
  assert.deepEqual(b.journalEntries.map((e) => [e.amount, e.vatCode ?? '']).sort(), [[146.62, 'B81-1'], [158, 'I38'], [2.57, ''], [6, 'I0']].sort());
  assert.deepEqual(findings(b).filter((f) => f[2]), [], 'no booking contradicts its receipts');
});

test('#455: a card line\'s bill counts only for its own line: another line at the zero code is not told the hotel bill shows 3.8 %', () => {
  const b = persona();
  b.journalEntries = [
    booked('linkly', 146.62, 'B81-1', ['linkly']), booked('fee', 2.57, 'I0', ['card']),
    booked('room', 158, 'I38', ['hotel']), booked('kurtaxe', 6, 'I0', ['hotel']),
  ] as unknown as Books['journalEntries'];
  assert.deepEqual(findings(b), [[146.62, 'B81-1', undefined], [2.57, 'I0', undefined], [158, 'I38', undefined], [6, 'I0', undefined]]);
  // Booked by hand, each line naming every receipt of the settlement: which line's bill is its evidence cannot be told, so nothing is said.
  const all = ['card', 'linkly', 'hotel'];
  const person = { origin: 'manual', by: { kind: 'person', at: '2026-11-13T11:00:00.000Z' } };
  b.journalEntries = [booked('linkly', 146.62, 'B81-1', all, person), booked('fee', 2.57, undefined, all, person), booked('room', 158, 'I38', all, person), booked('kurtaxe', 6, 'I0', all, person)] as unknown as Books['journalEntries'];
  assert.deepEqual(findings(b).filter((f) => f[2]), []);
});

test('#455: the hotel\'s line booked whole at I0 is still told, and «Nach Beleg buchen» puts no rate on the Kurtaxe', () => {
  const b = persona();
  b.receipts = b.receipts.map((x) => (x.id === 'hotel' ? { ...x, vatSummary: [{ ratePercent: 3.8, vat: 5.78, gross: 158 }, { ratePercent: 0, vat: 0, gross: 6 }] } : x));
  b.journalEntries = [booked('linkly', 146.62, 'B81-1', ['linkly']), booked('fee', 2.57, undefined, ['card']), booked('hotel', 164, 'I0', ['hotel'])] as unknown as Books['journalEntries'];
  const check = journalOf(b as unknown as Index).byId.get('hotel')!.evidence;
  assert.deepEqual(check, { kind: 'receiptGroups', rate: 3.8, amount: 158, currency: 'CHF', lines: [{ amount: 158, code: 'I38' }, { amount: 6, code: 'I0' }], entries: ['hotel'], receipts: ['hotel'] });
  bookByReceipt(b, 'hotel');
  assert.deepEqual(b.journalEntries.filter((e) => e.receipts?.includes('hotel')).map((e) => [e.amount, e.vatCode]).sort(), [[158, 'I38'], [6, 'I0']]);
});
