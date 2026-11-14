/**
 * The security review of PR #538, each probe turned around: what the review showed possible is now
 * refused or kept apart.
 *
 * 1. A link a web page hands over (`vanilla-accounting://…&service=<another host>`) opens only
 *    when the person confirmed it, and never moves an existing copy to another service or sharer
 *    without that: the copy and its link stay as they were.
 * 2. Checking the shares and sharing at the same time lose no share from shares.json.
 * 3. A service that sends more than an object's size is cut off, by Content-Length or while streaming.
 * 4. The service chooses neither whom the confirmation e-mail goes to, nor its subject, nor its words.
 * 5. A link nobody opened is not a version the person holds: the next share is full; two shares at
 *    once each get their own version, and a share whose version was taken meanwhile is withdrawn.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'share-review-'));
process.env.VANILLA_SECRETS_FILE = join(dir, 'secrets.json');
process.env.VANILLA_SHARE_SETTINGS = join(dir, 'share.json');

const { startShareService } = await import('./support/share-service.js');
const { tempWorkspace, writeIndex } = await import('./support/workspace.js');
const sharing = await import('../src/share/sharing.js');
const { shareClient, ShareServiceError } = await import('../src/share/client.js');
const { readVersions, writeVersion } = await import('../src/handover/versions.js');
const { markerOf } = await import('../src/handover/durchsicht.js');
const { secrets } = await import('../src/secrets/secrets.js');

const ERNST = { name: 'Ernst Beispiel', email: 'ernst@example.ch' };
const SANDRA = { name: 'Sandra Muster' };
const tx = (ref: string, date: string, amount: number) => ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT' as const, description: `Zahlung ${ref}` });
const entry = (id: string, ref: string, date: string, amount: number, description: string) =>
  ({ id, transactionRef: ref, date, accountDebit: '6500', accountCredit: '1020', amount, description, origin: 'classify', by: { kind: 'model', model: 't' } });

function books(desc: string) {
  const ws = tempWorkspace('share-review-');
  writeIndex(ws, { transactions: [tx('T1', '2026-07-10', 50)], journalEntries: [entry('e1', 'T1', '2026-07-10', 50, desc)], config: {} });
  return ws;
}
const fakes: Array<{ stop(): Promise<void> }> = [];
after(async () => { for (const f of fakes) await f.stop(); });

async function serviceWithSender(email: string) {
  const svc = await startShareService();
  fakes.push(svc);
  process.env.VANILLA_SHARE_SERVICE = svc.url;
  await sharing.registerSender(books('x'), email);
  return svc;
}
const code = (c: string) => (e: Error & { code?: string }) => e.code === c;
const entriesOf = (root: string) => readFileSync(join(root, 'transactional-data/2026/books/entries.jsonl'), 'utf8');

test('1: a link naming another service opens only when confirmed, and moves no copy to another service without it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'share-review-home-'));
  await serviceWithSender('sandra@example.ch');
  const shared = await sharing.shareByLink(books('ECHTE BUCHUNG der Kundin'), { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(shared.link, { at: home });
  const before = sharing.linkOfCopy(copy.root)!;
  const linkBefore = readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8');

  // Someone who knows the client's UID makes a share of other books on his own service (his own computer: no signing key of hers).
  const evil = await serviceWithSender('attacker@example.org');
  await secrets.set('share:sign:ernst@example.ch', null);
  const planted = await sharing.shareByLink(books('ANGREIFER INHALT'), { to: ERNST }, SANDRA);
  const [, id, key] = /\/([a-z2-7]{26})#(.+)$/.exec(planted.link)!;
  const scheme = `vanilla-accounting://open?share=${id}&service=${encodeURIComponent(evil.url)}#${key}`;
  process.env.VANILLA_SHARE_SERVICE = before.service; // the fiduciary's app uses the real service

  // The preview says it plainly, without spending an opening.
  const preview = await sharing.previewLink(scheme);
  assert.equal(preview.foreign, true);
  assert.equal(preview.host, new URL(evil.url).host);
  assert.equal(evil.shares.get(id)!.opens.length, 0, 'a preview is no opening');

  await assert.rejects(sharing.openLink(scheme, { at: home }), code('shareForeignService'), 'not without the person');
  await assert.rejects(sharing.openLink(scheme, { at: home, trust: true }), (e: Error & { code?: string; params?: Record<string, string> }) =>
    e.code === 'shareCopyOther' && e.params?.was === SANDRA.name && e.params?.version === String(markerOf(copy.root)!.version.n), 'the copy it would move, by its real facts: not without the person');
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG') && !entriesOf(copy.root).includes('ANGREIFER'), 'the copy is as it was');
  assert.equal(readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8'), linkBefore, 'its link too: the return still goes to the real service');
  assert.equal(markerOf(copy.root)!.sharer.name, SANDRA.name);

  // Confirmed by the person, it opens from the download kept for her answer: no second opening.
  await sharing.openLink(scheme, { at: home, trust: true, replace: true });
  assert.equal(sharing.linkOfCopy(copy.root)!.service, evil.url);
  assert.equal(evil.shares.get(id)!.opens.length, 1, 'the question spent no second opening');
});

test('2: checking the shares while sharing loses no share', async () => {
  await serviceWithSender('sandra@example.ch');
  const ws = books('race');
  const first = await sharing.shareByLink(ws, { to: ERNST }, SANDRA);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = (service: string) => {
    const c = shareClient(service);
    return { ...c, status: async (sid: string, t: string) => { await gate; return c.status(sid, t); } } as typeof c;
  };
  const refreshing = sharing.refreshShares(ws, new Date(), slow);
  // The share waits for the check that is running (one at a time per books), then adds its record.
  const sharing2 = sharing.shareByLink(ws, { to: { name: 'Zweite Person' } }, SANDRA, { now: new Date(Date.now() + 1000) });
  release();
  await refreshing;
  const second = await sharing2;
  const ids = sharing.readShares(ws).map((s) => s.id).sort();
  assert.deepEqual(ids, [first.record.id, second.record.id].sort());
});

test('3: a service that sends more than an object\'s size is cut off', async () => {
  const big = 32 * 1024 * 1024;
  let sent = 0;
  const srv = httpServer((req, res) => {
    const chunked = req.url?.includes('chunked');
    res.writeHead(200, chunked ? {} : { 'Content-Length': String(big) });
    const chunk = Buffer.alloc(1024 * 1024);
    let n = 0;
    const w = () => { while (n < 32) { n++; sent += chunk.length; if (!res.write(chunk)) return void res.once('drain', w); } res.end(); };
    res.on('error', () => undefined);
    w();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const client = shareClient(url);
  await assert.rejects(client.get({ object: 'index', method: 'GET', url: `${url}/api/shares/x/objects/index` }, 64 * 1024), (e) => e instanceof ShareServiceError && e.code === 'oversized', 'by Content-Length');
  await assert.rejects(client.get({ object: 'index', method: 'GET', url: `${url}/api/shares/x/objects/index?chunked` }, 64 * 1024), (e) => e instanceof ShareServiceError && e.code === 'oversized', 'while streaming');
  srv.closeAllConnections(); srv.close();
  assert.ok(sent < big * 2, 'the second answer was not read to its end');
});

async function smtpCatcher() {
  const rcpts: string[] = [];
  let data = '';
  const smtp = tcpServer((s) => {
    let inData = false;
    s.write('220 x\r\n');
    s.on('data', (b) => {
      for (const line of b.toString().split('\r\n')) {
        if (inData) { if (line === '.') { inData = false; s.write('250 ok\r\n'); } else data += line + '\n'; continue; }
        if (!line) continue;
        if (/^EHLO|^HELO/i.test(line)) s.write('250 x\r\n');
        else if (/^RCPT TO:/i.test(line)) { rcpts.push(line); s.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; s.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  return { port: (smtp.address() as AddressInfo).port, rcpts, data: () => data, close: () => smtp.close() };
}
async function serviceAsking(confirmation: Record<string, string>) {
  const svc = httpServer((_req, res) => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ senderToken: 't', confirmed: false, confirmation })); });
  await new Promise<void>((r) => svc.listen(0, '127.0.0.1', r));
  process.env.VANILLA_SHARE_SERVICE = `http://127.0.0.1:${(svc.address() as AddressInfo).port}`;
  return svc;
}

test('4: the confirmation e-mail goes only to the service\'s own domain, with its subject and the app\'s own words', async () => {
  const smtp = await smtpCatcher();
  const ws = books('mail');
  (ws as { outgoingMail?: unknown }).outgoingMail = { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'sandra@example.ch' };
  const at = new Date().toISOString();
  const odd = await serviceAsking({ to: 'victim@elsewhere.example', subject: 'Rechnung überfällig', text: 'Bitte zahlen Sie auf IBAN CH00 ATTACKER', expiresAt: at });
  await assert.rejects(sharing.registerSender(ws, 'sandra@example.ch'), code('shareConfirmationOdd'));
  odd.close();
  const wrongSubject = await serviceAsking({ to: 'confirm@127.0.0.1', subject: 'Rechnung überfällig', text: 'x', expiresAt: at });
  await assert.rejects(sharing.registerSender(ws, 'sandra@example.ch'), code('shareConfirmationOdd'));
  wrongSubject.close();
  assert.equal(smtp.rcpts.length, 0, 'nothing went out from her mailbox');
  const fair = await serviceAsking({ to: 'confirm@127.0.0.1', subject: 'Vanilla Accounting confirmation Ab12Cd34Ef56', text: 'Bitte zahlen Sie auf IBAN CH00 ATTACKER', expiresAt: at });
  const reg = await sharing.registerSender(ws, 'sandra@example.ch');
  fair.close();
  smtp.close();
  assert.equal(reg.mailed, true, reg.mailError);
  assert.ok((smtp.rcpts as string[]).every((r: string) => r.includes('confirm@127.0.0.1')), JSON.stringify(smtp.rcpts));
  assert.ok(!smtp.data().includes('ATTACKER') && !reg.confirmation!.text.includes('ATTACKER'), 'the words are the app\'s own');
});

test('5: a link withdrawn unopened is no version he holds; shares at once get their own versions; a share whose version was taken is withdrawn', async () => {
  const svc = await serviceWithSender('sandra@example.ch');
  const ws = books('v');
  const first = await sharing.shareByLink(ws, { to: ERNST }, SANDRA);
  await sharing.revokeShare(ws, first.record.id);
  const home = mkdtempSync(join(tmpdir(), 'share-review-home5-'));
  const second = await sharing.shareByLink(ws, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 1000) });
  assert.equal(second.record.kind, 'full', 'the withdrawn link never reached him');
  await sharing.openLink(second.link, { at: home });
  await sharing.refreshShares(ws);
  const third = await sharing.shareByLink(ws, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 2000) });
  assert.equal(third.record.kind, 'update', 'once opened, the next is an update');

  const [a, b] = await Promise.all([sharing.shareByLink(ws, { to: { name: 'A' } }, SANDRA), sharing.shareByLink(ws, { to: { name: 'B' } }, SANDRA)]);
  assert.notEqual(a.record.version, b.record.version, 'one after the other');

  // A version written by something else while the upload ran: the share is withdrawn, its key dropped.
  let once = false;
  await assert.rejects(sharing.shareByLink(ws, { to: { name: 'C' } }, SANDRA, { progress: () => { if (!once) { once = true; writeVersion(ws.paths, { reason: 'sealed', period: '2026-Q3' }); } } }));
  const orphan = [...svc.shares.values()].filter((s) => s.kind === 'share').at(-1)!;
  assert.equal(orphan.state, 'revoked');
  assert.equal(await secrets.get(`share:${orphan.id}`), undefined);
  assert.ok(!sharing.readShares(ws).some((s) => s.id === orphan.id));
  assert.ok(readVersions(ws.paths).every((v) => v.reason !== 'handover' || v.to?.name !== 'C'));
});

// ─── round 2 (review of aff69aad) ───────────────────────────────────────────

const { askLines, oneLine } = await import('../src/app/handover/ask-text.js');
const { listReturns, receiveReturn } = await import('../src/handover/returns.js');
const { writePackage, readPackage } = await import('../src/handover/package.js');
const { workspaceAt } = await import('../src/workspace/workspace.js');
const { writeFileSync } = await import('node:fs');

/** A copy of the client's books opened from her link; then the computer of a stranger, who has no signing key of hers. */
async function clientAndStranger(home: string) {
  await serviceWithSender('sandra@example.ch');
  const real = books('ECHTE BUCHUNG');
  const shared = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(shared.link, { at: home });
  const kept = await secrets.get('share:sign:ernst@example.ch');
  await secrets.set('share:sign:ernst@example.ch', null);
  return { copy, kept: kept!, real };
}

