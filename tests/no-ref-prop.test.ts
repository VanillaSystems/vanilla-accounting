/**
 * React keeps `ref` for itself: a component that takes a prop named `ref` gets nothing, and a
 * string passed as `ref` throws on render («Function components cannot have string refs»), a white
 * page on every reload (r10k-1). No component of the app declares one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
});

test('no component takes a prop named ref', () => {
  const found = files('src/app').flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/function ([A-Z]\w*)\(\{([^}]*)\}/g)]
    .filter((m) => /(^|[\s,])ref([\s,:=]|$)/.test(m[2]))
    .map((m) => `${file}: ${m[1]}`));
  assert.deepEqual(found, []);
});
