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

  // Someone who knows the client's UID makes a share of other books on his own service.
  const evil = await serviceWithSender('attacker@example.org');
  const planted = await sharing.shareByLink(books('ANGREIFER INHALT'), { to: ERNST }, SANDRA);
  const [, id, key] = /\/([a-z2-7]{26})#(.+)$/.exec(planted.link)!;
  const scheme = `vanilla-accounting://open?share=${id}&service=${encodeURIComponent(evil.url)}#${key}`;
  process.env.VANILLA_SHARE_SERVICE = before.service; // the fiduciary's app uses the real service

  // The preview says it plainly, without spending an opening.
  const preview = await sharing.previewLink(scheme, { at: home });
  assert.equal(preview.foreign, true);
  assert.equal(preview.host, new URL(evil.url).host);
  assert.equal(preview.copy?.sharer, SANDRA.name, 'the copy it would move is named');
  assert.equal(evil.shares.get(id)!.opens.length, 0, 'a preview is no opening');

  await assert.rejects(sharing.openLink(scheme, { at: home }), code('shareForeignService'), 'not without the person');
  await assert.rejects(sharing.openLink(scheme, { at: home, trust: true }), code('shareCopyOther'), 'another service for this copy: not without the person');
  assert.ok(entriesOf(copy.root).includes('ECHTE BUCHUNG') && !entriesOf(copy.root).includes('ANGREIFER'), 'the copy is as it was');
  assert.equal(readFileSync(join(copy.root, 'data/durchsicht/link.json'), 'utf8'), linkBefore, 'its link too: the return still goes to the real service');
  assert.equal(markerOf(copy.root)!.sharer.name, SANDRA.name);

  // Confirmed by the person, it opens.
  await sharing.openLink(scheme, { at: home, trust: true, replace: true });
  assert.equal(sharing.linkOfCopy(copy.root)!.service, evil.url);
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
  const second = await sharing.shareByLink(ws, { to: { name: 'Zweite Person' } }, SANDRA, { now: new Date(Date.now() + 1000) });
  release();
  await refreshing;
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
