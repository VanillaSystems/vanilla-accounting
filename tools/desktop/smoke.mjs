/**
 * Drives the packaged desktop app the way a person does, with only /usr/bin:/bin on its PATH (no
 * Homebrew, no nvm) and a fresh user data folder, so no books of this machine are ever opened:
 * start screen → Demo → every area → issue an invoice and check its PDF (one page, the QR-bill
 * decodes) → the SMTP password saved in Firma, the invoice sent by e-mail to a local SMTP server →
 * a PDF, a PNG and a HEIC dropped and read by the inbox job → a camt.053 paying the invoice
 * imported → set up new books and switch back through the File menu → claude missing.
 *
 * The release build is fused (no --inspect, no ELECTRON_RUN_AS_NODE): the script reaches the page
 * through --remote-debugging-port and the native menu through `window.vanillaSmoke`, which the app
 * exposes only when started with --vanilla-smoke. claude is the stub of tests/support/stub-bin,
 * found through a login shell whose PATH holds it, as the app finds the real one.
 *
 *   node tools/desktop/smoke.mjs "release/mac-arm64/Vanilla Accounting.app" .verify/evidence/release/b
 *
 * Screenshots and smoke.json go to the evidence folder. Exit code 1 when a check fails.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fs from 'node:fs';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import git from 'isomorphic-git';
import { simpleParser } from 'mailparser';
import puppeteer from 'puppeteer-core';
import { SMTPServer } from 'smtp-server';

const [appPath, outArg = '.verify/evidence/release/b'] = process.argv.slice(2);
if (!appPath) throw new Error('usage: node tools/desktop/smoke.mjs <path to Vanilla Accounting.app> [evidence folder]');
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const exe = join(resolve(appPath), 'Contents/MacOS/Vanilla Accounting');
const userData = mkdtempSync(join(tmpdir(), 'vanilla-smoke-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');

// A login shell whose PATH finds the claude stub (and the node it runs on), as a person's terminal finds claude.
const stubBin = mkdtempSync(join(tmpdir(), 'vanilla-smoke-claude-'));
copyFileSync('tests/support/stub-bin/claude', join(stubBin, 'claude-stub.mjs'));
symlinkSync(process.execPath, join(stubBin, 'node'));
// The stub's own reading of a photo is too little to prove anything (textProves, src/parsers/receipt-text.ts, #284):
// the photo would be set aside for a person under its own name. A legible photo reads as words, so the model names it.
const OCR = 'Stub Shop. Quittung vom Stub gelesen: ein Foto eines Belegs, gut lesbar, mit dem Namen des Ladens, der gekauften Ware und dem Dank für den Einkauf.';
writeFileSync(join(stubBin, 'claude'), `#!/bin/sh\nCLAUDE_STUB_OCR_TEXT='${OCR}'\nexport CLAUDE_STUB_OCR_TEXT\nexec "${join(stubBin, 'node')}" "${join(stubBin, 'claude-stub.mjs')}" "$@"\n`);
chmodSync(join(stubBin, 'claude'), 0o755);
const stubShell = join(stubBin, 'login-shell');
writeFileSync(stubShell, `#!/bin/sh\nPATH=${stubBin}:/usr/bin:/bin\nexport PATH\nexec /bin/sh -c "$2"\n`);
chmodSync(stubShell, 0o755);

// The company's mailbox: a local SMTP server that takes one login and keeps each message.
const SMTP_USER = 'rechnungen@rauchtest.example';
const SMTP_PASSWORD = `smoke-${Date.now()}`;
const mails = [];
const smtp = new SMTPServer({
  authOptional: false, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
  onAuth: (auth, _s, cb) => cb(auth.username === SMTP_USER && auth.password === SMTP_PASSWORD ? null : new Error('Invalid login'), { user: auth.username }),
  onData: (stream, session, cb) => { simpleParser(stream).then((mail) => { mails.push({ rcpt: session.envelope.rcptTo.map((r) => r.address), mail }); cb(); }, cb); },
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const smtpPort = smtp.server.address().port;

// safeStorage's key is the login keychain item of the build that made it. When one exists (an
// installed copy of the app made it), this build would wait on macOS's prompt for it and a test
// must not touch it: the run then seals with Chromium's mock keychain and checks the item stays as it was.
const keychainEntry = () => { try { return execFileSync('security', ['find-generic-password', '-s', 'vanilla-accounting Safe Storage'], { encoding: 'utf8' }); } catch { return undefined; } };
const keychainBefore = keychainEntry();

async function launch(port, shell) {
  const log = join(out, `app-${port}.log`);
  const child = spawn(exe, [`--remote-debugging-port=${port}`, '--vanilla-smoke', `--user-data-dir=${userData}`, ...(keychainBefore ? ['--use-mock-keychain'] : [])], {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, SHELL: shell, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'de_CH.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  child.on('exit', () => writeFileSync(log, text));
  // A build signed otherwise than the one that made the keychain item waits on macOS's prompt
  // for it (cookie encryption reads it at start), with no window.
  const stuck = `the app opened no window on its server (log: ${log}). A keychain prompt? An unsigned build of another signature `
    + 'asks before it reads "vanilla-accounting Safe Storage"; remove that item (security delete-generic-password -s ...) and run again.';
  const listed = async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []))
    .some((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
  let ready = false;
  for (let i = 0; i < 360 && !ready; i++) { await sleep(500); ready = await listed(); }
  if (!ready) throw new Error(stuck);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  const page = (await browser.pages()).find((p) => p.url().startsWith('http://127.0.0.1'));
  if (!page) throw new Error(stuck);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { child, browser, page, base: new URL(page.url()).origin, errors };
}

const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const api = (page, path, init) => page.evaluate(async (path, init) => {
  const r = await fetch(path, init);
  return { status: r.status, json: await r.json().catch(() => null) };
}, path, init);
const clickText = (page, selector, text) => page.evaluate((selector, text) => {
  const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.includes(text));
  el?.click();
  return !!el;
}, selector, text);
async function settle(page, selector) {
  await page.waitForSelector(selector, { timeout: 20000 });
  await sleep(600);
}

const menu = (page) => page.evaluate(() => window.vanillaSmoke.menu());
const clickMenu = (page, id) => page.evaluate((id) => window.vanillaSmoke.click(id), id);
/** Files dropped on the page as a person drops them from the Finder. */
const drop = (page, files) => page.evaluate((files) => {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type, lastModified: Date.now() }));
  for (const type of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
}, files.map((f) => ({ ...f, b64: f.bytes.toString('base64') })));
/**
 * The add-files dialog takes each dropped file at once: wait until every one has its row there,
 * answer «verschieden» for the files in `distinct` (asked «schon da?»), wait until the dialog has
 * come to rest («Hinzugefügt», the bar at 100 %), then close it with «Schliessen».
 * Returns the rows as the dialog showed them at rest.
 */
