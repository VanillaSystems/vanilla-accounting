/** Firma › MWST › Nachdeklarationen: what a VAT adjustment entered by hand must be (src/accounting/vat-adjustments.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustmentId, parseAdjustment, type AdjustmentContext } from '../src/accounting/vat-adjustments.js';

const ctx: AdjustmentContext = {
  entries: [{ id: 'filed', date: '2026-05-10' }, { id: 'open', date: '2026-08-10' }],
  boxes: ['400', '405', '410', '415', '420'],
  length: 'quarter',
  isClosed: (d) => d <= '2026-06-30',
};
const line = { period: '2026-Q3', ziffer: '400', amount: -21.2, reason: ' Einfuhrsteuer zurückerstattet ', entryIds: ['filed'] };
const why = (raw: unknown) => { const p = parseAdjustment(raw, ctx); return p.ok ? 'ok' : `${p.refusal.params.why}${p.refusal.params.value ? `:${p.refusal.params.value}` : ''}`; };

test('a line of the open quarter on a filed entry is kept as typed, its reason trimmed and its amount in rappen', () => {
  assert.deepEqual(parseAdjustment({ ...line, amount: -21.204 }, ctx), { ok: true, draft: { ...line, amount: -21.2, reason: 'Einfuhrsteuer zurückerstattet' } });
});

test('each missing or wrong field is refused by name', () => {
  assert.equal(why({ ...line, period: '2026-07' }), 'period:2026-07', 'a month is no filing period of a quarterly firm');
  assert.equal(why({ ...line, ziffer: '302' }), 'ziffer:302', 'only an input-tax box takes a tax amount');
  assert.equal(why({ ...line, amount: 0 }), 'amount');
  assert.equal(why({ ...line, amount: '5' }), 'amount');
  assert.equal(why({ ...line, reason: '  ' }), 'reason');
  assert.equal(why({ ...line, entryIds: [] }), 'noEntry');
  assert.equal(why({ ...line, entryIds: ['gone'] }), 'entryMissing:gone');
});

test('the entry must be filed and before the line: an open entry is in the return already', () => {
  assert.equal(why({ ...line, entryIds: ['filed', 'open'] }), 'entryNotFiled:open');
  assert.equal(why({ ...line, period: '2026-Q2' }), 'entryNotFiled:filed', 'a Q2 line would be declared beside its own Q2 entry');
});

test('a new id is the period\'s next free one; an asked id (the undo of a removal) only when free', () => {
  const taken = [{ id: '2026-Q3-1', ...line }];
  assert.deepEqual(adjustmentId(undefined, '2026-Q3', taken), { ok: true, id: '2026-Q3-2' });
  assert.deepEqual(adjustmentId('fedex-refund', '2026-Q3', taken), { ok: true, id: 'fedex-refund' });
  assert.equal(adjustmentId('2026-Q3-1', '2026-Q3', taken).ok, false);
  assert.equal(adjustmentId('a b', '2026-Q3', taken).ok, false);
});
