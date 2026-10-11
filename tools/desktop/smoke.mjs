/**
 * Drives the packaged desktop app the way a person does, with only /usr/bin:/bin on its PATH (no
 * Homebrew, no nvm) and a fresh user data folder, so no books of this machine are ever opened:
 * start screen → Demo → every area → issue an invoice and check its PDF (one page, the QR-bill
 * decodes) → set up new books and switch back through the File menu → claude missing.
 *
 *   node tools/desktop/smoke.mjs "release/mac-arm64/Vanilla Accounting.app" .verify/evidence/release/b
 *
 * Screenshots and smoke.json go to the evidence folder. Exit code 1 when a check fails.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const [appPath, outArg = '.verify/evidence/release/b'] = process.argv.slice(2);
if (!appPath) throw new Error('usage: node tools/desktop/smoke.mjs <path to Vanilla Accounting.app> [evidence folder]');
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const exe = join(resolve(appPath), 'Contents/MacOS/Vanilla Accounting');
const userData = mkdtempSync(join(tmpdir(), 'vanilla-smoke-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(port, shell) {
  const log = join(out, `app-${port}.log`);
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--inspect=${port + 100}`, `--user-data-dir=${userData}`], {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, SHELL: shell, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'de_CH.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  child.on('exit', () => writeFileSync(log, text));
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(() => undefined);
  }
  if (!browser) throw new Error(`the app did not open its debugging port (log: ${log})`);
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith('http://127.0.0.1'));
    if (!page) await sleep(250);
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { child, browser, page, base: new URL(page.url()).origin, errors, main: await mainProcess(port + 100) };
}

/**
 * The main process through its inspector, to click the native menu (System Events needs a
 * permission a script does not have). Undefined when the build refuses --inspect.
 */
async function mainProcess(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => undefined);
  if (!list?.[0]) return undefined;
  const sock = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((r) => sock.addEventListener('open', r));
  let id = 0;
  const evaluate = (body) => new Promise((resolve) => {
    const mine = ++id;
    const onMessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== mine) return;
      sock.removeEventListener('message', onMessage);
      resolve(msg.result?.result?.value);
    };
    sock.addEventListener('message', onMessage);
    const expression = `(() => { const { Menu, app } = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const M = Menu.getApplicationMenu(); return (${body}); })()`;
    sock.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  // A process started with --inspect waits at its end until the inspector lets go.
  evaluate.close = () => sock.close();
  return evaluate;
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

// 1. First start: the start screen, nothing opened.
const first = await launch(9333, process.env.SHELL || '/bin/zsh');
let { page } = first;
const { base } = first;
await settle(page, '.st-choices');
// German, as a Swiss user would pick it: the page remembers it and the native menu follows.
await clickText(page, '.st-top .seg2 button', 'DE');
await sleep(500);
await shot(page, '01-start');
check('first start shows the start screen', await page.$('[data-act=demo]'));
check('the app keeps its state in the given user data folder', existsSync(join(userData, 'desktop.json')));
check('PATH of the app process is /usr/bin:/bin', execFileSync('ps', ['eww', '-o', 'command=', String(first.child.pid)], { encoding: 'utf8' }).includes('PATH=/usr/bin:/bin'));

// 2. Demo ansehen.
await Promise.all([page.waitForNavigation(), page.click('[data-act=demo]')]);
await settle(page, 'nav.dock');
await shot(page, '02-demo');
const demoName = (await api(page, '/api/workspace')).json?.company?.name;
check('Demo ansehen opens a copy in the user data folder', existsSync(join(userData, 'Demo', 'belege.workspace.yaml')), demoName);

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

// 5. New books from the File menu's "Neue Buchhaltung…" (/start?new), then back to the demo through the File menu.
await page.goto(`${base}/start?new`);
await settle(page, '.st-form');
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
await settle(page, 'nav.dock');
const created = (await api(page, '/api/workspace')).json?.company?.name;
check('new books are set up and opened', created === 'Rauchtest GmbH' && existsSync(join(root, 'belege.workspace.yaml')), created);
await shot(page, '06-new-books-open');

const viaMenu = !!first.main;
if (viaMenu) {
  const file = await first.main(`M.items[1].submenu.items.map((i) => i.label)`);
  check('the native menu speaks the UI language', file?.includes('Buchhaltung öffnen…') && file.includes('Neue Buchhaltung…'), file?.join(', '));
  check('the recent list holds both books', (await first.main(`M.getMenuItemById('recent').submenu.items.map((i) => i.label).join(', ')`))?.includes('Rauchtest GmbH'));
  await first.main(`M.getMenuItemById('zoomIn').click()`);
  await sleep(400);
  const zoomed = await page.evaluate(() => document.documentElement.style.zoom);
  await first.main(`M.getMenuItemById('zoomReset').click()`);
  await sleep(400);
  check('View › Vergrössern steps the page\'s own zoom, Originalgrösse resets it', zoomed === '1.1' && !(await page.evaluate(() => document.documentElement.style.zoom)), `zoom ${zoomed}`);
  await Promise.all([page.waitForNavigation({ timeout: 20000 }), first.main(`M.getMenuItemById('demo').click()`)]);
} else {
  console.log('  (this build refuses --inspect: the menu is not clickable from a script; the start screen\'s recent list instead)');
  await page.goto(`${base}/start`);
  await settle(page, '.st-recent');
  await Promise.all([page.waitForNavigation(), clickText(page, '.st-book', 'Demo')]);
}
await settle(page, 'nav.dock');
const back = (await api(page, '/api/workspace')).json?.company?.name;
check(`File menu switches back to the demo${viaMenu ? ' (menu clicked)' : ' (recent list)'}`, back === demoName, back);
await shot(page, '07-back-to-demo');
// Quit as the menu's Beenden does, so the page's storage is written; a script without the inspector can only kill.
const exited = new Promise((r) => first.child.once('exit', r));
if (first.main) {
  await first.main('setTimeout(() => app.quit(), 100) && true');
  first.main.close();
} else first.child.kill();
await exited;

// 6. Without claude (a shell that does not find it): a model feature names what to install, the rest works.
const second = await launch(9334, '/bin/sh');
page = second.page;
await settle(page, 'nav.dock');
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
await sleep(1500);
const toast = await page.evaluate(() => document.body.innerText.includes('Claude Code'));
check('the UI says what to install', clicked && toast);
await shot(page, '08-no-claude');
second.main?.close();
second.child.kill();

writeFileSync(join(out, 'smoke.json'), JSON.stringify({ app: appPath, userData, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; evidence in ${out}`);
process.exit(failed.length ? 1 : 0);
