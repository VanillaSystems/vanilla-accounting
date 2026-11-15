/**
 * npm run test:changed selects the test files a change can break (tools/test/select.ts): through the
 * import graph, the paths the code names, and the rules of tools/test/inputs.json; the full suite when
 * the change is one the graph cannot place. And the rules themselves name files that exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import { buildGraph, isCode, isTest, loadRules, matches, reverse, select, testsReaching, type Rules } from '../tools/test/select.ts';
import { APP_ROOT } from '../src/workspace/workspace.js';

/** A small repository: a leaf module, its chain to a test, an unrelated test, a spawned entry, a mapped yaml. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-select-'));
  const files: Record<string, string> = {
    'src/a/leaf.ts': 'export const leaf = 1;\nexport type Leaf = number;\n',
    'src/a/mid.ts': "import { leaf } from './leaf.js';\nexport const mid = leaf + 1;\n",
    'src/other.ts': 'export const other = 2;\n',
    'src/accounting/figure.ts': 'export const figure = 3;\n',
    'src/server/main.ts': "import { mid } from '../a/mid.js';\nconsole.log(mid);\n",
    'src/core/load.ts': "import { join } from 'node:path';\nexport const dir = (APP_ROOT: string, id: string) => join(APP_ROOT, 'modules', id);\n",
    'modules/ch/tax-codes.yaml': 'codes: []\n',
    'docs/guide.md': '# Guide\n',
    'notes.cfg': 'x\n',
    'tests/leaf.test.ts': "import { mid } from '../src/a/mid.js';\nconsole.log(mid);\n",
    'tests/other.test.ts': "import { other } from '../src/other.js';\nconsole.log(other);\n",
    'tests/types-only.test.ts': "import type { Leaf } from '../src/a/leaf.js';\nconst x: Leaf = 1;\n",
    'tests/spawn.test.ts': "import { join } from 'node:path';\nconst REPO = process.cwd();\nexport const entry = join(REPO, 'src/server/main.ts');\n",
    'tests/modules.test.ts': "import { dir } from '../src/core/load.js';\nconsole.log(dir);\n",
    'tests/golden.test.ts': "import { figure } from '../src/accounting/figure.js';\nconsole.log(figure);\n",
    'tests/guard.test.ts': 'export {};\n',
    'package.json': '{}\n',
  };
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}

const rules: Rules = {
  full: [{ paths: ['package.json'], why: 'every test' }],
  guards: { tests: ['tests/guard.test.ts'], why: 'guard' },
  golden: { paths: ['src/accounting/**', 'modules/ch/tax-codes.yaml'], tests: ['tests/golden.test.ts'], why: 'golden master' },
  inputs: [{ paths: ['modules/**'], via: ['src/core/load.ts'], why: 'modules' }],
  noTest: { paths: ['docs/**'], why: 'no test reads it' },
  vm: { paths: ['src/server/**'], why: 'vm' },
};

const FILES = ['src/a/leaf.ts', 'src/a/mid.ts', 'src/other.ts', 'src/accounting/figure.ts', 'src/server/main.ts', 'src/core/load.ts',
  'modules/ch/tax-codes.yaml', 'docs/guide.md', 'notes.cfg', 'tests/leaf.test.ts', 'tests/other.test.ts', 'tests/types-only.test.ts',
  'tests/spawn.test.ts', 'tests/modules.test.ts', 'tests/golden.test.ts', 'tests/guard.test.ts', 'package.json'];

const picked = (changed: string[]) => {
  const root = fixture();
  try {
    return select(root, FILES, changed, rules);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('a leaf module selects the tests that reach it, through imports and a spawned entry, and no unrelated one', () => {
  const sel = picked(['src/a/leaf.ts']);
  assert.equal(sel.full, undefined);
  assert.deepEqual([...sel.tests.keys()].sort(), ['tests/guard.test.ts', 'tests/leaf.test.ts', 'tests/spawn.test.ts']);
  assert.match(sel.tests.get('tests/spawn.test.ts')!, /src\/server\/main\.ts/);
  assert.deepEqual(sel.golden, []);
  assert.deepEqual(sel.vm, []);
});

test('a type-only import is no edge: the erased type cannot change what a test does', () => {
  assert.ok(!picked(['src/a/leaf.ts']).tests.has('tests/types-only.test.ts'));
});

test('a change in src/accounting adds the golden master', () => {
  const sel = picked(['src/accounting/figure.ts']);
  assert.deepEqual(sel.golden, ['src/accounting/figure.ts']);
  assert.match(sel.tests.get('tests/golden.test.ts')!, /reaches|golden master/);
  assert.ok(!sel.tests.has('tests/leaf.test.ts'));
});

test('package.json runs the full suite and says why', () => {
  const sel = picked(['src/other.ts', 'package.json']);
  assert.match(sel.full ?? '', /^package\.json: every test/);
});

test('a mapped yaml selects the tests reaching its loader, and the golden master for a tax file', () => {
  const sel = picked(['modules/ch/tax-codes.yaml']);
  assert.equal(sel.full, undefined);
  assert.ok(sel.tests.has('tests/modules.test.ts'), [...sel.tests.keys()].join(', '));
  assert.ok(sel.tests.has('tests/golden.test.ts'));
  assert.ok(!sel.tests.has('tests/other.test.ts'));
});

test('a doc runs only the guards; a file nothing maps runs the full suite', () => {
  const doc = picked(['docs/guide.md']);
  assert.deepEqual([...doc.tests.keys()], ['tests/guard.test.ts']);
  assert.deepEqual(doc.untested, [{ file: 'docs/guide.md', why: 'no test reads it' }]);
  assert.match(picked(['notes.cfg']).full ?? '', /notes\.cfg: nothing maps this file/);
});

test('a changed test runs itself; a deleted file is named, not a fallback; the VM rule names its files', () => {
  const sel = picked(['tests/other.test.ts', 'src/gone.ts', 'src/server/main.ts']);
  assert.equal(sel.tests.get('tests/other.test.ts'), 'changed');
  assert.ok(sel.untested.some((u) => u.file === 'src/gone.ts'));
  assert.deepEqual(sel.vm, ['src/server/main.ts']);
});

// This repository.
const repoFiles = execFileSync('git', ['ls-files'], { cwd: APP_ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && existsSync(join(APP_ROOT, f)));
const real = loadRules();

test('this repository: the share fix of #543 selects tests/share-link.test.ts, and no golden master', () => {
  const sel = select(APP_ROOT, repoFiles, ['src/share/sharing.ts', 'tests/support/share-service.ts'], real);
  assert.equal(sel.full, undefined);
  assert.ok(sel.tests.has('tests/share-link.test.ts'), [...sel.tests.keys()].join(', '));
  assert.ok(!sel.tests.has('tests/vat-golden.test.ts'));
  assert.ok(sel.tests.size < repoFiles.filter(isTest).length / 2, `${sel.tests.size}`);
});

test('this repository: the tax codes select the golden master; package.json and the runner the full suite', () => {
  const tax = select(APP_ROOT, repoFiles, ['modules/ch/tax-codes.yaml'], real);
  for (const t of real.golden.tests) assert.ok(tax.tests.has(t), t);
  assert.match(select(APP_ROOT, repoFiles, ['package.json'], real).full ?? '', /^package\.json/);
  assert.match(select(APP_ROOT, repoFiles, ['tools/test/run.sh'], real).full ?? '', /^tools\/test\/run\.sh/);
});

test('tools/test/inputs.json: every glob matches a file, every target exists', () => {
  const tests = repoFiles.filter(isTest);
  const globs = [...real.full.flatMap((r) => r.paths), ...real.golden.paths, ...real.inputs.flatMap((r) => r.paths), ...real.noTest.paths, ...real.vm.paths];
  for (const g of globs) assert.ok(repoFiles.some((f) => f === g || matchesGlob(f, g)), `${g} matches no file`);
  for (const t of [...real.guards.tests, ...real.golden.tests, ...real.inputs.flatMap((r) => r.tests ?? [])]) assert.ok(tests.some((f) => f === t || matchesGlob(f, t)), `${t} is no test file`);
  for (const v of real.inputs.flatMap((r) => r.via ?? [])) assert.ok(repoFiles.includes(v), `${v} does not exist`);
});

test('every file of the repository that is no code reaches a test, is mapped, or is known to need none', () => {
  const rev = reverse(buildGraph(APP_ROOT, repoFiles));
  const mapped = (f: string) => matches(f, real.noTest.paths) || matches(f, real.golden.paths) || real.full.some((r) => matches(f, r.paths)) || real.inputs.some((r) => matches(f, r.paths));
  const lost = repoFiles.filter((f) => !isCode(f) && !isTest(f) && !mapped(f) && testsReaching(rev, f).size === 0);
  assert.deepEqual(lost, [], 'add these to tools/test/inputs.json');
});
