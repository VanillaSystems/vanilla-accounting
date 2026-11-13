/**
 * The desktop bundle holds the app's own code: an import of a file of the app that the bundler
 * leaves outside the bundle (an import that names only types in the inline form, for one) stops
 * `npm run desktop:build`. The suite says so before a build does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
// @ts-expect-error a build script without types
import { bundles } from '../tools/desktop/bundles.mjs';

test('the desktop bundle leaves no file of the app outside', async () => {
  const results = await Promise.all((bundles({ version: 'test' }) as object[]).map((options) => build({ ...options, write: false, logLevel: 'silent' })));
  const outside = results.flatMap((r) => Object.entries(r.metafile!.inputs).flatMap(([file, input]) => input.imports.filter((i) => i.external && i.path.startsWith('.')).map((i) => `${file} → ${i.path}`)));
  assert.deepEqual(outside, []);
});
