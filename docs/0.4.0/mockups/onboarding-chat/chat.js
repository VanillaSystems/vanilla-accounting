// Design B of the switch from another program: a setup conversation in a large panel over the real
// Firma page (a capture of the demo workspace). Nothing here talks to the app; this script plays the
// conversation and fills the Firma list as answers come in. The hash picks the path and a chapter:
// #p=jan|mitte&at=talk|list|fetch|half|know|done&th=light|dark&later=1. Chapters before `at` play
// themselves with the path's default answers, instantly. What chapter 5 keeps fills the areas
// Geschäftspartner and Wissen (wissen.js); `later` shows them as they would be after Q3 2026.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svg = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const BOT = svg('<path d="M12 8V4H8"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M2 14h2M20 14h2M15 13v2M9 13v2"></path>', 'i bot');
const I = {
  check: svg('<path d="m5 12 5 5L20 7"></path>'),
  ok: svg('<path d="m5 12 5 5L20 7"></path>', 'i'),
  warn: svg('<path d="M12 3 2 20h20z"></path><path d="M12 10v4M12 17v.5"></path>', 'i'),
  chev: svg('<path d="m9 6 6 6-6 6"></path>', 'chev'),
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"></path>'),
  plus: svg('<path d="M12 5v14M5 12h14"></path>'),
  min: svg('<path d="M5 12h14"></path>'),
  doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path>'),
  down: svg('<path d="M12 4v12M6 10l6 6 6-6M4 20h16"></path>'),
  key: svg('<circle cx="8" cy="15" r="4"></circle><path d="m11 12 9-9M17 6l3 3"></path>'),
  person: svg('<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path>'),
};

// ── State ────────────────────────────────────────────────────────────────────────────────────────
const hash = new URLSearchParams(location.hash.slice(1));
const S = {
  path: hash.get('p') === 'mitte' ? 'mitte' : 'jan',
  at: hash.get('at'),
  prog: 'bexio', entry: 'double', vat: 'eff', who: 'me', filed: 2, h1: 'journal',
  ruleAnswers: 0, notes: 0, skipped: [], kept: 0, keptList: [], answers: [],
  learned: false, priv: 'yes', disputed: [], later: hash.get('later') === '1',
};
const CHAPTERS = ['talk', 'list', 'fetch', 'half', 'know', 'done'];
let chapter = null;
const ff = () => S.at && CHAPTERS.indexOf(chapter) < CHAPTERS.indexOf(S.at);
const wait = (ms) => (ff() ? Promise.resolve() : sleep(ms));
const PROG = { bexio: 'Bexio', abacus: 'Abacus', banana: 'Banana', excel: 'Excel', treuhand: 'deinem Treuhänder' };
const P = () => PROG[S.prog];
const hasApi = () => S.prog === 'bexio' || S.prog === 'abacus';
const mid = () => S.path === 'mitte';

const theme = (t) => {
  document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light';
  const a = document.querySelector('.row.fset[data-section="display"] .a');
  if (a) a.textContent = t === 'dark' ? 'Dunkel' : 'Hell';
};
theme(hash.get('th'));
const tell = () => { try { parent.postMessage({ chapter, path: S.path }, '*'); } catch { /* opened on its own */ } };
window.addEventListener('message', (e) => {
  if (e.data && e.data.theme) theme(e.data.theme);
  if (e.data && 'later' in e.data) { S.later = !!e.data.later; KW.refresh(); }
});

// ── The Firma list fills in ──────────────────────────────────────────────────────────────────────
const company = $('main[data-area="company"]');
const row = (s) => $(`.row.fset[data-section="${s}"]`);
const setRow = (s, v) => {
  const r = row(s); if (!r) return;
  const a = $('.a', r); a.textContent = v; a.classList.remove('unset');
  r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash');
};
$('h1', company).textContent = 'Neue Firma';
$('.counts span', company).textContent = 'Einrichtung läuft';
for (const s of ['profile', 'vat', 'banks', 'sources', 'accounts', 'periods', 'opening']) {
  const a = $('.a', row(s)); a.textContent = '—'; a.classList.add('unset');
}

// ── The panel ────────────────────────────────────────────────────────────────────────────────────
const RAIL = [['firma', 'Firma', 'profile'], ['mwst', 'MWST', 'vat'], ['konten', 'Kontenplan', 'accounts'], ['journal', 'Journal', 'journal'], ['wissen', 'Wissen', 'partners'], ['eroeffnung', 'Eröffnung', 'opening']];
const done = new Set();
document.body.insertAdjacentHTML('beforeend', `
<section class="obchat" aria-label="Einrichtung">
  <header class="obhead">
    <span class="face">${BOT}</span>
    <span class="who"><b>Einrichtung</b><span>Vanilla Accounting · Umzug in deine neue Buchhaltung</span></span>
    <button type="button" class="aiact" data-peek="firma" title="Das Gespräch zur Seite schieben und die App ansehen">App ansehen</button>
  </header>
  <nav class="obrail" aria-label="Was schon eingerichtet ist">${RAIL.map(([k, l]) => `<button type="button" data-rail="${k}"><span class="dot"></span>${l}</button>`).join('')}</nav>
  <div class="obscroll"><div class="obthread" aria-live="polite"></div></div>
  <footer class="obfoot">
    <div class="aibox">
      <button type="button" class="ib" data-attach title="Datei anhängen">${I.plus}</button>
      <textarea rows="1" placeholder="Antworte mit den Knöpfen oder schreib es in deinen Worten"></textarea>
      <button type="button" class="ib send" data-send title="Senden">${I.send}</button>
    </div>
    <div class="hint">Dateien kannst du jederzeit hierher ziehen.</div>
  </footer>
</section>
<button type="button" class="btn primary obback">${BOT} Zurück zum Gespräch</button>`);
const panel = $('.obchat');
const thread = $('.obthread');
const scroller = $('.obscroll');
const input = $('textarea', panel);
const rail = () => {
  const now = RAIL.find(([k]) => !done.has(k));
  panel.querySelectorAll('[data-rail]').forEach((b) => {
    const k = b.dataset.rail;
    b.className = done.has(k) ? 'done' : now && now[0] === k ? 'now' : '';
    b.title = done.has(k) ? 'Eingerichtet. Klick: in der App ansehen' : 'Noch nicht eingerichtet';
  });
};
const tick = (k) => { done.add(k); rail(); };
rail();

