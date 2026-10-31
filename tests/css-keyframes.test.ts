/**
 * Every @keyframes name under src/app is defined once. Keyframes are global: a second
 * definition anywhere wins over the first once its file loads, and animates whatever uses the
 * name (two `aispin`s once rotated the whole chat composer while it waited for the model).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []);

test('each @keyframes name is defined in one place only', () => {
  const seen = new Map<string, string[]>();
  for (const file of cssFiles('src/app')) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)/g)) {
        seen.set(m[1], [...(seen.get(m[1]) ?? []), `${file}:${i + 1}`]);
      }
    });
  }
  const twice = [...seen].filter(([, at]) => at.length > 1).map(([name, at]) => `@keyframes ${name}: ${at.join(', ')}`);
  assert.deepEqual(twice, [], `keyframes defined more than once (give one a name of its own):\n${twice.join('\n')}`);
});
