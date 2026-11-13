/**
 * One word, one count (#385): what the dock says, what Automatisierung's page says, what Belege counts
 * and what the drop dialog says, each from the same books, agree. A receipt is in the period of its
 * payment once it has one, else of its date; unpaid and undated, or dated before the working period,
 * it is the working period's (placeDay). «gelesen»: its text was read (linked, or not waiting for its
 * reading); what it lacks (a date) or that it may be a copy is a state of its own. «gebucht» of a
 * receipt: its payment is booked. Invented figures.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';
import type { DropRow } from '../src/types/drop.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { homeFigures } from '../src/app/automation/home.js';
import { dockWidget } from '../src/app/automation/widget.js';
import { dockLine, heroLine, stageLines } from '../src/app/automation/words.js';
import { ledgerOf, visible } from '../src/app/areas/receipts/model.js';
import { dropSummary } from '../src/app/shell/drop-summary.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';

const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: `Beleg ${id}`, extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-11-12T08:00:00Z', location: 'archived', currency: 'CHF', ...x,
});
const tx = (ref: string, date: string, amount: number): BankTransaction =>
  ({ ref, bank: 'Bank', date, amount, currency: 'CHF', direction: amount < 0 ? 'DBIT' : 'CRDT', description: ref });
const entry = (id: string, ref: string, date: string, x: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, transactionRef: ref, date, accountDebit: '6500', accountCredit: '1020', amount: 10, ...x });

const TODAY = '2026-11-13';
const Q3 = parsePeriod('2026-Q3', TODAY)!;
const Q4 = parsePeriod('2026-Q4', TODAY)!;
const OPEN_FROM = '2026-07-01';
const COPY_TEXT = 'Malerbedarf Konstanz AG Rechnung RE-447123 vom 14.08.2026 Farbe weiss 10 l Total CHF 312.90 inkl. MWST';

const books: Index = {
  config: { closedThrough: '2026-06-30' },
  receipts: [
    receipt('till-1', { amount: 38.9 }),                                  // till slip, no date, linked to a booked payment of 08.07.
    receipt('invoice-q3', { date: '2026-07-30', amount: 2410.85 }),       // linked, booked
    receipt('invoice-june', { date: '2026-06-28', amount: 1243.55 }),     // in the filed quarter, no payment: Q2's
    receipt('invoice-sept', { date: '2026-09-29', amount: 412.3 }),       // no payment yet
    receipt('dated-q3-paid-q4', { date: '2026-09-15', amount: 89 }),      // paid in October: Q4's
    receipt('filed-paid', { date: '2026-08-20', amount: 55, filedPayment: 'T-filed' }), // paid in the filed quarter: Q2's, by its payment
    receipt('no-date', { amount: 64.5, extractionMethod: 'claude-vision' }), // a till slip a model read, the date missing, no payment: incomplete, the working period's
    receipt('copy-a', { date: '2026-08-14', amount: 312.9, extractedText: COPY_TEXT }),
    receipt('copy-b', { date: '2026-08-14', amount: 312.9, extractedText: COPY_TEXT, filename: 'copy-b-download.pdf' }), // the same document again
    receipt('photo', { extractedText: '', extractionMethod: undefined as never }), // not read: no text, no date, no amount
    receipt('terms', { kind: 'supporting', date: '2026-08-01' }),         // no receipt
  ],
  transactions: [
    tx('T-till-1', '2026-07-08', -38.9), tx('T-q3', '2026-08-06', -2410.85), tx('T-late', '2026-10-03', -89), tx('T-filed', '2026-06-20', -55),
    ...[1, 2, 3].map((m) => tx(`T-wage-${m}`, `2026-0${m + 6}-25`, -4800)),
  ],
  mappings: [
    { receiptId: 'till-1', transactionRef: 'T-till-1' }, { receiptId: 'invoice-q3', transactionRef: 'T-q3' },
    { receiptId: 'dated-q3-paid-q4', transactionRef: 'T-late' },
  ],
  journalEntries: [
    entry('1', 'T-till-1', '2026-07-08', { by: { kind: 'rule', rule: 'r' } }),
    entry('2', 'T-q3', '2026-08-06', { origin: 'manual', by: { kind: 'person', at: 'x' } }),
    entry('f', 'T-filed', '2026-06-20', { origin: 'manual', by: { kind: 'person', at: 'x' } }),
    ...[1, 2, 3].map((m) => entry(`w${m}`, `T-wage-${m}`, `2026-0${m + 6}-25`, { accountDebit: '5000', origin: 'manual', by: { kind: 'person', at: 'x' } })),
  ],
  bankStatements: [],
};

const figuresOf = (p: typeof Q3) => homeFigures(books, { key: p.token, from: p.from, to: p.to }, { today: TODAY, vatRegistered: true, dueDays: 60, openFrom: OPEN_FROM });
const ledger = ledgerOf(books, OPEN_FROM);
/** What the app says in German: t() of these keys. */
const t = (key: string, vars: Record<string, string | number> = {}) => formatIn({ code: 'de', ...de }, key as never, vars);