// The app behind the panel: three areas a click can show (Firma, Buchungen, Wissen). Peek slides the
// panel away; after «Los geht's» the dock switches areas.
const dock = $('nav.activity');
const AREA_OF_HREF = { '/company/profile': 'company', '/journal': 'journal', '/partners': 'partners', '/knowledge': 'knowledge' };
let journal = null;
const journalArea = () => {
  if (journal) return journal;
  journal = $('#m-journal').content.firstElementChild.cloneNode(true);
  journal.querySelectorAll('.row .t').forEach((t) => {
    const name = t.firstChild && t.firstChild.nodeType === 3 ? t.firstChild.textContent.trim() : '';
    const id = KW.idOfName(name);
    if (id) t.firstChild.replaceWith(Object.assign(document.createElement('a'), { className: 'kwlink', href: `/partners/${id}`, textContent: name, title: `${name}: Seite des Geschäftspartners` }));
  });
  journal.addEventListener('click', (e) => {
    const a = e.target.closest('a.kwlink'); if (!a) return;
    e.preventDefault(); e.stopPropagation();
    show('partners', 'p:' + a.getAttribute('href').split('/').pop());
  });
  return journal;
};
const areas = { company, journal: journalArea, partners: () => KW.main('partners'), knowledge: () => KW.main('knowledge') };
const show = (area, sel) => {
  const el = typeof areas[area] === 'function' ? areas[area]() : areas[area];
  const cur = document.querySelector('main');
  if (cur !== el) cur.replaceWith(el);
  if (area === 'partners' || area === 'knowledge') KW.select(area, sel);
  if (area === 'journal' && sel) {
    el.querySelectorAll('.row[data-id]').forEach((r) => { const on = r.dataset.id === sel; r.classList.toggle('sel', on); r.setAttribute('aria-selected', String(on)); if (on) r.scrollIntoView({ block: 'center' }); });
  }
  dock.querySelectorAll('a.it').forEach((a) => {
    const on = AREA_OF_HREF[a.getAttribute('href')] === area;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
};
const peek = (k) => {
  const target = k === 'knowledge' ? 'knowledge' : (RAIL.find(([key]) => key === k) || [])[2] || 'profile';
  if (['journal', 'partners', 'knowledge'].includes(target)) show(target);
  else {
    show('company');
    const tpl = $(`#d-${target}`); const cur = $('section.detail', company);
    if (tpl && cur) cur.replaceWith(tpl.content.firstElementChild.cloneNode(true));
    company.querySelectorAll('.row.fset').forEach((r) => { const on = r.dataset.section === target; r.classList.toggle('sel', on); r.setAttribute('aria-selected', String(on)); });
  }
  if (!panel.classList.contains('gone')) panel.classList.add('peek');
};
const unpeek = () => { show('company'); panel.classList.remove('peek'); };
panel.addEventListener('click', (e) => {
  const r = e.target.closest('[data-rail]');
  if (r && done.has(r.dataset.rail)) peek(r.dataset.rail);
  const p = e.target.closest('[data-peek]');
  if (p) peek(p.dataset.peek);
});
$('.obback').addEventListener('click', unpeek);
dock.addEventListener('click', (e) => {
  const a = e.target.closest('a.it'); if (!a) return;
  e.preventDefault();
  const area = AREA_OF_HREF[a.getAttribute('href')];
  if (!area) { const t = $('.toast'); t.textContent = `${a.getAttribute('aria-label')} ist im Prototyp nicht nachgebaut.`; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); return; }
  if (panel.classList.contains('gone')) show(area);
  else if (area === 'company') unpeek();
  else { show(area); panel.classList.add('peek'); }
});
company.addEventListener('click', (e) => { const b = e.target.closest('[data-area]'); if (b) { show(b.dataset.area); if (!panel.classList.contains('gone')) panel.classList.add('peek'); } });

// ── Conversation primitives ──────────────────────────────────────────────────────────────────────
const down = () => { scroller.scrollTop = scroller.scrollHeight; };
const say = async (html) => {
  if (!ff()) {
    const t = document.createElement('div');
    t.className = 'obmsg ai typing'; t.innerHTML = `${BOT}<span class="tx"><i></i><i></i><i></i></span>`;
    thread.append(t); down();
    await sleep(Math.min(520, 200 + html.length * 1.2));
    t.remove();
  }
  const m = document.createElement('div');
  m.className = 'obmsg ai'; m.innerHTML = `${BOT}<div class="tx">${html.startsWith('<') ? html : `<p>${html}</p>`}</div>`;
  thread.append(m); down();
  return m;
};
const me = (text, note) => {
  const m = document.createElement('div');
  m.className = 'obmsg me'; m.innerHTML = text + (note ? `<small>${note}</small>` : '');
  thread.append(m); down();
};
const block = async (html) => {
  await wait(160);
  const b = document.createElement('div');
  b.className = 'obind'; b.innerHTML = html;
  thread.append(b); down();
  return b;
};
const ok = (el, text) => { el.insertAdjacentHTML('beforeend', `<div class="okline">${I.ok}<span>${text}</span></div>`); down(); };

// One question with answer buttons. Typed text matches an answer by its keywords.
let pendingAsk = null;
const ask = async (options, def) => {
  const b = await block(`<div class="qacts">${options.map((o, i) => `<button type="button" class="btn${o.primary ? ' primary' : ''}" data-i="${i}">${o.l}${o.s ? `<small>${o.s}</small>` : ''}</button>`).join('')}</div>`);
  const pick = (o, typed) => { pendingAsk = null; b.remove(); me(typed || o.l); return o.v; };
  if (ff()) return pick(options.find((o) => o.v === def) || options[0]);
  return new Promise((resolve) => {
    b.addEventListener('click', (e) => { const btn = e.target.closest('[data-i]'); if (btn) resolve(pick(options[+btn.dataset.i])); });
    pendingAsk = (text) => {
      const o = options.find((x) => x.k && x.k.test(text));
      if (!o) return false;
      resolve(pick(o, text)); return true;
    };
  });
};

// Waits for a click on one of the buttons matching `sel` inside `el`; typing «weiter» clicks the first.
let pendingGo = null;
const click = (el, sel) => {
  const first = () => [...el.querySelectorAll(sel)].find((x) => !x.disabled);
  if (ff()) return Promise.resolve(first());
  return new Promise((resolve) => {
    const on = (e) => { const t = e.target.closest(sel); if (t && !t.disabled && el.contains(t)) { el.removeEventListener('click', on); pendingGo = null; resolve(t); } };
    el.addEventListener('click', on);
    pendingGo = () => { const t = first(); if (t) t.click(); return !!t; };
  });
};
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); p.resolve = resolve; return p; };
const progress = async (el, text) => {
  el.insertAdjacentHTML('beforeend', `<div class="rk">${text}</div><div class="obbar"><i></i></div>`);
  down();
  const bar = el.lastElementChild;
  await wait(30); $('i', bar).style.width = '100%';
  await wait(580);
  bar.previousElementSibling.remove(); bar.remove();
};

// Typed input and dropped files.
let pendingDrop = null;
const send = async () => {
  const text = input.value.trim(); if (!text) return;
  input.value = '';
  if (pendingAsk && pendingAsk(text)) return;
  if (pendingGo && /^(weiter|ok|ja|los|mach|hol)/i.test(text)) { me(text); pendingGo(); return; }
  me(text);
  if (pendingAsk) await say('Das ordne ich nicht sicher einer Antwort zu. Wähl einen der Knöpfe oder sag es mit anderen Worten.');
  else await say('Notiert. Ich nehme es in die Einrichtung mit und frage nach, falls es etwas ändert.');
};
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('[data-send]', panel).addEventListener('click', send);
const dropped = async (name) => {
  me(`${I.doc.replace('class="i"', 'class="i" style="width:14px;height:14px;vertical-align:-2px"')} ${name}`, 'Datei');
  if (pendingDrop) { const d = pendingDrop; pendingDrop = null; d.resolve(name); return; }
  await say('Danke. Ich lege die Datei zu den Unterlagen der Einrichtung und schaue sie mir an, sobald wir dort sind.');
};
$('[data-attach]', panel).addEventListener('click', () => dropped(`${P() === 'deinem Treuhänder' ? 'export' : P().toLowerCase()}-export-2025.zip`));
panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('dragging'); });
panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('dragging'); });
panel.addEventListener('drop', (e) => { e.preventDefault(); panel.classList.remove('dragging'); const f = e.dataTransfer.files[0]; dropped(f ? f.name : 'export.zip'); });

const enter = (ch) => {
  chapter = ch;
  if (S.at === ch || (S.at === 'half' && !mid() && ch === 'know')) S.at = null;
  tell();
};

