/**
 * The desktop app's password store (src/secrets/sealed-store.ts): sealed by the system per books,
 * never in plain text on disk; on Electron's safeStorage the same round trip. The Electron test runs
 * with Chromium's mock keychain, so it never asks for or writes to the person's keychain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { sealedStore, type Cipher } from '../src/secrets/sealed-store.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
const cipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => xor(Buffer.from(s, 'utf8')),
  decryptString: (b) => xor(b).toString('utf8'),
};

test('a password saved for one books comes back sealed from the file, not for other books, and is removed by null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sealed-'));
  const file = join(dir, 'user-data', 'secrets.json');
  const [a, b] = [join(dir, 'a'), join(dir, 'b')];
  mkdirSync(a);
  mkdirSync(b);
  let open = a;
  const store = sealedStore({ file, cipher, books: () => open });
  await store.set('smtp', 'geheim-123');
  assert.equal(await sealedStore({ file, cipher, books: () => open }).get('smtp'), 'geheim-123', 'a new start reads it back');
  assert.ok(!readFileSync(file, 'utf8').includes('geheim'), 'never in plain text');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  open = b;
  assert.equal(await store.get('smtp'), undefined, 'other books have their own');
  open = a;
  await store.set('smtp', null);
  assert.equal(await store.get('smtp'), undefined);
});

test('an AI provider\'s key belongs to this computer: the same for every books, and with none open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sealed-'));
  const file = join(dir, 'secrets.json');
  let open: string | undefined = join(dir, 'a');
  mkdirSync(open);
  mkdirSync(join(dir, 'b'));
  const store = sealedStore({ file, cipher, books: () => open });
  await store.set('ai:anthropic', 'test-key-0004');
  open = join(dir, 'b');
  assert.equal(await store.get('ai:anthropic'), 'test-key-0004', 'other books use it too');
  open = undefined;
  assert.equal(await store.get('ai:anthropic'), 'test-key-0004', 'no books open');
  assert.ok(!readFileSync(file, 'utf8').includes('test-key'), 'never in plain text');
});

test('a store without the system keychain refuses to save', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sealed-'));
  const store = sealedStore({ file: join(dir, 'secrets.json'), cipher: { ...cipher, isEncryptionAvailable: () => false }, books: () => dir });
  await assert.rejects(store.set('smtp', 'x'), /keychain/);
  assert.equal(existsSync(join(dir, 'secrets.json')), false);
});

const electron = (() => { try { return createRequire(import.meta.url)('electron') as string; } catch { return undefined; } })();
const skip = electron && existsSync(electron) ? false : 'the Electron binary is not downloaded (node node_modules/electron/install.js)';

test('on Electron\'s safeStorage the password goes in and comes back, sealed', { skip, timeout: 60_000 }, async () => {
  const outfile = join(APP_ROOT, 'out/test/electron-secrets.mjs');
  await build({ entryPoints: [join(APP_ROOT, 'tests/support/electron-secrets.ts')], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
  const run = spawnSync(electron as string, [outfile, '--use-mock-keychain'], { encoding: 'utf8', timeout: 55_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const line = run.stdout.split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, `Electron printed nothing: ${run.stderr}`);
  const r = JSON.parse(line);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r, { available: true, read: 'geheim-123', other: null, plainOnDisk: false });
});