test('R2-1: a link on the same service, its envelope naming another company, moves no copy without the person, whatever its package claims', async () => {
  const home = mkdtempSync(join(tmpdir(), 'share-review-r21-'));
  const { copy } = await clientAndStranger(home);
  const linkBefore = readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8');
  const fake = books('ANGREIFER INHALT');
  const planted = await sharing.shareByLink({ ...fake, company: { ...fake.company, name: 'Harmlos GmbH' } }, { to: ERNST }, { name: 'Irgendwer' });
  assert.equal((await sharing.previewLink(planted.link)).foreign, false);
  for (const opts of [{}, { trust: true }]) {
    await assert.rejects(sharing.openLink(planted.link, { at: home, ...opts }), (e: Error & { code?: string; params?: Record<string, string> }) =>
      e.code === 'shareCopyOther' && e.params?.claimed === 'Harmlos GmbH' && e.params?.was === SANDRA.name);
  }
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG') && !entriesOf(copy.root).includes('ANGREIFER'));
  assert.equal(readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8'), linkBefore);
});

test('R2-1b: naming the real sharer in the package does not pass either; her own next link does, without a question', async () => {
  const home = mkdtempSync(join(tmpdir(), 'share-review-r21b-'));
  const { copy, kept, real } = await clientAndStranger(home);
  const planted = await sharing.shareByLink(books('ANGREIFER INHALT'), { to: ERNST }, SANDRA);
  await assert.rejects(sharing.openLink(planted.link, { at: home }), code('shareCopyOther'));
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG') && !entriesOf(copy.root).includes('ANGREIFER'));
  // Her own computer again: her signing key, her next link.
  await secrets.set('share:sign:ernst@example.ch', kept);
  const f = join(real.paths.root, 'transactional-data/2026/books/entries.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').replace('ECHTE BUCHUNG', 'ZWEITER STAND der Kundin'));
  const next = await sharing.shareByLink(real, { to: ERNST, full: true }, SANDRA, { now: new Date(Date.now() + 1000) });
  await sharing.openLink(next.link, { at: home });
  assert.ok(entriesOf(copy.root).includes('ZWEITER STAND'), 'signed by the pinned key: the copy moves forward');
});