// ── Demo data: Muster Kaffee GmbH (the same partners as design A) ────────────────────────────────
const CLEAR = [
  { id: 'swisscom', name: 'Swisscom (Schweiz) AG', n: 12, acc: '6510 Telefon und Internet', vat: 'I81', sum: "1'428.00", tx: 'Swisscom', ex: [['28.12.2025', '119.00', 'Rechnung Dezember'], ['28.11.2025', '119.00', 'Rechnung November'], ['28.10.2025', '119.00', 'Rechnung Oktober'], ['29.09.2025', '119.00', 'Rechnung September'], ['28.08.2025', '119.00', 'Rechnung August']] },
  { id: 'gruenkaffee', name: 'Grünkaffee Muster AG', n: 26, acc: '4000 Rohkaffee', vat: 'M26', sum: "27'480.50", tx: 'Gruenkaffee Muster', ex: [['19.12.2025', "1'184.00", 'Rohkaffee Dezember'], ['05.12.2025', '962.40', 'Rohkaffee'], ['21.11.2025', "1'206.10", 'Rohkaffee November'], ['07.11.2025', "1'011.00", 'Rohkaffee'], ['24.10.2025', "1'098.30", 'Rohkaffee Oktober']] },
  { id: 'liegenschaften', name: 'Liegenschaften Muster', n: 12, acc: '6000 Mietaufwand', vat: null, sum: "28'800.00", tx: 'Liegenschaften Muster', ex: [['01.12.2025', "2'400.00", 'Miete Ladenlokal Dezember'], ['01.11.2025', "2'400.00", 'Miete Ladenlokal November'], ['01.10.2025', "2'400.00", 'Miete Ladenlokal Oktober'], ['01.09.2025', "2'400.00", 'Miete Ladenlokal September'], ['01.08.2025', "2'400.00", 'Miete Ladenlokal August']] },
  { id: 'post', name: 'Post CH', n: 12, acc: '6513 Porti und Versand', vat: 'I81', sum: "2'540.35", tx: 'Post CH', ex: [['22.12.2025', '241.85', 'Pakete Webshop Dezember'], ['20.11.2025', '318.20', 'Pakete Webshop November'], ['20.10.2025', '198.40', 'Pakete Webshop Oktober'], ['22.09.2025', '176.95', 'Pakete Webshop September'], ['20.08.2025', '152.10', 'Pakete Webshop August']] },
  { id: 'cloud', name: 'Example Cloud', n: 12, acc: '6570 Informatik, Hosting, Software', vat: 'B81-1', sum: 'EUR 468.00', tx: 'Example Cloud', ex: [['03.12.2025', 'EUR 39.00', 'Kassensystem-Abo Dezember'], ['03.11.2025', 'EUR 39.00', 'Kassensystem-Abo November'], ['03.10.2025', 'EUR 39.00', 'Kassensystem-Abo Oktober'], ['03.09.2025', 'EUR 39.00', 'Kassensystem-Abo September'], ['04.08.2025', 'EUR 39.00', 'Kassensystem-Abo August']] },
  { id: 'infomaniak', name: 'Infomaniak', n: 4, acc: '6570 Informatik, Hosting, Software', vat: 'I81', sum: '312.40', tx: 'Infomaniak', ex: [['14.11.2025', '24.00', 'Domain muster-kaffee.ch'], ['02.07.2025', '96.00', 'Mail Pro'], ['02.04.2025', '96.00', 'Mail Pro'], ['02.01.2025', '96.40', 'Mail Pro']] },
  { id: 'raiffeisen', name: 'Raiffeisen', n: 4, acc: '6940 Bankspesen', vat: null, sum: '60.00', tx: 'Kontoführung', ex: [['31.12.2025', '15.00', 'Kontoführung Q4'], ['30.09.2025', '15.00', 'Kontoführung Q3'], ['30.06.2025', '15.00', 'Kontoführung Q2'], ['31.03.2025', '15.00', 'Kontoführung Q1']] },
  { id: 'estv', name: 'ESTV', n: 4, acc: '2201 Abrechnungskonto MWST', vat: null, sum: "8'214.60", tx: 'ESTV', ex: [['27.11.2025', "2'240.10", 'MWST-Abrechnung Q3 2025'], ['28.08.2025', "1'982.30", 'MWST-Abrechnung Q2 2025'], ['27.05.2025', "2'012.70", 'MWST-Abrechnung Q1 2025'], ['27.02.2025', "1'979.50", 'MWST-Abrechnung Q4 2024']] },
];
const MIXED = [
  { id: 'coop', name: 'Coop Pronto Musterdorf', n: 23, sum: "2'140.70", parts: [['6200 Fahrzeug', 14], ['4210 Verbrauchsmaterial', 6], ['privat', 3]] },
  { id: 'digitec', name: 'Digitec Galaxus', n: 7, sum: "4'310.90", parts: [['6570 Informatik', 4], ['1520 Büromaschinen', 2], ['6100 Unterhalt', 1]] },
  { id: 'bargeld', name: 'Bargeldbezüge (Bancomat)', n: 8, sum: "3'200.00", parts: [['privat', 5], ['4210 Verbrauchsmaterial', 3]] },
];
// Patterns of 2025 the app does not learn (AGENTS.md, VAT code rules), each kept as a case with its reason.
const FLAGS = [
  { id: 'aliexpress', name: 'AliExpress', n: 7, was: '4210 · MWST I81', now: '4210 · I0, bis ein Beleg Schweizer MWST zeigt', why: 'Vorsteuer gibt es nur mit einem Beleg, der Schweizer MWST ausweist. Die Belege von AliExpress 2025 zeigen keine.', of: 'AliExpress' },
  { id: 'atelier', name: 'Grafik Atelier Wien', n: 4, was: '6600 · ohne MWST', now: '6600 · B81-1, Bezugsteuer', why: 'Eine Dienstleistung aus dem Ausland ohne Schweizer MWST: dafür schuldest du Bezugsteuer und ziehst sie in derselben Buchung wieder ab.', of: 'Grafik Atelier Wien' },
  { id: null, name: 'Private Einkäufe', n: 3, was: '2451 privat · MWST I81', now: '2451 privat, ohne MWST', why: 'Auf Privates gibt es keine Vorsteuer.', of: 'den privaten Einkäufen' },
];
// The questions about the partners booked in mixed ways. `know` is what an answer adds to Wissen.
const QUESTIONS = {
  coop: { q: 'Wofür kaufst du bei Coop Pronto Musterdorf ein?', opts: [
    { l: 'Nach Beleg entscheiden', s: 'empfohlen · ich lese jeden Beleg: Benzin auf 6200, Café-Bedarf auf 4210, Lebensmittel für dich privat', v: 'note', primary: true, k: /beleg|lies|lesen/i, know: 'Nach dem Kassenzettel entscheiden: Benzin auf 6200 Fahrzeugaufwand, Café-Bedarf auf 4210 Verbrauchsmaterial, Lebensmittel für zu Hause privat auf 2451.' },
    { l: 'Immer fragen', s: 'eine Regel, die bei jeder Coop-Zahlung fragt', v: 'ask', k: /fragen|frag/i, know: 'Coop Pronto Musterdorf: frag mich «Wofür war der Einkauf?»' },
    { l: 'Immer 6200 Fahrzeugaufwand', s: 'eine Regel', v: 'rule', k: /fahrzeug|benzin|auto|tank/i, know: 'Coop Pronto Musterdorf: Konto 6200 Fahrzeugaufwand, MWST I81' } ] },
  digitec: { q: 'Was kaufst du bei Digitec Galaxus?', opts: [
    { l: 'Nach Beleg entscheiden', s: 'empfohlen · Kleines in den Aufwand, Geräte über ein paar hundert Franken als Anlage', v: 'note', primary: true, k: /beleg|lies|lesen/i, know: 'Nach dem Beleg entscheiden: Kleines auf 6570 Informatik, Geräte über ein paar hundert Franken auf 1520 Büromaschinen.' },
    { l: 'Immer 6570 Informatik', s: 'eine Regel', v: 'rule', k: /informatik|immer/i, know: 'Digitec Galaxus: Konto 6570 Informatik, MWST I81' },
    { l: 'Immer fragen', s: 'eine Regel, die fragt', v: 'ask', k: /fragen|frag/i, know: 'Digitec Galaxus: frag mich «Was hast du gekauft?»' } ] },
  bargeld: { q: 'Wofür hebst du Bargeld ab?', opts: [
    { l: 'Immer fragen, wofür', s: 'empfohlen · der Bankauszug sagt es nicht, der Beleg fehlt oft', v: 'ask', primary: true, k: /fragen|frag/i, know: 'Barbezüge (Text enthält Bargeldbezug oder Bancomat): frag mich «Wofür war der Barbezug?» (Vorschlag: Konto 2451, ohne MWST)' },
    { l: 'Immer privat', s: 'Regel: 2451 Kontokorrent Gesellschafterin, ohne MWST', v: 'rule', k: /privat/i, know: 'Barbezüge (Text enthält Bargeldbezug oder Bancomat): Konto 2451 Kontokorrent Gesellschafterin, ohne MWST' } ] },
};
const RARE = ['Vistaprint 2×', 'Landi Musterdorf 2×', 'Brockenhaus Zürich 1×', 'Möbel Pfister 1×', 'Kaffeemaschinen Service AG 2×', 'Druckerei am Bach 1×', 'Bäckerei Muster 2×'];
const vatText = (v) => (v ? `MWST ${v}` : 'ohne MWST');

