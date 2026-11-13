/**
 * #428, «Was muss ich jetzt noch machen?»: the facts the AI is handed and the card under its answer
 * name what the person can act on, most important first as code ranks it, and nothing else. The
 * firm's own invoice that the customer has not paid yet is no work of hers; a bank account without
 * its opening balance, a clearing account below zero and a proposal of the setup that waits for
 * her answer are. The tests read the facts, never a model's wording.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';
import type { Task } from '../src/workflows/model.js';
import { openLines, openPeriodState, type PendingOffer } from '../src/app/areas/automation/open-period.js';
import { periodNote } from '../src/server/open-work.js';
import { setupShareOffers } from '../src/saving/share-rule.js';
import { seedCreated } from '../src/onboarding/store.js';
import { loadBooks, type Books } from '../src/books/store.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { testIban } from './support/iban.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction, vatSetup } from '../src/engines/index.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const UID = 'CHE-123.456.789';
const tx = (ref: string, bank: string, date: string, amount: number, extra: Partial<BankTransaction> = {}): BankTransaction => ({ ref, bank, date, amount, currency: 'CHF', direction: 'DBIT', description: ref, ...extra });
const receipt = (id: string, date: string, amount: number, text: string, extra: Partial<Receipt> = {}): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: text, extractionMethod: 'pdftotext', fileSize: 4000, indexedAt: '2026-09-30T08:00:00Z', location: 'archived', currency: 'CHF', date, amount, description: text.split('\n')[0], ...extra });
const entry = (id: string, date: string, debit: string, credit: string, amount: number): JournalEntry => ({ id, transactionRef: id, date, accountDebit: debit, accountCredit: credit, amount, origin: 'classify' });

/** A consultancy's Q3: its own invoice not paid yet, a hotel bill without its payment, a Wise EUR account without its opening, a provider's clearing account paid out beyond its sales. */
const books: Index = {
  config: { closedThrough: '2026-06-30' },
  transactions: [tx('RENT', 'ZKB', '2026-07-01', 520), tx('PAYOUT', 'ZKB', '2026-08-03', 300, { direction: 'CRDT' })],
  journalEntries: [entry('RENT', '2026-07-01', '6000', '1020', 520), entry('PAYOUT', '2026-08-03', '1020', '1093', 300)],
  receipts: [
    receipt('own', '2026-09-01', 7783.2, `Kälin Advisory GmbH\nRechnung RE-2026-036\n${UID} MWST\nTotal CHF 7783.20`, { vatId: UID }),
    receipt('hotel', '2026-08-19', 164, 'Hotel Pilatusblick, Rechnung 26-08-4471\nCHE-999.888.777 MWST\nTotal CHF 164.00'),
  ],
  mappings: [{ receiptId: 'none', transactionRef: 'RENT' }],
  bankStatements: [],
  statementBalances: [{ account: '1021', date: '2026-07-31', amount: 1710.44 }],
} as unknown as Index;
const accounts = [
  { bank: 'ZKB', currency: 'CHF', account: '1020', label: 'Zuger Kantonalbank CHF' },
  { bank: 'Wise', currency: 'EUR', account: '1021', label: 'Wise EUR' },
] as never;
const review = { run: 'r-1', workflow: 'vat-filing', step: 'review', item: { kind: 'period', id: '2026-Q3' }, title: { de: 'Abrechnung {period} prüfen' }, since: '2026-11-01T08:00:00Z', outcomes: ['approved'], reads: { period: '2026-Q3' } } as unknown as Task;
const ctx = { today: '2026-11-13', vatRegistered: true, length: 'quarter' as const, dueDays: 60, firm: { uid: UID, name: 'Kälin Advisory GmbH' } };
const provider = { held: [], bills: [], payouts: {}, clearing: [{ provider: 'shop', name: 'Shop', account: '1093' }] };
const offer: PendingOffer = { ref: 'A7', date: '2026-07-20', name: 'Alpentel AG', percent: 50, account: '6510' };

test('the firm\'s own invoice not paid yet is no work of hers; an opening, a clearing account below zero and a waiting proposal are, ranked before the receipts', () => {
  const s = openPeriodState(books, [], [review], accounts, ctx, new Map(), new Map(), provider, [offer]);
  assert.deepEqual(s.unlinked.map((r) => r.id), ['hotel'], 'only what a payment may still pay');
  assert.deepEqual(s.issued.map((r) => r.id), ['own'], 'its customer pays it: nothing for her to do');
  assert.deepEqual(s.openings.map((o) => [o.account, o.amount, o.currency]), [['1021', 1710.44, 'EUR']], 'the EUR account opened at nothing while its statement says it held money');
  assert.deepEqual(s.clearing, [{ name: 'Shop', account: '1093', balance: -300 }]);
  assert.deepEqual(s.offers, [offer]);
  assert.deepEqual(openPeriodState(books, [], [], accounts, ctx, new Map(), new Map(), provider, [{ ...offer, date: '2026-10-20' }]).offers, [], 'an offer on a payment of another period is not this period\'s');
  assert.deepEqual(openLines(s).map((l) => l.kind), ['offers', 'openings', 'clearing', 'unlinked', 'task'], 'most important first, the review last');
  // Without the firm's UID nothing is told apart: its invoice stays a receipt without a payment.
  assert.deepEqual(openPeriodState(books, [], [], accounts, { ...ctx, firm: undefined }).unlinked.map((r) => r.id), ['own', 'hotel']);
});

