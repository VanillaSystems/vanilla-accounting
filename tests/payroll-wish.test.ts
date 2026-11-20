/**
 * The sidebar's payslip wish (src/payroll/wish.ts, src/assistant/changes.ts kind `payslip`, docs/specs/payroll.md
 * §22 decisions 130–134): code finds the person by the words she used and the month; the block takes no figure;
 * the state the model hears is counts only. Invented people only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesIn, ChangesError } from '../src/assistant/changes.js';
import { PayslipWishError, resolveWish, wishState } from '../src/payroll/wish.js';
import { closedThrough, ctxOf, dated, firm, owner } from './support/payroll.js';

const marco = owner({ id: 'e2', isOwner: false, name: [dated('2026-01-01', { first: 'Marco', last: 'Muster' })] });
const store = firm([owner(), marco]);
const block = (json: string) => `Ok.\n\n\`\`\`vanilla-changes\n${json}\n\`\`\``;

test('the block: person, month, close; nothing else', () => {
  assert.deepEqual(changesIn(block('[{"kind":"payslip","person":"Marco"}]')), [{ kind: 'payslip', person: 'Marco' }]);
  assert.deepEqual(changesIn(block('[{"kind":"payslip","month":"2026-11","close":true}]')), [{ kind: 'payslip', month: '2026-11', close: true }]);
  assert.throws(() => changesIn(block('[{"kind":"payslip","person":"Marco","amount":2000}]')), ChangesError);
  assert.throws(() => changesIn(block('[{"kind":"payslip","person":"Marco","month":"Oktober"}]')), ChangesError);
});

test('the person by id, first name, last name or both, without accents or case; the first month not closed', () => {
  const ctx = ctxOf(store, closedThrough(store, '2026-08', 'e2'));
  for (const said of ['marco', 'Marco Muster', 'MUSTER', 'e2', 'Márco']) {
    assert.deepEqual(resolveWish(ctx, { person: said }, '2026-11-19'), { month: '2026-08', employee: 'e2', close: false }, said);
  }
  assert.deepEqual(resolveWish(ctx, { person: 'Marco', month: '2026-10', close: true }, '2026-11-19'), { month: '2026-10', employee: 'e2', close: true });
});

test('nobody, several, no payslip that month: refused in her own words, never a name of payroll', () => {
  const ctx = ctxOf(firm([owner(), marco, owner({ id: 'e3', isOwner: false, name: [dated('2026-01-01', { first: 'Marco', last: 'Beispiel' })] })]));
  const why = (wish: object) => { try { resolveWish(ctx, wish, '2026-11-19'); return 'resolved'; } catch (e) { return e instanceof PayslipWishError ? [e.why, e.message] : String(e); } };
  assert.equal(why({ person: 'Nina' })[0], 'person');
  const [w, said] = why({ person: 'Marco' });
  assert.equal(w, 'ambiguous');
  assert.ok(!said.includes('Muster') && !said.includes('Beispiel'), 'no last name in the refusal');
  assert.equal(why({ person: 'Marco Muster', month: '2025-03' })[0], 'month');
  assert.throws(() => resolveWish(ctxOf(firm([])), {}, '2026-11-19'), (e) => e instanceof PayslipWishError && e.why === 'none');
});

test('the state the model hears: counts, never a figure', () => {
  const events = closedThrough(store, '2026-10', 'e2');
  const ctx = ctxOf(store, events);
  const closed = wishState(ctx, { month: '2026-09', employee: 'e2' });
  assert.equal(closed.kind === 'payslip' && closed.status, 'closed');
  const draft = wishState(ctx, { month: '2026-10', employee: 'e2' });
  assert.equal(draft.kind === 'payslip' && draft.status, 'draft');
  assert.deepEqual(Object.keys(draft).sort(), ['facts', 'incomplete', 'kind', 'status']);
  const month = wishState(ctx, { month: '2026-09' });
  assert.deepEqual(month, { kind: 'month', closed: 1, of: 2 });
});