// ── 1 · Gespräch ─────────────────────────────────────────────────────────────────────────────────
async function talk() {
  enter('talk');
  await say('Hallo Anna. Ich richte deine Buchhaltung mit dir ein. Du sagst mir, was du hast, ich hole den Rest. Das dauert etwa eine Viertelstunde.');
  await say('Deine UID habe ich schon im öffentlichen UID-Register nachgeschlagen:');
  await block(`<div class="obcard"><dl class="obkv">
    <dt>Name</dt><dd>Muster Kaffee GmbH</dd><dd></dd>
    <dt>Rechtsform</dt><dd>GmbH</dd><dd></dd>
    <dt>Adresse</dt><dd>Musterstrasse 1, 8000 Zürich</dd><dd></dd>
    <dt>MWST</dt><dd>eingetragen · <span class="mono">CHE-123.456.789 MWST</span></dd><dd><span class="obbadge ai">UID-Register</span></dd>
  </dl></div>`);
  const right = await ask([{ l: 'Stimmt so', v: 'ok', k: /stimmt|^ja|ok|genau|richtig/i, primary: true }, { l: 'Etwas stimmt nicht', v: 'fix', k: /nein|falsch|nicht/i }], 'ok');
  if (right === 'fix') await say('Sag mir einfach, was anders ist. Ich trage es so ein und merke mir, dass es von dir kommt, nicht aus dem Register. Hier im Prototyp nehmen wir die Angaben, wie sie sind.');
  $('h1', company).textContent = 'Muster Kaffee GmbH';
  $('.counts span', company).textContent = 'Anna Muster';
  setRow('profile', 'CHE-123.456.789'); tick('firma');

  await say('Womit hast du bisher gebucht?');
  S.prog = await ask([
    { l: 'Bexio', v: 'bexio', k: /bexio/i },
    { l: 'Abacus', v: 'abacus', k: /abacus|abaninja/i },
    { l: 'Banana', v: 'banana', k: /banana/i },
    { l: 'Excel oder eine Tabelle', v: 'excel', k: /excel|tabelle|numbers|sheet/i },
    { l: 'Mein Treuhänder macht es', v: 'treuhand', k: /treuh|buchhalter|berater/i },
  ], 'bexio');
  await say({
    bexio: 'Gut, Bexio kenne ich. Über die Schnittstelle komme ich an fast alles, was ich brauche.',
    abacus: 'Abacus hat eine Schnittstelle. Oft liegt der Zugang beim Treuhänder; das klären wir gleich.',
    banana: 'Banana speichert alles in einer Datei. Die nehme ich direkt, eine Schnittstelle brauchen wir nicht.',
    excel: 'Dann lese ich deine Tabellen so, wie sie sind. Umbauen musst du nichts.',
    treuhand: 'Dann frage ich ihn für dich. Du musst am Ende nur eine Mail abschicken, die ich dir schreibe.',
  }[S.prog]);

  await say(hasApi() || S.prog === 'banana'
    ? `${P()} führt fast immer eine doppelte Buchhaltung, also Soll und Haben mit Kontenplan. Ist das bei dir auch so?`
    : 'Führst du eine doppelte Buchhaltung (Soll und Haben, mit Kontenplan) oder eine einfache (nur Einnahmen und Ausgaben)?');
  S.entry = await ask([
    { l: 'Ja, doppelt', v: 'double', k: /doppel|soll|haben|^ja/i },
    { l: 'Nur Einnahmen und Ausgaben', v: 'single', k: /einfach|einnahmen|nein/i },
    { l: 'Weiss nicht', v: 'unknown', k: /weiss|keine ahnung|unsicher/i },
  ], 'double');
  if (S.entry === 'single') await say('Dann gibt es kein Journal zum Übernehmen. Ich baue das Jahr aus deinen Kontoauszügen und Belegen, der Kontenplan kommt von uns. Im Prototyp zeige ich weiter den Weg mit Journal.');
  if (S.entry === 'unknown') await say('Kein Problem, das sehe ich, sobald ich die Daten habe.');

  await say('Laut Register bist du MWST-pflichtig. Wie rechnest du ab?');
  S.vat = await ask([
    { l: 'Effektiv, pro Quartal', s: 'das Übliche', v: 'eff', k: /effektiv|quartal/i, primary: true },
    { l: 'Saldosteuersatz, pro Halbjahr', v: 'net', k: /saldo|halbjahr|pauschal/i },
    { l: 'Weiss nicht, schau du nach', v: 'unknown', k: /weiss|schau|nach/i },
  ], 'eff');
  if (S.vat === 'unknown') await say(`Das lese ich aus deiner letzten Abrechnung in ${P()}. Bis dahin nehme ich effektiv und pro Quartal an und sage dir, falls es anders ist.`);
  if (S.vat === 'net') await say('Dann frage ich dich nachher nach deinem Satz. Im Prototyp zeige ich den Weg mit der effektiven Methode.');
  await say('Und ich nehme an, du rechnest nach vereinnahmten Entgelten ab, also wenn bezahlt ist, nicht wenn verrechnet. Wenn nicht, sag es einfach.');
  setRow('vat', 'effektiv · Quartal'); tick('mwst');

  await say('Ab wann soll Vanilla Accounting buchen?');
  S.path = await ask([
    { l: 'Ab 1. Januar 2026', s: 'sauberer Schnitt, 2025 bleibt in ' + (S.prog === 'treuhand' ? 'den alten Büchern' : P()), v: 'jan', k: /1\.\s*1|januar|jahresanfang|neujahr|anfang/i },
    { l: 'Im laufenden Jahr, ab 1. Juli 2026', s: 'Q1 und Q2 sind schon gebucht', v: 'mitte', k: /lauf|juli|mitte|q3|jetzt/i },
  ], S.path);
  tell();
  if (mid()) {
    await say('Welche Quartale 2026 hast du schon bei der ESTV eingereicht?');
    S.filed = await ask([
      { l: 'Q1 und Q2', v: 2, k: /beide|q1 und q2|q2|zwei/i },
      { l: 'Nur Q1', v: 1, k: /nur q1|q1/i },
      { l: 'Noch keins', v: 0, k: /kein|nichts/i },
    ], 2);
    await say('Wie soll das erste Halbjahr rein? Ich empfehle das ganze Journal: jede Buchung kommt in die Bücher, und ich vergleiche jedes eingereichte Quartal mit der Abrechnung, bevor ich es versiegle.');
    S.h1 = await ask([
      { l: 'Ganzes Journal', s: 'empfohlen', v: 'journal', k: /journal|ganz|alle/i, primary: true },
      { l: 'Nur Kontosummen per 30.6.', s: 'schneller und reicht für den Abschluss, aber eine spätere Korrektur von Q1 oder Q2 kann die App dann nicht berechnen', v: 'totals', k: /summe|saldo|nur/i },
    ], 'journal');
  }
  if (S.prog !== 'treuhand') {
    await say(`Wer kommt an die Daten in ${P()}?`);
    S.who = await ask([
      { l: 'Ich, ich habe einen Login', v: 'me', k: /ich|login|selbst/i },
      { l: 'Mein Treuhänder', v: 'treuhand', k: /treuh/i },
      { l: 'Wir beide', v: 'both', k: /beide|wir/i },
    ], 'me');
  } else S.who = 'treuhand';
}

// ── 2 · Was ich von dir brauche ──────────────────────────────────────────────────────────────────
async function checklist() {
  enter('list');
  await say('Das ist alles, was ich wissen muss. Hier ist, was ich dafür brauche, und wer es holt:');
  const viaMail = S.who === 'treuhand';
  const fetcher = viaMail ? '<span class="obbadge">dein Treuhänder</span>' : '<span class="obbadge ai">ich hole es</span>';
  const items = [
    ['Kontenplan', `so wie in ${S.prog === 'treuhand' ? 'deinen Büchern' : P()}, mit deinen Nummern und Namen`, fetcher],
    ['Buchungen 2025', 'als Beispiele, aus denen ich lerne; sie kommen nicht in deine Bücher', fetcher],
    ['Bilanz per 31.12.2025', 'für die Eröffnung am 1.1.2026', fetcher],
  ];
  if (mid() && S.h1 === 'journal') items.push(['Buchungen 1.1. bis 30.6.2026', 'die kommen in die Bücher', fetcher]);
  if (mid() && S.h1 === 'totals') items.push(['Kontosummen per 30.6.2026', 'als Stand, ab dem die App weiterbucht', fetcher]);
  if (mid() && S.filed) items.push([`Eingereichte MWST-Abrechnung${S.filed === 2 ? 'en Q1 und Q2' : ' Q1'} 2026`, 'so wie eingereicht, für den Vergleich', viaMail ? '<span class="obbadge">dein Treuhänder</span>' : '<span class="obbadge ai">ich hole sie, du meldest dich an</span>']);
  items.push(['Belege 2025', 'nicht nötig; nur wenn du sie hier haben willst', '<span class="obbadge">optional</span>']);
  const yours = viaMail ? ['Eine Mail abschicken', 'an deinen Treuhänder; ich schreibe sie dir'] : hasApi() ? [`Einmal Zugang zu ${P()}`, 'etwa zwei Minuten: einen Schlüssel erstellen und hier einfügen'] : [`Die ${P()}-Datei hierher ziehen`, 'oder ich zeige dir, wo du sie findest'];
  items.push([...yours, '<span class="obbadge warn">von dir</span>']);
  const card = await block(`<div class="obcard"><h4>Was ich von dir brauche</h4><ul class="obcheck">${items.map(([b, s, badge]) => `<li>${I.doc}<b>${b}</b>${badge}<span class="rk">${s}</span></li>`).join('')}</ul>
    <span class="rk">${mid() ? 'Q3 2026 rechnest du schon hier ab.' : `Die MWST-Abrechnung Q4 2025 machst du noch wie immer ${S.prog === 'treuhand' ? 'mit deinem Treuhänder' : 'in ' + P()}.`}</span></div>`);
  card.dataset.list = '1';
  S.how = await ask(viaMail
    ? [{ l: 'Mail an den Treuhänder ansehen', v: 'mail', k: /mail|treuh|weiter|ok|ja/i, primary: true }, { l: 'Ich hole es doch selbst', v: 'file', k: /selbst|datei|export/i }]
    : hasApi()
      ? [{ l: 'Hol es dir', v: 'api', k: /hol|los|ja|ok|weiter|mach/i, primary: true }, { l: 'Ich exportiere lieber selbst', v: 'file', k: /selbst|export|datei/i }]
      : [{ l: 'Datei ablegen', v: 'file', k: /datei|ablegen|ok|weiter|ja/i, primary: true }, { l: 'Mein Treuhänder hat sie', v: 'mail', k: /treuh/i }], viaMail ? 'mail' : hasApi() ? 'api' : 'file');
}

