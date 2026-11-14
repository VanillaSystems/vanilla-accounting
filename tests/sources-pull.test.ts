/**
 * A pull (src/platform/sources/host.ts, mail-channel.ts, the app's sources/imap): a bound mailbox
 * delivers the PDFs of the senders its reach lets through into the inbox, a file the inbox or the
 * ledger holds already as a duplicate; a second pull delivers nothing; a pull that crashed midway,
 * pulled again, gives the inbox a clean pull gives; a missing password stops only that source; code
 * that fetches is `changed`, code that reaches past its reach `over-reach`; a dry run writes
 * nothing. Against a stand-in mailbox, never a real one.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveSource, sources } from '../src/platform/sources/index.js';
import { pull, type PullRequest } from '../src/platform/sources/host.js';
import { readLedger } from '../src/platform/sources/ledger.js';
import type { MailBackend, MailSummary } from '../src/platform/sources/mail-channel.js';
import { APP_ROOT, type Workspace } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import { addSkip, skipOffers } from '../src/platform/sources/skip.js';

process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'pull-approvals-'));
const secretsFile = join(mkdtempSync(join(tmpdir(), 'pull-secrets-')), 'secrets.json');
process.env.VANILLA_SECRETS_FILE = secretsFile;
writeFileSync(secretsFile, JSON.stringify({ 'source:office:mail': 'app-password' }));

const pdf = (n: string) => Buffer.from(`%PDF-1.4\n% ${n}\n%%EOF\n`);
type Mail = MailSummary & { files: Array<{ filename: string; contentType: string; content: Buffer }> };
const MAILS: Mail[] = [
  { uid: 1, from: 'billing@vendor.example', to: ['office@example.com'], subject: 'Invoice 1', date: '2026-10-01T08:00:00Z', messageId: '<1@vendor>', files: [{ filename: 'invoice-1.pdf', contentType: 'application/pdf', content: pdf('one') }, { filename: 'logo.png', contentType: 'image/png', content: Buffer.from('png') }] },
  { uid: 2, from: 'news@spam.example', to: ['office@example.com'], subject: 'Offer', date: '2026-10-02T08:00:00Z', messageId: '<2@spam>', files: [{ filename: 'offer.pdf', contentType: 'application/pdf', content: pdf('offer') }] },
  { uid: 3, from: 'billing@vendor.example', to: ['office@example.com'], subject: 'Invoice 1 again', date: '2026-10-03T08:00:00Z', messageId: '<3@vendor>', files: [{ filename: 'copy.pdf', contentType: 'application/pdf', content: pdf('one') }] },
  { uid: 4, from: 'billing@vendor.example', to: ['office@example.com'], subject: 'Invoice 2', date: '2026-10-04T08:00:00Z', messageId: '<4@vendor>', files: [{ filename: 'invoice-2.pdf', contentType: 'application/pdf', content: pdf('two') }] },
];

/** A stand-in mailbox; `failAt` makes the attachment fetch of that UID fail once, as a dropped connection would. */
function fake(opts: { failAt?: number; mails?: Mail[] } = {}): { backend: () => Promise<MailBackend>; fetched: number[] } {
  const mails = opts.mails ?? MAILS;
  const fetched: number[] = [];
  let failed = false;
  return {
    fetched,
    backend: async () => ({
      async list(_folder, after, _since, limit) {
        return { validity: '7', messages: mails.filter((m) => !after || m.uid > after).slice(0, limit).map(({ files: _f, ...m }) => m) };
      },
      async attachments(_folder, uid) {
        if (opts.failAt === uid && !failed) { failed = true; throw new Error('connection dropped'); }
        fetched.push(uid);
        return mails.find((m) => m.uid === uid)!.files;
      },
      async close() {},
    }),
  };
}

const YAML = `label: Office
code: app:imap
settings:
  boxes: [{ label: Office, address: office@example.com }]
reach:
  mail: { host: imap.example.com, account: office@example.com, from: ["*@vendor.example"] }
feeds:
  attachments: { output: document, every: daily }
`;

