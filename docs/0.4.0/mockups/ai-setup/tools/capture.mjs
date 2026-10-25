// Captures the real app (demo workspace, read-only, port 5207) as static HTML: DOM + CSS as rendered.
// The start screen and the setup conversation need the desktop bridge: a stub, and /api/desktop answered here.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

// Run from the repo root with the app on 5207 (see ../index.html); writes .verify/ai-setup/cap-*.html.
const out = new URL('../../../../../.verify/ai-setup/', import.meta.url).pathname;
const BASE = 'http://localhost:5207';
const launch = () => puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: 1440, height: 900 } });

const HOME = '/Users/anna/Buchhaltung';
const DESKTOP = {
  'GET /api/desktop': { open: null, recent: [], booksHome: HOME, folders: [] },
  'GET /api/desktop/ai': { available: true },
  'GET /api/desktop/setup': { root: `${HOME}/Buchhaltung 2026`, draft: { started: '2026-10-25T09:00:00Z', language: 'de', answers: {} }, baseCurrency: 'CHF' },
};

async function open(url, opts = {}) {
  for (let n = 0; ; n++) {
    try { return await openOnce(url, opts); } catch (e) { if (n >= 2) throw e; console.log('retry', url, e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

async function openOnce(url, { desktop = false } = {}) {
  const browser = await launch();
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((d) => {
    localStorage.setItem('theme', 'light');
    localStorage.setItem('language', 'de');
    if (d) window.vanilla = { chooseFolder: async () => null, onMenu: () => () => {}, setLanguage() {}, saveFile: async () => false };
  }, desktop);
  if (desktop) {
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const u = new URL(r.url());
      const body = DESKTOP[`${r.method()} ${u.pathname}`];
      if (body) r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      else r.continue();
    });
  }
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  try { await page.goto(BASE + url, { waitUntil: 'networkidle0' }); } catch (e) { await browser.close().catch(() => {}); throw e; }
  await new Promise((r) => setTimeout(r, 1500));
  return page;
}

async function dump(page, name) {
  const html = await page.evaluate(() => {
    const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch { return ''; } }).join('\n');
    const urls = [...document.querySelectorAll('canvas')].map((c) => { try { return c.toDataURL('image/png'); } catch { return ''; } });
    const doc = document.documentElement.cloneNode(true);
    doc.querySelectorAll('canvas').forEach((c, i) => { const img = document.createElement('img'); img.className = c.className; img.setAttribute('style', c.getAttribute('style') || ''); img.src = urls[i]; c.replaceWith(img); });
    doc.querySelectorAll('script, style, link[rel="stylesheet"], link[rel="modulepreload"]').forEach((n) => n.remove());
    const st = document.createElement('style'); st.textContent = css; doc.querySelector('head').appendChild(st);
    return '<!doctype html>\n' + doc.outerHTML;
  });
  fs.writeFileSync(out + name + '.html', html);
  await page.screenshot({ path: out + name + '.png' });
  console.log(name, html.length);
}

let p = await open('/start', { desktop: true });
await dump(p, 'cap-start');
await p.browser().close();
p = await open(`/start?setup=${encodeURIComponent(HOME + '/Buchhaltung 2026')}`, { desktop: true });
await dump(p, 'cap-setup');
await p.browser().close();
p = await open('/company/ai');
await dump(p, 'cap-company-ai');
await p.browser().close();
p = await open('/journal');
await p.click('body');
await p.keyboard.down('Meta'); await p.keyboard.press('KeyJ'); await p.keyboard.up('Meta');
await new Promise((r) => setTimeout(r, 1500));
await dump(p, 'cap-journal-ai');
await p.browser().close();