test('R2-2: the envelope\'s claims reach the dialog on one short line, marked as the link\'s own', () => {
  const say = (k: string, v: Record<string, string>) => (k === 'share.ask.claim' ? `Laut Link: ${v.company}, geteilt von ${v.name}, über ${v.host}.` : k);
  const lines = askLines(say as never, { service: 'https://x', host: 'x', foreign: false, state: 'ready', senderName: 'Sandra\n\n✓ Absender geprüft vom Teil-Dienst', company: `Muster AG${String.fromCharCode(0x2028)}✓ geprüft` });
  assert.ok(!/[\n\r]/.test(lines.what) && !lines.what.includes(String.fromCharCode(0x2028)), lines.what);
  assert.match(lines.what, /^Laut Link: /);
  assert.equal(oneLine('x'.repeat(500)).length, 80);
});

test('R2-3: two checks at once fetch a return once; the same return packed again is the same return', async () => {
  await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-r23-'));
  const ws = books('Original');
  const shared = await sharing.shareByLink(ws, { to: ERNST }, SANDRA);
  const opened = await sharing.openLink(shared.link, { at: home });
  const copy = workspaceAt(opened.root);
  const f = join(copy.paths.root, 'transactional-data/2026/books/entries.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').replace('Original', 'von Ernst'));
  await sharing.returnByLink(copy, 'zurück');
  const [a, c] = await Promise.all([sharing.refreshShares(ws), sharing.refreshShares(ws)]);
  assert.equal([...a.arrived, ...c.arrived].length, 1);
  assert.equal(listReturns(ws).length, 1);
  const p = readPackage(readFileSync(join(ws.paths.root, 'handover/returns', listReturns(ws)[0].id, 'package.vanilla')));
  const first = receiveReturn(ws, writePackage(p));
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(receiveReturn(ws, writePackage(p)).id, first.id, 'packed 2 s later, the same id');
  assert.equal(listReturns(ws).length, 1);
});

