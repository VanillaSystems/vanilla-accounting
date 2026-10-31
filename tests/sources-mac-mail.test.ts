/**
 * The Mail app of this Mac as a source (src/platform/sources/mac-mail.ts, reach `mac-mail`, the
 * app's sources/mail-client): the accounts listed for the person's pick, a pull that delivers
 * the PDFs and scans of the senders its reach lets through into the inbox, and nothing twice on
 * the next pull, nor after Mail numbered its messages anew; Mail closed or not permitted is the
 * outcome `mail-app` with nothing written. Against a stand-in for osascript, never the real Mail.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveSource, sources } from '../src/platform/sources/index.js';
import { pull, type PullRequest } from '../src/platform/sources/host.js';
import { readLedger } from '../src/platform/sources/ledger.js';
import { inProcessLauncher } from '../src/platform/sources/launcher.js';
import { MacMailError, addressOf, macMailAccounts, macMailBackend, problemOf, type Osascript } from '../src/platform/sources/mac-mail.js';
import { reachLines } from '../src/platform/sources/reach.js';
import type { MacMailProblem } from '../src/platform/sources/model.js';
import { APP_ROOT, type Workspace } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';

process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'mac-mail-approvals-'));

const pdf = (n: string) => Buffer.from(`%PDF-1.4\n% ${n}\n%%EOF\n`);
const photo = (n: string, size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(n), Buffer.alloc(size)]);

interface StoredMail { uid: number; sender: string; subject: string; date: string; messageId: string; files: Array<{ name: string; content: Buffer }> }
const MAILS: StoredMail[] = [
  { uid: 101, sender: 'Vendor Billing <billing@vendor.example>', subject: 'Invoice 1', date: '2026-10-01T08:00:00.000Z', messageId: '1@vendor', files: [{ name: 'invoice-1.pdf', content: pdf('one') }, { name: 'logo.png', content: Buffer.from('tiny logo') }] },
  { uid: 102, sender: 'news@spam.example', subject: 'Offer', date: '2026-10-02T08:00:00.000Z', messageId: '2@spam', files: [{ name: 'offer.pdf', content: pdf('offer') }] },
  { uid: 103, sender: 'Shop <orders@shop.example>', subject: 'Your receipt', date: '2026-10-03T08:00:00.000Z', messageId: '3@shop', files: [{ name: 'scan.jpg', content: photo('receipt', 60_000) }] },
];

/**
 * A stand-in for osascript and Mail: it answers the three scripts as Mail would, from `mails`,
 * and writes attachments into the folder the host names, as Mail's `save` does.
 */
function fakeMail(opts: { mails?: StoredMail[]; problem?: MacMailProblem; accounts?: Array<{ name: string; addresses: string[]; mailboxes: string[] }> } = {}): Osascript & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (script: string, args: string[]) => {
    calls.push(args);
    if (opts.problem === 'not-permitted') throw new MacMailError('not-permitted', 'Not authorized to send Apple events to Mail. (-1743)');
    if (opts.problem) return JSON.stringify({ error: opts.problem });
    const mails = opts.mails ?? MAILS;
    if (script.includes('emailAddresses')) return JSON.stringify({ accounts: opts.accounts ?? [{ name: 'Office', addresses: ['office@example.com'], mailboxes: ['Archive', 'INBOX', 'Sent Messages'] }] });
    if (args[0] !== 'Office') return JSON.stringify({ error: 'no-account' });
    if (args[1] !== 'INBOX') return JSON.stringify({ error: 'no-mailbox' });
    if (script.includes('mailAttachments')) {
      const [, , uid, dir] = args;
      const m = mails.find((x) => x.uid === Number(uid));
      return JSON.stringify({ parts: (m?.files ?? []).map((f, i) => { const path = join(dir, `${i}-${f.name}`); writeFileSync(path, f.content); return { name: f.name, path }; }) });
    }
    const [, , after, since, limit] = args;
    const ids = mails.filter((m) => (after ? m.uid > Number(after) : Date.parse(m.date) > Date.parse(since))).slice(0, Number(limit));
    // Mail hands messages in its own order, not by id.
    return JSON.stringify({ validity: mails.length ? String(Math.min(...mails.map((m) => m.uid))) : '', messages: ids.reverse().map(({ files: _f, ...m }) => m) });
  }) as Osascript & { calls: string[][] };
  run.calls = calls;
  return run;
}

