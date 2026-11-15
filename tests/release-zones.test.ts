/**
 * The threat zones of a release (tools/release/zones.ts, tools/release/zones.json): a change selects
 * the VM scenarios and persona walks of the zones it touches, docs select none, app code of no zone
 * falls back to the install scenario; and the map names files, scenarios, personas and recipes that
 * exist, and gives every tracked file a place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { loadZones, matches, scope, versionOnly } from '../tools/release/zones.ts';
import { APP_ROOT } from '../src/workspace/workspace.js';

const map = loadZones();
const repoFiles = execFileSync('git', ['ls-files'], { cwd: APP_ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && existsSync(join(APP_ROOT, f)));
const verify = join(APP_ROOT, '.claude/skills/verify');
const walks = (dir: string) => readdirSync(join(verify, dir)).filter((f) => f.endsWith('.md') && f !== 'README.md');

test('0.6.1 (v0.6.0..release/0.6.1): the scenarios the owner chose by hand, and nothing else', () => {
  // The app files of that release (its docs, specs and tests left out: they select nothing).
  const changed = [
    'desktop/electron-builder.config.cjs', 'src/app/desktop/StartScreen.tsx', 'src/app/lib/api.ts', 'src/app/shell/Shell.tsx',
    'src/desktop/main.ts', 'src/desktop/open-files.ts', 'src/desktop/server.ts', 'src/version.ts', 'tools/desktop/build.mjs',
    'src/app/areas/changes/changes.tsx', 'src/app/handover/ShareDialog.tsx', 'src/handover/returns.ts', 'src/handover/versions.ts',
    'src/server/routes/share.ts', 'src/share/sharing.ts', 'src/share/transport.ts', 'src/app/i18n/locales/de.ts', 'src/types/api-error.ts',
    'docs/share-protocol.md', 'docs/specs/payroll.md', 'tests/share-link.test.ts', 'CHANGELOG.md',
  ];
  const s = scope(changed, map);
  assert.deepEqual([...s.vm.keys()].sort(), ['file-open', 'install', 'share-link', 'share-return', 'share-update', 'share-withdraw']);
  assert.deepEqual(s.unmapped, []);
  assert.ok(s.personas.has('treuhaender.md'));
  assert.ok(!s.personas.has('first-run.md'), 'a sharing release walks no first half hour');
});

test('docs, specs, tests and the dictionaries alone select no scenario and no walk', () => {
  const s = scope(['docs/specs/payroll.md', 'docs/releasing.md', 'README.md', 'tests/vat-golden.test.ts', 'src/app/i18n/locales/fr.ts'], map);
  assert.equal(s.vm.size, 0);
  assert.equal(s.personas.size, 0);
  assert.equal(s.zones.size, 0);
  assert.equal(s.quiet.length, 5);
});

test('app code of no zone falls back to install and first start; a file the map does not place selects everything', () => {
  const s = scope(['src/somewhere-new/thing.ts'], map);
  assert.deepEqual(s.fallback, ['src/somewhere-new/thing.ts']);
  assert.deepEqual([...s.vm.keys()], ['install']);
  const u = scope(['brand-new-folder/x.cfg'], map);
  assert.deepEqual(u.unmapped, ['brand-new-folder/x.cfg']);
  assert.equal(u.vm.size, Object.keys(map.scenarios).length);
});

test('a change of the figures walks the quarter close without a VM; filing adds the return on the VM', () => {
  const vat = scope(['modules/ch/tax-codes.yaml'], map);
  assert.equal(vat.vm.size, 0);
  assert.ok(vat.personas.has('quarter-close.md'));
  assert.deepEqual([...scope(['src/workflows/filing.ts'], map).vm.keys()], ['vat-return']);
});

test('a version bump of package.json is quiet; a dependency is the install scenario', () => {
  const a = JSON.stringify({ name: 'x', version: '0.6.0', dependencies: { y: '1' } });
  assert.ok(versionOnly(a, JSON.stringify({ name: 'x', version: '0.6.1', dependencies: { y: '1' } })));
  assert.ok(!versionOnly(a, JSON.stringify({ name: 'x', version: '0.6.1', dependencies: { y: '2' } })));
  const lock = (v: string) => JSON.stringify({ version: v, packages: { '': { version: v }, 'node_modules/y': { version: '1' } } });
  assert.ok(versionOnly(lock('0.6.0'), lock('0.6.1')));
  assert.equal(scope(['package.json'], map, new Map([['package.json', 'the version only']])).vm.size, 0);
  assert.deepEqual([...scope(['package.json'], map).vm.keys()], ['install']);
});

test('--all selects every scenario, every persona and every recipe', () => {
  const s = scope([], map, new Map(), true);
  assert.equal(s.vm.size, Object.keys(map.scenarios).length);
  assert.deepEqual([...s.personas.keys()].sort(), walks('personas').sort());
  assert.deepEqual([...s.features.keys()].sort(), walks('features').sort());
});

test('tools/release/zones.json: every glob matches a file; every scenario, persona and recipe exists and is used', () => {
  const globs = [...map.zones.flatMap((z) => z.paths), ...map.quiet.paths, ...map.fallback.paths];
  for (const g of globs) assert.ok(repoFiles.some((f) => f === g || matchesGlob(f, g)), `${g} matches no file`);
  const used = new Set([...map.zones.flatMap((z) => z.vm), ...map.fallback.vm]);
  assert.deepEqual([...used].filter((v) => !map.scenarios[v]), [], 'scenarios a zone names but zones.json does not describe');
  assert.deepEqual(Object.keys(map.scenarios).filter((v) => !used.has(v)), [], 'scenarios no zone selects');
  const personas = new Set([...map.zones.flatMap((z) => z.personas), ...map.onRequest.personas]);
  const features = new Set(map.zones.flatMap((z) => z.features));
  assert.deepEqual(walks('personas').filter((p) => !personas.has(p)), [], 'persona walks of no zone (add them to one, or to onRequest)');
  assert.deepEqual([...personas].filter((p) => !walks('personas').includes(p)), [], 'no such persona file');
  assert.deepEqual(walks('features').filter((p) => !features.has(p)), [], 'feature recipes of no zone');
  assert.deepEqual([...features].filter((p) => !walks('features').includes(p)), [], 'no such feature file');
  assert.equal(new Set(map.zones.map((z) => z.id)).size, map.zones.length, 'zone ids are unique');
});

test('every tracked file is in a zone, quiet, or app code the fallback takes', () => {
  const placed = (f: string) => map.zones.some((z) => matches(f, z.paths)) || matches(f, map.quiet.paths) || matches(f, map.fallback.paths);
  assert.deepEqual(repoFiles.filter((f) => !placed(f)), [], 'give these a place in tools/release/zones.json');
});
