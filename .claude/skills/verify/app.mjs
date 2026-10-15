// Drives the packed app inside the VM through its DevTools port (vm.sh app sets CDP), then saves
// $EVIDENCE/NAME.png (the app's page only) and prints the URL and the page's visible text.
//
//   node app.mjs NAME ['STEP' …]      each STEP is JavaScript run in Node with these in scope:
//     clickText('Buchhaltung anlegen')         the smallest visible button/link/label holding the text
//     fill('Firmenname', 'Malerei Huber')      the field of the label that starts with the text
//     nth(8, 'CH11 8080 …')                    the i-th visible input/textarea (fields without labels)
//     pick('PDFs hierher ziehen', ['IMG_4471.jpg'])   the app's file picker with ~/Downloads files
//     wait(3000), ev('document.title'), p      (p: the puppeteer page)
//   TEXT_FROM=… TEXT_LEN=… slice the printed text (default the first 3000 characters).
import puppeteer from 'puppeteer-core';

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
const ev = (s) => p.evaluate(s);
void [wait, fill, nth, pick, ev];

for (const s of steps) { await eval(`(async () => { ${s} })()`); await wait(400); }
await wait(800);
await p.screenshot({ path: `${EVIDENCE}/${name}.png` });
const text = await p.evaluate(() => document.body.innerText);
const from = Number(process.env.TEXT_FROM ?? 0);
console.log(p.url());
console.log(text.slice(from, from + Number(process.env.TEXT_LEN ?? 3000)));
b.disconnect();