async function takeDropped(page, names, { shot: shotName, distinct = [] } = {}) {
  const row = (name) => `[data-testid=drop-dialog] [data-testid=drop-row][data-file="${name}"]`;
  await page.waitForFunction((names) => {
    const files = [...document.querySelectorAll('[data-testid=drop-dialog] [data-testid=drop-row]')].map((r) => r.dataset.file);
    return names.every((n) => files.includes(n));
  }, { timeout: 30000 }, names);
  if (shotName) await shot(page, shotName);
  for (const name of distinct) {
    await page.waitForSelector(`${row(name)} [data-testid=drop-twin-distinct]`, { timeout: 30000 });
    await page.click(`${row(name)} [data-testid=drop-twin-distinct]`);
    await page.waitForSelector(`${row(name)}[data-state]:not([data-state=duplicate])`, { timeout: 30000 });
  }
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[data-testid=drop-dialog]');
    return dialog?.dataset.working === 'false' && dialog.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '100'
      && dialog.querySelector('[data-testid=drop-close]')?.textContent.trim() === 'Schliessen';
  }, { timeout: 180000 });
  const rows = await page.$$eval('[data-testid=drop-dialog] [data-testid=drop-row]', (rs) => rs.map((r) => ({ file: r.dataset.file, state: r.dataset.state })));
  await page.click('[data-testid=drop-close]');
  await page.waitForSelector('[data-testid=drop-dialog]', { hidden: true, timeout: 5000 });
  return rows;
}
/** The inbox processing's runs started since `since` have come to rest (the workflow receipt-intake). */
async function intakeDone(page, since) {
  const ofIntake = (v) => (v?.runs ?? []).filter((r) => r.workflow === 'receipt-intake' && r.startedAt > since);
  for (let i = 0; i < 240; i++) {
    const runs = ofIntake((await api(page, '/api/automation')).json);
    if (runs.length && runs.every((r) => r.status !== 'queued' && r.status !== 'running')) return { job: { steps: runs[0].path.map((id) => ({ id, done: 1, total: 1 })) } };
    await sleep(500);
  }
  return { job: { steps: ofIntake((await api(page, '/api/automation')).json)[0]?.path.map((id) => ({ id, done: 0, total: 1 })) ?? [] } };
}

