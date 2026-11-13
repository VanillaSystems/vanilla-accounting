/**
 * The small points of #398 (round 3 of the first-run score): a document beside an invoice shows no
 * amount of its own and is made a receipt with words for what it is; an amount a reader wrote into a
 * receipt's text reads in the app's one money format; the drop names both places that hold what
 * waits; an unregistered firm's invoice has no VAT line in its head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/jurisdiction.js';
import { markLabel, ownAmount } from '../src/app/areas/receipts/model.js';
import { moneyInText } from '../src/app/lib/utils.js';

test('an order confirmation (a document beside an invoice) has no amount of its own, and its action says what it does', () => {
  assert.equal(ownAmount({ kind: 'supporting', amount: 0 }), undefined, 'no «0.00»');
  assert.equal(ownAmount({ kind: 'invoice', amount: 0 }), 0, 'a receipt worth 0.00 keeps its amount');
  assert.equal(ownAmount({ kind: 'invoice', amount: 88.98 }), 88.98);
  assert.equal(markLabel({ kind: 'supporting' }), 'receipts.asOwnReceipt');
  assert.equal(markLabel({ kind: 'noise' }), 'receipts.isReceipt');
  const de = readFileSync('src/app/i18n/locales/de.ts', 'utf8');
  assert.match(de, /'receipts\.asOwnReceipt': 'Als eigenen Beleg führen'/);
  for (const f of ['src/app/areas/receipts/receipts.tsx', 'src/app/areas/receipts/Detail.tsx']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /\{r\.amount != null && (<>|\()/, `${f}: the amount shown goes through ownAmount`);
  }
});

test('an amount written into a receipt\'s text reads in the app\'s money format: «CHF 3\'200.00», never «CHF 3200.00»', () => {
  assert.match(moneyInText('Malerarbeiten Konstanz, CHF 3200.00'), /CHF 3.200\.00$/);
  assert.equal(moneyInText('EUR 412.30 inkl. 19 %'), 'EUR 412.30 inkl. 19 %', 'below a thousand as it was');
  assert.equal(moneyInText('Rechnung 2026-031'), 'Rechnung 2026-031', 'a number without a currency stays');
  assert.equal(moneyInText('Kontoauszug UBS 2026.09'), 'Kontoauszug UBS 2026.09', 'three capitals that are no currency stay (#398 review)');
  assert.equal(moneyInText('EWZ 2026.10.pdf'), 'EWZ 2026.10.pdf');
  assert.match(moneyInText('Lasur, EUR 1412.30'), /EUR 1.412\.30$/, 'a common currency');
});

test('Belege says a receipt\'s amount in its words as every other place does, and leaves a file name as it is (#398 review)', async () => {
  const { ledgerOf } = await import('../src/app/areas/receipts/model.js');
  const r = (id: string, extra: object) => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: 'x', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-09-01T00:00:00Z', location: 'archived', currency: 'EUR', date: '2026-09-01', amount: 1, ...extra });
  const books = { config: {}, transactions: [], journalEntries: [], mappings: [], bankStatements: [], receipts: [r('a', { description: 'Malerei, Rechnung 2026-031, EUR 3200.00' }), r('EWZ 2026.10', {})] } as never;
  const views = ledgerOf(books, '2026-07-01').views;
  assert.match(views[0].desc, /EUR 3.200\.00$/, 'the list and the detail read the same words as the open list');
  assert.equal(views[1].vendor, 'EWZ 2026.10', 'a file name is never rewritten');
});

test('the drop\'s closing line counts the tasks as the dock does, all of them, and the receipts of this drop that wait for her (#398 review)', async () => {
  const { waitsAfterDrop } = await import('../src/app/shell/drop-summary.js');
  const { dockWidget, tasksWaiting } = await import('../src/app/automation/widget.js');
  const view = { rev: '', workflows: [], problems: [], warnings: [], paused: false, limits: { ai: 1, other: 1 }, pending: [],
    tasks: [{ run: 't1' }, { run: 't2' }], runs: [{ id: 's', workflow: 'receipt-intake', status: 'stuck', mode: 'live', startedAt: '2026-10-21T05:00:00Z', item: { kind: 'company', id: 'inbox' }, path: [], startedBy: { kind: 'manual' } }] } as never;
  const states = [{ kind: 'waits' }, { kind: 'matched' }, { kind: 'twin', of: 'x', name: 'x', why: 'same' }, { kind: 'unread' }, { kind: 'read' }] as never[];
  const forMe = 2;
  const left = waitsAfterDrop(states, tasksWaiting(view, forMe));
  assert.equal(left.receipts, 3, 'the slip without a date, the possible copy, the photo not read');
  const figures = { period: { key: '2026-Q3', from: '2026-07-01', to: '2026-09-30' }, collected: 0, read: 0, withVat: 0, matched: 0, booked: 0, payments: 0, paymentsBooked: 0, authors: { app: 0, asked: 0, changed: 0, person: 0, unknown: 0 }, waitingReceipt: 0, filing: { kind: 'running', ends: '2026-09-30' } } as never;
  assert.equal(left.tasks, dockWidget(figures, view, forMe, new Date()).waiting, 'the dock\'s «Aufgaben»: open tasks, the stuck run and the questions for her');
  assert.equal(left.tasks, 5);
  const de = readFileSync('src/app/i18n/locales/de.ts', 'utf8');
  assert.match(de, /'drop\.waitsTasks': \{ one: '\{n\} offene Aufgabe insgesamt/, 'it says they are all the open tasks, not this drop\'s');
});

test('an invoice of a firm not in the VAT register has no VAT line in its head', () => {
  assert.match(readFileSync('src/app/areas/invoices/Detail.tsx', 'utf8'), /\{chargesVat\(\) \|\| t0\.vat \? <span data-testid="invoice-head-vat">/);
});