const YAML = `label: Office
code: app:mail-client
reach:
  mac-mail: { account: Office, folders: [INBOX], from: ["*"], skip: ["*@spam.example"] }
feeds:
  attachments: { output: document, every: daily }
`;

function office(yaml = YAML): Workspace {
  const ws = tempWorkspace('mac-mail-');
  mkdirSync(join(ws.paths.root, 'sources', 'office'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'sources', 'office', 'source.yaml'), yaml);
  const v = sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office');
  assert.ok(v && v.kind !== 'invalid', JSON.stringify(v));
  approveSource(ws, v.decl);
  return ws;
}

const req = (ws: Workspace, run: Osascript, over: Partial<PullRequest> = {}): PullRequest =>
  ({ ws, appRoot: APP_ROOT, source: 'office', run: 'collect-1', mode: 'live', now: () => new Date('2026-10-10T00:00:00Z'), macMailBackend: (r) => macMailBackend(r, run), ...over });
const inbox = (ws: Workspace) => (existsSync(ws.paths.inbox) ? readdirSync(ws.paths.inbox).sort() : []);

test('the accounts of Mail, each with its inbox; none set up, or a «no» to the permission, is a problem the person can act on', async () => {
  assert.deepEqual(await macMailAccounts(fakeMail()), [{ name: 'Office', addresses: ['office@example.com'], mailboxes: ['Archive', 'INBOX', 'Sent Messages'], inbox: 'INBOX' }]);
  const exchange = await macMailAccounts(fakeMail({ accounts: [{ name: 'Work', addresses: [], mailboxes: ['Calendar', 'Inbox'] }] }));
  assert.equal(exchange[0].inbox, 'Inbox');
  await assert.rejects(macMailAccounts(fakeMail({ accounts: [] })), (e: MacMailError) => e.problem === 'no-account');
  await assert.rejects(macMailAccounts(fakeMail({ problem: 'not-permitted' })), (e: MacMailError) => e.problem === 'not-permitted');
  await assert.rejects(macMailAccounts(fakeMail({ problem: 'not-running' })), (e: MacMailError) => e.problem === 'not-running');
});

test('osascript failures read as the problems macOS reports', () => {
  assert.equal(problemOf({ stderr: 'execution error: Not authorized to send Apple events to Mail. (-1743)' }), 'not-permitted');
  assert.equal(problemOf({ stderr: "execution error: Error: Application isn't running. (-600)" }), 'not-running');
  assert.equal(problemOf({ killed: true, signal: 'SIGTERM' }), 'timeout');
  assert.equal(problemOf({ code: 'ENOENT' }), 'unavailable');
  assert.equal(problemOf({ stderr: 'something else' }), 'failed');
  assert.equal(addressOf('Vendor Billing <Billing@Vendor.example>'), 'billing@vendor.example');
  assert.equal(addressOf('plain@example.com'), 'plain@example.com');
});

