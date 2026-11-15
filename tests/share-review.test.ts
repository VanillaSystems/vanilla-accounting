/**
 * The security review of PR #538, each probe turned around, as far as it still holds after the
 * owner's decision of 2026-11-15 (no end-to-end encryption, no signatures, no pinning: a link opens
 * like a `.vanilla` file does).
 *
 * 1. A link a web page hands over (`vanilla-accounting://…&service=<another host>`) opens only
 *    when the person confirmed it.
 * 2. Checking the shares and sharing at the same time lose no share from shares.json.
 * 3. A service that sends more than an object's size is cut off, by Content-Length or while streaming.
 * 4. The service chooses neither whom the confirmation e-mail goes to, nor its subject, nor its words.
 * 5. Every share is whole, opened or not; two shares at once each get their own version, and a share
 *    whose version was taken meanwhile is withdrawn.
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

test('1: a link naming another service opens only when confirmed; then it opens like a file, no pinning question', async () => {
  const home = mkdtempSync(join(tmpdir(), 'share-review-home-'));
  await serviceWithSender('sandra@example.ch');
  const shared = await sharing.shareByLink(books('ECHTE BUCHUNG der Kundin'), { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(shared.link, { at: home });
  const linkBefore = readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8');

  const evil = await serviceWithSender('attacker@example.org');
  const planted = await sharing.shareByLink(books('ANDERER INHALT'), { to: ERNST }, SANDRA, { now: new Date(Date.now() + 1000) });
  const [, id] = /\/([a-z2-7]{26})$/.exec(planted.link)!;
  const scheme = `vanilla-accounting://open?share=${id}&service=${encodeURIComponent(evil.url)}`;
  process.env.VANILLA_SHARE_SERVICE = sharing.linkOfCopy(copy.root)!.service; // the fiduciary's app uses the real service

  const preview = await sharing.previewLink(scheme);
  assert.equal(preview.foreign, true);
  assert.equal(preview.host, new URL(evil.url).host);
  assert.equal(evil.shares.get(id)!.opens.length, 0, 'a preview is no opening');
  await assert.rejects(sharing.openLink(scheme, { at: home }), code('shareForeignService'), 'not without the person');
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG') && !entriesOf(copy.root).includes('ANDERER'), 'the copy is as it was');
  assert.equal(readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8'), linkBefore);
  // The service confirmed, the link still does not move the copy, which came by another link (review of #551): she is asked.
  await assert.rejects(sharing.openLink(scheme, { at: home, trust: true }), code('shareCopyOther'));
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG') && !entriesOf(copy.root).includes('ANDERER'), 'the copy is as it was');
  assert.equal(readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8'), linkBefore);
  // «Bestehende Kopie ersetzen», her answer: then it moves.
  await sharing.openLink(scheme, { at: home, trust: true, copy: 'replace' });
  assert.equal(sharing.linkOfCopy(copy.root)!.service, evil.url);
  assert.ok(entriesOf(copy.root).includes('ANDERER INHALT'));
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
  const sharing2 = sharing.shareByLink(ws, { to: { name: 'Zweite Person', email: 'zweite@example.ch' } }, SANDRA, { now: new Date(Date.now() + 1000) });
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
  await assert.rejects(client.download({ object: 'package', method: 'GET', url: `${url}/storage/x` }, 64 * 1024, () => undefined), (e) => e instanceof ShareServiceError && e.code === 'oversized', 'by Content-Length');
  await assert.rejects(client.download({ object: 'package', method: 'GET', url: `${url}/storage/x?chunked` }, 64 * 1024, () => undefined), (e) => e instanceof ShareServiceError && e.code === 'oversized', 'while streaming');
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

test('5: every share is whole, withdrawn, opened or not; shares at once get their own versions; a share whose version was taken is withdrawn', async () => {
  const svc = await serviceWithSender('sandra@example.ch');
  const ws = books('v');
  const first = await sharing.shareByLink(ws, { to: ERNST }, SANDRA);
  await sharing.revokeShare(ws, first.record.id);
  const home = mkdtempSync(join(tmpdir(), 'share-review-home5-'));
  const second = await sharing.shareByLink(ws, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 1000) });
  assert.equal(second.record.kind, 'full');
  await sharing.openLink(second.link, { at: home });
  await sharing.refreshShares(ws);
  const third = await sharing.shareByLink(ws, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 2000) });
  assert.equal(third.record.kind, 'full', 'once opened, the next is whole too');

  const [a, b] = await Promise.all([sharing.shareByLink(ws, { to: { name: 'A', email: 'a@example.ch' } }, SANDRA), sharing.shareByLink(ws, { to: { name: 'B', email: 'b@example.ch' } }, SANDRA)]);
  assert.notEqual(a.record.version, b.record.version, 'one after the other');

  // A version written by something else while the upload ran: the share is withdrawn, its tokens dropped.
  let once = false;
  await assert.rejects(sharing.shareByLink(ws, { to: { name: 'C', email: 'c@example.ch' } }, SANDRA, { progress: () => { if (!once) { once = true; writeVersion(ws.paths, { reason: 'sealed', period: '2026-Q3' }); } } }));
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

test('R3-2: oneLine takes out every format character: bidi marks, zero-width spaces, joiners', () => {
  for (const cp of [0x200e, 0x200f, 0x061c, 0x200b, 0x2060, 0x202e, 0x2066, 0xfeff]) {
    const ch = String.fromCodePoint(cp);
    assert.ok(!oneLine(`Sandra${ch}Muster`).includes(ch), `U+${cp.toString(16)}`);
  }
  assert.equal(oneLine(`a${String.fromCodePoint(0x202e)}b`), 'a b');
  assert.equal(oneLine('x'.repeat(200)).length, 80);
});

// ─── round 4 (review of 67e20cc7) ───────────────────────────────────────────

test('R4-2: an older state moves no copy back, and says so plainly', async () => {
  await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-r42-'));
  const real = books('VERSION EINS');
  const v1 = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(v1.link, { at: home });
  const f = join(real.paths.root, 'transactional-data/2026/books/entries.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').replace('VERSION EINS', 'VERSION ZWEI'));
  const v2 = await sharing.shareByLink(real, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 1000) });
  // A new share (not «Aktualisieren»): another link than the copy's, so she answers once.
  await sharing.openLink(v2.link, { at: home, copy: 'replace' });
  assert.equal(markerOf(copy.root)!.version.n, 2);
  // Her first link, opened again: another link than the copy's, so asked first; replacing, older than the copy, said plainly, nothing rolls back.
  await assert.rejects(sharing.openLink(v1.link, { at: home }), code('shareCopyOther'));
  await assert.rejects(sharing.openLink(v1.link, { at: home, copy: 'replace' }), code('shareCopyNewer'));
  assert.equal(markerOf(copy.root)!.version.n, 2);
  assert.ok(entriesOf(copy.root).includes('VERSION ZWEI'));
});

// ─── the owner's verdict of 2026-11-15: sharing heals itself ────────────────

const { rmSync, existsSync, mkdirSync, readdirSync } = await import('node:fs');

/** Books with receipt files of the open year, like the owner's: a link carries them all every time. */
function booksWithReceipts(desc: string) {
  const ws = books(desc);
  const dir = join(ws.paths.root, 'transactional-data/2026/receipts');
  mkdirSync(dir, { recursive: true });
  for (const r of ['a', 'b', 'c']) writeFileSync(join(dir, `${r}.pdf`), `%PDF-1.4 ${r}`);
  return ws;
}