// ── 3 · Ich hole es für dich ─────────────────────────────────────────────────────────────────────
const FOUND = () => `<div class="found">
  <div><b>27</b><span>Konten</span></div>
  <div><b>1'184</b><span>Buchungen 2025</span></div>
  ${mid() && S.h1 === 'journal' ? "<div><b>612</b><span>Buchungen 2026</span></div>" : ''}
  <div><b>2</b><span>Bankkonten</span></div>
  <div><b>12</b><span>MWST-Codes</span></div>
  <div><b>6</b><span>Eröffnungssalden</span></div>
</div>`;

async function fetchAll() {
  enter('fetch');
  const got = deferred();
  const ways = async (exclude) => {
    const w = [['file', 'Exportdatei', 'Du exportierst, ich lese die Datei.'], ['browser', 'Im App-Browser anmelden', 'Du meldest dich an, ich lade herunter.'], ['mail', 'Treuhänder fragen', 'Ich schreibe die Mail, du schickst sie.']].filter(([k]) => k !== exclude);
    const b = await block(`<span class="rk">Geht das nicht? ${w.length === 3 ? 'Drei' : 'Zwei'} andere Wege:</span><div class="obways" style="grid-template-columns: repeat(${w.length}, 1fr)">${w.map(([k, t, s]) => `<button type="button" data-way="${k}"><b>${t}</b><span>${s}</span></button>`).join('')}</div>`);
    b.addEventListener('click', (e) => { const x = e.target.closest('[data-way]'); if (x) { b.remove(); me(x.querySelector('b').textContent); route(x.dataset.way); } });
  };
  const finish = (card, how) => { got.resolve(how); return card; };

  const routes = {
    async api() {
      await say(`Am schnellsten geht es über die ${P()}-Schnittstelle. Ich habe dafür eine Quelle geschrieben, die einmal holt und sich danach abschaltet:`);
      const c = await block(`<div class="obcard obsrc">
        <div class="srchead"><b>${P()}: Umzug, einmal holen</b><span class="mono">sources/${S.prog}-umzug/</span></div>
        <ul class="srcplain">
          <li>Liest über die ${P()}-Schnittstelle: Kontenplan, Buchungen 2025${mid() ? ' und 2026 bis 30.6.' : ''}, MWST-Codes, Bilanz per 31.12.2025.</li>
          <li>Schreibt nichts in ${P()}, und nichts in deine Bücher, bevor du es übernimmst.</li>
          <li>Läuft einmal. Danach schaltet sie sich ab.</li>
          <li>Den Schlüssel legt sie im Schlüsselbund dieses Macs ab, nicht im Workspace.</li>
        </ul>
        <div class="srcpw"><input aria-label="Zugangsschlüssel" placeholder="Zugangsschlüssel aus ${P()}" readonly><button type="button" class="btn" data-key>${I.key} Einfügen</button></div>
        <details class="srclines"><summary>Wo finde ich den Schlüssel?</summary><p>In ${P()} bei den Zugängen für Apps einen neuen Schlüssel erstellen, nur mit Leserechten. Ich zeige dir die genauen Menünamen deiner Version, wenn du so weit bist.</p></details>
        <div class="srccheck"><button type="button" class="btn" data-check disabled>Prüfen</button><span class="rk">zeigt, was sie holen würde, ohne etwas zu holen</span></div>
      </div>`);
      const card = $('.obcard', c);
      await click(card, '[data-key]');
      $('input', card).value = '•••• •••• •••• 7f3a'; $('[data-key]', card).disabled = true; $('[data-check]', card).disabled = false;
      await click(card, '[data-check]');
      $('.srccheck', card).remove();
      await progress(card, `Frage ${P()} nach dem, was da ist …`);
      card.insertAdjacentHTML('beforeend', `<div class="rk">Das würde sie holen:</div>${FOUND()}<span class="rk">Nichts davon ist schon in deinen Büchern. «Holen» legt es in den Workspace, nicht in ${P()}.</span><div class="actions"><button type="button" class="aiact primary" data-get>${I.down} Holen</button></div>`);
      down();
      await click(card, '[data-get]');
      $('.actions', card).remove();
      await progress(card, 'Hole …');
      ok(card, 'Geholt. Die Quelle hat sich abgeschaltet.');
      setRow('sources', `${P()} · aus`);
      finish(card, 'api');
    },
    async file() {
      await say(`Gut. So kommst du in ${P() === 'deinem Treuhänder' ? 'deinem Programm' : P()} zu den Dateien; ich zeige dir die genauen Menünamen deiner Version:`);
      const c = await block(`<div class="obcard"><ol class="obsteps">
          <li>Die Buchhaltung öffnen und das Journal exportieren, Zeitraum 1.1. bis 31.12.2025${mid() ? ', dann nochmals 1.1. bis 30.6.2026' : ''}.</li>
          <li>Den Kontenplan und die Bilanz per 31.12.2025 ebenso exportieren.</li>
          <li>Die Dateien hierher ziehen. Welches Format, ist egal.</li>
        </ol>
        <div class="obdrop" data-drop role="button" tabindex="0"><b>Dateien hierher ziehen</b><span class="rk">oder klicken, um im Prototyp eine Beispieldatei abzulegen</span></div></div>`);
      const card = $('.obcard', c);
      pendingDrop = deferred();
      $('[data-drop]', card).addEventListener('click', () => dropped(`${S.prog === 'treuhand' ? 'buchhaltung' : S.prog}-export-2025.zip`));
      if (ff()) pendingDrop.resolve('export.zip');
      await pendingDrop; pendingDrop = null;
      $('[data-drop]', card).remove();
      await progress(card, 'Lese die Dateien …');
      card.insertAdjacentHTML('beforeend', `<div class="rk">Gelesen:</div>${FOUND()}`);
      ok(card, 'Alles da. Nichts davon ist schon in deinen Büchern.');
      finish(card, 'file');
    },
    async browser() {
      await say(`Dann öffne ich ${P() === 'deinem Treuhänder' ? 'dein Programm' : P()} in einem Fenster der App. Du meldest dich an wie immer, ich lade die Exporte herunter:`);
      const c = await block(`<div class="obcard obsrc">
        <div class="srchead"><b>${P()} im App-Fenster</b><span class="mono">einmal</span></div>
        <ul class="srcplain"><li>Öffnet die Anmeldeseite in einem Fenster der App.</li><li>Du meldest dich selbst an; dein Passwort sehe ich nicht.</li><li>Ich lade Kontenplan, Journal und Bilanz als Export herunter und schliesse das Fenster.</li></ul>
        <div class="actions"><button type="button" class="aiact primary" data-open>Fenster öffnen</button></div></div>`);
      const card = $('.obcard', c);
      await click(card, '[data-open]');
      $('.actions', card).remove();
      await progress(card, 'Warte auf deine Anmeldung …');
      await progress(card, 'Angemeldet. Lade herunter …');
      card.insertAdjacentHTML('beforeend', FOUND());
      ok(card, 'Geholt. Das Fenster ist zu.');
      finish(card, 'browser');
    },
    async mail() {
      await say('Hier ist die Mail an deinen Treuhänder. Ich schicke nichts selbst; du schickst sie ab, seine Antwort kommt über deine Beleg-Adresse herein.');
      const list = ['den Kontenplan', 'das Journal 2025 (CSV oder Excel)', 'die Bilanz per 31.12.2025'];
      if (mid()) list.push(S.h1 === 'journal' ? 'das Journal 1.1. bis 30.6.2026' : 'die Kontosummen per 30.6.2026', 'die eingereichten MWST-Abrechnungen Q1 und Q2 2026 als PDF');
      const c = await block(`<div class="obcard"><div class="obmail">
          <span class="h">An: dein Treuhänder · Betreff: Unterlagen für den Wechsel zu Vanilla Accounting</span>
          <p>Hallo

Ich wechsle ${mid() ? 'per 1.7.2026' : 'per 1.1.2026'} zu Vanilla Accounting. Kannst du mir bitte schicken:
${list.map((x) => '· ' + x).join('\n')}

Am einfachsten an belege@muster-kaffee.ch.

Danke und Gruss
Anna</p></div>
        <div class="actions"><button type="button" class="aiact primary" data-mail>${I.mail} In Mail öffnen</button><button type="button" class="aiact">Kopieren</button></div></div>`);
      const card = $('.obcard', c);
      await click(card, '[data-mail]');
      $('.actions', card).innerHTML = '<span class="rk">Gesendet aus deinem Mailprogramm. Ich warte auf die Antwort.</span><button type="button" class="aiact" data-reply>Antwort ist da (im Prototyp)</button>';
      await click(card, '[data-reply]');
      $('.actions', card).remove();
      await progress(card, 'Lese die Anhänge aus der Antwort …');
      card.insertAdjacentHTML('beforeend', FOUND());
      ok(card, 'Alles da, aus der Antwort deines Treuhänders.');
      finish(card, 'mail');
    },
  };
  const route = (k) => routes[k]();
  route(S.how);
  if (S.how !== 'mail' || S.prog !== 'treuhand') { if (!ff()) await wait(400); if (!ff()) ways(S.how); }
  await got;
  thread.querySelectorAll('.obways').forEach((w) => w.parentElement.remove());
  setRow('banks', '2'); setRow('accounts', '27'); tick('konten');
  if (!mid()) tick('journal');

  if (mid() && S.filed) {
    const qs = S.filed === 2 ? 'Q1 und Q2' : 'Q1';
    if (S.who === 'treuhand' || S.how === 'mail') {
      await say(`Die eingereichten Abrechnungen ${qs} 2026 waren in der Antwort deines Treuhänders dabei. Ich lege sie ab, wie sie eingereicht sind.`);
    } else {
      await say(`Jetzt noch die eingereichten Abrechnungen ${qs} 2026. Die hole ich aus dem ESTV-Portal:`);
      const c = await block(`<div class="obcard obsrc">
        <div class="srchead"><b>ESTV ePortal: eingereichte Abrechnungen</b><span class="mono">einmal</span></div>
        <ul class="srcplain"><li>Öffnet das ePortal in einem Fenster der App.</li><li>Du meldest dich selbst an; dein Passwort sehe ich nicht.</li><li>Lädt die Abrechnungen ${qs} 2026 herunter und legt sie ab, wie sie eingereicht sind.</li></ul>
        <div class="actions"><button type="button" class="aiact primary" data-open>Im App-Fenster öffnen</button><button type="button" class="aiact" data-tr>Hat mein Treuhänder</button></div></div>`);
      const card = $('.obcard', c);
      const b = await click(card, '[data-open], [data-tr]');
      $('.actions', card).remove();
      if (b.dataset.tr !== undefined) ok(card, 'Dann frage ich ihn in derselben Mail. Im Prototyp sind sie schon da.');
      else await progress(card, 'Warte auf deine Anmeldung, dann lade ich herunter …');
      ok(card, S.filed === 2 ? '2 Abrechnungen abgelegt: Q1 2026 (eingereicht 28.04.2026) und Q2 2026 (eingereicht 27.07.2026).' : '1 Abrechnung abgelegt: Q1 2026 (eingereicht 28.04.2026).');
    }
  }

  await say('Den Kontenplan übernehme ich, wie er ist. Vier Konten habe ich erkannt: Bank 1021, Wise EUR 1023, Vorsteuer 1170 und 1171, geschuldete MWST 2200. Bei einem bin ich unsicher:');
  await say('Konto 2451 «Kontokorrent Gesellschafterin»: ist das dein Privatkonto in der Firma, also wo private Ausgaben hinkommen?');
  const priv = S.priv = await ask([{ l: 'Ja', v: 'yes', k: /^ja|genau|stimmt|privat/i, primary: true }, { l: 'Nein, etwas anderes', v: 'no', k: /nein|anders/i }], 'yes');
  const b = await block('');
  ok(b, priv === 'yes' ? 'Gespeichert: 2451 ist dein Privatkonto · Quelle: deine Antwort' : 'Gut, dann frage ich dich bei der ersten privaten Zahlung, wohin sie soll.');
}