test('a pull delivers the PDFs of the senders it may read, scans only when asked for, never a signature logo; a second pull delivers nothing', async () => {
  const plain = office();
  await pull(req(plain, fakeMail()));
  assert.deepEqual(inbox(plain), ['invoice-1.pdf'], 'photos are no documents unless settings.photos');
  const ws = office(YAML.replace('feeds:', 'settings: { photos: true }\nfeeds:'));
  const mail = fakeMail();
  const r = await pull(req(ws, mail));
  assert.equal(r.outcome, 'ok', JSON.stringify(r));
  assert.deepEqual(inbox(ws), ['invoice-1.pdf', 'scan.jpg'], 'the skipped sender\'s PDF and the small logo stay out');
  assert.deepEqual(readFileSync(join(ws.paths.inbox, 'invoice-1.pdf')), MAILS[0].files[0].content);
  const got = readLedger(ws, 'office').flatMap((l) => ('got' in l ? [l] : []));
  assert.deepEqual(got.map((l) => [l.key, l.got.kind === 'document' && l.got.from]), [['1@vendor#invoice-1.pdf', 'billing@vendor.example'], ['3@shop#scan.jpg', 'orders@shop.example']]);
  assert.ok(!mail.calls.some((a) => a[2] === '102' && a.length === 4), 'no attachment of a skipped sender was asked for');

  const again = await pull(req(ws, mail, { feeds: ['attachments'] }));
  assert.equal(again.outcome, 'ok');
  assert.deepEqual(again.feeds.map((f) => f.documents + f.duplicates), [0], 'the cursor stands after the last message');
  assert.deepEqual(inbox(ws), ['invoice-1.pdf', 'scan.jpg']);
});

test('Mail numbering its messages anew starts again from the window, and the ledger keeps the documents from arriving twice', async () => {
  const ws = office(YAML.replace('feeds:', 'settings: { photos: true }\nfeeds:'));
  await pull(req(ws, fakeMail()));
  const renumbered = MAILS.map((m, i) => ({ ...m, uid: i + 1 }));
  const r = await pull(req(ws, fakeMail({ mails: renumbered }), { feeds: ['attachments'] }));
  assert.equal(r.outcome, 'ok', JSON.stringify(r));
  assert.deepEqual(inbox(ws), ['invoice-1.pdf', 'scan.jpg']);
  const cursor = readLedger(ws, 'office').flatMap((l) => ('cursor' in l ? [l.cursor] : [])).at(-1);
  assert.deepEqual(cursor, { validity: '1', uid: 3 });
});

test('Mail closed, not permitted, or the account gone: the outcome mail-app, nothing written', async () => {
  for (const problem of ['not-running', 'not-permitted', 'no-account'] as const) {
    const ws = office();
    const r = await pull(req(ws, fakeMail({ problem })));
    assert.deepEqual(r, { outcome: 'mail-app', problem, feeds: [] });
    assert.deepEqual(inbox(ws), []);
    assert.deepEqual(readLedger(ws, 'office'), []);
  }
  const ws = office(YAML.replace('account: Office', 'account: Renamed'));
  assert.equal((await pull(req(ws, fakeMail()))).outcome, 'mail-app');
});

test('in the Mac app the app\'s own code runs in the process and delivers the same', async () => {
  const ws = office();
  const r = await pull(req(ws, fakeMail(), { launcher: inProcessLauncher }));
  assert.equal(r.outcome, 'ok', JSON.stringify(r));
  assert.deepEqual(inbox(ws), ['invoice-1.pdf']);
});

test('the reach reads as the account in the Mail app; a source with both ways to the mail is refused', () => {
  const ws = office();
  const v = sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office');
  assert.ok(v && v.kind !== 'invalid');
  assert.deepEqual(reachLines(v.decl.reach).map((l) => l.what), ['Office in the Mail app of this Mac · INBOX', 'from *', 'not from *@spam.example']);
  const both = tempWorkspace('mac-mail-both-');
  mkdirSync(join(both.paths.root, 'sources', 'office'), { recursive: true });
  writeFileSync(join(both.paths.root, 'sources', 'office', 'source.yaml'), YAML.replace('reach:\n', 'reach:\n  mail: { host: imap.example.com, account: office@example.com, from: ["*"] }\n'));
  const bad = sources(both, APP_ROOT).find((x) => x.kind === 'invalid' && x.id === 'office');
  assert.ok(bad && bad.kind === 'invalid' && bad.problems.some((p) => /not both/.test(p.message)), JSON.stringify(bad));
});
