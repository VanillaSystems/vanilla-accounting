/**
 * The browser-session channel io.web and the API channel io.api (src/platform/sources/web-channel.ts,
 * web-driver.ts, api-channel.ts): every navigation and download is checked against the source's
 * reach before it leaves, a sign-in page is the person's task, nothing is typed or sent, downloads
 * are delivered and deduplicated like the mail channels', and a run keeps its trace. Against a
 * stand-in browser and a local fake site, never a real webmail. Each test names the wrong
 * behaviour it catches.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.VANILLA_APPROVALS_DIR = mkdtempSync(join(tmpdir(), 'web-approvals-'));
process.env.VANILLA_TRACES_DIR = mkdtempSync(join(tmpdir(), 'web-traces-'));
process.env.VANILLA_BROWSER_DIR = mkdtempSync(join(tmpdir(), 'web-sessions-'));
const SECRETS = join(mkdtempSync(join(tmpdir(), 'web-secrets-')), 'secrets.json');
writeFileSync(SECRETS, JSON.stringify({ 'source:shopapi:api': 'tok-123' }));
process.env.VANILLA_SECRETS_FILE = SECRETS;

const { approveSource, sources } = await import('../src/platform/sources/index.js');
const { pull } = await import('../src/platform/sources/host.js');
const { readLedger } = await import('../src/platform/sources/ledger.js');
const { readDecl } = await import('../src/platform/sources/load.js');
const { LoginNeeded, navigationAllowed, signInUrl, webChannel } = await import('../src/platform/sources/web-channel.js');
const { ReachError } = await import('../src/platform/sources/reach.js');
const { playwrightDriver } = await import('../src/platform/sources/web-driver.js');
const { closeSession } = await import('../src/platform/browser/chrome.js');
const { browserPath } = await import('./support/browser.js');
const { APP_ROOT } = await import('../src/workspace/workspace.js');
const { tempWorkspace } = await import('./support/workspace.js');
type WebDriver = import('../src/platform/sources/web-channel.js').WebDriver;
type WebReach = import('../src/platform/sources/model.js').WebReach;
type Workspace = import('../src/workspace/workspace.js').Workspace;

const pdf = (n: string) => Buffer.from(`%PDF-1.4\n% ${n}\n%%EOF\n`);

const YAML = `label: Webmail
code: ./source.ts
reach:
  web:
    start: https://mail.example.com/inbox
    sign-in: [accounts.example.com/*]
    open: [mail.example.com/*]
    download: [mail.example.com/attachment/*]
feeds:
  attachments: { output: document, every: daily }
`;
const CODE = `export default {
  attachments: async function* (io: any, from: any) {
    const seen = from.cursor ?? 0;
    const page = await io.web.open('https://mail.example.com/inbox');
    const rows = await io.web.list('li.mail');
    let n = 0;
    for (const row of rows) {
      n++;
      if (n <= seen || !row.href) continue;
      const f = await io.web.download(row.href);
      yield io.out.document(f.file, { key: row.href });
    }
    yield io.out.checkpoint(n);
  },
};
`;

function reachOf(yaml = YAML): WebReach {
  const dir = join(mkdtempSync(join(tmpdir(), 'web-decl-')), 'probe');
  mkdirSync(dir);
  writeFileSync(join(dir, 'source.yaml'), yaml.replace('code: ./source.ts', 'code: app:imap'));
  const r = readDecl(dir, 'company', join(APP_ROOT, 'sources'));
  assert.ok('decl' in r, JSON.stringify(r));
  return r.decl.reach.web!;
}

/** A stand-in browser over a map of pages; `signedIn: false` sends every page to the sign-in. */
function fakeBrowser(opts: { signedIn?: boolean; mails?: string[] } = {}) {
  const mails = opts.mails ?? ['a', 'b'];
  const calls: string[] = [];
  let at = 'about:blank';
  const pageAt = (url: string) => (opts.signedIn === false && url.startsWith('https://mail.example.com/') ? 'https://accounts.example.com/signin' : url);
  const driver: WebDriver = {
    async goto(url) { calls.push(`goto ${url}`); at = pageAt(url); return { url: at }; },
    url: () => at,
    async read() { return { url: at, title: 'Inbox', text: 'Posteingang', links: [] }; },
    async list() { return mails.map((m) => ({ text: `Invoice ${m}`, href: `https://mail.example.com/attachment/${m}.pdf` })); },
    async submits(selector) { return selector === 'button.send'; },
    async click(selector) { calls.push(`click ${selector}`); if (selector === 'a.out') return { url: at, blocked: 'https://evil.example.net/steal' }; return { url: at }; },
    async fetch(url) { calls.push(`fetch ${url}`); return { name: url.split('/').pop()!, contentType: 'application/pdf', content: pdf(url), url }; },
    async clickDownload(_s, allow) { const url = 'https://cdn.example.org/x.pdf'; return allow(url) ? { name: 'x.pdf', contentType: 'application/pdf', content: pdf('x'), url } : { refused: url }; },
    async snapshot() { return { url: at, html: '<html>inbox</html>' }; },
    async close() { calls.push('close'); },
  };
  return { driver, calls };
}