// ── 4 · Erstes Halbjahr (only in the running year) ───────────────────────────────────────────────
const Q = {
  Q1: [['299', 'Steuerbarer Umsatz', "41'920.30", "41'920.30"], ['399', 'Geschuldete Steuer', "2'961.40", "2'961.40"], ['400', 'Vorsteuer Material und Dienstleistungen', '486.20', '486.20'], ['405', 'Vorsteuer Investitionen und Betriebsaufwand', '612.75', '612.75'], ['500', 'Zu bezahlen', "1'862.45", "1'862.45"]],
  Q2: [['299', 'Steuerbarer Umsatz', "46'115.80", "46'115.80"], ['399', 'Geschuldete Steuer', "3'271.05", "3'271.05"], ['400', 'Vorsteuer Material und Dienstleistungen', '540.10', '540.10'], ['405', 'Vorsteuer Investitionen und Betriebsaufwand', '701.30', '688.90'], ['500', 'Zu bezahlen', "2'029.65", "2'042.05"]],
};
const qTable = (rows, fixed) => `<table class="obtable"><thead><tr><th>Ziffer</th><th></th><th class="n">aus dem Journal</th><th class="n">eingereicht</th></tr></thead><tbody>${rows.map(([z, t, a, b]) => {
  const v = fixed && z === '405' ? '688.90' : fixed && z === '500' ? "2'042.05" : a;
  return `<tr class="${v !== b ? 'off' : ''}"><td class="mono">${z}</td><td>${t}</td><td class="n">${v}</td><td class="n">${b}</td></tr>`;
}).join('')}</tbody></table>`;

