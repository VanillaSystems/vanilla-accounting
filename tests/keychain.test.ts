/**
 * Secrets in the keychain (src/secrets/keychain-store.ts, ADR 0014): a value goes to the keychain
 * program on its standard input and never as an argument a process list shows; a quote, a
 * backslash and a space in it survive; a missing secret is undefined; deleting one that is not
 * there is fine; each belongs to its books; a value is kept as base64, so a password outside ASCII
 * comes back as it went in. No file of the app reads an IMAP password from the
 * environment any more, except the one-time import. Runs against a stand-in `security`, never the
 * real keychain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keychainStore } from '../src/secrets/keychain-store.js';

/** A `security` that keeps items in a JSON file and logs every call's arguments and input. */
function fakeSecurity(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-security-'));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(join(dir, 'security'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const db = path.join(${JSON.stringify(dir)}, 'items.json');
const items = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : {};
const args = process.argv.slice(2);
const input = args[0] === '-i' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
const opt = (a, f) => a[a.indexOf(f) + 1];
if (args[0] === 'find-generic-password') { const v = items[opt(args, '-a')]; if (v === undefined) process.exit(44); process.stdout.write(v + '\\n'); }
else if (args[0] === 'delete-generic-password') { if (!(opt(args, '-a') in items)) process.exit(44); delete items[opt(args, '-a')]; fs.writeFileSync(db, JSON.stringify(items)); }
else if (args[0] === '-i') {
  const words = []; let w = null, q = false;
  for (let i = 0; i < input.length; i++) { const c = input[i];
    if (q) { if (c === '\\\\') { w += input[++i]; } else if (c === '"') { q = false; } else w += c; }
    else if (c === '"') { q = true; w = w ?? ''; } else if (/\\s/.test(c)) { if (w !== null) words.push(w); w = null; } else w = (w ?? '') + c; }
  items[opt(words, '-a')] = opt(words, '-w'); fs.writeFileSync(db, JSON.stringify(items));
}
`);
  chmodSync(join(dir, 'security'), 0o755);
  return { dir, log };
}

test('a secret goes to the keychain on standard input, never as an argument, and comes back as it was', async () => {
  const fake = fakeSecurity();
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const books = mkdtempSync(join(tmpdir(), 'books-'));
    const other = mkdtempSync(join(tmpdir(), 'books-'));
    const store = keychainStore({ books: () => books });
    const value = 'p"a\\ss wörd';
    await store.set('source:office:mail', value);
    assert.equal(await store.get('source:office:mail'), value, 'a quote, a backslash and a space survive');
    assert.equal(await keychainStore({ books: () => other }).get('source:office:mail'), undefined, 'a secret belongs to its books');
    assert.equal(await store.get('source:shop:mail'), undefined);
    const calls = readFileSync(fake.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; input: string });
    const kept = `b64:${Buffer.from(value, 'utf8').toString('base64')}`;
    assert.ok(calls.every((c) => !c.args.some((a) => a.includes('wörd') || a.includes(kept))), 'never in the arguments');
    assert.ok(calls.some((c) => c.input.includes(kept)), 'only on standard input, as base64 (security prints a non-ASCII password as hex)');
    await store.set('source:office:mail', null);
    assert.equal(await store.get('source:office:mail'), undefined);
    await store.set('source:office:mail', null);
  } finally {
    process.env.PATH = path;
  }
});

test('no file of the app reads an IMAP password from the environment, except the one-time import', () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
  const readers = files('src').filter((f) => /\.tsx?$/.test(f) && /_IMAP_PASSWORD/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(readers, ['src/cli/secret.ts']);
});
