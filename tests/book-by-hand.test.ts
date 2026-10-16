/**
 * A payment booked by hand, without the AI (MISSION.md; persona test «treuhaender», findings 8 and
 * 9): the route books lines that add up to the payment as a person's entries on the payment's
 * date and refuses lines that do not, a later inbox run keeps them, and the task «Bewegung von
 * Hand buchen» is done only once the payment holds an entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, moduleActor, periodLock, saveBooks, update, PERSON, type Books } from '../src/books/store.js';
import { bookingDraft, inputTaxWithoutReceipt } from '../src/accounting/manual-booking.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { bookPayment } from '../src/server/edits.js';
import { classifyStep } from '../src/intake/classify.js';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { openEngine } from '../src/workflows/engine.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { startApi } from './support/api-server.js';
import { DEMO_ROOT, booksOnDisk } from './support/workspace.js';
import './support/jurisdiction.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'runs-'));
const entriesOf = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref);

test('a payment booked by hand in two lines that add up: the payment\'s date, the ESTV rate, origin manual, its receipt', async () => {
  const api = await startApi('tests/fixtures/classify-index.json');
  try {
    assert.equal((await api.send('DELETE', '/api/journal-entries/jw')).status, 200);
    const lines = [
      { accountDebit: '4400', accountCredit: '1023', amount: 51.02, vatCode: 'M81', description: 'Shop EU, Material' },
      { accountDebit: '1023', accountCredit: '4400', amount: 1.02, vatCode: '-M81', description: 'Shop EU, Skonto 2 %' },
    ];
    const { status, json } = await api.send('POST', '/api/transactions/W1/entries', { lines });
    assert.equal(status, 200, String(json.error));
    const booked = entriesOf(loadBooks(workspaceAt(api.ws.paths.root)), 'W1').sort((a, b) => b.amount - a.amount);
    assert.deepEqual(booked.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.date, e.origin, e.exchangeCurrency, e.receipts]), [
      ['4400', '1023', 51.02, 'M81', '2026-08-14', 'manual', 'EUR', ['rw']],
      ['1023', '4400', 1.02, '-M81', '2026-08-14', 'manual', 'EUR', ['rw']],
    ]);
    assert.ok(booked.every((e) => e.exchangeRate === loadFxResolver().daily('EUR', '2026-08-14')), 'the ESTV sell rate of the payment day');

    const again = await api.send('POST', '/api/transactions/W1/entries', { lines });
    assert.deepEqual([again.status, again.json.code], [409, 'hasEntries'], 'a booked payment is not booked twice');
  } finally {
    api.stop();
  }
});

test('lines that do not add up to the payment are refused and nothing is written', async () => {
  const api = await startApi('tests/fixtures/classify-index.json');
  try {
    assert.equal((await api.send('DELETE', '/api/journal-entries/jw')).status, 200);
    const before = JSON.stringify(booksOnDisk(api.ws));
    const { status, json } = await api.send('POST', '/api/transactions/W1/entries', { lines: [
      { accountDebit: '4400', accountCredit: '1023', amount: 40, vatCode: 'M81', description: 'Teil 1' },
      { accountDebit: '6570', accountCredit: '1023', amount: 5, description: 'Teil 2' },
    ] });
    assert.equal(status, 400);
    assert.deepEqual([json.code, json.params], ['paymentBalance', { date: '2026-08-14', currency: 'EUR', paid: 50, booked: 45 }]);
    assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'books byte-identical');

    const closed = await api.send('POST', '/api/transactions/C1/entries', { lines: [{ accountDebit: '6570', accountCredit: '1023', amount: 30, description: 'Mai' }] });
    assert.equal(closed.status, 403, 'a payment of a filed quarter is never booked');
  } finally {
    api.stop();
  }
});

/** A copy of the demo with one open payment of the classifier's unbooked, the payment and its linked receipts. */
function demoUnbooked(): { ws: Workspace; ref: string } {
  const dir = mkdtempSync(join(tmpdir(), 'book-by-hand-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  const ws = workspaceAt(dir);
  const books = loadBooks(ws);
  const lock = periodLock(books);
  const linked = new Set(books.mappings.map((m) => m.transactionRef));
  const tx = books.transactions.find((t) => !lock.isClosed(t.date) && t.direction === 'DBIT' && linked.has(t.ref) && entriesOf(books, t.ref).length === 1)!;
  update(books, PERSON, (b) => { b.journalEntries = b.journalEntries.filter((e) => e.transactionRef !== tx.ref); });
  saveBooks(ws, books);
  return { ws, ref: tx.ref };
}

function byHand(ws: Workspace, ref: string) {
  const books = loadBooks(ws);
  const draft = bookingDraft(books, ref, ws.bankAccounts)!;
  const lines = draft.lines.map((l) => ({ ...l, accountDebit: l.accountDebit || '6570', accountCredit: l.accountCredit || '6570', vatCode: undefined }));
  update(books, PERSON, (b) => { bookPayment(b, ref, lines, ws.bankAccounts, loadFxResolver()); });
  saveBooks(ws, books);
}

test('a later inbox run keeps the booking by hand, also after another receipt is linked', async () => {
  const { ws, ref } = demoUnbooked();
  try {
    byHand(ws, ref);
    const books = loadBooks(ws);
    const before = entriesOf(books, ref);
    assert.ok(before.length && before.every((e) => e.origin === 'manual' && e.receipts?.length), 'booked by hand with the receipts linked now');
    const other = books.receipts.find((r) => !books.mappings.some((m) => m.receiptId === r.id && m.transactionRef === ref))!;
    update(books, PERSON, (b) => { b.mappings.push({ transactionRef: ref, receiptId: other.id }); });
    saveBooks(ws, books);

    const ask: Ask = async (prompt) => JSON.stringify(Object.fromEntries([...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map(([, r]) => [r, { entries: [] }])));
    await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask, steps: [['classify', classifyStep()]] });
    await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask, steps: [['classify', classifyStep({ force: true })]] });
    assert.deepEqual(entriesOf(loadBooks(ws), ref), before);
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true });
  }
});