async function half() {
  enter('half');
  if (S.h1 === 'totals') {
    await say(`Die Kontosummen per 30.6.2026 sind übernommen. Q1 und Q2 bleiben, wie sie in ${P()} gebucht und eingereicht sind; eine Korrektur dazu machst du mit deinem Treuhänder.`);
    setRow('periods', 'bis 30.06.2026'); tick('journal');
    return;
  }
  if (!S.filed) {
    await say('Noch nichts eingereicht: das ganze Halbjahr kommt in die Bücher, und du reichst Q1 und Q2 hier ein. Ich zeige dir die Abrechnungen, sobald wir fertig sind.');
    tick('journal');
    return;
  }
  await say('Bevor das erste Halbjahr in die Bücher kommt, rechne ich jedes eingereichte Quartal aus deinem Journal nach und vergleiche es Ziffer für Ziffer mit der Abrechnung. Erst wenn es stimmt, versiegle ich es. Danach ändert sich das Quartal nie mehr.');
  const c1 = await block(`<div class="obcard"><div class="obq"><b>Q1 2026</b><span class="rk">eingereicht 28.04.2026</span><span class="obbadge pos">stimmt</span></div>${qTable(Q.Q1)}
    <div class="okline">${I.ok}<span>Q1 stimmt mit der eingereichten Abrechnung überein.</span></div>
    <div class="actions"><button type="button" class="aiact primary" data-seal>Q1 versiegeln</button></div></div>`);
  const k1 = $('.obcard', c1);
  await click(k1, '[data-seal]');
  $('.actions', k1).remove();
  ok(k1, 'Q1 versiegelt. Bis 31.03.2026 ändert sich nichts mehr.');
  setRow('periods', 'bis 31.03.2026');

  if (S.filed === 2) {
    const c2 = await block(`<div class="obcard"><div class="obq"><b>Q2 2026</b><span class="rk">eingereicht 27.07.2026</span><span class="obbadge warn">1 Abweichung</span></div>${qTable(Q.Q2)}
      <div class="warnline">${I.warn}<span>Weicht in Ziffer 405 um CHF 12.40 ab.</span></div>
      <div class="obwhy">Eine Rechnung von Digitec Galaxus über CHF 165.50 mit 8.1 % MWST hat ${P()} am Rechnungsdatum gebucht, dem 24.06. Bezahlt hast du sie am 02.07. Du rechnest nach vereinnahmten Entgelten ab, also gehört die Vorsteuer ins Q3. In der eingereichten Abrechnung fehlt sie darum zu Recht.</div>
      <div class="qacts">
        <button type="button" class="btn primary" data-fix="q3">Am Zahlungsdatum ins Q3 buchen<small>empfohlen · Q2 stimmt dann, die CHF 12.40 kommen in die Abrechnung Q3</small></button>
        <button type="button" class="btn" data-fix="q2">In Q2 lassen<small>Q2 wird so versiegelt; die CHF 12.40 zeigt die Korrekturabrechnung Q2 (Formular 0535)</small></button>
      </div>
      <div class="actions"><button type="button" class="aiact primary" data-seal disabled title="Erst eine Antwort wählen">Q2 versiegeln</button></div></div>`);
    const k2 = $('.obcard', c2);
    const fix = await click(k2, '[data-fix]');
    S.q2fix = fix.dataset.fix;
    k2.querySelectorAll('[data-fix]').forEach((x) => { x.disabled = x !== fix; x.classList.toggle('chosen', x === fix); x.classList.remove('primary'); });
    if (fix.dataset.fix === 'q3') {
      $('table', k2).outerHTML = qTable(Q.Q2, true);
      $('.warnline', k2).remove();
      $('.qacts', k2).insertAdjacentHTML('afterend', `<div class="okline">${I.ok}<span>Q2 stimmt jetzt mit der eingereichten Abrechnung überein. Die Digitec-Rechnung ist am 02.07.2026 gebucht.</span></div>`);
      $('.obq .obbadge', k2).className = 'obbadge pos'; $('.obq .obbadge', k2).textContent = 'stimmt';
    }
    $('[data-seal]', k2).disabled = false;
    await click(k2, '[data-seal]');
    $('.actions', k2).remove();
    ok(k2, fix.dataset.fix === 'q3' ? 'Q2 versiegelt. Bis 30.06.2026 ändert sich nichts mehr.' : 'Q2 versiegelt, mit der Abweichung. Die Korrekturabrechnung Q2 zeigt die CHF 12.40 im MWST-Bereich.');
    setRow('periods', 'bis 30.06.2026');
  } else {
    await say('Q2 ist noch nicht eingereicht. Es kommt einfach in die Bücher, und du reichst es hier ein.');
  }
  tick('journal');
  await say('Q3 ist offen: ab dem 1. Juli buchst du hier. Muss später etwas an einem versiegelten Quartal korrigiert werden, buche ich es im offenen Quartal, und es kommt in die Korrekturabrechnung des Quartals, das es betrifft.');
}

// ── 5 · Was ich aus 2025 lerne ───────────────────────────────────────────────────────────────────
const ruleCard = (p) => `<div class="ruledraft" hidden>
  <span class="rk">Neue Regel</span>
  <b>${p.name} → ${p.acc} · ${vatText(p.vat)}</b>
  <span class="rk">Erkennt die Zahlung am Namen auf dem Kontoauszug, «${p.tx}». Keine andere Regel gilt für dieselben Zahlungen.</span>
  <div class="rulepreview"><span class="rk">So gebucht 2025, ${p.n} von ${p.n}:</span><ul>${p.ex.map(([d, a, t]) => `<li>${d} · ${a} · ${t}</li>`).join('')}${p.n > p.ex.length ? `<li class="rk">und ${p.n - p.ex.length} weitere</li>` : ''}</ul></div>
  <span class="rk">Herkunft, wenn du sie behältst: Buchungen 2025, von dir bestätigt</span>
  <div class="aiacts"><button type="button" class="aiact" data-keep>Behalten</button><button type="button" class="aiact" data-drop>Nicht als Regel</button></div>
</div>`;

async function knowledge() {
  enter('know');
  await say('Jetzt zu dem, was ich aus deinen Buchungen 2025 lerne. Vorweg: Was 2025 gebucht ist, nehme ich als Beispiel, nicht als Regel. Eine Regel gibt es erst, wenn du sie gesehen und behalten hast.');
  await say('Ich habe 88 Geschäftspartner gefunden und in drei Gruppen sortiert:');
  const c = await block(`<div class="obcard">
    <div class="obbin"><div class="obbinh"><b>Eindeutig</b><span class="count">8 Partner</span><span class="rk">immer gleich gebucht, mindestens 4×</span></div>
      <ul class="obrows">${CLEAR.map((p, i) => `<li><button type="button" class="obrow" data-row="${i}" aria-expanded="false">${I.chev}<span class="nm">${p.name}</span><span class="ev">${p.n} von ${p.n}</span><span class="bk">${p.acc} · ${vatText(p.vat)}</span><span class="sm">${p.sum}</span></button>${ruleCard(p)}</li>`).join('')}</ul>
      <div class="actions"><button type="button" class="aiact primary" data-all>Alle 8 übernehmen</button><span class="rk">oder eine Zeile öffnen und einzeln entscheiden</span></div>
    </div>
    <div class="obbin"><div class="obbinh"><b>Uneinheitlich</b><span class="count">3 Partner</span><span class="rk">mal so, mal anders gebucht: dazu frage ich dich je einmal</span></div>
      <div class="obmix">${MIXED.map((m) => `<span>${m.name} <span class="rk">${m.n}×</span></span><span class="obsplit" title="${m.parts.map(([a, n]) => `${n}× ${a}`).join(', ')}">${m.parts.map(([, n]) => `<i style="flex:${n}"></i>`).join('')}</span><span class="rk">${m.parts.map(([a, n]) => `${n}× ${a}`).join(' · ')}</span>`).join('')}</div>
    </div>
    <div class="obbin"><div class="obbinh"><b>Selten</b><span class="count">75 Partner</span><span class="rk">ein- oder zweimal: bleiben Beispiele</span></div>
      <div class="obrare">${RARE.map((r) => `<span>${r}</span>`).join('')}<span>und 68 weitere</span></div>
      <span class="rk">Kommt einer wieder, schlage ich die Buchung von 2025 vor, und du bestätigst sie.</span>
    </div></div>`);
  const card = $('.obcard', c);
  const decided = new Map();
  const allDone = deferred();
  const decide = (i, keep) => {
    decided.set(i, keep);
    const r = card.querySelector(`[data-row="${i}"]`);
    r.classList.toggle('kept', keep); r.setAttribute('aria-expanded', 'false');
    const d = r.nextElementSibling; d.hidden = true;
    if (decided.size === CLEAR.length) allDone.resolve();
  };
  card.addEventListener('click', (e) => {
    const r = e.target.closest('[data-row]');
    if (r) { const open = r.getAttribute('aria-expanded') !== 'true'; r.setAttribute('aria-expanded', String(open)); r.nextElementSibling.hidden = !open; return; }
    const k = e.target.closest('[data-keep], [data-drop]');
    if (k) { const i = +k.closest('li').querySelector('[data-row]').dataset.row; decide(i, k.dataset.keep !== undefined); return; }
    if (e.target.closest('[data-all]')) { CLEAR.forEach((_, i) => { if (!decided.has(i)) decide(i, true); }); }
  });
  pendingGo = () => { card.querySelector('[data-all]').click(); return true; };
  if (ff()) CLEAR.forEach((_, i) => decide(i, true));
  await allDone; pendingGo = null;
  S.keptList = CLEAR.filter((_, i) => decided.get(i));
  S.kept = S.keptList.length;
  $('.obbin .actions', card).remove();
  S.learned = true;
  ok(card, `${S.kept} Regeln behalten · Herkunft: Buchungen 2025, von dir bestätigt · steht bei den Geschäftspartnern`);
  KW.refresh();

  await say('Zwei Partner waren zwar immer gleich gebucht, aber so übernehme ich sie nicht. Ein drittes Muster auch nicht:');
  const f = await block(`<div class="obcard"><h4>So nicht übernehmen</h4>
    ${FLAGS.map((x) => `<div class="obflag"><span class="nm">${x.name} <span class="rk">${x.n}×</span></span><span><s>2025: ${x.was}</s> → <span class="now">${x.now}</span></span><span class="why">${x.why}</span><button type="button" class="aiact" data-other="${x.of}">Ich sehe es anders</button></div>`).join('')}
    <span class="rk">Deine Bücher 2025 bleiben, wie sie eingereicht sind. Ob du für 2025 etwas nachmelden musst, klärst du am besten mit deinem Treuhänder.</span></div>`);
  f.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-other]'); if (!o) return;
    o.disabled = true; me(`Ich sehe es anders bei ${o.dataset.other}.`);
    S.disputed.push(o.dataset.other); KW.refresh();
    await say('Erzähl mir, was anders war. Ich schreibe deine Antwort auf und frage dich bei der nächsten Zahlung nochmals, mit deinem Grund daneben. Bis dahin bleibt es wie oben.');
    input.focus();
  });
  await ask([{ l: 'Verstanden, weiter', v: 'ok', k: /weiter|ok|verstanden|ja/i, primary: true }], 'ok');

  await say('Noch drei Fragen, die mit den meisten Zahlungen zuerst. Jede kannst du überspringen; dann frage ich bei der nächsten Zahlung.');
  const said = { note: (n) => `Steht in den Notizen von ${n}: nach Beleg entscheiden · Quelle: deine Antwort`, ask: (n) => `Regel gespeichert: bei ${n} fragen · Quelle: deine Antwort`, rule: (n) => `Regel gespeichert für ${n} · Quelle: deine Antwort`, skip: (n) => `Übersprungen. Bei der nächsten Zahlung an ${n} frage ich nochmals.` };
  for (const m of MIXED) {
    const q = QUESTIONS[m.id];
    await say(`<p><b>${q.q}</b></p><p>2025: ${m.n} Zahlungen, CHF ${m.sum}. ${m.parts.map(([a, n]) => `${n}× ${a}`).join(', ')}.</p>`);
    const a = await ask([...q.opts, { l: 'Überspringen', v: 'skip', k: /überspring|später|skip/i }], q.opts[0].v);
    if (a === 'note') S.notes++; else if (a === 'skip') S.skipped.push(m.name); else S.ruleAnswers++;
    S.answers.push({ id: m.id, kind: a });
    KW.refresh();
    const b = await block('');
    ok(b, said[a](m.name));
  }
  tick('wissen');
}