test('the dock, Automatisierung, Belege and the drop dialog say the same of one set of books (#385)', () => {
  const f = figuresOf(Q3);
  const dock = dockLine(t, dockWidget(f, undefined, 0, new Date(2026, 10, 13)));
  const page = { hero: heroLine(t, f), ...stageLines(t, f, true) };
  const belege = visible(ledger, Q3, undefined, undefined).counts;
  // The drop that brought the files of Q3 in, its possible copies as the dialog finds them.
  const q3 = new Set(visible(ledger, Q3, undefined, undefined).rows.map((v) => v.r.id).concat(['photo']));
  const rows = books.receipts.filter((r) => q3.has(r.id)).map((r): DropRow => ({ key: r.id, id: r.id, name: r.filename, size: 1, state: 'taken' }) as DropRow);
  const drop = dropSummary(rows, books, () => false, new Set(), (row) => books.receipts.find((r) => r.id === row.id), [], (id) => ledger.byId.get(id)?.twin?.relation === 'duplicate').receipts!;

  // Q3 holds: till-1 (by its payment), invoice-q3, invoice-sept, no-date (undated, the working period's), both copies, the photo.
  assert.equal(page.hero.split(',')[0], t('automation.home.hero.collected', { n: 7 }), 'the page: «7 Belege gesammelt»');
  assert.equal(belege.all, 7, 'Belege «7 alle»');
  assert.equal(drop.n, 7, 'the drop: the files that are receipts');
  assert.ok(ledger.byId.get('copy-b')?.twin?.relation === 'duplicate', 'the second download is a possible copy');

  // «gelesen»: all but the photo, the undated one and the possible copy among them.
  const read = t('dock.card.read', { n: 6 });
  assert.match(dock, new RegExp(`^6 ${read}`), `the dock: «6 ${read}»`);
  assert.equal(page.read, t('automation.home.s.unread', { n: 1 }), 'the page: only the photo is not read');
  assert.equal(t('drop.sum.receipts', { n: drop.read }), t('drop.sum.receipts', { n: 6 }), 'the drop: «6 Belege gelesen»');
  assert.equal(drop.read, drop.matched + drop.unmatched, 'the drop\'s parts add up to what it read');
  assert.ok(drop.incomplete >= 1 && drop.copies >= 1, 'what the read ones lack stays said apart');

  // «zugeordnet» and «gebucht».
  assert.equal(belege.linked, 2, 'Belege «2 zugeordnet»');
  assert.equal(drop.matched, belege.linked, 'the drop «einer Zahlung zugeordnet»');
  assert.equal(page.matched, t('automation.home.s.unmatched', { n: 7 - 2 }));
  assert.match(dock, new RegExp(`· ${f.booked} ${t('dock.card.booked', { n: f.booked })}`));
  assert.equal(f.booked, 2, '«gebucht»: the receipts whose payment is booked');
});

test('a receipt dated in Q3 and paid in October is October\'s in every place; those of the filed quarter stay there', () => {
  const q4 = visible(ledger, Q4, undefined, undefined);
  assert.deepEqual(q4.rows.map((v) => v.r.id), ['dated-q3-paid-q4']);
  assert.equal(figuresOf(Q4).collected, q4.counts.all);
  assert.ok(!visible(ledger, Q3, undefined, undefined).rows.some((v) => v.r.id === 'dated-q3-paid-q4'));
  const q2 = parsePeriod('2026-Q2', TODAY)!;
  assert.deepEqual(visible(ledger, q2, undefined, undefined).rows.map((v) => v.r.id).sort(), ['filed-paid', 'invoice-june'], 'by its date, and by its filed payment');
  assert.equal(figuresOf(q2).collected, 2);
});

test('what leads into Belege lands where Belege lists the receipt (#385 review): a task on an undated receipt is the working period\'s', async () => {
  const { openPeriodState } = await import('../src/app/areas/automation/open-period.js');
  const { placedReceiptDay } = await import('../src/app/automation/home.js');
  for (const r of books.receipts) if (!ledger.byId.get(r.id)!.none) assert.equal(placedReceiptDay(books, r, OPEN_FROM), ledger.byId.get(r.id)!.day, r.id);
  const task = { run: 't', item: { kind: 'receipt', id: 'no-date' } } as never;
  const s = openPeriodState(books, [], [task], [], { today: TODAY, vatRegistered: true, length: 'quarter', dueDays: 60 });
  assert.equal(s.period.from, OPEN_FROM);
  assert.equal(s.tasks.length, 1, 'read on 12.11. but listed in Q3: the task is Q3\'s');
});
