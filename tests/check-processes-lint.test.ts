/**
 * The "counterparty knowledge still hardcoded" lint of npm run check-processes: only code
 * that names a counterparty counts, not a substring of another word or a comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { counterpartiesNamedIn } from '../src/knowledge/mentions.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

const { counterparties } = loadKnowledge(APP_ROOT, DEMO_ROOT);

test('only a counterparty named in code counts', () => {
  const source = [
    '// Shopify payouts land on account 1093.',
    'const groups = rows.filter((r) => r.grouped);',
    'const isCoopPronto = /coop\\s*pronto/i.test(desc);',
  ].join('\n');
  assert.deepEqual(counterpartiesNamedIn(source, 'example.ts', counterparties), ['coop-pronto']);
});
