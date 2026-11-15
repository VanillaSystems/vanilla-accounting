/**
 * Sharing by link end to end through the API (src/server/routes/share.ts) against a fake of the share
 * service, version 3 (tests/support/share-service.ts, after its docs/api.md): the sender confirms her
 * address, «Einladung senden» uploads one Freigabe-Datei and the service sends the invitation; the
 * link in it is the access (no key after a #, no code), downloads the file into Downloads and opens
 * it on a fresh copy, and again; «Aktualisieren» puts the
 * whole books into the same link, before or after he opened it, and his copy moves forward with his
 * changes kept; his return goes back into the same share; «Zurückziehen» ends it, his copy says so
 * and offers «Kopie löschen». Each refusal of the service reaches the person as a code with its limit.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { anywhere, startShareService, type FakeShareService } from './support/share-service.js';
import { canReturnByLink, checkCopy, deleteCopy, linkOfCopy } from '../src/share/sharing.js';
import { changesOf, markerOf } from '../src/handover/durchsicht.js';
import { readPackage } from '../src/handover/package.js';
import { documentOf } from '../src/handover/document.js';

let api: ApiServer;
let svc: FakeShareService;
const dir = mkdtempSync(join(tmpdir(), 'share-link-'));
const copies = join(dir, 'copies');
const downloads = join(dir, 'Downloads');
const SANDRA = 'sandra@example.ch';
const ERNST = { name: 'Ernst Beispiel', email: 'ernst@example.ch' };

before(async () => {
  svc = await startShareService();
  api = await startApi('tests/fixtures/period-lock-index.json', {
    VANILLA_DURCHSICHT_DIR: copies, VANILLA_SHARE_SERVICE: svc.url, VANILLA_DOWNLOADS_DIR: downloads,
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

/** The one copy this test's recipient holds, as his app keeps it. */
const copyRoot = (): string => { const [slug] = readdirSync(copies); return join(copies, slug); };
/** Whether any file of the copy holds `text`. */
function copyHolds(root: string, text: string): boolean {
  for (const name of readdirSync(root)) {
    const f = join(root, name);
    if (statSync(f).isDirectory()) { if (copyHolds(f, text)) return true; } else if (readFileSync(f).includes(text)) return true;
  }
  return false;
}
const entries = async () => (await api.send('GET', '/books.json')).json.journalEntries as Array<{ id: string; date: string; description: string }>;

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

test('«Einladung senden»: the service sends the invitation, from her name and replying to her; the link carries no key', async () => {
  assert.equal((await job('/api/share/link', { to: { name: ERNST.name } })).error?.code, 'shareEmailMissing', 'by link the address is needed');
  const done = await job('/api/share/link', { to: ERNST, message: 'Bitte Q3 ansehen', language: 'fr' });
  assert.equal(done.phase, 'done', JSON.stringify(done.error));
  const r = done.result as { link: string; invited: boolean; record: { id: string; version: number; state: string; invitedAt?: string; expiresAt?: string } };
  link = r.link;
  shareId = r.record.id;
  assert.equal(link, `${svc.url}/${shareId}`, 'the link is the service and the id: no # and no key');
  assert.match(shareId, /^[a-z2-7]{26}$/);
  assert.equal(r.invited, true);
  assert.ok(r.record.invitedAt);
  assert.equal(r.record.version, 1);
  assert.equal(r.record.state, 'ready');
  assert.ok(Date.parse(r.record.expiresAt!) - Date.now() > 13 * 86400_000, 'open 14 days');
  assert.equal(svc.mails.length, 1);
  const mail = svc.mails[0];
  assert.deepEqual(mail.to, ERNST);
  assert.equal(mail.from.email, SANDRA, 'the confirmed address');
  assert.equal(mail.replyTo, SANDRA);
  assert.ok(mail.from.name);
  assert.equal(mail.link, link);
  assert.equal(mail.message, 'Bitte Q3 ansehen');
  assert.equal(mail.language, 'fr', 'in the sharer\'s language');
  assert.equal(mail.kind, 'invite');
  for (const s of svc.seen) assert.ok(!s.url.includes('#'), 'no fragment anywhere');
  // One Freigabe-Datei, one PUT: the hand-over itself, naming the share it went into.
  const file = svc.shares.get(shareId)!.current.file!;
  const p = readPackage(new Uint8Array(file));
  assert.equal(p.index.kind, 'full');
  assert.deepEqual({ ...p.index.share, returnToken: undefined }, { service: svc.url, id: shareId, generation: 1, returnToken: undefined });
  assert.equal(p.index.share?.returnToken, svc.shares.get(shareId)!.returnToken, 'the recipient\'s return token rides in the file');
  assert.equal(svc.seen.filter((s) => s.method === 'PUT').length, 1, 'one upload');
  assert.ok(!anywhere(svc.seen, 'openProof') && !svc.seen.some((s) => s.body.includes('"key"')), 'no key travels: the service keeps none');
  const view = await api.send('GET', '/api/handover');
  assert.equal((view.json.version as { n: number }).n, 1);
  assert.equal((await api.send('GET', `/api/share/${shareId}/link`)).json.link, link, '«Link kopieren» again');
});

