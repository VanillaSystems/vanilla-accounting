/**
 * What the setup AI can see by itself before it asks (src/server/mail-evidence.ts), on a fake
 * machine: the mail programs and the one macOS opens for an e-mail link, the company's mail domains
 * and their provider, how receipts came in. Each test names the wrong conclusion it would catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceLines, mailEvidence, type Probes, type Seen } from '../src/server/mail-evidence.js';

const mac = (over: Partial<Probes> = {}): Probes => ({
  platform: 'darwin', home: '/Users/anna',
  exists: (p) => p === '/System/Applications/Mail.app',
  launchHandlers: async () => undefined,
  mx: async () => { throw new Error('no DNS in this test'); },
  ...over,
});
const none: Seen = { addresses: [], receipts: [], ledgers: [] };
const receipt = (sender: string, text: string, name = `${sender}.pdf`) => ({ filename: name, originalFilename: name, extractedText: text, vatId: sender });

test('Apple Mail, which every Mac has, is no sign; a mail program the person installed is', async () => {
  const bare = await mailEvidence(none, mac());
  assert.deepEqual(bare.mac, { installed: [], defaultMail: 'never-chosen' });
  const lines = evidenceLines(bare).join('\n');
  assert.match(lines, /never chosen, so Apple Mail by default \(no sign that the person uses it\)/);
  const outlook = await mailEvidence(none, mac({ exists: (p) => p === '/Applications/Microsoft Outlook.app' || p === '/Users/anna/Applications/Thunderbird.app' }));
  assert.deepEqual(outlook.mac?.installed, ['Microsoft Outlook', 'Thunderbird']);
});

test('the mail program the person chose is read from LaunchServices, a browser there means webmail, an unreadable file is said so', async () => {
  const handlers = (id: string) => async () => [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.apple.safari' }, { LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: id }];
  assert.deepEqual((await mailEvidence(none, mac({ launchHandlers: handlers('com.microsoft.Outlook') }))).mac?.defaultMail, { name: 'Microsoft Outlook', kind: 'mail' }, 'bundle ids compare without case');
  const chrome = await mailEvidence(none, mac({ launchHandlers: handlers('com.google.chrome') }));
  assert.deepEqual(chrome.mac?.defaultMail, { name: 'Google Chrome', kind: 'browser' });
  assert.match(evidenceLines(chrome).join('\n'), /Google Chrome, a web browser \(a sign the person reads mail in the browser\)/);
  assert.deepEqual((await mailEvidence(none, mac({ launchHandlers: handlers('com.example.mailer') }))).mac?.defaultMail, { unknownApp: 'com.example.mailer' });
  assert.equal((await mailEvidence(none, mac({ launchHandlers: async () => { throw new Error('plutil failed'); } }))).mac?.defaultMail, 'unreadable', 'a failed read is no «never chosen»');
});

test('on Windows or Linux no Mac is assumed', async () => {
  const e = await mailEvidence(none, mac({ platform: 'win32' }));
  assert.equal(e.os, 'windows');
  assert.equal(e.mac, undefined);
  assert.doesNotMatch(evidenceLines(e).join('\n'), /Apple Mail/);
});

test('the company\'s domains: from its sending address and mailbox sources by MX, a free mail domain without DNS', async () => {
  const asked: string[] = [];
  const e = await mailEvidence({ ...none, addresses: [{ address: 'info@malerei.example', where: 'outgoing-mail' }, { address: 'anna.muster@gmail.com', where: 'mailbox-source' }] }, mac({
    mx: async (d) => { asked.push(d); return [{ exchange: 'malerei-example.mail.protection.outlook.com', priority: 0 }]; },
  }));
  assert.deepEqual(asked, ['malerei.example'], 'gmail.com is known without a lookup');
  assert.deepEqual(e.domains, [
    { domain: 'malerei.example', seenIn: ['outgoing-mail'], webmail: false, provider: 'Microsoft' },
    { domain: 'gmail.com', seenIn: ['mailbox-source'], webmail: true, provider: 'Google' },
  ]);
  const lines = evidenceLines(e).join('\n');
  assert.match(lines, /mail domain malerei\.example \(the address invoices are sent from\): mail hosted by Microsoft/);
  assert.match(lines, /mail domain gmail\.com \(a connected mailbox\): a free mail service \(Google\), read in its web page or app/);
});

test('a domain on receipts of several senders is the company\'s own; a supplier\'s domain on its own receipts is not', async () => {
  const e = await mailEvidence({ ...none, receipts: [
    receipt('CHE-1', 'Rechnung an anna@malerei.example\nFragen: support@farben.example'),
    receipt('CHE-1', 'Kopie an anna@malerei.example, support@farben.example'),
    receipt('CHE-2', 'Kunde: buchhaltung@malerei.example'),
    { ...receipt('CHE-3', 'anna@malerei.example'), kind: 'duplicate' as const },
  ] }, mac({ mx: async () => [] }));
  assert.deepEqual(e.domains.map((d) => [d.domain, d.onReceipts]), [['malerei.example', { receipts: 3, senders: 2 }]], 'farben.example: one sender only; the duplicate is not counted');
  assert.doesNotMatch(evidenceLines(e).join('\n'), /anna@|buchhaltung@|Rechnung an/, 'never an address or a receipt\'s text');
});

test('how receipts came in: the phone by its upload name, each source by its ledger, the senders as domains', async () => {
  const got = (file: string, from?: string) => ({ at: '2026-10-01T08:00:00Z', run: 'r', feed: 'attachments', key: file, got: { kind: 'document' as const, sha256: 'x', file, ...(from ? { from } : {}) } });
  const e = await mailEvidence({
    addresses: [],
    receipts: [receipt('A', '', '20260912-081500.jpg'), receipt('B', '', '20260913-090000-2.pdf'), receipt('C', '', 'rechnung.pdf')],
    ledgers: [
      { source: 'belege-firma', lines: [got('a.pdf', 'Shop <billing@shop.example>'), got('b.pdf', 'billing@shop.example'), got('c.pdf', 'no-reply@tel.example'), { at: '2026-10-01T08:00:00Z', run: 'r', feed: 'attachments', cursor: 5 }] },
      { source: 'leer', lines: [] },
    ],
  }, mac());
  assert.deepEqual(e.arrivals, { receipts: 3, phone: 2, collected: [{ source: 'belege-firma', documents: 3 }], senders: [{ domain: 'shop.example', documents: 2 }, { domain: 'tel.example', documents: 1 }] });
  assert.match(evidenceLines(e).join('\n'), /receipts so far: 3, of them 2 taken with the phone; documents delivered by connected sources: 3 from belege-firma/);
});