function office(yaml = YAML): Workspace {
  const ws = tempWorkspace('pull-');
  mkdirSync(join(ws.paths.root, 'sources', 'office'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'sources', 'office', 'source.yaml'), yaml);
  const v = sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office');
  assert.ok(v && v.kind !== 'invalid', JSON.stringify(v));
  approveSource(ws, v.decl);
  return ws;
}

const req = (ws: Workspace, backend: PullRequest['mailBackend'], over: Partial<PullRequest> = {}): PullRequest =>
  ({ ws, appRoot: APP_ROOT, source: 'office', run: 'collect-1', mode: 'live', mailBackend: backend, ...over });
const inbox = (ws: Workspace) => (existsSync(ws.paths.inbox) ? readdirSync(ws.paths.inbox).sort() : []);

test('a pull delivers the PDFs of the senders the reach lets through; a copy is a duplicate; the second pull delivers nothing', async () => {
  const ws = office();
  const first = await pull(req(ws, fake().backend));
  assert.deepEqual(first, { outcome: 'ok', feeds: [{ feed: 'attachments', documents: 2, duplicates: 1, quarantined: 0, complete: true }] });
  assert.deepEqual(inbox(ws), ['invoice-1.pdf', 'invoice-2.pdf'], 'not the logo, not the other sender\'s offer, not the copy');
  const ledger = readLedger(ws, 'office');
  assert.deepEqual(ledger.map((l) => ('cursor' in l ? `cursor ${JSON.stringify(l.cursor)}` : 'got' in l ? `${l.key} ${l.got.kind === 'document' && l.got.duplicateOf ? 'duplicate' : 'new'}` : 'deleted')), [
    '<1@vendor>#invoice-1.pdf new', '<3@vendor>#copy.pdf duplicate', '<4@vendor>#invoice-2.pdf new', 'cursor {"validity":"7","uid":4}',
  ]);
  const second = fake();
  assert.deepEqual(await pull(req(ws, second.backend, { feeds: ['attachments'] })), { outcome: 'ok', feeds: [{ feed: 'attachments', documents: 0, duplicates: 0, quarantined: 0, complete: true }] });
  assert.deepEqual(second.fetched, [], 'from its cursor, nothing new to fetch');
  assert.deepEqual(await pull(req(ws, fake().backend)), { outcome: 'ok', feeds: [] }, 'a daily feed pulled today is not due');
});

test('a pull that crashed midway, pulled again, gives the inbox a clean pull gives', async () => {
  const clean = office();
  await pull(req(clean, fake().backend));
  const ws = office();
  await assert.rejects(pull(req(ws, fake({ failAt: 3 }).backend)), /connection dropped/);
  assert.deepEqual(inbox(ws), ['invoice-1.pdf'], 'what came before the crash is in');
  await pull(req(ws, fake().backend, { feeds: ['attachments'] }));
  assert.deepEqual(inbox(ws), inbox(clean));
});

test('a missing password stops that source only; a dry run writes nothing', async () => {
  const ws = office();
  mkdirSync(join(ws.paths.root, 'sources', 'shop'));
  writeFileSync(join(ws.paths.root, 'sources', 'shop', 'source.yaml'), YAML.replace('label: Office', 'label: Shop'));
  approveSource(ws, (sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'shop') as unknown as { decl: never }).decl);
  assert.deepEqual(await pull(req(ws, fake().backend, { source: 'shop' })), { outcome: 'missing-secret', channel: 'mail', feeds: [] });
  assert.equal((await pull(req(ws, fake().backend))).outcome, 'ok', 'the other source pulls');
  const dry = office();
  const r = await pull(req(dry, fake().backend, { mode: 'dry' }));
  assert.deepEqual(r, { outcome: 'ok', feeds: [{ feed: 'attachments', documents: 2, duplicates: 1, quarantined: 0, complete: true, seen: [
    { name: 'invoice-1.pdf', from: 'billing@vendor.example', date: '2026-10-01T08:00:00Z', as: 'new' },
    { name: 'copy.pdf', from: 'billing@vendor.example', date: '2026-10-03T08:00:00Z', as: 'duplicate' },
    { name: 'invoice-2.pdf', from: 'billing@vendor.example', date: '2026-10-04T08:00:00Z', as: 'new' },
  ] }] }, 'a dry run says what it would bring, for «Prüfen»');
  assert.deepEqual([inbox(dry), readLedger(dry, 'office')], [[], []]);
  const first = await pull(req(office(), fake().backend, { mode: 'dry', limit: 1 }));
  assert.equal(first.feeds[0].seen?.length, 1, 'a preview stops after its limit instead of reading months of mail');
});

