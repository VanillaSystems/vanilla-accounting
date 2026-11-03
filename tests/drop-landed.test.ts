/**
 * Where a drop's files landed (src/app/shell/drop-upload.ts `landedPeriod`, F10): the page behind the
 * drop window moves to the period of the newest file it took, unless the period on screen holds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landedPeriod } from '../src/app/shell/drop-upload.js';
import { parsePeriod } from '../src/accounting/periods.js';
import type { DropRow } from '../src/types/drop.js';

const TODAY = '2026-11-02';
const q = (token: string) => parsePeriod(token, TODAY)!;
const row = (key: string, extra: Partial<DropRow>): DropRow => ({ key, id: key, name: `${key}.pdf`, size: 1, state: 'taken', ...extra });
const statement = row('s', { kind: 'camt', facts: { from: '2026-10-01', to: '2026-10-31' }, statement: { file: 's.xml', refs: ['a'] } });
const dates: Record<string, string> = { r1: '2026-06-12', r2: '2026-10-21' };
const dateOf = (r: DropRow) => (r.statement ? r.facts?.to : dates[r.id]);

test('an October statement dropped while Q2 is shown moves the page to Q4', () => {
  assert.equal(landedPeriod([row('r1', {}), statement], dateOf, q('2026-Q2'), TODAY, 'quarter')?.token, '2026-Q4');
});

test('the period on screen holds the newest file: the page stays', () => {
  assert.equal(landedPeriod([statement], dateOf, q('2026-Q4'), TODAY, 'quarter'), undefined);
  assert.equal(landedPeriod([statement], dateOf, q('2026'), TODAY, 'quarter'), undefined);
});

test('a receipt counts once it has its date; a file not taken does not count', () => {
  assert.equal(landedPeriod([row('r9', {})], dateOf, q('2026-Q2'), TODAY, 'quarter'), undefined, 'not read yet');
  assert.equal(landedPeriod([row('r1', {}), row('r2', { state: 'duplicate' })], dateOf, q('2026-Q4'), TODAY, 'quarter')?.token, '2026-Q2');
  assert.equal(landedPeriod([row('r2', {})], dateOf, q('2026-Q2'), TODAY, 'half')?.token, '2026-H2');
});