test('H1: his copy deleted, the next link opens on this computer with no error; the sharer did nothing special', async () => {
  await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-h1-'));
  const real = booksWithReceipts('ERSTER STAND');
  const first = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(first.link, { at: home });
  rmSync(copy.root, { recursive: true, force: true });
  const f = join(real.paths.root, 'transactional-data/2026/books/entries.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').replace('ERSTER STAND', 'ZWEITER STAND'));
  // Her plain next share: no option, no question.
  const next = await sharing.shareByLink(real, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 1000) });
  const opened = await sharing.openLink(next.link, { at: home });
  assert.ok(entriesOf(opened.root).includes('ZWEITER STAND'));
  for (const r of ['a', 'b', 'c']) assert.ok(existsSync(join(opened.root, `transactional-data/2026/receipts/${r}.pdf`)), `${r}.pdf is there`);
  assert.ok(sharing.linkOfCopy(opened.root)?.returnToken, 'his return goes into the new share');
});

test('H2: a copy missing one receipt heals with the next link, and with the same link opened again', async () => {
  await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-h2-'));
  const real = booksWithReceipts('STAND');
  const first = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(first.link, { at: home });
  const b = join(copy.root, 'transactional-data/2026/receipts/b.pdf');
  rmSync(b);
  // The same link again: the copy is whole again, no question.
  await sharing.openLink(first.link, { at: home });
  assert.equal(readFileSync(b, 'utf8'), '%PDF-1.4 b');
  rmSync(b);
  const next = await sharing.shareByLink(real, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 1000) });
  // A new share, not «Aktualisieren» of the first: asked once (review of #551), «Bestehende Kopie ersetzen» heals it.
  await assert.rejects(sharing.openLink(next.link, { at: home }), code('shareCopyOther'));
  await sharing.openLink(next.link, { at: home, copy: 'replace' });
  assert.equal(readFileSync(b, 'utf8'), '%PDF-1.4 b');
});