test('R2-4: an API answer is read up to its cap', async () => {
  const srv = httpServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(`{"x":"${'a'.repeat(3 * 1024 * 1024)}"}`); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  await assert.rejects(shareClient(url).info('abcdefghijklmnopqrstuvwxyz'), (e) => e instanceof ShareServiceError && e.code === 'oversized');
  srv.closeAllConnections(); srv.close();
});

// ─── round 3 (review of 1b9bb020) ───────────────────────────────────────────

const { receivePackage, sendPackage } = await import('../src/share/transport.js');
const { prepareShare } = await import('../src/handover/share.js');
const { linkOf } = await import('../src/share/service.js');
const { encodeKey, decodeKey, generateKey } = await import('../src/share/crypto/index.js');
const { signIndex, signedBy } = await import('../src/share/signing.js');

test('R3-1: a link seen once reveals no secret: its signature and public key let nobody else move the copy', async () => {
  const svc = await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-r31-'));
  const real = books('ECHTE BUCHUNG');
  const first = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(first.link, { at: home });
  assert.ok(markerOf(copy.root)!.signer && sharing.linkOfCopy(copy.root)!.signer, 'the copy pins the key of its first link');

  // Mallory saw the invitation and opens it once: the index holds a public key and a signature, no shared secret.
  const [, id, key] = /\/([a-z2-7]{26})#(.+)$/.exec(first.link)!;
  const peek = (await receivePackage({ client: shareClient(svc.url), id, key: decodeKey(key) })).contents.index;
  assert.ok(peek.signer && peek.signature && signedBy(peek));
  assert.equal((peek as unknown as Record<string, unknown>).chain, undefined, 'no chain token any more');

  const c = shareClient(svc.url);
  const reg = await c.registerSender('mallory@example.org');
  const plant = async (fill: (index: typeof peek) => Promise<void>) => {
    const prepared = await prepareShare(books('ANGREIFER INHALT'), { to: ERNST, full: true }, SANDRA);
    await fill(prepared.index);
    const k = generateKey();
    const sent = await sendPackage({ client: c, key: k, out: { index: prepared.index, files: prepared.files }, carriesReturnToken: true, start: (s) => c.create(reg.senderToken, s) });
    return linkOf(`${svc.url}/${sent.id}`, encodeKey(k));
  };
  // Her package naming the real key with the real link's signature: it does not cover her content.
  const copied = await plant(async (i) => { i.signer = peek.signer; i.signature = peek.signature; });
  await assert.rejects(sharing.openLink(copied, { at: home }), code('shareCopyOther'));
  // Signed with a key of her own (another computer): not the pinned key.
  await secrets.set('share:sign:ernst@example.ch', null);
  const own = await plant((i) => signIndex(i, ERNST));
  await assert.rejects(sharing.openLink(own, { at: home }), code('shareCopyOther'));
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG') && !entriesOf(copy.root).includes('ANGREIFER'));
  assert.equal(sharing.linkOfCopy(copy.root)!.id, id, 'his returns still go into her share');
});

