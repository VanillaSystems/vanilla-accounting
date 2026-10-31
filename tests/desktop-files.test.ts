/**
 * The Mac app packs only what desktop/electron-builder.config.cjs lists. Every folder of the app
 * that the code reads at run time through APP_ROOT must be in it, or the packed app fails where
 * `npm start` works (modules/ was missing once).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { sourceFiles } from '../tools/layers/map.js';

const { files } = createRequire(import.meta.url)('../desktop/electron-builder.config.cjs') as { files: string[] };
const NOT_AT_RUN_TIME = new Set(['src', 'node_modules', '.env', 'tests', 'tools']);

test('every app folder the code reads through APP_ROOT is packed into the Mac app', () => {
  const read = new Set<string>();
  for (const file of sourceFiles(APP_ROOT)) {
    if (file.startsWith('src/cli/') || file.startsWith('src/publish/')) continue;
    for (const m of readFileSync(join(APP_ROOT, file), 'utf8').matchAll(/join\((?:APP_ROOT|appRoot), '([^'/]+)/g)) {
      const dir = m[1];
      if (!NOT_AT_RUN_TIME.has(dir) && existsSync(join(APP_ROOT, dir)) && statSync(join(APP_ROOT, dir)).isDirectory()) read.add(dir);
    }
  }
  assert.ok(read.has('modules') && read.has('reference'), [...read].join(', '));
  assert.deepEqual([...read].filter((dir) => !files.some((f) => f.startsWith(`${dir}/`))), []);
});