// ─── review of #551: a link never takes over a copy silently ────────────────

test('551-1: a package from any confirmed sender, naming the firm and the real sharer, takes no copy over: asked, nothing written; her «Aktualisieren» still moves the copy', async () => {
  const svc = await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-551-'));
  const real = books('ECHTE BUCHUNG');
  const shared = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(shared.link, { at: home });
  const linkBefore = readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8');
  const markerBefore = readFileSync(join(copy.root, 'data/durchsicht/marker.json'), 'utf8');

  // Another confirmed sender of the same service: the same firm, her name as sender, a far higher version.
  await sharing.registerSender(books('x'), 'mallory@example.org');
  const fake = books('UNTERGESCHOBEN');
  for (let i = 0; i < 5; i++) writeVersion(fake.paths, { reason: 'sealed', period: '2026-Q3' });
  const planted = await sharing.shareByLink(fake, { to: ERNST }, SANDRA, { now: new Date(Date.now() + 1000) });
  assert.ok(readVersions(fake.paths).at(-1)!.n > markerOf(copy.root)!.version.n);

  await assert.rejects(sharing.openLink(planted.link, { at: home }), (e: Error & { code?: string; params?: Record<string, string> }) =>
    e.code === 'shareCopyOther' && e.params?.was === SANDRA.name && e.params?.now === SANDRA.name);
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG') && !entriesOf(copy.root).includes('UNTERGESCHOBEN'), 'the copy is as it was');
  assert.equal(readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8'), linkBefore, 'his return still goes to her share');
  assert.equal(readFileSync(join(copy.root, 'data/durchsicht/marker.json'), 'utf8'), markerBefore);

  // Her «Aktualisieren» into the same share moves the copy forward without a question.
  const f = join(real.paths.root, 'transactional-data/2026/books/entries.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').replace('ECHTE BUCHUNG', 'ECHTE BUCHUNG NEU'));
  await sharing.updateByLink(real, shared.record.id, SANDRA, { now: new Date(Date.now() + 2000) });
  const checked = await sharing.checkCopy(copy.root);
  assert.equal(checked.state, 'updated');
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG NEU'));
  assert.equal(sharing.linkOfCopy(copy.root)!.id, shared.record.id);

  // «Als neue Kopie öffnen»: a second copy beside it; hers and its link stay.
  const beside = await sharing.openLink(planted.link, { at: home, copy: 'new' });
  assert.notEqual(beside.root, copy.root);
  assert.ok(entriesOf(beside.root).includes('UNTERGESCHOBEN'));
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG NEU'));
  assert.equal(sharing.linkOfCopy(copy.root)!.id, shared.record.id);
  assert.equal(sharing.linkOfCopy(beside.root)!.id, planted.record.id);
  // Each link goes on to its own copy: opened again, no question.
  await sharing.openLink(planted.link, { at: home });
  await sharing.openLink(shared.link, { at: home });
  assert.ok(svc.shares.size >= 2);
});