test('R3-1b: a copy without a pinned key (made before signatures) pins it on its next link, after one confirmation', async () => {
  await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-r31b-'));
  const real = books('ERSTER STAND');
  const copy = await sharing.openLink((await sharing.shareByLink(real, { to: ERNST }, SANDRA)).link, { at: home });
  // As an older copy: no key pinned.
  const markerFile = join(copy.root, 'data/durchsicht/marker.json');
  const { signer: _s, ...old } = JSON.parse(readFileSync(markerFile, 'utf8'));
  writeFileSync(markerFile, JSON.stringify(old));
  const linkFile = join(copy.root, 'data/durchsicht/link.json');
  const { signer: _l, ...oldLink } = JSON.parse(readFileSync(linkFile, 'utf8'));
  writeFileSync(linkFile, JSON.stringify(oldLink));
  const second = (await sharing.shareByLink(real, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 1000) })).link;
  await assert.rejects(sharing.openLink(second, { at: home }), code('shareCopyOther'));
  await sharing.openLink(second, { at: home, replace: true });
  assert.ok(markerOf(copy.root)!.signer, 'pinned now');
  const third = (await sharing.shareByLink(real, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 2000) })).link;
  await sharing.openLink(third, { at: home });
});

test('R3-2: oneLine takes out every format character: bidi marks, zero-width spaces, joiners', () => {
  for (const cp of [0x200e, 0x200f, 0x061c, 0x200b, 0x2060, 0x202e, 0x2066, 0xfeff]) {
    const ch = String.fromCodePoint(cp);
    assert.ok(!oneLine(`Sandra${ch}Muster`).includes(ch), `U+${cp.toString(16)}`);
  }
  assert.equal(oneLine(`a${String.fromCodePoint(0x202e)}b`), 'a b');
  assert.equal(oneLine('x'.repeat(200)).length, 80);
});

