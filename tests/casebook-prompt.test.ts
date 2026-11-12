/**
 * The casebook's examples come with the warning never to take their amounts (#362, first-ai-28: the
 * model split a social-insurance payment «nach dem Verhältnis des Beispielfalls»): no amount, share
 * or ratio from an example case; when nothing states how a payment divides, the reason says so and
 * the guide's rule for that kind of payment decides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadClassifyContext } from '../src/booking/classify.js';
import { buildBatchClassifyPrompt } from '../src/llm/prompts.js';
import { loadCases } from '../src/knowledge/cases.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

test('where the casebook is given, the model is told never to take an example\'s amounts, and what to do instead', () => {
  const context = loadClassifyContext(workspaceAt(DEMO_ROOT));
  const prompt = buildBatchClassifyPrompt([], context, loadCases().filter((c) => c.id === 'ahv-akonto'));
  const casebook = prompt.slice(prompt.indexOf('## Casebook'));
  assert.match(casebook, /never take an amount, a share or a ratio from an example case/);
  assert.match(casebook, /When nothing on the transaction, a linked document or the firm's books states how a payment divides, say so in "reason" and follow the guide's rule for that kind of payment/);
  assert.ok(casebook.indexOf('never take an amount') < casebook.indexOf('ahv-akonto') || !casebook.includes('ahv-akonto'), 'the warning stands before the cases');
});

test('without casebook examples, no warning about them', () => {
  const context = loadClassifyContext(workspaceAt(DEMO_ROOT));
  assert.doesNotMatch(buildBatchClassifyPrompt([], context, []), /from an example case/);
});
