/**
 * Who decided a booking (JournalEntry.by): a rule, a check of the app's code, the model, or a
 * person. The booking page says it from the data; an entry from before the field reads as it did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadBooks, type Books } from '../src/books/store.js';
import { parseBookedBy } from '../src/books/booked-by.js';
import { setEntry } from '../src/server/edits.js';
import { bookedByText, changesText, reasonText } from '../src/app/areas/journal/by.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { wordsIn } from '../src/export/texts.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { startApi } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const say = wordsIn('de').t;

const RULES = `process: booking
steps:
  classify:
    rules:
      - id: fuel
        when: { text: "Tankstelle" }
        then: { account: "6200", vat: I81 }
        source: wish 2026-10-15
`;

const tx = (t: Partial<BankTransaction> & Pick<BankTransaction, 'ref'>): BankTransaction =>
  ({ bank: 'Raiffeisen', date: '2026-08-14', amount: 50, currency: 'CHF', direction: 'DBIT', description: 'Bank text', ...t });

/** The model books a payment out on 6570, a payment in as a sale on 3400 at V0 «for want of a paper». */
const model: NonNullable<ClassifyDeps['ask']> = async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, {
    reason: 'so gelesen',
    entries: ref.startsWith('IN')
      ? [{ accountDebit: '', accountCredit: '3400', amount: 500, vatCode: 'V0', description: 'Kunde' }]
      : [{ accountDebit: '6570', accountCredit: '', amount: 50, vatCode: 'I0', description: 'Model' }],
  }])));
};

test('each booking names who decided it: the rule, the model, or the app\'s check that set a sale\'s code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'booked-by-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  mkdirSync(join(dir, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'rules', 'booking.guide.yaml'), RULES);
  const context = loadClassifyContext(workspaceAt(dir));
  const txs = [
    tx({ ref: 'FUEL', description: 'Tankstelle Wil Ost' }),
    tx({ ref: 'SHOP', description: 'Papeterie' }),
    tx({ ref: 'IN-1', description: 'Gutschrift Meier', direction: 'CRDT', amount: 500 }),
  ];
  const books = { transactions: txs, receipts: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books;
  await classifyTransactions(books, txs, { ask: model, fx: loadFxResolver(), context });
  const of = (ref: string) => books.journalEntries.find((e) => e.transactionRef === ref)!;

  assert.deepEqual(of('FUEL').by, { kind: 'rule', rule: 'fuel' });
  assert.deepEqual(of('SHOP').by, { kind: 'model', model: 'sonnet' });
  assert.deepEqual(of('IN-1').by, { kind: 'code', check: 'saleCode' });

  assert.equal(bookedByText(of('FUEL'), say), 'von der Regel «fuel» gebucht');
  assert.equal(bookedByText(of('SHOP'), say), 'von Claude gebucht (Modell sonnet)');
  assert.match(bookedByText(of('IN-1'), say), /^von der App gebucht/);
  assert.match(reasonText(of('FUEL'), of('FUEL').reason!, say), /^Regel: /, 'a rule\'s reason is never put in Claude\'s mouth');
  assert.match(reasonText(of('IN-1'), of('IN-1').reason!, say), /^Die App: «/);
  assert.equal(reasonText(of('SHOP'), of('SHOP').reason!, say), 'Claude: «so gelesen»');
});

test('an entry from before the field reads as its origin says', () => {
  const old: JournalEntry = { id: 'o', transactionRef: 'T', date: '2026-08-01', accountDebit: '6570', accountCredit: '1020', amount: 5, origin: 'classify', reason: 'alt' };
  assert.equal(bookedByText(old, say), 'vom Klassifizierer gebucht (Claude)');
  assert.equal(reasonText(old, 'alt', say), 'Claude: «alt»');
});

test('a person who changes the code decides the booking: the reason goes, «by» keeps what it was; a text change keeps the author', () => {
  const e: JournalEntry = { id: 'e', transactionRef: 'T', date: '2026-08-14', accountDebit: '1020', accountCredit: '3400', amount: 500, vatCode: 'V0', origin: 'classify', reason: 'gilt V0', by: { kind: 'model', model: 'sonnet' } };
  const books = { transactions: [], receipts: [], mappings: [], bankStatements: [], journalEntries: [e], config: { closedThrough: '2026-06-30' } } as unknown as Books;

  setEntry(books, 'e', { description: 'Kunde Meier' });
  assert.deepEqual([e.origin, e.reason, e.by], ['manual', 'gilt V0', { kind: 'model', model: 'sonnet' }], 'a text is no decision');

  const undo = setEntry(books, 'e', { vatCode: 'V81' });
  assert.equal(e.reason, undefined);
  assert.equal(e.by?.kind, 'person');
  assert.deepEqual(e.by?.kind === 'person' && e.by.was, { vatCode: 'V0' });
  assert.equal(changesText(e, { vatCode: 'V0' }, say), 'MWST V0 → V81');
  assert.match(bookedByText(e, say), /^von Hand geändert am \d\d\.\d\d\.\d{4}$/);

  assert.equal(undo.kind, 'entry');
  setEntry(books, 'e', (undo as Extract<typeof undo, { kind: 'entry' }>).set);
  assert.deepEqual([e.vatCode, e.reason, e.by], ['V0', 'gilt V0', { kind: 'model', model: 'sonnet' }], 'the undo puts back who decided and why');
});

