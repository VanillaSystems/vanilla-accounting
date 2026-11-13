/**
 * #450 (owner 2026-11-13): a receipt whose VAT read keeps failing. The VAT step counts each failed
 * read on the receipt (`vatReadFailures`); after the third the receipt is «Beleg nicht lesbar»
 * (isUnreadable), its payment reaches the task with its ways out, the step stops trying it, and
 * the run note names the limit. A read that succeeds, or her typed VAT, starts the count afresh.
 * A receipt of a filed period is not touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vatStep } from '../src/intake/vat.js';
import { classifyStep } from '../src/intake/classify.js';
import { noteLines, type BooksPort, type IntakeNote } from '../src/intake/pipeline.js';
import { isUnreadable, VAT_READ_TRIES, waitingForReceipt } from '../src/accounting/receipt-due.js';
import { setVatFacts } from '../src/accounting/vat-facts.js';
import de from '../src/app/i18n/locales/de.js';
import fr from '../src/app/i18n/locales/fr.js';
import it from '../src/app/i18n/locales/it.js';
import en from '../src/app/i18n/locales/en.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const tx: BankTransaction = { ref: 'P1', bank: 'Raiffeisen', date: '2026-10-17', amount: 80, currency: 'CHF', direction: 'DBIT', description: 'Tankstelle Berg Dorf' } as BankTransaction;
const RECEIPT = (over: Partial<Receipt> = {}): Receipt => ({ id: 'r1', filename: '20261017-tankstelle.pdf', location: 'archived', kind: 'invoice', date: '2026-10-17', amount: 80, currency: 'CHF',
  extractedText: 'Tankstelle Berg Dorf\nRechnung 4711\nBenzin Oktober 2026\nTotal CHF 80.00\nzahlbar innert 30 Tagen', extractionMethod: 'pdftotext', ...over } as Receipt);

function booksWith(r: Receipt, closedThrough = '2026-09-30'): Books {
  return { transactions: [tx], receipts: [r], mappings: [{ transactionRef: tx.ref, receiptId: r.id }], bankStatements: [], journalEntries: [], config: { closedThrough } } as unknown as Books;
}
const port = (b: Books): BooksPort => ({ read: () => structuredClone(b), update: (fn) => fn(b) });
const NO_VAT = JSON.stringify({ vatId: '', hasSwissVat: false, vatSummary: [] });

/** One run of the VAT step with a model that answers `answer`; how often it was asked, and the step's notes. */
async function readVat(b: Books, answer: () => Promise<string>) {
  let asked = 0;
  const { notes } = await vatStep()({ ws: undefined as never, books: port(b), ask: (async () => { asked++; return answer(); }) as never, progress: () => {}, log: () => {} });
  return { asked, notes };
}
const broken = async () => 'kaputt';
const givenUp = (notes: IntakeNote[]) => notes.filter((n): n is Extract<IntakeNote, { code: 'vatGivenUp' }> => n.code === 'vatGivenUp');

test('three failed reads in three runs: the receipt is «Beleg nicht lesbar», its payment\'s task appears, the run note names the limit, the fourth run asks no model', async () => {
  assert.equal(VAT_READ_TRIES, 3);
  const b = booksWith(RECEIPT());
  for (const n of [1, 2]) {
    const { notes } = await readVat(b, broken);
    assert.equal(b.receipts[0].vatReadFailures, n);
    assert.equal(isUnreadable(b.receipts[0]), false, `after ${n} failed read(s) it is still only not read yet`);
    assert.deepEqual(givenUp(notes), []);
  }
  const third = await readVat(b, broken);
  assert.equal(b.receipts[0].vatReadFailures, 3);
  assert.equal(isUnreadable(b.receipts[0]), true, 'counts as unreadable now');
  assert.deepEqual(givenUp(third.notes), [{ code: 'vatGivenUp', files: ['20261017-tankstelle.pdf'], tries: 3 }]);
  assert.match(noteLines(third.notes).join('\n'), /after 3 tries/);

  const fourth = await readVat(b, broken);
  assert.equal(fourth.asked, 0, 'the step stops trying it');
  assert.equal(b.receipts[0].vatReadFailures, 3);

  // The classify step: the payment waits for the person under «Beleg nicht lesbar», no model guesses.
  const dir = mkdtempSync(join(tmpdir(), 'vat-limit-450-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  let classifyAsked = 0;
  const { notes } = await classifyStep()({ ws: workspaceAt(dir), books: port(b), ask: (async () => { classifyAsked++; return '{}'; }) as never, progress: () => {}, log: () => {} });
  assert.equal(classifyAsked, 0);
  assert.equal(b.journalEntries.length, 0);
  assert.equal(b.transactions[0].waitsForReceipt?.unread, true);
  assert.ok(notes.some((n) => n.code === 'receiptUnread'), JSON.stringify(notes));
  assert.deepEqual(waitingForReceipt(b, () => false, '2026-10-18').map((w) => [w.tx.ref, w.kind]), [['P1', 'unread']]);
});

test('a read that succeeds after two failures starts the count afresh', async () => {
  const b = booksWith(RECEIPT());
  await readVat(b, broken);
  await readVat(b, broken);
  assert.equal(b.receipts[0].vatReadFailures, 2);
  await readVat(b, async () => NO_VAT);
  assert.equal(b.receipts[0].hasSwissVat, false);
  assert.equal('vatReadFailures' in b.receipts[0], false, 'no count left behind');
});

test('her typed VAT starts the count afresh', () => {
  const r = RECEIPT({ vatReadFailures: 3 });
  assert.equal(isUnreadable(r), true);
  setVatFacts(r, { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: 80, vat: 6 }] }, 'human');
  assert.equal('vatReadFailures' in r, false);
  assert.equal(isUnreadable(r), false);
});

test('a receipt of a filed period is not touched: no count, even when its read is forced', async () => {
  const b = booksWith(RECEIPT(), '2026-12-31');
  const { asked } = await readVat(b, broken);
  assert.equal(asked, 0, 'not a candidate');
  await vatStep({ force: true })({ ws: undefined as never, books: port(b), ask: broken as never, progress: () => {}, log: () => {} });
  assert.equal('vatReadFailures' in b.receipts[0], false);
});

test('the limit is told in four languages, on the run note and on the receipt', () => {
  for (const dict of [de, fr, it, en]) {
    for (const key of ['automation.note.vatGivenUp', 'receipts.vatGivenUp', 'receipts.vatGivenUpTip']) assert.ok((dict.messages as Record<string, unknown>)[key], `${dict.name}: ${key}`);
  }
  assert.match(JSON.stringify((de.messages as Record<string, unknown>)['automation.note.vatGivenUp']), /nach \{tries\} Versuchen nicht lesbar/);
});