test('the channel checks before it acts: an address outside open is never visited, a sign-in page is the person\'s, a submit is never clicked, a download outside download never fetched', async () => {
  const reach = reachOf();
  const { driver, calls } = fakeBrowser();
  const web = webChannel(driver, reach, new Map());
  await assert.rejects(web.open('https://elsewhere.example.com/'), (e: unknown) => e instanceof ReachError && e.attempted === 'open https://elsewhere.example.com/');
  await assert.rejects(web.open('http://mail.example.com/inbox'), ReachError, 'https only');
  assert.deepEqual(calls, [], 'refused before the browser went anywhere');
  await assert.rejects(web.click('button.send'), (e: unknown) => e instanceof ReachError && /submit/.test(e.attempted), 'a source never sends a form (no send, reply, forward)');
  await assert.rejects(web.click('a.out'), (e: unknown) => e instanceof ReachError && e.attempted === 'open https://evil.example.net/steal', 'a navigation the driver blocked is an over-reach');
  await assert.rejects(web.download('https://mail.example.com/settings/export'), ReachError);
  await assert.rejects(web.downloadBy('a.cdn'), (e: unknown) => e instanceof ReachError && e.attempted === 'download https://cdn.example.org/x.pdf');
  assert.deepEqual(calls, ['click a.out'], 'neither the submit nor the off-reach download was carried out');

  const out = fakeBrowser({ signedIn: false });
  await assert.rejects(webChannel(out.driver, reach, new Map()).open('https://mail.example.com/inbox'), (e: unknown) => e instanceof LoginNeeded && e.at === 'https://accounts.example.com/signin');
  assert.equal(navigationAllowed(reach)('https://accounts.example.com/signin'), true, 'the driver lets the sign-in page load, so the person sees it');
  assert.equal(signInUrl(reach), 'https://mail.example.com/inbox');
});

function webSource(): Workspace {
  const ws = tempWorkspace('web-');
  const dir = join(ws.paths.root, 'sources', 'webmail');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'source.yaml'), YAML);
  writeFileSync(join(dir, 'source.ts'), CODE);
  const v = sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === 'webmail');
  assert.ok(v && v.kind !== 'invalid', JSON.stringify(v));
  approveSource(ws, v.decl);
  return ws;
}
const inbox = (ws: Workspace) => (existsSync(ws.paths.inbox) ? readdirSync(ws.paths.inbox).sort() : []);