test('«by» is parsed where the books are read: a shape of none of its kinds is left out, a known one kept as written', () => {
  assert.deepEqual(parseBookedBy({ kind: 'rule', rule: 'fuel' }), { kind: 'rule', rule: 'fuel' });
  assert.deepEqual(parseBookedBy({ kind: 'person', at: '2026-10-16T10:00:00Z', was: { vatCode: 'V0', note: 'x' } }), { kind: 'person', at: '2026-10-16T10:00:00Z', was: { vatCode: 'V0' } });
  for (const bad of [{ kind: 'rule' }, { kind: 'code', check: 'guess' }, { kind: 'person' }, 'model', { kind: 'robot' }]) assert.equal(parseBookedBy(bad), undefined, JSON.stringify(bad));

  const root = mkdtempSync(join(tmpdir(), 'booked-by-load-'));
  cpSync(DEMO_ROOT, root, { recursive: true });
  const books = loadBooks(workspaceAt(root));
  const open = books.journalEntries.find((e) => e.date > (books.config.closedThrough ?? ''))!;
  const file = join(root, 'transactional-data', open.date.slice(0, 4), 'books', 'entries.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n').map((l) => (l.includes(`"id":"${open.id}"`) ? l.replace(/}$/, ',"by":{"kind":"robot"}}') : l));
  writeFileSync(file, lines.join('\n'));
  const again = loadBooks(workspaceAt(root)).journalEntries.find((e) => e.id === open.id)!;
  assert.equal('by' in again, false);
});

const entryOf = (root: string) => loadBooks(workspaceAt(root)).journalEntries.find((e) => e.id === 'jw')!;

test('a change by hand through the API says who decided, and its undo puts the booking back as it was', async () => {
  const api = await startApi('tests/fixtures/classify-index.json');
  try {
    const before = entryOf(api.ws.paths.root);
    assert.equal((await api.send('PATCH', '/api/journal-entries/jw', { vatCode: 'I81' })).status, 200);
    const changed = entryOf(api.ws.paths.root);
    assert.deepEqual([changed.origin, changed.by?.kind, changed.by?.kind === 'person' && changed.by.was], ['manual', 'person', { vatCode: 'I0' }]);

    const back = await api.send('PATCH', '/api/journal-entries/jw', { vatCode: 'I0', origin: null, reason: null, by: null });
    assert.equal(back.status, 200, String(back.json.error));
    assert.deepEqual(entryOf(api.ws.paths.root), before);

    const bad = await api.send('PATCH', '/api/journal-entries/jw', { by: { kind: 'robot' } });
    assert.equal(bad.status, 400);
  } finally {
    await api.stop();
  }
});

test('the bank\'s fee row says it is the bank\'s fee in its «Erfasst» line, read from its reason; the stamp stays the purchase check (#398)', () => {
  const fee = { id: 'f', transactionRef: 'FEE', date: '2026-09-30', accountDebit: '6940', accountCredit: '1020', amount: 12, vatCode: '', by: { kind: 'code', check: 'purchaseVat' }, reason: say('bankFee.reason', { account: '6940', name: 'Bankspesen' }) } as JournalEntry;
  assert.equal(bookedByText(fee, say), 'von der App gebucht: die Gebühr der Bank laut Kontoauszug, ohne MWST');
  const refund = { ...fee, reason: say('bankFee.refundReason', { account: '6940', name: 'Bankspesen' }) } as JournalEntry;
  assert.match(bookedByText(refund, say), /Gebühr der Bank/);
  const purchase = { ...fee, reason: 'Beleg zeigt 8.1 % MWST' } as JournalEntry;
  assert.match(bookedByText(purchase, say), /die Vorsteuer folgt dem Beleg/, 'a purchase keeps its words');
  for (const lang of ['en', 'fr', 'it']) assert.doesNotMatch(bookedByText(fee, wordsIn(lang).t), /journal\.check/, `${lang}: the words exist`);
  // Entries stored with today's words keep their fee wording: a later edit of bankFee.reason fails here (#398 review).
  const stored = { ...fee, reason: 'Gebühr der Bank laut Kontoauszug: auf 6940 Bankspesen, ohne MWST. Leistungen einer Bank sind von der MWST ausgenommen, es gibt keine Vorsteuer.' } as JournalEntry;
  assert.match(bookedByText(stored, say), /Gebühr der Bank laut Kontoauszug, ohne MWST$/);
  const storedRefund = { ...fee, reason: 'Gebühr, die die Bank laut Kontoauszug zurückzahlt: von 6940 Bankspesen zurück, ohne MWST, wie die Gebühr.' } as JournalEntry;
  assert.match(bookedByText(storedRefund, say), /Gebühr der Bank laut Kontoauszug, ohne MWST$/);
});