test('the task «Bewegung von Hand buchen»: «Gebucht» without an entry keeps it waiting; with one it is done', async () => {
  const { ws, ref } = demoUnbooked();
  try {
    const engine = openEngine(ws, { appRoot: APP_ROOT, ask: async () => undefined });
    const started = await engine.start('booking', { kind: 'transaction', id: ref }, { kind: 'manual' }, 'live');
    assert.ok(started.ok, JSON.stringify(started));
    const id = started.ok ? started.run! : '';
    await engine.idle();
    const at = () => { const s = engine.run(id)!.state; return s.status === 'waiting' ? `waiting:${s.at}` : s.status; };
    assert.equal(at(), 'waiting:manual');

    const disk = booksOnDisk(ws);
    assert.ok((await engine.command({ kind: 'answer', run: id, outcome: 'booked' })).ok);
    await engine.idle();
    assert.equal(at(), 'waiting:manual', 'nothing booked: the task stays');
    assert.deepEqual(booksOnDisk(ws), disk, 'and nothing was written');

    byHand(ws, ref);
    assert.ok((await engine.command({ kind: 'answer', run: id, outcome: 'booked' })).ok);
    await engine.idle();
    assert.equal(at(), 'done');
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true });
  }
});

test('the draft: the bank on its side, the payment\'s amount and date, the receipt\'s rate as its code, the vendor\'s account', () => {
  const books = {
    transactions: [
      { ref: 'T1', bank: 'Wise', date: '2026-08-14', amount: 50, currency: 'EUR', direction: 'DBIT' as const, description: 'Card Shop EU' },
      { ref: 'T0', bank: 'Wise', date: '2026-07-02', amount: 20, currency: 'EUR', direction: 'DBIT' as const, description: 'Card Shop EU' },
    ],
    receipts: [
      { id: 'r1', filename: 'a.pdf', originalFilename: 'a.pdf', extractedText: '', extractionMethod: 'pdftotext' as const, fileSize: 1, indexedAt: '', location: 'archived' as const, currency: 'EUR', vatId: 'CHE-123.456.789', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 3.75, gross: 50 }], description: 'Shop EU, Farbe' },
      { id: 'r0', filename: 'b.pdf', originalFilename: 'b.pdf', extractedText: '', extractionMethod: 'pdftotext' as const, fileSize: 1, indexedAt: '', location: 'archived' as const, vatId: 'CHE-123.456.789' },
    ],
    mappings: [{ transactionRef: 'T1', receiptId: 'r1' }, { transactionRef: 'T0', receiptId: 'r0' }],
    journalEntries: [{ id: 'j0', transactionRef: 'T0', date: '2026-07-02', accountDebit: '4400', accountCredit: '1023', amount: 20 }],
  };
  const accounts = [{ bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR' }];
  const draft = bookingDraft(books, 'T1', accounts)!;
  assert.deepEqual(draft.bank, { account: '1023', side: 'accountCredit' });
  assert.equal(draft.date, '2026-08-14');
  assert.deepEqual(draft.receipts, ['r1']);
  assert.deepEqual(draft.lines, [{ accountDebit: '4400', accountCredit: '1023', amount: 50, vat: 'M81', description: 'Shop EU, Farbe' }]);
  assert.equal(draft.precedent?.id, 'j0');

  const alone = bookingDraft({ ...books, journalEntries: [] }, 'T1', accounts)!;
  assert.deepEqual(alone.lines[0], { accountDebit: '', accountCredit: '1023', amount: 50, vat: '8.1', description: 'Shop EU, Farbe' }, 'no precedent: the rate waits for the account');
});

test('the hand form warns when a code would deduct input tax no receipt shows, and names the zero code (corner-8)', () => {
  assert.equal(inputTaxWithoutReceipt('I81'), 'I0');
  assert.equal(inputTaxWithoutReceipt('M81'), 'M0');
  assert.equal(inputTaxWithoutReceipt('M26-2'), 'M0');
  for (const code of ['I0', 'M0', 'V81', '-I81', 'B81-1', '', undefined, 'XYZ']) assert.equal(inputTaxWithoutReceipt(code), undefined, String(code));
});