test('a source\'s own code reads webmail through io.web in its fenced child: a dry run shows what it would bring, a live run delivers once, the next brings only what is new', async () => {
  const ws = webSource();
  const dry = await pull({ ws, appRoot: APP_ROOT, source: 'webmail', run: 'preview', mode: 'dry', feeds: ['attachments'], webDriver: async () => fakeBrowser().driver });
  assert.equal(dry.outcome, 'ok');
  assert.deepEqual(dry.feeds[0].seen?.map((s) => [s.name, s.as]), [['a.pdf', 'new'], ['b.pdf', 'new']]);
  assert.deepEqual([inbox(ws), readLedger(ws, 'webmail')], [[], []], 'a dry run writes nothing');

  const one = fakeBrowser();
  const live = await pull({ ws, appRoot: APP_ROOT, source: 'webmail', run: 'collect-1', mode: 'live', webDriver: async () => one.driver });
  assert.deepEqual(live, { outcome: 'ok', feeds: [{ feed: 'attachments', documents: 2, duplicates: 0, quarantined: 0, complete: true }] });
  assert.deepEqual(inbox(ws), ['a.pdf', 'b.pdf']);
  assert.ok(one.calls.at(-1) === 'close', 'the run closes its tab');
  const got = readLedger(ws, 'webmail').flatMap((l) => ('got' in l && l.got.kind === 'document' ? [l.got] : []));
  assert.equal(got[0]?.from, 'https://mail.example.com/attachment/a.pdf', 'each document keeps where it came from (R1)');

  const two = fakeBrowser({ mails: ['a', 'b', 'c'] });
  const next = await pull({ ws, appRoot: APP_ROOT, source: 'webmail', run: 'collect-2', mode: 'live', feeds: ['attachments'], webDriver: async () => two.driver });
  assert.equal(next.outcome === 'ok' && next.feeds[0].documents, 1);
  assert.deepEqual(two.calls.filter((c) => c.startsWith('fetch')), ['fetch https://mail.example.com/attachment/c.pdf'], 'from its cursor, only the new mail is fetched');
  const traces = readdirSync(join(process.env.VANILLA_TRACES_DIR!, 'webmail'));
  assert.ok(traces.some((d) => existsSync(join(process.env.VANILLA_TRACES_DIR!, 'webmail', d, 'steps.jsonl'))), 'every run keeps what it saw');
});

test('a run that meets the sign-in page ends as login-needed (the task «Bei … anmelden»), delivers nothing and moves no cursor', async () => {
  const ws = webSource();
  const r = await pull({ ws, appRoot: APP_ROOT, source: 'webmail', run: 'collect-1', mode: 'live', webDriver: async () => fakeBrowser({ signedIn: false }).driver });
  assert.equal(r.outcome, 'login-needed');
  assert.deepEqual([inbox(ws), readLedger(ws, 'webmail')], [[], []]);
  const dir = readdirSync(join(process.env.VANILLA_TRACES_DIR!, 'webmail')).map((d) => join(process.env.VANILLA_TRACES_DIR!, 'webmail', d)).find((d) => existsSync(join(d, '001.html')));
  assert.ok(dir, 'the trace keeps the page the run stopped on');
});

const API_YAML = `label: Shop
code: ./source.ts
reach:
  api:
    base: https://api.shop.example.com/v1/
    allow: ["GET invoices", "GET invoices/*/pdf"]
feeds:
  invoices: { output: document, every: daily }
`;
const apiSource = (code: string, id = 'shopapi'): Workspace => {
  const ws = tempWorkspace('api-');
  const dir = join(ws.paths.root, 'sources', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'source.yaml'), API_YAML);
  writeFileSync(join(dir, 'source.ts'), `export default { invoices: async function* (io: any) { ${code} } };\n`);
  approveSource(ws, (sources(ws, APP_ROOT).find((x) => x.kind !== 'invalid' && x.decl.id === id) as unknown as { decl: never }).decl);
  return ws;
};
function fakeApi(status = 200) {
  const asked: Array<{ url: string; auth?: string }> = [];
  const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
    asked.push({ url, auth: init.headers.authorization });
    const json = url.endsWith('/invoices');
    const body = json ? Buffer.from(JSON.stringify([{ id: 7 }])) : pdf(url);
    return { status, headers: { get: (n: string) => (n === 'content-type' ? (json ? 'application/json' : 'application/pdf') : n === 'content-disposition' && !json ? 'attachment; filename="inv-7.pdf"' : null) }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer };
  };
  return { fetcher, asked };
}

