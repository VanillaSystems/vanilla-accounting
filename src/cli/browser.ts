/**
 * The company's own Chrome per session, from the terminal (browser-design.md, before the UI has it):
 *
 *   npm run browser -- open <session> [url]     Chrome on the session's profile; sign in there once
 *   npm run browser -- record <session> [url]   the same, and everything you do is recorded until you press Enter
 *   npm run browser -- show [recording]         the recording in Playwright's trace viewer (default: the newest)
 *   npm run browser -- close <session>          ends the session's Chrome
 *   npm run browser -- list                     sessions and recordings
 *
 * A recording holds, per page you saw, its address, HTML and a screenshot; every JSON answer the
 * site loaded; your clicks, entries (never a password) and downloads; and a Playwright trace. It is
 * what Claude writes a source's script from. It stays on this Mac (~/.vanilla-accounting/recordings),
 * outside the books and git: it holds the site's data as you saw it.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { BrowserContext, Page } from 'playwright-core';
import { browserHome, closeSession, openSession } from '../platform/browser/chrome.js';
import { APP_ROOT } from '../workspace/workspace.js';

const RECORDINGS = process.env.VANILLA_RECORDINGS_DIR ?? join(homedir(), '.vanilla-accounting', 'recordings');

/** Runs in every page: reports clicks, entries and form submits, by what a person would call the element. */
const LISTEN = `(() => {
  if (window.__vanillaListening) return; window.__vanillaListening = true;
  const describe = (el) => {
    if (!el || !el.tagName) return {};
    // Never a field's value here: what was typed is reported by 'enter', and hidden there when secret.
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    const t = field ? '' : (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    return { tag: el.tagName.toLowerCase(), id: el.id || undefined, name: el.getAttribute('name') || undefined,
      role: el.getAttribute('role') || undefined, label: el.getAttribute('aria-label') || undefined,
      testid: el.getAttribute('data-testid') || undefined, href: el.getAttribute('href') || undefined, text: t || undefined };
  };
  const send = (x) => { try { window.__vanillaRecord(x); } catch {} };
  document.addEventListener('click', (e) => { const el = e.target.closest('a,button,[role=button],[role=link],[role=tab],input,label,summary,td,th,li') || e.target; send({ kind: 'click', target: describe(el) }); }, true);
  document.addEventListener('change', (e) => { const el = e.target; const secret = el.type === 'password' || /pass|otp|code|token/i.test(el.name || el.id || '');
    send({ kind: 'enter', target: describe(el), value: secret ? '(hidden)' : String(el.value).slice(0, 200) }); }, true);
  document.addEventListener('submit', (e) => send({ kind: 'submit', target: describe(e.target) }), true);
})();`;

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function record(session: string, url?: string): Promise<void> {
  const dir = join(RECORDINGS, session, stamp());
  for (const sub of ['pages', 'json', 'downloads']) mkdirSync(join(dir, sub), { recursive: true });
  const log = (x: Record<string, unknown>) => appendFileSync(join(dir, 'recording.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...x }) + '\n');
  let n = 0;
  const next = () => String(++n).padStart(4, '0');

  const open = await openSession(session, { url });
  const context: BrowserContext = open.browser.contexts()[0];
  await context.tracing.start({ screenshots: true, snapshots: true, title: `${session} ${stamp()}` });
  await context.exposeBinding('__vanillaRecord', ({ page }, x: Record<string, unknown>) => log({ ...x, page: page.url() }));
  await context.addInitScript(LISTEN);

  const snapshot = async (page: Page) => {
    const id = next();
    try {
      writeFileSync(join(dir, 'pages', `${id}.html`), await page.content());
      await page.screenshot({ path: join(dir, 'pages', `${id}.png`), fullPage: false });
      log({ kind: 'page', id, url: page.url(), title: await page.title() });
    } catch (e) { log({ kind: 'page', id, url: page.url(), error: (e as Error).message }); }
  };
  const watch = (page: Page) => {
    page.evaluate(LISTEN).catch(() => undefined);
    page.on('load', () => void snapshot(page));
    page.on('response', async (r) => {
      if (!/json/.test(r.headers()['content-type'] ?? '')) return;
      const id = next();
      try {
        const body = await r.text();
        writeFileSync(join(dir, 'json', `${id}.json`), body);
        log({ kind: 'json', id, url: r.url(), method: r.request().method(), status: r.status(), request: r.request().postData()?.slice(0, 2000) });
      } catch { /* a body the browser no longer holds */ }
    });
  };
  // Downloads go straight into the recording, under the name the site gives them.
  const cdp = await open.browser.newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(dir, 'downloads'), eventsEnabled: true });
  const downloading = new Set<string>();
  cdp.on('Browser.downloadWillBegin', (e) => { downloading.add(e.guid); log({ kind: 'download', file: e.suggestedFilename, url: e.url }); });
  cdp.on('Browser.downloadProgress', (e) => { if (e.state !== 'inProgress') downloading.delete(e.guid); });
  context.pages().forEach(watch);
  // The page already open when the recording starts counts as the first page seen.
  for (const page of context.pages()) await snapshot(page);
  context.on('page', watch);
  if (url && !open.started) await (context.pages()[0] ?? (await context.newPage())).goto(url);

  console.log(`Recording session "${session}" into ${dir}`);
  console.log('Work in the Chrome window: sign in, open the pages, download what you need.');
  console.log('Press Enter here when you are done (leave the Chrome window open until then).');
  await new Promise<void>((done) => {
    const rl = createInterface({ input: process.stdin });
    rl.once('line', () => { rl.close(); done(); });
    process.once('SIGINT', () => { rl.close(); done(); });
    open.browser.once('disconnected', () => { rl.close(); done(); });
  });
  for (let i = 0; i < 120 && downloading.size && open.browser.isConnected(); i++) {
    if (i === 0) console.log('Waiting for downloads to finish …');
    await new Promise((r) => setTimeout(r, 250));
  }
  if (open.browser.isConnected()) {
    await context.tracing.stop({ path: join(dir, 'trace.zip') }).catch((e) => console.log(`(no trace: ${(e as Error).message})`));
    await open.detach();
  } else {
    console.log('Chrome was closed before Enter: the pages, data and clicks are saved, the trace is not.');
  }
  const counts = readdirSync(join(dir, 'pages')).filter((f) => f.endsWith('.html')).length;
  console.log(`Saved: ${counts} pages, ${readdirSync(join(dir, 'json')).length} data answers, ${readdirSync(join(dir, 'downloads')).length} downloads → ${dir}`);
  console.log(`See it: npm run browser -- show "${dir}"`);
  // A CDP connection can keep handles open after detaching; the recording is complete here.
  process.exit(0);
}