test('a refusal of the service names its limit, and writes no version', async () => {
  svc.refuse(/^\/api\/shares$/, 429, { error: 'Höchstens 10 Freigaben pro Tag.', code: 'tooManyShares', limit: 10, per: 'sender-day' });
  const refused = await job('/api/share/link', { to: ERNST });
  assert.equal(refused.error?.code, 'shareServiceRefused');
  assert.deepEqual(refused.error?.params, { reason: 'tooManyShares', limit: '10', per: 'sender-day' });
  assert.equal(((await api.send('GET', '/api/handover')).json.version as { n: number }).n, 1, 'no version for a share the service did not take');
});

test('«Aktualisieren» before he opened it: the same link, the newest state, and a short note when asked', async () => {
  const done = await job(`/api/share/${shareId}/update`, { notify: true, message: 'Beleg nachgereicht' });
  assert.equal(done.phase, 'done', JSON.stringify(done.error));
  const r = done.result as { id: string; version: number; updatedAt?: string; notifiedAt?: string };
  assert.equal(r.id, shareId, 'the same share');
  assert.equal(r.version, 2);
  assert.ok(r.updatedAt && r.notifiedAt);
  assert.equal(svc.mails.length, 2);
  assert.equal(svc.mails[1].kind, 'update');
  assert.equal(svc.mails[1].link, link, 'the same link');
  assert.equal(svc.mails[1].to.email, ERNST.email, 'to the address the service keeps for the share');
});