// ── 6 · Fertig ───────────────────────────────────────────────────────────────────────────────────
const OPENING = [['1021', 'Bank Raiffeisen', "18'500.00", ''], ['1023', 'Wise EUR', "3'753.36", ''], ['1510', 'Mobiliar und Einrichtungen', "12'000.00", ''], ['1520', 'Büromaschinen, Informatik', "2'500.00", ''], ['2800', 'Stammkapital', '', "20'000.00"], ['2970', 'Gewinnvortrag', '', "16'753.36"]];

async function finish() {
  enter('done');
  const src = S.prog === 'treuhand' ? 'vom Treuhänder' : 'aus ' + P();
  await say('Fertig. Das weiss die App jetzt, und woher:');
  const items = [
    ['Firma, Rechtsform, Adresse', '<span class="obbadge ai">UID-Register</span>'],
    ['MWST effektiv, pro Quartal, nach vereinnahmten Entgelten', '<span class="obbadge">deine Antwort</span>'],
    ['Kontenplan mit 27 Konten, 2 Bankkonten', `<span class="obbadge">${src}</span>`],
  ];
  if (mid() && S.h1 === 'journal') items.push([`Erstes Halbjahr 2026: 612 Buchungen${S.filed ? `, ${S.filed === 2 ? 'Q1 und Q2' : 'Q1'} versiegelt` : ''}`, `<span class="obbadge">${src}</span>${S.filed ? '<span class="obbadge pos">mit Abrechnung verglichen</span>' : ''}`]);
  if (mid() && S.h1 === 'totals') items.push(['Kontosummen per 30.6.2026', `<span class="obbadge">${src}</span>`]);
  items.push([`${S.kept + S.ruleAnswers} Regeln`, `<span class="obbadge pos">${S.kept} aus Buchungen 2025, bestätigt</span>${S.ruleAnswers ? `<span class="obbadge">${S.ruleAnswers} aus deinen Antworten</span>` : ''}`]);
  if (S.notes) items.push([`${S.notes} ${S.notes === 1 ? 'Antwort steht' : 'Antworten stehen'} in den Notizen der Partner: nach Beleg entscheiden`, '<span class="obbadge">deine Antwort</span>']);
  items.push(['Notizen zu 12 Geschäftspartnern und 4 Seiten über eure Arbeitsweise, von mir entworfen', '<span class="obbadge ai">aus Buchungen 2025 und deinen Antworten</span>']);
  items.push(['3 Muster nicht übernommen', '<span class="obbadge warn">Regel der App</span>']);
  items.push(["1'184 Buchungen 2025 als Beispiele", '<span class="obbadge">nur Hinweise, nie in den Büchern</span>']);
  const c = await block(`<div class="obcard"><h4>Eingerichtet</h4><ul class="obsum">${items.map(([t, b]) => `<li><span>${t}</span><span>${b}</span></li>`).join('')}</ul>
    <h4>Was ich noch frage</h4>
    <span class="lead">Neue und seltene Partner: ich schlage eine Buchung vor, oft «wie 2025», und du bestätigst. Mit «Immer so?» wird daraus eine Regel.${S.skipped.length ? ` Übersprungen hast du ${S.skipped.join(', ')}: dazu frage ich bei der nächsten Zahlung.` : ''}</span>
    <h4>Eröffnung 1.1.2026</h4>
    <table class="obtable"><thead><tr><th>Konto</th><th></th><th class="n">Aktiven</th><th class="n">Passiven</th></tr></thead><tbody>
      ${OPENING.map(([k, n, a, p]) => `<tr><td class="mono">${k}</td><td>${n}</td><td class="n">${a}</td><td class="n">${p}</td></tr>`).join('')}
      <tr class="sum"><td></td><td>Total</td><td class="n">36'753.36</td><td class="n">36'753.36</td></tr></tbody></table>
    <span class="rk">Aus der Bilanz per 31.12.2025 ${src}. Bis zum Jahresabschluss kannst du sie in Firma › Eröffnung 2026 ändern.</span>
    <div class="actions"><button type="button" class="aiact primary" data-open>Eröffnung übernehmen</button></div></div>`);
  const card = $('.obcard', c);
  await click(card, '[data-open]');
  $('.actions', card).remove();
  ok(card, 'Eröffnung übernommen. Sie geht auf.');
  setRow('opening', '6 Konten'); tick('eroeffnung');
  await say('Das war es. Ab jetzt buche ich neue Zahlungen selbst; wo ich unsicher bin, frage ich dich unter Aufgaben. Mich findest du rechts in der KI-Spalte, wenn du etwas ändern willst.');
  const go = await block(`<div class="actions"><button type="button" class="aiact primary" data-go>Los geht's</button><button type="button" class="aiact" data-peek="wissen">Geschäftspartner ansehen</button><button type="button" class="aiact" data-peek="knowledge">Wissen ansehen</button></div><span class="rk">Beides hat links im Dock einen eigenen Bereich. Geschäftspartner: je Partner eine Seite mit deinen Notizen, dem, was die App selbst tut, und allem, was in den Büchern zu ihm gehört. Wissen: wie ihr arbeitet, eine Seite je Thema, und wo die App noch nicht allein weiterkommt.</span>`);
  await click(go, '[data-go]');
  panel.classList.remove('peek'); panel.classList.add('gone');
  show('journal');
  document.body.insertAdjacentHTML('beforeend', `<div class="obland" role="status">${I.check} Eingerichtet. Die App bucht ab ${mid() ? '1. Juli' : '1. Januar'} 2026; wo sie unsicher ist, fragt sie dich unter Aufgaben. Was sie weiss, steht bei den Geschäftspartnern und unter Wissen.</div>`);
  setTimeout(() => $('.obland').classList.add('fade'), 7000);
  chapter = 'landed'; tell();
}

(async () => {
  await talk();
  await checklist();
  await fetchAll();
  if (mid()) await half();
  await knowledge();
  await finish();
})();
