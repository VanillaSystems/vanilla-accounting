/**
 * Source declarations (src/platform/sources/, ADR 0014): the reach grammar parses and matches as
 * its table says; a source.yaml is read strictly and every refusal names its line; the code is
 * checked without running it, each refused import or global with its line; mail.yaml becomes one
 * source per mailbox and back without losing a mailbox or a sender; a company source waits to be
 * switched on and shows what its reach adds; the app's bindable IMAP source is never listed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matches, parseHostPath, parseSender, senderAllowed } from '../src/platform/sources/reach.js';
import { readDecl } from '../src/platform/sources/load.js';
import { approveSource, sources } from '../src/platform/sources/index.js';
import { mailFromSources, sourcesFromMail } from '../src/platform/sources/mail.js';
import type { SourceDecl } from '../src/platform/sources/model.js';
import type { MailConfig } from '../src/collect/mail-config.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';

process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'sources-approvals-'));
const APP_SOURCES = join(APP_ROOT, 'sources');

test('the reach grammar: what parses, what matches', () => {
  const p = (t: string) => { const r = parseHostPath(t); assert.ok(r.ok, `${t}: ${r.ok ? '' : r.message}`); return r.value; };
  const table: Array<[string, string, boolean]> = [
    ['shop.example.com/admin/orders/*', 'https://shop.example.com/admin/orders/12', true],
    ['shop.example.com/admin/orders/*', 'https://shop.example.com/admin/orders/12/refunds', true],
    ['shop.example.com/admin/orders/*', 'https://shop.example.com/admin/orders', false],
    ['shop.example.com/admin/*/download', 'https://shop.example.com/admin/b-17/download?x=1#y', true],
    ['shop.example.com/admin/*/download', 'https://shop.example.com/admin/b-17/c/download', false],
    ['shop.example.com/admin', 'http://shop.example.com/admin', false],
    ['shop.example.com/admin', 'https://shop.example.com:8443/admin', false],
    ['shop.example.com/admin', 'https://evil.example.com/admin', false],
    ['*.example.com/login', 'https://accounts.example.com/login', true],
    ['*.example.com/login', 'https://a.b.example.com/login', false],
  ];
  for (const [pattern, url, ok] of table) assert.equal(matches(p(pattern), url), ok, `${pattern} ~ ${url}`);
  for (const bad of ['http://shop.example.com/x', 'shop.example.com/ad*min', 'shop.example.com/**', '10.0.0.1/x', 'example', 'a.*.example.com/x']) assert.equal(parseHostPath(bad).ok, false, bad);
  const s = (t: string) => { const r = parseSender(t); assert.ok(r.ok); return r.value; };
  const reach = { from: [s('*@example.com'), s('billing@vendor.example')], skip: [s('news@example.com')] };
  assert.deepEqual(['a@example.com', 'news@example.com', 'billing@vendor.example', 'other@vendor.example'].map((a) => senderAllowed(reach, a)), [true, false, true, false]);
  assert.equal(parseSender('a*b@example.com').ok, false);
});

function folder(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'source-')), 'shop');
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

const YAML = `label: Shop
code: ./source.ts
reach:
  api:
    base: https://shop.example.com/api/
    auth: { header: X-Token }
    allow: [GET orders.json]
feeds:
  orders: { output: records sales.order@1, every: daily }
`;

test('a source.yaml is read strictly: every refusal names its line', () => {
  const ok = readDecl(folder({ 'source.yaml': YAML, 'source.ts': 'export default { orders: async function* () {} };\n' }), 'company', APP_SOURCES);
  assert.ok('decl' in ok, JSON.stringify(ok));
  assert.deepEqual([ok.decl.feeds, ok.decl.reach.api?.allow.map((a) => a.path.text)], [[{ id: 'orders', output: { kind: 'records', record: 'sales.order@1' }, every: 'daily' }], ['orders.json']]);
  const bad = readDecl(folder({ 'source.yaml': YAML.replace('allow: [GET orders.json]', 'allow: [POST orders.json]\n    secret: x').replace('every: daily', 'every: often'), 'source.ts': 'export default {};\n' }), 'company', APP_SOURCES);
  assert.ok('problems' in bad);
  assert.deepEqual(bad.problems.map((p) => [p.line, p.message.split(':')[0]]).sort(), [[7, 'reach.api.allow'], [8, 'reach.api'], [10, 'feeds.orders.every']].sort());
  const unbound = readDecl(folder({ 'source.yaml': 'label: X\ncode: app:nothing\nfeeds:\n  a: { output: document, every: daily }\n' }), 'company', APP_SOURCES);
  assert.ok('problems' in unbound && unbound.problems[0].line === 2 && /ships no source "nothing"/.test(unbound.problems[0].message));
});

