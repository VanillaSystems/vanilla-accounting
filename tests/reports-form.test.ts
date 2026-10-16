/**
 * The form of Eigene Berichte (src/reports/form.ts) makes the same spec the AI writes: a spec
 * edited in the form and sent back is the spec it was; lists are typed with commas; a source
 * takes only its own filters, groupings and columns, and the form drops the rest when the source
 * changes, so what it sends is a spec the server takes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, type ReportSpec } from '../src/reports/spec.js';
import { draftOf, newDraft, rawOf, withSource } from '../src/reports/form.js';

const parsed = (raw: unknown): ReportSpec => { const p = parseSpec(raw, '2026-10-16'); assert.ok(p.ok, JSON.stringify(p)); return p.value; };

const AI = parsed({
  title: 'Spesen und Zahlungen', period: '2026-Q3', comment: 'Zusammen {section1.total}.',
  sections: [
    { title: 'Spesen', source: 'entries', filter: { accounts: ['6000-6999', '4000'], vatCodes: ['I81'], text: 'Post', origins: ['manual'], receipt: 'without', currencies: ['EUR'] }, group: 'vatCode', columns: ['date', 'text', 'tax', 'amount'] },
    { source: 'payments', filter: { currencies: ['CHF'] }, group: 'month', columns: ['date', 'text', 'amount'] },
  ],
});

test('a spec opened in the form and sent back unchanged is the same spec', () => {
  assert.deepEqual(parsed(rawOf(draftOf(AI))), AI);
});

test('typed lists: commas between items, a range with spaces stays one range, codes and currencies by commas or spaces', () => {
  const d = newDraft('2026');
  d.title = 'Handmade';
  d.sections[0] = { ...d.sections[0], accounts: '6000 - 6999, 1020', vatCodes: 'I81 M81', currencies: 'eur, chf' };
  const s = parsed(rawOf(d));
  assert.deepEqual(s.sections[0].filter, { accounts: [{ from: '6000', to: '6999' }, { from: '1020', to: '1020' }], vatCodes: ['I81', 'M81'], currencies: ['EUR', 'CHF'] });
  assert.deepEqual(s.sections[0].columns, ['date', 'text', 'account', 'counterAccount', 'vatCode', 'amount'], 'a new section starts with its source\'s columns');
});

test('another source keeps what it takes and drops the rest, so the server takes what the form sends', () => {
  const entries = draftOf(AI).sections[0];
  const receipts = withSource(entries, 'receipts');
  assert.deepEqual([receipts.accounts, receipts.vatCodes, receipts.origins, receipts.receipt, receipts.group], ['', '', [], '', 'none']);
  assert.deepEqual(receipts.columns, ['date', 'text', 'tax', 'amount']);
  assert.equal(receipts.text, 'Post', 'a text filter every source takes stays');
  assert.ok(parseSpec(rawOf({ ...draftOf(AI), sections: [receipts] }), '2026-10-16').ok);
  assert.deepEqual(withSource({ ...entries, columns: ['vatCode'] }, 'invoices').columns, ['date', 'text', 'net', 'tax', 'amount', 'currency'], 'no column left: the source\'s own');
});

test('what the form cannot send is refused by the same parser: no title, a period the app does not know', () => {
  const d = newDraft('Q3');
  assert.deepEqual(parseSpec(rawOf(d), '2026-10-16'), { ok: false, refusal: { code: 'shape', params: { what: 'title' } } });
  d.title = 'X';
  assert.deepEqual(parseSpec(rawOf(d), '2026-10-16'), { ok: false, refusal: { code: 'period', params: { period: 'Q3' } } });
});