test('code that fetches is changed; code that reaches past its reach is over-reach; a version not switched on does not run live', async () => {
  const own = (body: string) => {
    const ws = tempWorkspace('pull-own-');
    const dir = join(ws.paths.root, 'sources', 'office');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'source.yaml'), YAML.replace('code: app:imap', 'code: ./source.ts'));
    writeFileSync(join(dir, 'source.ts'), `export default { attachments: async function* (io: any) { ${body} } };\n`);
    return ws;
  };
  const fetching = own("const r = await (globalThis as any).fetch('https://example.com'); yield r;");
  const v = sources(fetching, APP_ROOT)[0];
  assert.equal(v.kind, 'pending');
  await assert.rejects(pull(req(fetching, fake().backend)), /not switched on/);
  approveSource(fetching, (v as unknown as { decl: never }).decl);
  const changed = await pull(req(fetching, fake().backend));
  assert.equal(changed.outcome, 'changed');
  const reaching = own("yield await io.web.open('https://elsewhere.example/');");
  approveSource(reaching, (sources(reaching, APP_ROOT)[0] as unknown as { decl: never }).decl);
  assert.deepEqual(await pull(req(reaching, fake().backend)), { outcome: 'over-reach', feed: 'attachments', channel: 'web', attempted: 'web.open', feeds: [{ feed: 'attachments', documents: 0, duplicates: 0, quarantined: 0, complete: false }] });
});

test('an attachment whose words say it is no receipt goes to quarantine, not the inbox; a sender that sends only such is offered to be skipped, and skipping keeps the mailbox switched on', async () => {
  const news = async (n: number) => textPdf(['Vendor News', `Ausgabe ${n}: neue Farben im Herbst`, 'Sie erhalten diesen Newsletter als Kundin. Abmelden: vendor.example/abmelden']);
  const mail = (uid: number, filename: string, content: Buffer, from = 'news@vendor.example'): Mail => ({ uid, from, to: ['office@example.com'], subject: filename, date: `2026-10-0${uid}T08:00:00Z`, messageId: `<${uid}@news>`, files: [{ filename, contentType: 'application/pdf', content }] });
  const mails = [mail(1, 'news-1.pdf', await news(1)), mail(2, 'news-2.pdf', await news(2)), mail(3, 'news-3.pdf', await news(3)), mail(4, 'invoice-9.pdf', await textPdf(['Vendor AG', 'Rechnung R-9', 'Total CHF 54.00', 'MWST 8.1 % 4.05']), 'billing@vendor.example')];
  const ws = office(YAML.replace('from: ["*@vendor.example"]', 'from: ["*@vendor.example"], skip: []'));
  const r = await pull(req(ws, fake({ mails }).backend));
  assert.deepEqual(r, { outcome: 'ok', feeds: [{ feed: 'attachments', documents: 1, duplicates: 0, quarantined: 3, complete: true }] });
  assert.deepEqual(inbox(ws), ['invoice-9.pdf']);
  assert.deepEqual(readdirSync(join(ws.paths.data, 'quarantine')).filter((f) => f.endsWith('.pdf')).sort(), ['news-1.pdf', 'news-2.pdf', 'news-3.pdf']);
  const decl = (sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office') as unknown as { decl: { reach: { mail: never } } }).decl;
  assert.deepEqual(skipOffers(readLedger(ws, 'office'), [], decl.reach.mail), [{ sender: 'news@vendor.example', n: 3 }], 'the newsletter address, not the vendor that sends the invoices too');
  addSkip(ws, 'office', 'news@vendor.example');
  const next = sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'office');
  assert.equal(next?.kind, 'pending', 'a new version');
  assert.deepEqual(next?.kind === 'pending' && next.reachDiff, { added: [{ channel: 'mail', what: 'not from news@vendor.example' }], removed: [] }, 'that only narrows the reach: the click switches it on');
});