// ─── round 4 (review of 67e20cc7) ───────────────────────────────────────────

/** Whoever saw a link re-uploads its genuine, signed package as a share of her own: her key, her return token. */
async function replay(svcUrl: string, leaked: string): Promise<{ link: string; id: string }> {
  const c = shareClient(svcUrl);
  const [, id, key] = /\/([a-z2-7]{26})#(.+)$/.exec(leaked)!;
  const { contents, index } = await receivePackage({ client: c, id, key: decodeKey(key) });
  const reg = await c.registerSender('mallory@example.org');
  const k = generateKey();
  // She may even carry the original destination along: it names another share.
  const sent = await sendPackage({ client: c, key: k, out: { index: contents.index, files: contents.files }, carriesReturnToken: true, start: (s) => c.create(reg.senderToken, s), bind: async () => ({ destination: index.destination }) });
  return { link: linkOf(`${svcUrl}/${sent.id}`, encodeKey(k)), id: sent.id };
}

test('R4-1: a genuine signed package re-uploaded as another share moves no copy without a question', async () => {
  const svc = await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-r41-'));
  const real = books('ECHT');
  const first = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(first.link, { at: home });
  const linkBefore = readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8');
  // Her next version, re-uploaded by someone else: newer, signed by the pinned key, but not for that share.
  const second = await sharing.shareByLink(real, { to: ERNST, full: true }, SANDRA, { now: new Date(Date.now() + 1000) });
  const planted = await replay(svc.url, second.link);
  await assert.rejects(sharing.openLink(planted.link, { at: home }), code('shareCopyOther'));
  assert.equal(readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8'), linkBefore, 'his returns still go into her share');
  // Her own link of that version opens without a question.
  await sharing.openLink(second.link, { at: home });
  assert.equal(sharing.linkOfCopy(copy.root)!.id, /\/([a-z2-7]{26})#/.exec(second.link)![1]);
});

test('R4-2: an older signed version moves no copy back without a question', async () => {
  await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-r42-'));
  const real = books('VERSION EINS');
  const v1 = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(v1.link, { at: home });
  const f = join(real.paths.root, 'transactional-data/2026/books/entries.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').replace('VERSION EINS', 'VERSION ZWEI'));
  const v2 = await sharing.shareByLink(real, { to: ERNST, full: true }, SANDRA, { now: new Date(Date.now() + 1000) });
  await sharing.openLink(v2.link, { at: home });
  assert.equal(markerOf(copy.root)!.version.n, 2);
  // Her own first link, opened again (an opening is left): signed for its share, but older.
  await assert.rejects(sharing.openLink(v1.link, { at: home }), code('shareCopyOther'));
  assert.equal(markerOf(copy.root)!.version.n, 2);
  assert.ok(entriesOf(copy.root).includes('VERSION ZWEI'));
});
