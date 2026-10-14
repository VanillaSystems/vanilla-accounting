/**
 * Imports point one way (docs/0.4.0/layers.md): views → split → engines/providers → core.
 * tools/layers/allowed.txt lists the wrong-way imports that existed when the lint arrived; it may
 * only shrink. A new wrong-way import fails, and so does a listed one that no longer exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { layerOf, sourceFiles, violations } from '../tools/layers/map.js';
import { inventory } from '../tools/layers/inventory.js';

const allowed = readFileSync(join(APP_ROOT, 'tools/layers/allowed.txt'), 'utf8').split('\n').filter(Boolean);
const actual = violations(APP_ROOT);

test('every file of src/ has a layer', () => {
  for (const file of sourceFiles(APP_ROOT)) layerOf(file);
});

test('no new import points the wrong way', () => {
  assert.deepEqual(actual.filter((v) => !allowed.includes(v)), [], 'fix the import, or move the file to the layer it belongs to');
});

test('the allow-list only shrinks: a fixed import leaves it', () => {
  assert.deepEqual(allowed.filter((v) => !actual.includes(v)), [], 'remove these lines from tools/layers/allowed.txt');
});

test('the lint sees a wrong-way import', () => {
  assert.ok(allowed.includes('src/workspace/workspace.ts -> src/engines/index.ts'));
});

test('docs/0.4.0/inventory.md is what npm run inventory writes', () => {
  assert.equal(readFileSync(join(APP_ROOT, 'docs/0.4.0/inventory.md'), 'utf8'), inventory(APP_ROOT), 'run npm run inventory');
});