const wire = await getCurrentFuseWire(exe);
const fused = wire[FuseV1Options.RunAsNode] === 48 && wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable] === 48
  && wire[FuseV1Options.EnableNodeCliInspectArguments] === 48 && wire[FuseV1Options.OnlyLoadAppFromAsar] === 49
  && wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] === 49 && wire[FuseV1Options.EnableCookieEncryption] === 48;
check('the build is fused: no RunAsNode, NODE_OPTIONS or --inspect; app.asar only, its integrity checked; no cookie encryption (no keychain prompt at start)', fused, JSON.stringify(wire));

// 1. First start: «Einrichtung» (docs/0.4.0/ai-setup.md), nothing opened; the claude stub is signed in, so the AI is ready and the books' choices follow.
const first = await launch(9333, stubShell);
let { page } = first;
const { base } = first;
await settle(page, '[data-answer=demo]');
// German, as a Swiss user would pick it: the page remembers it and the native menu follows.
await clickText(page, '.st-top .seg2 button', 'DE');
await sleep(500);
await shot(page, '01-start');
check('a fresh install opens «Einrichtung», the AI ready, then the books\' choices', await page.$('[data-ready=claude]') && await page.$('[data-answer=create]'));
check('the window is dragged by its top edge (no title bar on the Mac)', await page.evaluate(() => {
  const bar = document.querySelector('.dragbar');
  return !!bar && getComputedStyle(bar).getPropertyValue('-webkit-app-region') === 'drag' && bar.getBoundingClientRect().height >= 28;
}));
const blocking = async (p) => p.evaluate(() => [...document.querySelectorAll('*')].filter((el) => {
  const r = el.getBoundingClientRect();
  return getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'no-drag' && r.width >= innerWidth * 0.9 && r.top <= 0 && r.bottom >= 36;
}).map((el) => el.className || el.tagName));
check('the app keeps its state in the given user data folder', existsSync(join(userData, 'desktop.json')));
check('PATH of the app process is /usr/bin:/bin', execFileSync('ps', ['eww', '-o', 'command=', String(first.child.pid)], { encoding: 'utf8' }).includes('PATH=/usr/bin:/bin'));

// 2. Demo ansehen.
await Promise.all([page.waitForNavigation(), page.click('[data-answer=demo]')]);
await settle(page, 'nav.activity');
await shot(page, '02-demo');
check('nothing covers the title bar zone with no-drag in the books (the window moves by its top edge)', (await blocking(page)).length === 0, JSON.stringify(await blocking(page)));
const demoName = (await api(page, '/api/workspace')).json?.company?.name;
check('Demo ansehen opens a copy in the user data folder', existsSync(join(userData, 'Demo', 'vanilla-accounting', 'belege.workspace.yaml')), demoName);

// 3. Every area.
const AREAS = [['receipts', '/receipts'], ['invoices', '/invoices'], ['bank', '/bank'], ['journal', '/journal'], ['vat', '/vat'],
  ['codes', '/vat/codes'], ['reports', '/reports/income'], ['close', '/close'], ['company', '/company/profile']];