test('nothing open is never said while an opening is missing or a proposal waits', () => {
  const quiet = { ...books, receipts: [], journalEntries: books.journalEntries!.filter((e) => e.id !== 'PAYOUT'), transactions: books.transactions.filter((t) => t.ref !== 'PAYOUT') } as Index;
  const s = openPeriodState(quiet, [], [], accounts, ctx);
  assert.deepEqual(openLines(s).map((l) => l.kind), ['openings']);
});

test('the firm\'s own invoice stays work when that is not sure: a name alone, a payment that may be its own, the agreed basis without its event', () => {
  // A firm without a UID: a supplier's receipt addressed to it, its name the first line, is no proof of its own (issuedByFirm 'name').
  const coiffeur = { ...books, receipts: [receipt('supplier', '2026-08-02', 120, 'Coiffeur Muster\nRechnung 4471 der Haarpflege AG\nTotal CHF 120.00')] } as Index;
  const named = openPeriodState(coiffeur, [], [], accounts, { ...ctx, firm: { name: 'Coiffeur Muster' } });
  assert.deepEqual([named.unlinked.map((r) => r.id), named.issued], [['supplier'], []]);
  // Its customer paid it and the payment is booked without the link: offered for pairing, hers to confirm.
  const paid = { ...books, transactions: [...books.transactions, tx('KUNDE', 'ZKB', '2026-09-20', 7783.2, { direction: 'CRDT', counterparty: 'Brändli Logistik AG', description: 'Zahlung RE-2026-036' })],
    journalEntries: [...books.journalEntries!, entry('KUNDE', '2026-09-20', '1020', '3400', 7783.2)] } as Index;
  const s = openPeriodState(paid, [], [], accounts, ctx);
  assert.ok(s.unlinked.some((r) => r.id === 'own') && !s.issued.length, 'a payment may be its own: still a receipt without a payment');
  // The agreed basis: a dropped invoice with no booked issue is turnover the return lacks; with its event booked it waits for the customer.
  const was = vatSetup();
  setJurisdiction(ch, { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' });
  try {
    assert.deepEqual(openPeriodState(books, [], [], accounts, ctx).issued, [], 'no event: hers');
    const booked = { ...books, journalEntries: [...books.journalEntries!, { ...entry('RE-2026-036', '2026-09-01', '1100', '3400', 7200), vatCode: 'V81' }] } as Index;
    assert.deepEqual(openPeriodState(booked, [], [], accounts, ctx).issued.map((r) => r.id), ['own']);
  } finally { setJurisdiction(ch, was); }
});

const pay = (ref: string, date: string, amount: number): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty: 'Alpentel AG', counterpartyIban: testIban('04835012345678009'), description: 'Mobilfunk' });

/** The consultancy with the phone's share named in the setup, its first phone bill booked whole, and its own invoice and a hotel bill without a payment. */
function consultancy(): Workspace {
  const made = tempWorkspace('what-now-428-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: yes\n  imports: no\n  employees: owner\n  ownerPaysPrivately: yes\n  privateUse: [phone]\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  const phone = pay('A7', '2026-07-20', 84.35);
  const uid = ws.company.uid;
  writeIndex(ws, {
    transactions: [phone],
    journalEntries: [{ id: 'e-A7', transactionRef: 'A7', date: '2026-07-20', accountDebit: '6510', accountCredit: '1020', amount: 84.35, vatCode: 'I81', description: 'Alpentel, Mobilfunk', origin: 'classify', by: { kind: 'model', model: 'test' } }],
    receipts: [
      receipt('own', '2026-09-01', 7783.2, `${ws.company.name}, Ausgangsrechnung RE-2026-036\n${uid} MWST\nTotal CHF 7783.20`, { vatId: uid }),
      receipt('hotel', '2026-08-19', 164, 'Hotel Pilatusblick, Rechnung 26-08-4471\nCHE-999.888.777 MWST\nTotal CHF 164.00'),
    ],
    config: { closedThrough: '2026-06-30' },
  });
  seedCreated(ws, { started: '2026-11-13T08:00:00Z', shares: { phone: { percent: 50, said: 'öppe d Hälfti' } } }, '2026-11-13T08:00:00Z');
  return ws;
}

test('the AI is handed the setup\'s waiting proposal and not the firm\'s own invoice, in the card\'s order', () => {
  const ws = consultancy();
  const books = loadBooks(ws);
  assert.deepEqual(setupShareOffers(ws, books).map((o) => [o.ref, o.name, o.percent, o.account]), [['A7', 'Alpentel AG', 50, '6510']]);
  const note = periodNote(ws, books as Books, [], 'de', '2026-11-13');
  assert.match(note, /listed most important first as the app ranks it/);
  assert.match(note, /Proposals from the setup that wait for the person's answer \(1\)[^\n]*\n- Alpentel AG: 50 % private, the rest on 6510/);
  assert.match(note, /Receipts without a payment \(1\)[^\n]*\n- «Hotel Pilatusblick/);
  assert.doesNotMatch(note, /Ausgangsrechnung RE-2026-036/, 'its own invoice is never named as work');
  assert.match(note, /Invoices the firm issued, with its UID, that no payment in the books fits \(1\): they wait for the customer's payment, nothing for the person to do/);
  assert.ok(note.indexOf('Proposals from the setup') < note.indexOf('Receipts without a payment'), 'the proposal before the receipts, as on the card');
});