test('the code is checked without running it: each refused import and global with its line', () => {
  const dir = folder({
    'source.yaml': YAML,
    'source.ts': "import type { Feeds } from 'source-v1';\nimport { parse } from './parse.js';\nimport fs from 'node:fs';\nexport default { orders: async function* () { yield parse(process.env.X); } };\n",
    'parse.ts': "import { x } from '../elsewhere.js';\nexport const parse = (s: unknown) => eval(String(s));\n",
  });
  const r = readDecl(dir, 'company', APP_SOURCES);
  assert.ok('problems' in r);
  assert.deepEqual(r.problems.map((p) => `${p.file}:${p.line} ${p.message.split(' ').slice(0, 2).join(' ')}`).sort(), [
    'sources/shop/parse.ts:1 imports "../elsewhere.js",',
    'sources/shop/parse.ts:2 eval is',
    'sources/shop/source.ts:3 imports "node:fs":',
    'sources/shop/source.ts:4 process is',
  ].sort(), 'a type-only import of the contract is fine');
});

test('mail.yaml becomes one source per login and back, losing no mailbox and no sender', () => {
  const cfg: MailConfig = {
    mailboxes: [
      { label: 'office', address: 'office@example.com', env: 'OFFICE', host: 'imap.example.com', mixed: false },
      { label: 'private', address: 'me@example.com', env: 'MY_BOX', host: 'imap.example.net', filterTo: 'shop@example.com', mixed: true },
      { label: 'shop', address: 'shop@example.com', env: 'MY_BOX', host: 'imap.example.net', filterTo: 'contact@example.com', mixed: false },
    ],
    skipDomains: new Set(['news.example.com', 'social.example.org', 'a stray word']),
    includeDomains: new Set(['vendor.example']),
    linkReceiptDomains: new Set(['billing.example.com']),
  };
  const root = mkdtempSync(join(tmpdir(), 'mail-sources-'));
  const files = sourcesFromMail(cfg, { OFFICE_IMAP_USER: 'login@example.com' });
  assert.deepEqual(files.map((f) => f.id), ['office', 'my-box'], 'two mailboxes sharing a login are one source');
  const decls = files.map((f) => {
    mkdirSync(join(root, f.id));
    writeFileSync(join(root, f.id, 'source.yaml'), f.yaml);
    const r = readDecl(join(root, f.id), 'company', APP_SOURCES);
    assert.ok('decl' in r, JSON.stringify(r));
    return r.decl as SourceDecl;
  });
  assert.equal(decls[0].reach.mail?.account, 'login@example.com', 'the login name from .env');
  assert.deepEqual(decls[1].reach.mail?.skip.map((s) => s.text), ['*@news.example.com', '*@social.example.org'], 'a mixed mailbox skips the skip list; a stray word is no sender');
  assert.match(files[1].yaml, /Not a sender domain, so left out of reach\.mail\.skip \(kept in settings\.skip\): a stray word/);
  assert.deepEqual(mailFromSources(decls), cfg);
});

test('a company source waits to be switched on and shows what its reach adds; the bindable IMAP source is not listed', () => {
  const ws = tempWorkspace('sources-ws-');
  mkdirSync(join(ws.paths.root, 'sources', 'shop'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'sources', 'shop', 'source.yaml'), YAML);
  writeFileSync(join(ws.paths.root, 'sources', 'shop', 'source.ts'), 'export default { orders: async function* () {} };\n');
  let [shop] = sources(ws, APP_ROOT);
  assert.equal(sources(ws, APP_ROOT).length, 1, 'only the company source: imap is bindable');
  assert.equal(shop.kind, 'pending');
  assert.deepEqual(shop.kind === 'pending' && shop.reachDiff.added.map((l) => l.what), ['GET https://shop.example.com/api/orders.json']);
  approveSource(ws, shop.kind === 'pending' ? shop.decl : (null as never));
  assert.equal(sources(ws, APP_ROOT)[0].kind, 'ready');
  writeFileSync(join(ws.paths.root, 'sources', 'shop', 'source.yaml'), YAML.replace('allow: [GET orders.json]', 'allow: [GET orders.json, GET payouts.json]'));
  [shop] = sources(ws, APP_ROOT);
  assert.deepEqual(shop.kind === 'pending' && shop.reachDiff.added.map((l) => l.what), ['GET https://shop.example.com/api/payouts.json'], 'only what the change adds');
});