function newest(): string | undefined {
  if (!existsSync(RECORDINGS)) return undefined;
  const all = readdirSync(RECORDINGS).flatMap((s) => readdirSync(join(RECORDINGS, s)).map((r) => join(RECORDINGS, s, r)));
  return all.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const [command, arg, url] = process.argv.slice(2);
const usage = 'npm run browser -- open|record <session> [url] · show [recording] · close <session> · list';
switch (command) {
  case 'open': {
    if (!arg) { console.log(usage); process.exitCode = 1; break; }
    const s = await openSession(arg, { url });
    if (url && !s.started) await (s.browser.contexts()[0].pages()[0] ?? (await s.browser.contexts()[0].newPage())).goto(url);
    console.log(`${s.started ? 'Started' : 'Found'} Chrome on the session "${arg}" (${join(browserHome(), arg)}). Sign in there; the sign-in stays in this profile.`);
    await s.detach();
    break;
  }
  case 'record':
    if (!arg) { console.log(usage); process.exitCode = 1; break; }
    await record(arg, url);
    break;
  case 'show': {
    const dir = arg ?? newest();
    if (!dir || !existsSync(join(dir, 'trace.zip'))) { console.log(`No trace in ${dir ?? RECORDINGS}`); process.exitCode = 1; break; }
    spawnSync(process.execPath, [join(APP_ROOT, 'node_modules', 'playwright-core', 'cli.js'), 'show-trace', join(dir, 'trace.zip')], { stdio: 'inherit' });
    break;
  }
  case 'close':
    if (!arg) { console.log(usage); process.exitCode = 1; break; }
    console.log((await closeSession(arg)) ? `Closed the session "${arg}".` : `No Chrome runs on "${arg}".`);
    break;
  case 'list':
    for (const s of existsSync(browserHome()) ? readdirSync(browserHome()) : []) console.log(`session ${s}`);
    for (const s of existsSync(RECORDINGS) ? readdirSync(RECORDINGS) : []) for (const r of readdirSync(join(RECORDINGS, s))) console.log(`recording ${join(RECORDINGS, s, r)}`);
    break;
  default:
    console.log(usage);
    process.exitCode = command ? 1 : 0;
}
