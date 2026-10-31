// Drives the packed app inside the VM through its DevTools port (vm.sh app sets CDP), then saves
// $EVIDENCE/NAME.png (the app's page only) and prints the URL and the page's visible text.
//
//   node app.mjs NAME ['STEP' …]      each STEP is JavaScript run in Node with these in scope:
//     clickText('Buchhaltung anlegen')         the smallest visible button/link/label holding the text
//     fill('Firmenname', 'Malerei Huber')      the field of the label that starts with the text
//     nth(8, process.env.PERSONA_IBAN_SPACED)   the i-th visible input/textarea, selects not counted (fields without labels)
//     pick('PDFs hierher ziehen', ['IMG_4471.jpg'])   the app's file picker with ~/Downloads files
//     drop(['IMG_4471.jpg', 'swisscom_juli.pdf'])     a Finder drag onto the window (DevTools drag events);
//                                              only files that were in the VM's ~/Downloads when it started
//     dropLocal(['/path/on/this/Mac/file.pdf'])  any file of this Mac, dropped as a File built in the page
//     wait(3000), ev('document.title'), p      (p: the puppeteer page)
//     await books()                            the books as /books.json gives them (receipts, transactions, mappings, journalEntries)
//   TEXT_FROM=… TEXT_LEN=… slice the printed text (default the first 3000 characters).
import puppeteer from 'puppeteer-core';
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [, , name, ...steps] = process.argv;
const { CDP, EVIDENCE } = process.env;
if (!name || !CDP || !EVIDENCE) { console.error('usage: source the run env (vm.sh up, vm.sh app), then node app.mjs NAME [STEP…]'); process.exit(1); }
const b = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const p = (await b.pages()).find((x) => x.url().startsWith('http://127.0.0.1'));
if (!p) { console.error('no app page behind ' + CDP); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = async (t, sel = 'button, a, [role=button], [role=tab], label, summary, [tabindex]') => {
  const ok = await p.evaluate((t, sel) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null && e.innerText?.trim().includes(t));
    els.sort((a, b) => a.innerText.length - b.innerText.length);
    if (!els[0]) return false;
    els[0].scrollIntoView({ block: 'center' }); els[0].click(); return true;
  }, t, sel);
  if (!ok) console.log(`!! nothing clickable with "${t}"`);
};
const focus = async (h, value) => {
  await h.evaluate((e) => { e.scrollIntoView({ block: 'center' }); e.focus(); e.select?.(); });
  await p.keyboard.press('Backspace'); await p.keyboard.type(value, { delay: 15 });
};
const fill = async (label, value) => {
  const h = await p.evaluateHandle((label) => {
    const l = [...document.querySelectorAll('label')].find((x) => x.innerText.trim().startsWith(label));
    return l && (l.control || l.querySelector('input,textarea,select') || l.parentElement.querySelector('input,textarea,select'));
  }, label);
  if (!(await h.evaluate((e) => !!e))) { console.log(`!! no field "${label}"`); return; }
  await focus(h, value);
};
const nth = async (i, value) => focus(await p.evaluateHandle((i) => [...document.querySelectorAll('input,textarea')].filter((e) => e.offsetParent)[i], i), value);
const pick = async (t, files) => {
  const [fc] = await Promise.all([p.waitForFileChooser({ timeout: 8000 }), clickText(t)]);
  await fc.accept(files.map((f) => `/Users/admin/Downloads/${f}`));
};
const drop = async (files, x = 700, y = 500) => {
  const c = await p.createCDPSession();
  const data = { items: [], files: files.map((f) => `/Users/admin/Downloads/${f}`), dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver']) await c.send('Input.dispatchDragEvent', { type, x, y, data });
  await wait(600);
  await c.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
  await c.detach();
};
const dropLocal = async (paths) => {
  const files = paths.map((f) => ({ name: basename(f), b64: readFileSync(f).toString('base64') }));
  await p.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name));
    for (const type of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, files);
};
const ev = (s) => p.evaluate(s);
const books = () => p.evaluate(async () => (await fetch('/books.json')).json());
void [wait, fill, nth, pick, drop, dropLocal, ev, books];

for (const s of steps) { await eval(`(async () => { ${s} })()`); await wait(400); }
await wait(800);
await p.screenshot({ path: `${EVIDENCE}/${name}.png` });
const text = await p.evaluate(() => document.body.innerText);
const from = Number(process.env.TEXT_FROM ?? 0);
console.log(p.url());
console.log(text.slice(from, from + Number(process.env.TEXT_LEN ?? 3000)));
b.disconnect();
