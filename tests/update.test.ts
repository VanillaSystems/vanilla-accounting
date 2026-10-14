/**
 * npm run update (src/cli/update.ts), end to end and offline: a clone of this checkout follows a
 * local bare repo as its origin, and opens a copy of the demo workspace in the layout of 0.3
 * (books.json at the root, before the schema), with the demo's golden master. `npm ci` is stubbed (it would download); npm run is real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import { BOOKS_SCHEMA } from '../src/workspace/schema.js';
import { DEMO_ROOT } from './support/workspace.js';
import { writeOldLayout } from './support/old-layout.js';

const tmp = mkdtempSync(join(tmpdir(), 'update-'));
// No automatic maintenance: a recent git repacks after a commit of this many files, in the background,
// and deletes the loose objects while the bare clone below copies them.
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8', stdio: 'pipe' });

// Upstream: this checkout's files as one commit, served by a bare repo.
const seed = join(tmp, 'seed');
for (const f of git(APP_ROOT, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)) {
  if (!existsSync(join(APP_ROOT, f))) continue;
  mkdirSync(dirname(join(seed, f)), { recursive: true });
  cpSync(join(APP_ROOT, f), join(seed, f));
}
git(seed, 'init', '-q', '-b', 'main');
git(seed, 'add', '-A');
git(seed, 'commit', '-qm', 'v0.2.0');
const origin = join(tmp, 'origin.git');
execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
git(seed, 'remote', 'add', 'origin', origin);

// The adopter's copy, with node_modules of its own that links each package of this checkout's.
const app = join(tmp, 'app');
execFileSync('git', ['clone', '-q', origin, app]);
mkdirSync(join(app, 'node_modules'));
for (const p of readdirSync(join(APP_ROOT, 'node_modules'))) symlinkSync(join(APP_ROOT, 'node_modules', p), join(app, 'node_modules', p));

// A workspace of 0.3, from before the schema: books.json at the root, no `schema` in it nor in the manifest.
const ws = join(tmp, 'ws');
writeOldLayout(DEMO_ROOT, ws, join(APP_ROOT, 'tests/golden/demo'));
const unversioned = readFileSync(join(ws, 'books.json'), 'utf8');
writeFileSync(join(ws, 'belege.workspace.yaml'), readFileSync(join(ws, 'belege.workspace.yaml'), 'utf8').replace(/^schema: 1\n/m, ''));
const app_ = (f: string) => `${APP_FOLDER}/${f}`;

// Tools doctor looks for, and an npm whose `ci` only logs.
const bin = join(tmp, 'bin');
const npmLog = join(tmp, 'npm-ci.log');
const realNpm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
mkdirSync(bin);
for (const [name, body] of Object.entries({
  claude: 'echo "2.0.0 (Claude Code)"',
  pdftotext: 'echo "pdftotext version 24"',
  convert: 'echo "Version: ImageMagick 7"',
  npm: `if [ "$1" = ci ]; then echo ci >> "${npmLog}"; exit 0; fi\nexec "${realNpm}" "$@"`,
})) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function update() {
  // Without NODE_TEST_CONTEXT: under it, the nested node --test of test:books would skip every file and pass.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/update.ts'], {
    cwd: app, encoding: 'utf8',
    env: { ...env, VANILLA_WORKSPACE: ws, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: '' },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

/** A new upstream commit: `edit` on the seed, then pushed. */
function release(message: string, edit: () => void) {
  edit();
  git(seed, 'commit', '-qam', message);
  git(seed, 'push', '-q', 'origin', 'main');
}
const ciCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, 'utf8').split('\n').filter(Boolean).length : 0);
const read = (f: string) => readFileSync(join(ws, f), 'utf8');

test('update pulls a release, prints its changelog, writes the workspace at the new schema with backups', () => {
  const pkg = join(seed, 'package.json');
  const current: string = JSON.parse(readFileSync(pkg, 'utf8')).version;
  const next = current.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  release(`v${next}`, () => {
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace(/"version": "[^"]+"/, `"version": "${next}"`));
    const log = join(seed, 'CHANGELOG.md');
    writeFileSync(log, readFileSync(log, 'utf8').replace(/^## \[/m, `## [${next}] - 2026-10-10\n\n### Fixed\n\n- A stand-in fix.\n\n## [`));
  });
  const r = update();
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(`version ${current} → ${next}`), r.out);
  assert.match(r.out, /A stand-in fix/);
  assert.match(r.out, new RegExp(`books\\.json: schema \\(none\\) → ${BOOKS_SCHEMA}, backup ${APP_FOLDER}/data/backups/books\\.json\\.schema-none; \\d+ files and folders moved into vanilla-accounting/`));
  assert.match(r.out, /vanilla-accounting\/belege\.workspace\.yaml: schema \(none\) → 1/);
  assert.match(r.out, /^(# |ℹ )pass [1-9]\d*$/m, 'the golden master ran its tests');
  assert.match(r.out, /✓ npm run test:books/);
  assert.match(r.out, /Up to date\./);
  assert.equal(ciCalls(), 0, 'the lockfile did not change');
  assert.equal(existsSync(join(ws, 'books.json')), false, 'the books moved into vanilla-accounting/');
  assert.equal(JSON.parse(read(app_('ledger.json'))).schema, BOOKS_SCHEMA);
  assert.match(read(app_('belege.workspace.yaml')), /^schema: 1\n/);
  assert.equal(read(app_('data/backups/books.json.schema-none')), unversioned);
});

test('a second run changes nothing', () => {
  const before = [read(app_('ledger.json')), read(app_('belege.workspace.yaml'))];
  const r = update();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /nothing new/);
  assert.match(r.out, /up to date/);
  assert.deepEqual([read(app_('ledger.json')), read(app_('belege.workspace.yaml'))], before);
});

test('a changed lockfile runs npm ci once', () => {
  release('lockfile', () => {
    const lock = join(seed, 'package-lock.json');
    writeFileSync(lock, readFileSync(lock, 'utf8') + '\n');
  });
  assert.equal(update().status, 0);
  assert.equal(ciCalls(), 1);
  assert.equal(update().status, 0);
  assert.equal(ciCalls(), 1, 'the rerun finds the install current');
});

test('a moved figure stops the update with what to do', () => {
  const golden = join(ws, app_('transactional-data/2026/expected'));
  const file = readdirSync(golden).find((f) => f.startsWith('figures-'))!;
  writeFileSync(join(golden, file), readFileSync(join(golden, file), 'utf8').replace(/\d+\.\d\d/, '0.01'));
  const r = update();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✗ npm run test:books[^\n]*figure differs[\s\S]*filed quarter's figure must never move/);
});

test('an uncommitted change in the app stops the update before the pull', () => {
  writeFileSync(join(app, 'src', 'local-change.ts'), '');
  const r = update();
  assert.equal(r.status, 1);
  assert.match(r.out, /✗ No uncommitted change in the app[\s\S]*src\/local-change\.ts[\s\S]*git stash/);
});
