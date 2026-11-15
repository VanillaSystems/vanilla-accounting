/**
 * Sharing by link end to end through the API (src/server/routes/share.ts) against a fake of the share
 * service (tests/support/share-service.ts, after its docs/api.md): the sender confirms her address,
 * shares the books, the recipient opens the link as a Durchsicht copy, changes an entry and sends it
 * back into the same share, and the sharer's app fetches the return and shows it for review. The
 * service sees ciphertext, sizes and tokens only: never the key, a path or a name. Each refusal of
 * the service reaches the person as a code with the limit it names.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { anywhere, startShareService, type FakeShareService } from './support/share-service.js';

let api: ApiServer;
let svc: FakeShareService;
const dir = mkdtempSync(join(tmpdir(), 'share-link-'));
const SANDRA = 'sandra@example.ch';
const ERNST = { name: 'Ernst Beispiel', email: 'ernst@example.ch' };

before(async () => {
  svc = await startShareService();
  api = await startApi('tests/fixtures/period-lock-index.json', {
    VANILLA_DURCHSICHT_DIR: join(dir, 'copies'), VANILLA_SHARE_SERVICE: svc.url,
    VANILLA_SECRETS_FILE: join(dir, 'secrets.json'), VANILLA_SHARE_SETTINGS: join(dir, 'share.json'),
  });
});
after(async () => { await api?.stop(); await svc?.stop(); });

interface Job { id: string; phase: string; result?: Record<string, unknown>; error?: { code?: string; params?: Record<string, string>; error: string } }
async function job(path: string, body: unknown): Promise<Job> {
  const started = await api.send('POST', path, body);
  assert.equal(started.status, 202, JSON.stringify(started.json));
  for (let i = 0; i < 400; i++) {
    const j = (await api.send('GET', `/api/share/jobs/${started.json.id as string}`)).json as unknown as Job;
    if (j.phase === 'done' || j.phase === 'failed') return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${path}: the job did not end`);
}

let link = '';
let shareId = '';

test('the sender confirms her address once; until then sharing by link is refused, the file is not', async () => {
  const early = await job('/api/share/link', { to: ERNST });
  assert.equal(early.error?.code, 'shareSenderMissing');
  svc.autoConfirm = false;
  const reg = await api.send('POST', '/api/share/sender', { email: SANDRA });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  assert.equal(reg.json.confirmed, false);
  assert.equal(reg.json.mailed, false, 'no mailbox sends from this address: the person sends it from her mail program');
  assert.match((reg.json.confirmation as { subject: string }).subject, /^Vanilla Accounting confirmation /);
  assert.equal((await job('/api/share/link', { to: ERNST })).error?.code, 'shareSenderUnconfirmed');
  svc.refuseSender(SANDRA, 'notAuthenticated');
  assert.equal((await api.send('GET', '/api/share/sender')).json.refusedReason, 'notAuthenticated');
  svc.confirm(SANDRA);
  const me = await api.send('GET', '/api/share/sender');
  assert.equal(me.json.confirmed, true);
  assert.equal(me.json.email, SANDRA);
});

test('«Teilen» by link: sealed, uploaded, Version 1 written only then; the service never sees the key, a path or a name', async () => {
  const done = await job('/api/share/link', { to: ERNST, message: 'Bitte Q3 ansehen' });
  assert.equal(done.phase, 'done', JSON.stringify(done.error));
  const r = done.result as { link: string; record: { id: string; version: number; state: string }; invitation: { subject: string; text: string; html: string }; mailed: boolean };
  link = r.link;
  shareId = r.record.id;
  assert.match(link, new RegExp(`^${svc.url}/[a-z2-7]{26}#[A-Za-z0-9_-]{43}$`));
  assert.equal(r.record.version, 1);
  assert.equal(r.record.state, 'ready');
  assert.ok(r.invitation.text.includes(link) && r.invitation.html.includes(link), 'the invitation carries the link');
  assert.match(r.invitation.subject, /hat dir die Buchhaltung geschickt/);
  const key = link.split('#')[1];
  assert.ok(!anywhere(svc.seen, key), 'the key never reached the service');
  assert.ok(!anywhere(svc.seen, Buffer.from(key, 'base64url').toString('hex')), 'not even as hex');
  for (const plain of ['ledger.json', 'Ernst Beispiel', ERNST.email, 'Bitte Q3 ansehen']) assert.ok(!anywhere(svc.seen, plain), `${plain} never reached the service`);
  const view = await api.send('GET', '/api/handover');
  assert.equal((view.json.version as { n: number }).n, 1);
  assert.equal((view.json.shares as unknown[]).length, 1);
  assert.equal((await api.send('GET', `/api/share/${shareId}/link`)).json.link, link, '«Link kopieren» again');
});

test('a refusal of the service names its limit, and writes no version', async () => {
  svc.refuse(/^\/api\/shares$/, 429, { error: 'Höchstens 10 Freigaben pro Tag.', code: 'tooManyShares', limit: 10, per: 'sender-day' });
  const refused = await job('/api/share/link', { to: ERNST });
  assert.equal(refused.error?.code, 'shareServiceRefused');
  assert.deepEqual(refused.error?.params, { reason: 'tooManyShares', limit: '10', per: 'sender-day' });
  assert.equal(((await api.send('GET', '/api/handover')).json.version as { n: number }).n, 1, 'no version for a share the service did not take');
});

test('the link opens as a Durchsicht copy; his change goes back into the same share', async () => {
  assert.equal((await job('/api/share/open', { link: 'https://example.ch/nothing' })).error?.code, 'shareLinkInvalid');
  const opened = await job('/api/share/open', { link });
  assert.equal(opened.phase, 'done', JSON.stringify(opened.error));
  assert.equal(opened.result?.kind, 'full');
  const d = (await api.send('GET', '/api/handover')).json.durchsicht as { me: { name: string }; linked: boolean; message?: string };
  assert.equal(d.me.name, ERNST.name);
  assert.equal(d.linked, true);
  assert.equal(d.message, 'Bitte Q3 ansehen');
  // Sharing onward is the sharer's.
  assert.equal((await api.send('POST', '/api/share/link', { to: { name: 'Jemand' } })).json.code, 'roleRefused');
  const entries = (await api.send('GET', '/books.json')).json.journalEntries as Array<{ id: string; date: string }>;
  const open = entries.find((e) => e.date > '2026-06-30')!;
  assert.equal((await api.send('PATCH', `/api/journal-entries/${open.id}`, { description: 'von Ernst korrigiert' })).status, 200);
  await api.send('PUT', '/api/handover/notes', { key: `entry:${open.id}`, text: 'Falsches Konto' });
  const back = await job('/api/share/return', { message: 'Ein Punkt' });
  assert.equal(back.phase, 'done', JSON.stringify(back.error));
  assert.equal(back.result?.changes, 1);
  assert.ok(!anywhere(svc.seen, 'von Ernst korrigiert'), 'his change travels encrypted');
  assert.equal((await api.send('POST', '/api/handover/close')).status, 200);
});

test('the sharer\'s app fetches the return and shows it for review; nothing is taken over', async () => {
  const before = (await api.send('GET', '/books.json')).json.journalEntries as Array<{ description: string }>;
  const r = await api.send('POST', '/api/share/refresh');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const arrived = r.json.arrived as Array<{ id: string; from: { name: string }; changes: number; basedOn: number }>;
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].from.name, ERNST.name);
  assert.equal(arrived[0].basedOn, 1);
  const share = (r.json.shares as Array<{ opens: string[]; returns: Array<{ received?: string }> }>)[0];
  assert.equal(share.opens.length, 1, 'the opening is a fact on the card');
  assert.equal(share.returns[0].received, arrived[0].id);
  const review = await api.send('GET', `/api/handover/returns/${arrived[0].id}`);
  assert.equal(review.status, 200);
  assert.ok(JSON.stringify(review.json).includes('von Ernst korrigiert'), 'the review shows his change');
  assert.ok(JSON.stringify(review.json).includes('Falsches Konto'), 'and his «Warum?»');
  const after = (await api.send('GET', '/books.json')).json.journalEntries as Array<{ description: string }>;
  assert.deepEqual(after.map((e) => e.description), before.map((e) => e.description), 'the books are as they were until she takes it over');
  assert.equal(((await api.send('POST', '/api/share/refresh')).json.arrived as unknown[]).length, 0, 'fetched once');
});

test('«Zurückziehen»: the service deletes the share; the link opens no more', async () => {
  const revoked = await api.send('DELETE', `/api/share/${shareId}`);
  assert.equal(revoked.json.state, 'revoked');
  const late = await job('/api/share/open', { link });
  assert.equal(late.error?.code, 'shareServiceRefused');
  assert.equal(late.error?.params?.reason, 'revoked');
});