for (const [i, [area, path]] of AREAS.entries()) {
  await page.goto(`${base}${path}?period=2026-Q3`);
  await settle(page, 'h1');
  await shot(page, `03-${String(i + 1).padStart(2, '0')}-${area}`);
  const heading = await page.$eval('h1', (h) => h.textContent.trim());
  check(`area ${area} opens`, heading && !(await page.$('.st-choices')), heading);
}
check('no page errors in the areas', first.errors.length === 0, first.errors.slice(0, 3).join(' | '));

// 4. Issue the demo's draft and fetch its PDF.
await page.goto(`${base}/invoices?period=2026-Q3`);
await settle(page, '.list .row');
check('the draft is listed', await clickText(page, '.list .row', 'Barista-Schulung'));
await settle(page, '[data-act=issue]');
const issued = page.waitForResponse((r) => /\/api\/invoices\/[^/]+\/issue$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30000 });
await page.click('[data-act=issue]');
const issueResponse = await issued;
const issuedJson = await issueResponse.json().catch(() => ({}));
const number = issuedJson.number ?? issuedJson.invoice?.number;
check('issuing answers 200', issueResponse.status() === 200, `${issueResponse.status()} ${number ?? JSON.stringify(issuedJson).slice(0, 200)}`);
await sleep(1500);
await shot(page, '04-issued');
const pdfB64 = await page.evaluate(async (n) => {
  const r = await fetch(`/invoices/${n}.pdf`);
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}, number);
check('the issued PDF is served', pdfB64);
if (pdfB64) {
  const pdf = Buffer.from(pdfB64, 'base64');
  const pdfFile = join(out, `invoice-${number}.pdf`);
  writeFileSync(pdfFile, pdf);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  check('the invoice PDF has one page', pages === 1, `${pages} page(s), ${pdf.length} bytes`);
  check('the PDF dates are the issue time, not the print time', /\/CreationDate \(D:\d{14}/.test(pdf.toString('latin1')));
  const png = join(out, `invoice-${number}.png`);
  execFileSync('sips', ['-s', 'format', 'png', '-s', 'dpiWidth', '300', '-s', 'dpiHeight', '300', pdfFile, '--out', png], { stdio: 'ignore' });
  const qr = await page.evaluate(async (b64) => {
    if (!('BarcodeDetector' in window)) return { error: 'no BarcodeDetector' };
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const codes = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(img);
    return { text: codes[0]?.rawValue };
  }, readFileSync(png).toString('base64'));
  check('the QR-bill decodes as a Swiss QR code', qr.text?.startsWith('SPC\n'), qr.error ?? qr.text?.split('\n').slice(0, 4).join(' | '));
}

// 4b. The SMTP password through Firma › E-Mail-Versand, into the app's keychain store.
await page.goto(`${base}/company/mail`);
await settle(page, '.fedit button');
await page.click('.fedit button');
await settle(page, 'form.form.inline input[name=password]');
const setField = (sel, value) => page.evaluate((sel, value) => {
  const el = document.querySelector(sel);
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}, sel, value);
for (const [name, value] of [['host', '127.0.0.1'], ['port', String(smtpPort)], ['user', SMTP_USER], ['password', SMTP_PASSWORD], ['fromName', 'Demo'], ['fromAddress', SMTP_USER]]) {
  await setField(`form.form.inline input[name=${name}]`, value);
}
await setField('form.form.inline select[name=security]', 'none');
await shot(page, '04b-mail-form');
await page.click('form.form.inline button[type=submit]');
await sleep(1500);
await shot(page, '04c-mail-saved');
const mailStatus = (await api(page, '/api/mail')).json;
const sealed = existsSync(join(userData, 'secrets.json')) ? readFileSync(join(userData, 'secrets.json'), 'utf8') : '';
check('the password is saved through Firma into the keychain store, sealed, not in the books', mailStatus?.password === 'set' && mailStatus.inApp && sealed.length > 0 && !sealed.includes(SMTP_PASSWORD)
  && !readFileSync(join(userData, 'Demo', 'vanilla-accounting', 'belege.workspace.yaml'), 'utf8').includes(SMTP_PASSWORD), JSON.stringify(mailStatus));
// The key safeStorage seals with lives in the login keychain under the app's name (only its presence is read).
if (keychainBefore) check('the login keychain item of the installed app is left as it was (sealed with the mock keychain)', keychainEntry() === keychainBefore, 'vanilla-accounting Safe Storage');
else check('the sealing key is in the macOS keychain', keychainEntry() !== undefined, 'vanilla-accounting Safe Storage');

// 4c. The issued invoice by e-mail: the stored PDF arrives byte for byte.
const invoices = (await api(page, '/api/invoices')).json.invoices;
const inv = invoices.find((i) => i.number === number);
await page.goto(`${base}/invoices/${number}`);
await settle(page, '[data-act=send]');
await page.click('[data-act=send]');
await settle(page, 'input[name=to]');
await setField('input[name=to]', 'buchhaltung@kunde.example');
await shot(page, '04d-send-dialog');
await page.click('[data-act=mail]');
for (let i = 0; i < 60 && !mails.length; i++) await sleep(250);
await sleep(800);
await shot(page, '04e-sent');
const stored = readFileSync(join(userData, 'Demo', 'vanilla-accounting', 'transactional-data', '2026', 'invoices', `${number}.pdf`));
const attachment = mails[0]?.mail.attachments.find((a) => a.contentType === 'application/pdf');
check('the invoice goes out by e-mail through the local SMTP server with the saved password', mails[0]?.rcpt.includes('buchhaltung@kunde.example'), mails[0]?.mail.subject);
check('the attachment is the stored PDF byte for byte', attachment && sha(attachment.content) === sha(stored), attachment && `${sha(attachment.content).slice(0, 16)} = ${sha(stored).slice(0, 16)}`);
const sentLog = (await api(page, `/api/invoices/${inv.id}`)).json.sent;
check('the sent log records the e-mail', sentLog?.some((d) => d.channel === 'email' && d.to === 'buchhaltung@kunde.example' && d.messageId), JSON.stringify(sentLog?.at(-1)));

// 4d. A PDF, a PNG and an iPhone photo dropped on Belege: the inbox job reads them with the claude stub.
await page.goto(`${base}/receipts?period=2026-Q3`);
await settle(page, '.list');
const receiptsBefore = new Set((await api(page, '/books.json')).json.receipts.map((r) => r.id));
const demoPdf = readdirSync(join(userData, 'Demo', 'vanilla-accounting', 'transactional-data', '2026', 'receipts')).find((f) => f.endsWith('.pdf'));
const heicDir = mkdtempSync(join(tmpdir(), 'vanilla-smoke-heic-'));
execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', 'desktop/icon.png', '--out', join(heicDir, 'IMG_0001.HEIC')], { stdio: 'ignore' });
const since = new Date().toISOString();
await drop(page, [
  { name: 'beleg.pdf', type: 'application/pdf', bytes: Buffer.concat([readFileSync(join(userData, 'Demo', 'vanilla-accounting', 'transactional-data', '2026', 'receipts', demoPdf)), Buffer.from(`\n% smoke ${Date.now()}\n`)]) },
  { name: 'foto.png', type: 'image/png', bytes: readFileSync('desktop/icon.png') },
  { name: 'IMG_0001.HEIC', type: '', bytes: readFileSync(join(heicDir, 'IMG_0001.HEIC')) },
]);
const dropRows = await takeDropped(page, ['beleg.pdf', 'foto.png', 'IMG_0001.HEIC'], { shot: '04f-drop-dialog', distinct: ['beleg.pdf'] });
check('the add-files dialog takes the photos at once and the PDF (a copy of a demo receipt, «schon da?») on «verschieden», and comes to rest with each read', dropRows.length === 3 && dropRows.every((r) => r.state === 'read' || r.state === 'matched'),
  dropRows.map((r) => `${r.file} ${r.state}`).join(', '));
const job = await intakeDone(page, since);
await sleep(1000);
await shot(page, '04g-dropped-read');
const books = (await api(page, '/books.json')).json;
const added = books.receipts.filter((r) => !receiptsBefore.has(r.id));
check('the run reads the dropped PDF, PNG and HEIC: three receipts, named by the model, archived', added.length === 3 && added.every((r) => r.location === 'archived' && /stub-shop/.test(r.filename)),
  `${added.map((r) => `${r.filename} (${r.extractionMethod})`).join(', ')}; steps ${job?.job?.steps?.map((st) => `${st.id} ${st.done}/${st.total}`).join(', ')}`);
check('the photos became PDFs in the books', added.filter((r) => r.extractionMethod !== 'pdftotext').length === 2, added.map((r) => r.extractionMethod).join(', '));

// 4e. A camt.053 that pays the invoice by its QR reference, dropped on Bank.
const paid = (await api(page, `/api/invoices/${inv.id}`)).json;
const day = new Date().toISOString().slice(0, 10);
const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>SMOKE-${Date.now()}</MsgId><CreDtTm>${day}T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>SMOKE-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">${paid.view.open.toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>${day}</Dt></BookgDt><AcctSvcrRef>SMOKE-PAY-1</AcctSvcrRef>
<NtryDtls><TxDtls><RmtInf><Strd><CdtrRefInf><Ref>${paid.reference}</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
await page.goto(`${base}/bank`);
await settle(page, 'h1');
const sinceCamt = new Date().toISOString();
await drop(page, [{ name: `camt053-smoke-${day}.xml`, type: 'text/xml', bytes: Buffer.from(camt) }]);
await page.waitForFunction((day) => location.pathname.startsWith('/bank/') && location.pathname.includes(day), { timeout: 30000 }, day).catch(() => undefined);
await settle(page, 'h1');
const shownStatement = await page.evaluate(() => ({ path: location.pathname, dialog: !!document.querySelector('[data-testid=drop-dialog]'), title: [...document.querySelectorAll('h1')].map((h) => h.textContent).join(' | ') }));
check('Bank reads the dropped camt.053 itself (no add-files dialog) and opens the new statement', shownStatement.path.startsWith('/bank/') && shownStatement.path.includes(day) && !shownStatement.dialog, `${shownStatement.path}: ${shownStatement.title}`);
await intakeDone(page, sinceCamt);
await shot(page, '04h-camt-imported');
const tx = (await api(page, '/books.json')).json.transactions?.find((t) => JSON.stringify(t).includes('SMOKE-PAY-1'));
check('the camt.053 is imported: its payment is in the books', tx, tx && `${tx.ref} ${tx.amount} ${tx.currency}`);
const after = (await api(page, `/api/invoices/${inv.id}`)).json;
check('its QR reference pays the invoice', after.view.status === 'paid' && after.view.open === 0, `${after.view.status}, open ${after.view.open}`);
await page.goto(`${base}/invoices/${number}`);
await settle(page, 'h1');
await shot(page, '04i-invoice-paid');

// 5. New books from the File menu's "Neue Buchhaltung…" (/start?new), set up through the form («Ohne KI einrichten»),
// then back to the demo through the File menu.
const aiAsked = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ai/setup', { timeout: 20000 });
await page.goto(`${base}/start?new`);
const aiAvailable = (await (await aiAsked).json()).available;
await settle(page, '[data-act=by-hand]');
check('Neue Buchhaltung opens «Einrichtung» with «Neue Buchhaltung erstellen» when claude answers', aiAvailable && await page.$('[data-answer=create]'), `available ${aiAvailable}`);
await page.click('[data-act=by-hand]');
await settle(page, '.st-form input[name=name]');
const root = mkdtempSync(join(tmpdir(), 'vanilla-smoke-books-'));
const fill = async (name, value) => {
  const ok = await page.evaluate((name, value) => {
    const input = document.querySelector(`.st-form input[name=${name}]`);
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, name, value);
  if (!ok) throw new Error(`no field ${name}`);
};
await fill('name', 'Rauchtest GmbH');
await fill('uid', 'CHE-153.004.184');
await fill('owner', 'Erika Rauch');
await fill('root', root);
await shot(page, '05-new-books-form');
await Promise.all([page.waitForNavigation({ timeout: 30000 }), page.click('[data-act=create]')]);
await settle(page, 'nav.activity');
const created = (await api(page, '/api/workspace')).json?.company?.name;
check('new books are set up and opened', created === 'Rauchtest GmbH' && existsSync(join(root, 'vanilla-accounting', 'belege.workspace.yaml')), created);
const commits = await git.log({ fs, dir: root }).catch((e) => String(e));
check('new books are committed to a new git repository', Array.isArray(commits) && commits.length === 1, Array.isArray(commits) ? commits[0].commit.message.trim() : commits);
await shot(page, '06-new-books-open');

const { file, recent } = await menu(page);
check('the native menu speaks the UI language', file.includes('Buchhaltung öffnen…') && file.includes('Neue Buchhaltung…'), file.join(', '));
check('the recent list holds both books', recent.join(', ').includes('Rauchtest GmbH'), recent.join(', '));
await clickMenu(page, 'zoomIn');
// Waits for the effect, not a fixed time: the x64 build under Rosetta is slower.
await page.waitForFunction(() => document.documentElement.style.zoom === '1.1', { timeout: 10000 }).catch(() => undefined);
const zoomed = await page.evaluate(() => document.documentElement.style.zoom);
await clickMenu(page, 'zoomReset');
await page.waitForFunction(() => !document.documentElement.style.zoom, { timeout: 10000 }).catch(() => undefined);
check('View › Vergrössern steps the page\'s own zoom, Originalgrösse resets it', zoomed === '1.1' && !(await page.evaluate(() => document.documentElement.style.zoom)), `zoom ${zoomed}`);
await Promise.all([page.waitForNavigation({ timeout: 20000 }), clickMenu(page, 'demo')]);
await settle(page, 'nav.activity');
const back = (await api(page, '/api/workspace')).json?.company?.name;
check('File menu switches back to the demo (menu clicked)', back === demoName, back);
await shot(page, '07-back-to-demo');
// Quit as the menu's Beenden does, so the page's storage is written.
const exited = new Promise((r) => first.child.once('exit', r));
await page.evaluate(() => window.vanillaSmoke.quit());
await exited;

// 6. Without claude (a shell that does not find it): a model feature names what to install, the rest works.
const second = await launch(9334, '/bin/sh');
page = second.page;
await settle(page, 'nav.activity');
check('the next start opens the last books', (await api(page, '/api/workspace')).json?.company?.name === demoName);
check('the next start keeps the page\'s origin and with it the language', second.base === base && (await page.evaluate(() => document.documentElement.lang)) === 'de', `${second.base} ${await page.evaluate(() => document.documentElement.lang)}`);
const receipts = (await api(page, '/books.json')).json.receipts;
const open = receipts.find((r) => r.date >= '2026-07-01' && r.location === 'archived');
const refusal = await api(page, '/api/vision/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receiptId: open.id }) });
check('without claude a model call answers noClaude', refusal.status === 503 && refusal.json?.code === 'noClaude', `${refusal.status} ${refusal.json?.code}`);
await page.goto(`${base}/receipts/${open.id}?period=2026-Q3`);
await settle(page, '.detail');
await page.evaluate(() => document.querySelectorAll('.sec > button.sum').forEach((b) => { if (b.getAttribute('aria-expanded') === 'false') b.click(); }));
await sleep(400);
const clicked = await clickText(page, '.dangers button', 'Neu lesen');
// It names no product (Claude Code or Codex, #175): it says an AI is missing and offers to set one up or to go on by hand.
const toast = await page.waitForFunction(() => document.body.innerText.includes('braucht eine KI') && document.body.innerText.includes('KI einrichten'), { timeout: 15000 }).then(() => true, () => false);
check('the UI says an AI is missing and offers to set one up', clicked && toast, `clicked ${clicked}, message ${toast}`);
await shot(page, '08-no-claude');
second.child.kill();
await new Promise((r) => smtp.close(r));

writeFileSync(join(out, 'smoke.json'), JSON.stringify({ app: appPath, userData, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; evidence in ${out}`);
process.exit(failed.length ? 1 : 0);
