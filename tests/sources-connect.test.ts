/**
 * r5h-27: an owner connects a mailbox in Firma › Quellen, without npm run secret: address, IMAP
 * server and login make a source folder that waits to be switched on; the password goes into the
 * secret store (a test's file here, the keychain in the app), never into the workspace; the check
 * logs in and lists what the source would read. Against a stand-in mailbox, never a real one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailFailure, MailLoginError } from '../src/platform/sources/mail-channel.js';
import { startApi, type ApiServer } from './support/api-server.js';
import type { MailCheck, SourcesView } from '../src/platform/sources/model.js';

const dir = mkdtempSync(join(tmpdir(), 'connect-'));
const SECRETS = join(dir, 'secrets.json');
const MAILBOX = join(dir, 'mailbox.json');
const PASSWORD = 'app-pass-4711';
const recent = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
writeFileSync(MAILBOX, JSON.stringify({
  password: PASSWORD,
  messages: [
    { uid: 1, from: 'rechnung@swisscom.example', to: ['sandra@malerei.example'], subject: 'Ihre Rechnung Oktober', date: recent(6), messageId: '<1>' },
    { uid: 2, from: 'news@baucenter.example', to: ['sandra@malerei.example'], subject: 'Herbst-News', date: recent(3), messageId: '<2>' },
    { uid: 3, from: 'alt@vendor.example', to: ['sandra@malerei.example'], subject: 'Rechnung vom Frühling', date: recent(200), messageId: '<3>' },
  ],
}));

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/fresh-books-index.json', { VANILLA_SECRETS_FILE: SECRETS, VANILLA_FAKE_MAILBOX: MAILBOX }); });
after(() => api?.stop());

/** Every file of the workspace, its text: where a password must never be. */
function workspaceText(root: string): string {
  const all: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else all.push(readFileSync(p, 'latin1')); } };
  walk(root);
  return all.join('\n');
}

test('a mailbox connected in Firma › Quellen: a source waiting to be switched on, its password in the store only, the check lists what it reads', async () => {
  const empty = (await api.send('GET', '/api/sources')).json as unknown as SourcesView;
  assert.deepEqual([empty.rows.length, empty.secretsInApp, empty.runsHere], [0, true, true]);

  const bad = await api.send('POST', '/api/sources/mail', { address: 'sandra', host: 'imap.malerei.example' });
  assert.deepEqual([bad.status, bad.json.code], [400, 'mailSourceField']);

  const made = await api.send('POST', '/api/sources/mail', { address: 'sandra@malerei.example', host: 'imap.malerei.example', password: 'wrong' });
  assert.equal(made.status, 200, String(made.json.error));
  const id = String(made.json.id);
  assert.equal(id, 'sandra-malerei-example');
  const yaml = readFileSync(join(api.root, 'sources', id, 'source.yaml'), 'utf8');
  assert.match(yaml, /code: app:imap/);
  assert.match(yaml, /host: imap\.malerei\.example/);

  const view = (await api.send('GET', '/api/sources')).json as unknown as SourcesView;
  assert.equal(view.rows[0].verdict.kind, 'pending', 'it waits to be switched on, as any new source');
  assert.deepEqual(view.rows[0].secrets, [{ channel: 'mail', present: true }]);

  const refused = (await api.send('POST', `/api/sources/${id}/check`)).json as unknown as MailCheck;
  assert.deepEqual(refused, { ok: false, reason: 'login' }, 'a wrong password is the server refusing the login');

  assert.equal((await api.send('PUT', `/api/sources/${id}/secret`, { password: PASSWORD })).status, 200);
  const check = (await api.send('POST', `/api/sources/${id}/check`)).json as unknown as MailCheck;
  assert.ok(check.ok);
  assert.deepEqual([check.days, check.total, check.read], [60, 2, 2], 'the last 60 days, every sender');
  assert.deepEqual(check.mails.map((m) => m.subject), ['Herbst-News', 'Ihre Rechnung Oktober'], 'newest first');

  assert.equal(JSON.parse(readFileSync(SECRETS, 'utf8'))[`source:${id}:mail`], PASSWORD);
  assert.ok(!workspaceText(api.root).includes(PASSWORD), 'the password is nowhere in the workspace');

  assert.equal((await api.send('PUT', `/api/sources/${id}/secret`, { password: null })).status, 200);
  assert.deepEqual((await api.send('POST', `/api/sources/${id}/check`)).json, { ok: false, reason: 'no-secret' });

  const second = await api.send('POST', '/api/sources/mail', { address: 'sandra@malerei.example', host: 'imap.malerei.example' });
  assert.equal(second.json.id, 'sandra-malerei-example-2', 'the same address twice: a second source, not an overwrite');
});

test('what a failed connection means, in the check\'s words: a name that does not resolve is unreachable, a certificate this Mac does not trust is the server reached (r6h-26)', () => {
  const code = (c: string) => Object.assign(new Error(c), { code: c });
  assert.deepEqual(mailFailure(code('ENOTFOUND')), { ok: false, reason: 'connect', detail: 'ENOTFOUND' });
  assert.deepEqual(mailFailure(code('ECONNREFUSED')), { ok: false, reason: 'connect', detail: 'ECONNREFUSED' });
  for (const c of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) assert.deepEqual(mailFailure(code(c)), { ok: false, reason: 'certificate', detail: c }, c);
  assert.deepEqual(mailFailure(new MailLoginError('Authentication failed')), { ok: false, reason: 'login' });
});

test('an unknown source or one that is no mailbox is refused', async () => {
  assert.equal((await api.send('POST', '/api/sources/nope/check')).status, 404);
  assert.equal((await api.send('PUT', '/api/sources/nope/secret', { password: 'x' })).status, 404);
});