test('551-1b: a file of another sender beside a copy opens as a new copy; the copy here is not moved', async () => {
  await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-551b-'));
  const { makeShare } = await import('../src/handover/share.js');
  const { openPackage } = await import('../src/handover/durchsicht.js');
  const mine = openPackage((await makeShare(books('VON SANDRA'), { to: ERNST }, SANDRA)).bytes, new Date(), home);
  const other = await makeShare(books('VON JEMAND ANDEREM'), { to: ERNST }, { name: 'Jemand Anderes' });
  assert.throws(() => openPackage(other.bytes, new Date(), home), code('shareCopyOther'));
  const beside = openPackage(other.bytes, new Date(), home, { otherAsNew: true });
  assert.notEqual(beside.root, mine.root);
  assert.ok(entriesOf(mine.root).includes('VON SANDRA'));
});

test('551-6: a newer state whose firm name changed moves the copy in its folder, never a second copy beside it; a folder that is no copy is never written over', async () => {
  await serviceWithSender('sandra@example.ch');
  const home = mkdtempSync(join(tmpdir(), 'share-review-5516-'));
  const real = books('STAND');
  const ws = real as { company: { name: string; uid?: string } };
  ws.company = { ...ws.company, name: 'Alpha GmbH', uid: undefined };
  // Something of the person's in the folder the copy would take: it stays, the copy goes beside it.
  mkdirSync(join(home, 'alpha-gmbh'), { recursive: true });
  writeFileSync(join(home, 'alpha-gmbh', 'mine.txt'), 'meins');
  const shared = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const copy = await sharing.openLink(shared.link, { at: home });
  assert.equal(copy.root, join(home, 'alpha-gmbh-2'));
  assert.equal(readFileSync(join(home, 'alpha-gmbh', 'mine.txt'), 'utf8'), 'meins');
  ws.company = { ...ws.company, name: 'Beta AG' };
  await sharing.updateByLink(real, shared.record.id, SANDRA, { now: new Date(Date.now() + 1000) });
  assert.equal((await sharing.checkCopy(copy.root)).state, 'updated');
  assert.deepEqual(readdirSync(home).sort(), ['alpha-gmbh', 'alpha-gmbh-2']);
  assert.equal(markerOf(copy.root)!.firm.name, 'Beta AG');
});

test('551-7: a note of «Aktualisieren» that does not go out leaves the update done and says why; «Nochmals senden» sends the note', async () => {
  const svc = await serviceWithSender('sandra@example.ch');
  const real = books('STAND');
  const shared = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  svc.refuse(/\/invite$/, 503, { error: 'Der Dienst hat heute schon 100 Einladungen verschickt.', code: 'mailsPerDay', limit: 100, per: 'day' });
  const done = await sharing.updateByLink(real, shared.record.id, SANDRA, { notify: true, now: new Date(Date.now() + 1000) });
  assert.ok(done.updatedAt, 'the update is done');
  assert.equal(done.version, 2);
  assert.match(done.notifyError ?? '', /100 Einladungen/);
  const again = await sharing.inviteAgain(real, shared.record.id, SANDRA);
  assert.equal(again.notifyError, undefined);
  assert.ok(again.notifiedAt);
  assert.equal(svc.mails.at(-1)!.kind, 'update');
});

test('551-4: a check fetches a small return by itself; a larger one waits at the service until the sharer fetches it', async () => {
  await serviceWithSender('sandra@example.ch');
  const real = books('STAND');
  const shared = await sharing.shareByLink(real, { to: ERNST }, SANDRA);
  const opened: string[] = [];
  const big = 30 * 1024 * 1024;
  const stub = (() => ({
    status: async () => ({ state: 'ready', opens: [], returns: [
      { id: 'small', state: 'ready', bytes: 4000, createdAt: new Date().toISOString() },
      { id: 'large', state: 'ready', bytes: big, createdAt: new Date().toISOString() },
    ] }),
    open: async (id: string) => { opened.push(id); throw new ShareServiceError('nicht da', 'notFound', 404); },
  })) as unknown as Parameters<typeof sharing.refreshShares>[2];
  await sharing.refreshShares(real, new Date(), stub);
  assert.deepEqual(opened, ['small'], 'only the small return is fetched by the check');
  const large = sharing.readShares(real).find((r) => r.id === shared.record.id)!.returns.find((r) => r.id === 'large')!;
  assert.equal(large.received, undefined);
  assert.equal(large.bytes, big);
  // «Holen»: fetched now that she asks; its failure is said in words.
  await assert.rejects(sharing.fetchReturn(real, shared.record.id, 'large', new Date(), stub), code('shareReturnFailed'));
  assert.deepEqual(opened, ['small', 'large']);
});
