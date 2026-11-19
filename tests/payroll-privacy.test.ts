/**
 * No social security number reaches a model (docs/specs/payroll.md §11, §15.1 checkpoint 12, #508): every
 * prompt, system text, judged state and sidebar message is masked by the jurisdiction's pattern, and the
 * payslip a close files carries its facts, so no step reads it again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setJurisdiction } from '../src/engines/index.js';
import { maskForModel, maskState } from '../src/llm/mask.js';
import { assistantPrompt } from '../src/assistant/claude.js';
import { payslipReceipt } from '../src/payroll/close.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { ch } from './support/payroll.js';

const n = (...parts: string[]) => parts.join('');

test('every way of writing the number is masked; other long numbers stay', () => {
  setJurisdiction(ch);
  for (const written of [n('756.', '1234.5678.97'), n('756 ', '1234 5678 97'), n('756', '1234567897')]) {
    assert.equal(maskForModel(`AHV-Nr. ${written} Lohn`), 'AHV-Nr. 756.****.****.** Lohn', written);
  }
  const other = `IBAN ${n('CH93 0076', ' 2011 6238 5295 7')}, Rechnung 2026-001, EAN 7612345678906`;
  assert.equal(maskForModel(other), other);
  assert.deepEqual(maskState({ a: n('756.', '1234.5678.97'), b: [n('756', '1234567897')] }), { a: '756.****.****.**', b: ['756.****.****.**'] });
});

test('the sidebar\'s message is masked before it leaves', () => {
  setJurisdiction(ch);
  const out = assistantPrompt(`Meine AHV ist ${n('756.', '1234.5678.97')}`, [`Lohnabrechnung von ${n('756', '1234567897')}`]);
  assert.ok(!/756[.\s]?\d{4}/.test(out), out);
});

test('the model calls mask what they send: ask and judge', () => {
  const ask = readFileSync(join(APP_ROOT, 'src/llm/ask.ts'), 'utf8');
  assert.match(ask, /prompt: maskForModel\(prompt\)/);
  assert.match(ask, /system: maskForModel\(/);
  assert.match(readFileSync(join(APP_ROOT, 'src/llm/judge.ts'), 'utf8'), /state: maskState\(raw\.state\)/);
});

test('a closed payslip\'s receipt is typed and read: no VAT step, no model, and no number or salary in its text', () => {
  const r = payslipReceipt({ draft: { month: '2026-09', postingDate: '2026-09-30' } as never }, 'r1', '20260930-lohnabrechnung-2026-09-e1.pdf', 100, '2026-09-28T10:00:00Z');
  assert.equal(r.kind, 'payslip');
  assert.ok(r.vatExtractedAt);
  assert.equal(r.hasSwissVat, false);
  assert.ok(!/\d{3,}\.\d\d/.test(r.extractedText), 'no amount in its text');
});