test('io.api reads within its allow list with the stored token, which the code never sees; a path outside is refused before it leaves; a refused token is the person\'s task', async () => {
  const CODE_OK = "const list = await io.api.get('invoices'); for (const i of list.json) { const f = await io.api.get(`invoices/${i.id}/pdf`); yield io.out.document(f.file, { key: String(i.id) }); }";
  const ws = apiSource(CODE_OK);
  const api = fakeApi();
  const r = await pull({ ws, appRoot: APP_ROOT, source: 'shopapi', run: 'c1', mode: 'live', apiFetch: api.fetcher });
  assert.deepEqual(r, { outcome: 'ok', feeds: [{ feed: 'invoices', documents: 1, duplicates: 0, quarantined: 0, complete: true }] });
  assert.deepEqual(inbox(ws), ['inv-7.pdf']);
  assert.deepEqual(api.asked.map((a) => a.auth), ['Bearer tok-123', 'Bearer tok-123'], 'the host adds the token');

  const outside = apiSource("yield await io.api.get('customers');");
  const none = fakeApi();
  assert.deepEqual(await pull({ ws: outside, appRoot: APP_ROOT, source: 'shopapi', run: 'c1', mode: 'live', apiFetch: none.fetcher }), { outcome: 'over-reach', feed: 'invoices', channel: 'api', attempted: 'GET https://api.shop.example.com/v1/customers', feeds: [{ feed: 'invoices', documents: 0, duplicates: 0, quarantined: 0, complete: false }] });
  assert.deepEqual(none.asked, [], 'nothing left the machine');

  const refused = apiSource(CODE_OK);
  assert.equal((await pull({ ws: refused, appRoot: APP_ROOT, source: 'shopapi', run: 'c1', mode: 'live', apiFetch: fakeApi(401).fetcher })).outcome, 'missing-secret');
  const noToken = apiSource(CODE_OK, 'other');
  assert.deepEqual(await pull({ ws: noToken, appRoot: APP_ROOT, source: 'other', run: 'c1', mode: 'live', apiFetch: fakeApi().fetcher }), { outcome: 'missing-secret', channel: 'api', feeds: [] });
});

test('the browser driver blocks a navigation its guard refuses before the request leaves, reads, lists, clicks, refuses no submit itself, and downloads in the session', { skip: !browserPath && 'no Chromium browser installed' }, async () => {
  const hits: string[] = [];
  const server = createServer((q, r) => {
    hits.push(`${q.method} ${q.url}`);
    if (q.url === '/inbox') { r.setHeader('set-cookie', 'sid=1'); r.setHeader('content-type', 'text/html'); return r.end('<title>Inbox</title><ul><li class="mail"><a href="/attachment/a.pdf">Invoice A</a></li><li class="mail"><a id="dl" href="/attachment/b.pdf" download>Invoice B</a></li></ul><a id="out" href="/forbidden">Out</a><a id="next" href="/inbox2">Next</a><form method="post" action="/send"><button id="send">Send</button></form>'); }
    if (q.url === '/inbox2') { r.setHeader('content-type', 'text/html'); return r.end('<title>Page 2</title><p>two</p>'); }
    if (q.url?.startsWith('/attachment/')) { r.setHeader('content-type', 'application/pdf'); r.setHeader('content-disposition', `attachment; filename="${q.url.split('/').pop()}"`); return r.end(q.headers.cookie?.includes('sid=1') ? pdf('signed') : pdf('anon')); }
    r.statusCode = 404; r.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const guard = (url: string) => url.startsWith(`${base}/inbox`) || url.startsWith(`${base}/attachment/`);
  const driver = await playwrightDriver('test-web', guard, { headless: true });
  try {
    assert.deepEqual(await driver.goto(`${base}/inbox`), { url: `${base}/inbox` });
    const page = await driver.read();
    assert.equal(page.title, 'Inbox');
    assert.deepEqual((await driver.list('li.mail')).map((i) => i.text), ['Invoice A', 'Invoice B']);
    const blocked = await driver.click('#out');
    assert.equal(blocked.blocked, `${base}/forbidden`);
    assert.ok(!hits.includes('GET /forbidden'), 'the refused navigation never reached the site');
    assert.equal(await driver.submits('#send'), true, 'a button in a form is known to submit, so the channel refuses it');
    assert.equal(await driver.submits('#next'), false);
    const f = await driver.fetch(`${base}/attachment/a.pdf`);
    assert.equal(f.name, 'a.pdf');
    assert.match(f.content.toString(), /signed/, 'a download carries the session\'s sign-in (its cookies)');
    const d = await driver.clickDownload('#dl', (u) => u.startsWith(`${base}/attachment/`));
    assert.ok('content' in d && /signed/.test(d.content.toString()), 'a download a click starts is kept when its address is allowed');
    assert.deepEqual(await driver.click('#next'), { url: `${base}/inbox2` });
  } finally {
    await driver.close();
    await closeSession('test-web').catch(() => undefined);
    server.close();
  }
});