test('an app of protocol v2 (0.6.1 opens with {}) is told appTooOld, never handed a file it would call broken', async () => {
  const res = await fetch(`${svc.url}/api/shares/${shareId}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 426);
  assert.equal(((await res.json()) as { code: string }).code, 'appTooOld');
});

test('the link opens the books on a fresh copy, with no key and no code; it opens again; his change goes back into the same share', async () => {
  assert.equal((await job('/api/share/open', { link: 'https://example.ch/nothing' })).error?.code, 'shareLinkInvalid');
  const opened = await job('/api/share/open', { link });
  assert.equal(opened.phase, 'done', JSON.stringify(opened.error));
  assert.equal(opened.result?.kind, 'full');
  assert.equal(opened.result?.version, 2, 'he gets the newest state on his first opening');
  // Downloaded as a real Freigabe-Datei into Downloads, named as the browser would name it; it is the copy's document.
  const [saved] = readdirSync(downloads);
  assert.match(saved, / – Buchhaltung \(\d{4}-\d{2}-\d{2}\)\.vanillashare$/);
  assert.equal(opened.result?.document, join(downloads, saved));
  const again = await job('/api/share/open', { link });
  assert.equal(again.phase, 'done', JSON.stringify(again.error));
  assert.equal(svc.shares.get(shareId)!.opens.length, 2, 'a second opening works, and counts as a fact');
  const d = (await api.send('GET', '/api/handover')).json.durchsicht as { me: { name: string }; linked: boolean; byLink: boolean };
  assert.equal(d.me.name, ERNST.name);
  assert.equal(d.linked, true);
  assert.equal(d.byLink, true);
  assert.equal((await api.send('POST', '/api/share/check')).json.state, 'current', 'nothing newer');
  // Sharing onward is the sharer's.
  assert.equal((await api.send('POST', '/api/share/link', { to: { name: 'Jemand' } })).json.code, 'roleRefused');
  const open = (await entries()).find((e) => e.date > '2026-06-30')!;
  assert.equal((await api.send('PATCH', `/api/journal-entries/${open.id}`, { description: 'von Ernst korrigiert' })).status, 200);
  await api.send('PUT', '/api/handover/notes', { key: `entry:${open.id}`, text: 'Falsches Konto' });
  const back = await job('/api/share/return', { message: 'Ein Punkt' });
  assert.equal(back.phase, 'done', JSON.stringify(back.error));
  assert.equal(back.result?.changes, 1);
  const ret = [...svc.shares.values()].find((x) => x.parent === shareId)!;
  assert.equal(readPackage(new Uint8Array(ret.current.file!)).index.kind, 'return', 'his return is one Freigabe-Datei too');
  assert.equal((await api.send('POST', '/api/handover/close')).status, 200);
});

test('the sharer\'s app fetches the return and shows it for review; nothing is taken over', async () => {
  const before = await entries();
  const r = await api.send('POST', '/api/share/refresh');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const arrived = r.json.arrived as Array<{ id: string; from: { name: string }; changes: number; basedOn: number }>;
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].from.name, ERNST.name);
  const share = (r.json.shares as Array<{ id: string; opens: string[]; returns: Array<{ received?: string }> }>).find((s) => s.id === shareId)!;
  assert.equal(share.opens.length, 2, 'the openings are facts on the card');
  assert.equal(share.returns[0].received, arrived[0].id);
  const review = await api.send('GET', `/api/handover/returns/${arrived[0].id}`);
  assert.equal(review.status, 200);
  assert.ok(JSON.stringify(review.json).includes('von Ernst korrigiert'), 'the review shows his change');
  assert.ok(JSON.stringify(review.json).includes('Falsches Konto'), 'and his «Warum?»');
  assert.deepEqual((await entries()).map((e) => e.description), before.map((e) => e.description), 'the books are as they were until she takes it over');
  assert.equal(((await api.send('POST', '/api/share/refresh')).json.arrived as unknown[]).length, 0, 'fetched once');
});

test('«Aktualisieren» after he downloaded: his copy moves forward by itself when it opens, his change kept', async () => {
  const open = (await entries()).find((e) => e.date > '2026-06-30')!;
  const added = await api.send('POST', '/api/journal-entries', { date: open.date, accountDebit: '6500', accountCredit: '1020', amount: 12.5, description: 'von Sandra nachgetragen' });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const done = await job(`/api/share/${shareId}/update`, {});
  assert.equal(done.phase, 'done', JSON.stringify(done.error));
  assert.equal(svc.mails.length, 2, 'without «Bescheid geben» no mail');
  const root = copyRoot();
  assert.equal(markerOf(root)!.version.n, 2);
  const inDownloads = readdirSync(downloads).sort();
  const docBefore = documentOf(root)!;
  const found = await checkCopy(root);
  assert.equal(found.state, 'updated', JSON.stringify(found));
  // Unasked, nothing lands in Downloads (no folder question of macOS, no «… 2.vanillashare»): the copy keeps it until he saves.
  assert.deepEqual(readdirSync(downloads).sort(), inDownloads);
  assert.equal(documentOf(root)!.path, docBefore.path, 'the copy\'s document is still his file');
  assert.equal((found as { file?: string }).file, basename(docBefore.path));
  assert.equal(readPackage(readFileSync(docBefore.path)).index.version.n, 2, 'which holds the older state until he saves');
  assert.equal(markerOf(root)!.version.n, 3, 'on the newest state');
  assert.ok(copyHolds(root, 'von Sandra nachgetragen'), 'with what she added');
  assert.ok(copyHolds(root, 'von Ernst korrigiert'), 'and his own change still there');
  assert.equal(changesOf(root).length >= 1, true);
  assert.equal((await checkCopy(root)).state, 'current', 'once only');
});

test('an invitation the service does not send leaves the share standing, says why with its limit; «Nochmals senden» sends it later', async () => {
  svc.refuse(/\/invite$/, 503, { error: 'Der Dienst hat heute schon 100 Einladungen verschickt.', code: 'mailsPerDay', limit: 100, per: 'day' });
  const done = await job('/api/share/link', { to: { name: 'Pius Muster', email: 'pius@example.ch' } });
  assert.equal(done.phase, 'done', JSON.stringify(done.error));
  const r = done.result as { invited: boolean; inviteError?: { code: string; params: Record<string, string> }; record: { id: string; state: string } };
  assert.equal(r.invited, false);
  assert.equal(r.record.state, 'ready', 'the share stands');
  assert.equal(r.inviteError?.code, 'shareServiceRefused');
  assert.deepEqual(r.inviteError?.params, { reason: 'mailsPerDay', limit: '100', per: 'day' });
  const again = await api.send('POST', `/api/share/${r.record.id}/invite`);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.ok(again.json.invitedAt);
  assert.equal(svc.mails.at(-1)!.to.email, 'pius@example.ch');
  // 14 days later the service has deleted it: the link says so in words.
  svc.expire(r.record.id);
  const late = await job('/api/share/open', { link: `${svc.url}/${r.record.id}` });
  assert.equal(late.error?.code, 'shareServiceRefused');
  assert.equal(late.error?.params?.reason, 'expired');
});

test('«Zurückziehen» after he downloaded: the link opens no more; his copy stays, says so, offers «Kopie löschen», returns go as a file', async () => {
  const revoked = await api.send('DELETE', `/api/share/${shareId}`);
  assert.equal(revoked.json.state, 'revoked');
  assert.equal(svc.shares.get(shareId)!.current.file, undefined, 'everything deleted at the service');
  const late = await job('/api/share/open', { link });
  assert.equal(late.error?.code, 'shareServiceRefused');
  assert.equal(late.error?.params?.reason, 'revoked');
  assert.equal((await job(`/api/share/${shareId}/update`, {})).error?.code, 'shareUnknown', 'nothing to update');
  const root = copyRoot();
  const found = await checkCopy(root);
  assert.equal(found.state, 'withdrawn');
  assert.ok(existsSync(root), 'never deleted for him');
  assert.ok(linkOfCopy(root)?.withdrawnAt);
  assert.equal(canReturnByLink(root), false, 'his changes go back as a file now');
  deleteCopy(root);
  assert.ok(!existsSync(root), '«Kopie löschen» when he says so');
});
