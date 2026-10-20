// Clickable prototype of the receipt inflow (docs/0.4.0/mockups/receipt-inflow). Nothing here talks to
// the app: the page is a capture of the real receipts page, and this script plays the new parts.
'use strict';

const svg = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const BOT = svg('<path d="M12 8V4H8"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M2 14h2M20 14h2M15 13v2M9 13v2"></path>', 'i bot');
const I = {
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path>'),
  fwd: svg('<path d="M15 5l6 6-6 6"></path><path d="M21 11H9a6 6 0 0 0-6 6v2"></path>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>'),
  bank: svg('<path d="M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18M12 3l9 5H3z"></path>'),
  plus: svg('<path d="M12 5v14M5 12h14"></path>'),
  down: svg('<path d="M12 4v12M6 10l6 6 6-6M4 20h16"></path>'),
  play: svg('<path d="M7 5v14l11-7z"></path>'),
  gear: svg('<circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"></path>'),
  laptop: svg('<rect x="4" y="5" width="16" height="11" rx="1"></rect><path d="M2 19h20"></path>'),
  print: svg('<path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z"></path>'),
  link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"></path><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"></path>'),
  shop: svg('<path d="M4 7h16l-1 13H5z"></path><path d="M9 7a3 3 0 0 1 6 0"></path>'),
  key: svg('<circle cx="8" cy="15" r="4"></circle><path d="m11 12 9-9M17 6l3 3"></path>'),
  archive: svg('<rect x="3" y="4" width="18" height="4" rx="1"></rect><path d="M5 8v11h14V8M10 12h4"></path>'),
  check: svg('<path d="M5 12l5 5 9-10"></path>'),
  phone: svg('<rect x="7" y="2" width="10" height="20" rx="2"></rect><path d="M11 18h2"></path>'),
  globe: svg('<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"></path>'),
};

const $ = (s, el = document) => el.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const main = $('main');

// What a way in is, as the strip shows it.
const CH = {
  imap: { icon: I.mail, label: 'info@muster-kaffee.ch', ok: 'vor 2 Min.', title: 'IMAP bei Infomaniak' },
  fwd: { icon: I.fwd, label: 'Weiterleitung belege@', ok: 'aktiv', title: 'Gmail-Filter leitet Rechnungen an belege@ weiter' },
  folder: { icon: I.folder, label: 'Ordner «Belege»', ok: 'beobachtet', title: 'iCloud Drive › Belege' },
  bank: { icon: I.bank, label: 'Zahlungen', ok: 'bis 31.08.', title: 'So weit sind Kontoauszüge eingelesen. Einen neuen (camt.053 oder PDF) einfach hierher ziehen.' },
  shopify: { icon: I.shop, label: 'Shopify-Rechnung', ok: 'monatlich', title: 'Erinnerung: Rechnung aus dem Shopify-Admin holen' },
  gmail: { icon: I.mail, label: 'anna.muster@gmail.com', ok: 'vor 2 Min.', title: 'IMAP bei Google' },
  applemail: { icon: I.laptop, label: 'Apple Mail', ok: 'liest mit', title: 'Liest die Rechnungen aus Apple Mail auf diesem Mac' },
  phone: { icon: I.phone, label: 'iPhone', ok: 'gekoppelt', title: 'Receipt-App auf dem iPhone, gekoppelt mit diesem Mac' },
};

let S;
function reset(mode) {
  S = { mode, channels: [], warn: {}, inbox: 0, covered: 0, total: 64, setup: null, fetched: 0, open: false, phone: 'none', reading: 0, questions: 0, run: null };
  if (mode !== 'blank') {
    S.channels = ['imap', 'fwd', 'folder', 'bank'];
    S.inbox = 0; S.covered = 58; S.phone = 'on'; S.questions = 1;
    S.run = { state: 'ok', at: 'vor 12 Min.', when: 'heute 22:46', sources: [['imap', 'ok', ['Swisscom · 64.90']], ['fwd', 'ok', []], ['folder', 'ok', []]] };
  }
  if (mode === 'problem') { S.run = { state: 'fail', at: 'vor 2 Std.', when: 'heute 21:00', sources: [['imap', 'fail', [], 'Anmeldung abgelaufen: das Passwort wurde wohl geändert'], ['fwd', 'ok', ['Google Workspace · 14.40']], ['folder', 'ok', []]] }; S.warn.imap = 'Anmeldung abgelaufen'; S.covered = 52; S.phone = 'off'; S.questions = 0; }
  closeAI(); closeDialog(); $('#toast').classList.remove('on');
  render();
}

function render() {
  const full = S.mode !== 'blank';
  main.innerHTML = $(full ? '#t-full' : '#t-empty').innerHTML;
  const period = full ? 'Q3 2026' : 'Q4 2026';
  document.querySelectorAll('.topbar .chip.mono').forEach((c) => { if (/Q\d \d{4}/.test(c.textContent)) c.textContent = `${period} ▾`; });
  if (full) renderStrip();
}

function runChip() {
  const r = S.run;
  if (!r) return '';
  if (r.state === 'running') return '<button type="button" class="runchip running" data-act="run"><span class="spin"></span>läuft …</button>';
  const failed = r.sources.filter((x) => x[1] === 'fail').length;
  return r.state === 'ok'
    ? `<button type="button" class="runchip ok" data-act="run" title="Letzter Lauf ${r.when}">✓ ${r.at}</button>`
    : `<button type="button" class="runchip fail" data-act="run" title="Letzter Lauf ${r.when}">✗ ${failed} von ${r.sources.length} fehlgeschlagen</button>`;
}

function runDialog() {
  const r = S.run;
  const icon = { ok: '<span class="ri ok">✓</span>', fail: '<span class="ri fail">✗</span>', running: '<span class="ri"><span class="spin"></span></span>' };
  const rows = r.sources.map(([k, st, items, why]) => `<div class="runrow">${icon[st]}<b>${CH[k].label}</b><span class="n">${st === 'fail' ? 'fehlgeschlagen' : items.length ? `${items.length} neu` : 'nichts Neues'}</span>
    ${items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
    ${why ? `<p class="why">${why}</p><div><button type="button" class="aiact primary" data-act="imap">Neu anmelden</button></div>` : ''}</div>`).join('');
  dialog(`${head('Belege holen')}
<div class="body">
  <p class="known ${r.state === 'fail' ? 'bad' : ''}">${r.state === 'fail' ? '<span class="ri fail">✗</span>' : I.check}<span><b>${r.state === 'running' ? 'Läuft' : r.state === 'ok' ? 'Erfolgreich' : 'Teilweise fehlgeschlagen'}</b> · ${r.when}<small>${r.manual ? 'Von Hand gestartet' : 'Automatisch gestartet'} · läuft jede Stunde von selbst</small></span></p>
  <div class="runrows">${rows}</div>
  <div class="acts"><button type="button" class="linkbtn back" data-act="runs-area">Alle Läufe in Automatisierung →</button><button type="button" class="aiact primary" data-act="close">Schliessen</button></div>
</div>`);
}

function wireDrop() {
  const z = $('.seg.dz');
  if (!z) return;
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', async (e) => {
    e.preventDefault(); z.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const group = $('.rows .group');
    for (const f of files.reverse()) group?.insertAdjacentHTML('afterend', `<div class="row fresh" role="option" tabindex="-1"><span class="d mono"><span class="dl">17.10.2026</span><span class="ds">17.10.</span></span><span class="t">${f.name.replace(/\.[^.]+$/, '')}<small> hierher gezogen</small><span class="newtag">neu</span></span><span class="a mono">…</span></div>`);
    toast(`${files.length} ${files.length > 1 ? 'Dateien' : 'Datei'} angenommen`);
    await readArrivals(files.length);
  });
}

function renderStrip() {
  const el = $('#strip');
  if (!el) return;
  const chips = S.channels.map((k) => {
    const c = CH[k]; const w = S.warn[k];
    return `<button type="button" class="chan${w ? ' warn' : ''}" data-chan="${k}" title="${c.title}">${c.icon}<i class="dot"></i>${c.label} · ${w || c.ok}</button>`;
  }).join('');
  const missing = S.total - S.covered;
  const warns = S.channels.filter((k) => S.warn[k]).length;
  const dots = S.channels.map((k) => `<span class="sd${S.warn[k] ? ' warn' : ''}" title="${CH[k].label}"></span>`).join('');
  const r = S.run;
  const runLine = !r ? 'noch nie gelaufen' : r.state === 'running' ? '<span class="spin"></span> läuft …' : r.state === 'ok' ? `✓ ${r.at}` : `✗ ${r.sources.filter((x) => x[1] === 'fail').length} von ${r.sources.length} fehlgeschlagen`;
  const phoneLine = S.phone === 'none' ? 'noch nicht gekoppelt' : S.phone === 'on' ? 'verbunden · Annas iPhone' : 'aus · nimmt nichts an';
  el.outerHTML = `<section class="ways3s${S.open ? ' open' : ''}" id="strip" aria-label="So kommen Belege in die App">
  <div class="segs">
    <div class="seg dz" data-act="drop-pick" title="PDFs und Fotos hierher ziehen oder klicken">${I.down}<span class="tx"><b>Hierher ziehen</b><small>PDFs und Fotos auf diese Zeile ziehen, oder klicken</small></span></div>
    <button type="button" class="seg phone ${S.phone}" data-act="phone-panel">${I.phone}<span class="tx"><b>${S.phone === 'none' ? 'Handy koppeln' : 'Handy'}</b><small><i class="pd"></i>${phoneLine}</small></span><span class="go">${S.phone === 'off' ? 'Einschalten' : S.phone === 'none' ? 'Koppeln' : 'Öffnen'} ›</span></button>
    <div class="seg auto ${r ? r.state : ''}">
      <button type="button" class="segmain" data-act="toggle" aria-expanded="${S.open}">${I.gear}<span class="tx"><b>Automatisch <span class="sdots">${dots}</span></b><small class="rl">${runLine}</small></span><svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button>
      <button type="button" class="aiact fetchbtn" data-act="fetch"${r && r.state === 'running' ? ' disabled' : ''} title="Jetzt holen, statt auf die nächste Stunde zu warten">Belege holen</button>
    </div>
  </div>
  ${S.reading ? `<div class="sline"><span class="spin"></span>${S.reading} ${S.reading > 1 ? 'werden' : 'wird'} gelesen …</div>` : S.questions ? `<div class="sline"><button type="button" class="linkbtn waiting" data-act="questions">${S.questions} ${S.questions > 1 ? 'warten' : 'wartet'} auf dich →</button></div>` : ''}
  ${S.open ? `<div class="more">
    <div class="chans">${chips}</div>
    ${S.total ? `<div class="cover"><span>${S.covered} von ${S.total} Zahlungen mit Beleg</span><span class="bar"><i style="width:${Math.round((100 * S.covered) / S.total)}%"></i></span><button type="button" class="linkbtn" data-act="missing">${missing} ohne Beleg →</button></div>` : ''}
    <div class="links">${r ? `<button type="button" class="linkbtn" data-act="run">Letzter Lauf: ${r.when} →</button>` : ''}<button type="button" class="linkbtn" data-act="add">${I.plus}Weg hinzufügen</button><button type="button" class="linkbtn" data-act="all">Alle Wege</button></div>
  </div>` : ''}
</section>`;
  wireDrop();
}

let toastTimer;
function toast(text) {
  const t = $('#toast'); t.textContent = text; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

// ---------- AI sidebar ----------
// Opening the chat from a button: the button's words fly into the chat as the first message,
// the page dims for a moment and the chat's edge lights up, so the eye follows to the right.
let origin = null;
let flight = Promise.resolve();
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function cue(text) {
  const aside = $('aside.aside');
  if (!aside) return;
  aside.classList.remove('flash'); void aside.offsetWidth; aside.classList.add('flash');
  if (reduced || !origin) { origin = null; return; }
  const dim = document.createElement('div'); dim.className = 'ai-dim'; document.body.append(dim);
  setTimeout(() => dim.remove(), 900);
  const from = origin.getBoundingClientRect(); origin = null;
  const to = $('#turns').getBoundingClientRect();
  const pill = document.createElement('div'); pill.className = 'flypill'; pill.textContent = text;
  pill.style.left = `${from.left}px`; pill.style.top = `${from.top}px`;
  document.body.append(pill);
  flight = new Promise((done) => {
    requestAnimationFrame(() => {
      const w = pill.offsetWidth;
      pill.style.left = `${to.right - w - 14}px`; pill.style.top = `${to.top + 4}px`;
      setTimeout(() => { pill.remove(); done(); }, 560);
    });
  });
}
function openAI() {
  if (!$('aside.aside')) {
    const box = document.createElement('div'); box.innerHTML = $('#t-aside').innerHTML;
    $('.corner').before(box.firstElementChild);
    document.documentElement.style.setProperty('--aiw', 'min(400px, 34vw)');
  }
  return $('#turns');
}
function closeAI() {
  const a = $('aside.aside'); if (a) a.remove();
  document.documentElement.style.setProperty('--aiw', '0px');
}
const turns = () => $('#turns');
function scrollDown() { const t = turns(); if (t) t.scrollTop = t.scrollHeight; }
function me(text, ctx) {
  const d = document.createElement('div'); d.className = 'msg me';
  d.innerHTML = `${text}${ctx ? `<small>${ctx}</small>` : ''}`;
  turns().append(d); scrollDown();
}
async function ai(html, { tools, wait = 900 } = {}) {
  const d = document.createElement('div'); d.className = 'msg ai';
  d.innerHTML = `${BOT}<div><div class="m">Denkt nach …</div></div>`;
  turns().append(d); scrollDown();
  await sleep(wait);
  d.innerHTML = `${BOT}<div>${tools ? `<details class="aitools"><summary>Details</summary>${tools.map((t) => `<div class="aitool">${t}</div>`).join('')}</details>` : ''}${html}</div>`;
  scrollDown();
  return d;
}
const choices = (list) => `<div class="choices">${list.map(([act, label]) => `<button type="button" class="aiact" data-act="${act}">${label}</button>`).join('')}</div>`;
const manual = '<div class="manual"><button type="button" class="linkbtn" data-act="picker">Lieber von Hand einrichten →</button></div>';
const p = (...lines) => `<div class="aitext">${lines.map((l) => `<p>${l}</p>`).join('')}</div>`;
function lockChoices(btn) { btn.closest('.choices').querySelectorAll('button').forEach((b) => { b.disabled = true; }); }

async function startSetup() {
  openAI();
  if (S.setup) return;
  S.setup = { gmail: null, items: {} };
  cue('Richte den Belegeingang ein');
  await flight;
  me('Richte den Belegeingang ein', 'Belege · Eingang');
  await ai(p('Eure Mails für muster-kaffee.ch liegen bei Infomaniak, und Apple Mail hat zwei Konten: info@muster-kaffee.ch und anna.muster@gmail.com. Kontoauszüge sind noch keine da.', 'Kommen auf anna.muster@gmail.com auch private Mails an?')
    + choices([['mixed', 'Ja, gemischt'], ['business', 'Nein, nur Geschäft'], ['unsure', 'Weiss nicht']]) + manual,
  { tools: ['Domain muster-kaffee.ch · MX mx1.mail.infomaniak.com → Infomaniak', 'Dieser Mac · Apple Mail: info@muster-kaffee.ch, anna.muster@gmail.com', 'Zahlungen · noch keine (kein Kontoauszug)', 'Leitfaden · receipt-collection › setup'], wait: 1400 });
}

async function addViaAI() {
  openAI();
  cue('Weg hinzufügen');
  await flight;
  me('Weg hinzufügen', 'Belege · Eingang');
  const have = S.channels.map((k) => CH[k].label).join(', ');
  await ai(p(`Du hast schon ${S.channels.length} Wege: ${have}. Was soll dazukommen?`)
    + choices([['add-gmail', 'anna.muster@gmail.com (in Apple Mail gefunden)'], ['phone', 'Handy koppeln'], ['add-vendor', 'Rechnungen eines Lieferanten'], ['picker', 'Andere Adresse']]) + manual,
  { tools: ['Dieser Mac · Apple Mail: info@muster-kaffee.ch, anna.muster@gmail.com', 'Wege · ' + S.channels.join(', ')], wait: 1000 });
}

async function addGmail(btn) {
  lockChoices(btn);
  me('anna.muster@gmail.com');
  await ai(p('Die liegt bei Google und kommt in Apple Mail an. Kommen dort auch private Mails an?') + choices([['g-mixed', 'Ja, auch privat'], ['g-business', 'Nein, nur Geschäft']]) + manual, { wait: 800 });
}
async function gmailAnswer(mixed, btn) {
  lockChoices(btn);
  me(mixed ? 'Ja, auch privat' : 'Nein, nur Geschäft');
  if (mixed) return ai(p('Dann am besten ein Filter in Gmail, der nur Rechnungen an belege@muster-kaffee.ch weiterleitet. Die App sieht Gmail so nie. Dauert etwa 3 Minuten.') + choices([['fwd', 'Anleitung öffnen'], ['sug-client-ai', 'Lieber über Apple Mail lesen']]), { wait: 900 });
  return ai(p('Dann lese ich das Postfach über Apple Mail mit: keine neue Anmeldung, auch nicht mit 2FA. macOS fragt einmal, ob die App Mail steuern darf.') + choices([['sug-client-ai', 'Erlauben'], ['imap-gmail', 'Lieber direkt verbinden (IMAP)']]), { wait: 900 });
}
async function addVendor(btn) {
  lockChoices(btn);
  me('Rechnungen eines Lieferanten');
  await ai(p('Bei welchem? Ohne Beleg sind im Q3 noch: Shopify (Rechnung nur im Admin), SBB Mobile (nur in der App), Parkhaus Zentrum.') + choices([['shopify-yes', 'Shopify'], ['later', 'SBB Mobile']]) + manual, { wait: 900 });
}

async function answerGmail(kind, btn) {
  lockChoices(btn);
  const said = { mixed: 'Ja, Gmail ist privat. Aber Swisscom und der Grosshändler schicken ihre Rechnungen dorthin.', business: 'Nein, Gmail nutze ich nur fürs Geschäft.', unsure: 'Weiss nicht genau.' }[kind];
  me(said);
  if (kind === 'unsure') {
    await ai(p('Ich habe nur die Absender und Betreffe der letzten zwei Wochen angeschaut, keine Inhalte: 212 Mails, davon gut 60 % Newsletter und Shops. Ich nehme an: gemischt.'), { tools: ['Gmail · Kopfzeilen der letzten 14 Tage, über Apple Mail'], wait: 1500 });
    kind = 'mixed';
  }
  S.setup.gmail = kind;
  await plan();
}

async function plan() {
  const mixed = S.setup.gmail === 'mixed';
  const rows = [
    ['imap', I.mail, 'info@muster-kaffee.ch', 'Ganzes Postfach lesen, nur Anhänge und Rechnungslinks.', 'IMAP bei Infomaniak · das Passwort trägst du im Formular ein, nicht hier'],
    mixed
      ? ['fwd', I.fwd, 'anna.muster@gmail.com', 'Ein Gmail-Filter leitet nur Rechnungen an belege@muster-kaffee.ch weiter.', 'Anleitung mit Prüfen-Knopf · die App sieht Gmail nie']
      : ['gmail', I.mail, 'anna.muster@gmail.com', 'Ganzes Postfach lesen, nur Anhänge und Rechnungslinks.', 'IMAP bei Google · mit App-Passwort'],
    ['folder', I.folder, 'Fotos vom Handy', 'Ordner iCloud Drive › Belege beobachten.', 'Kassenzettel fotografieren, landet von selbst bei den Belegen'],
    ['bank', I.bank, 'Kontoauszüge', 'Ziehst du hierher, wann es dir passt: camt.053 oder PDF aus dem E-Banking.', 'Danach sieht die App, zu welchen Zahlungen ein Beleg fehlt'],
  ];
  S.setup.rows = rows.map((r) => r[0]);
  const d = await ai(p(mixed ? 'Dann lese ich Gmail nicht. Ein Filter dort schickt nur die Rechnungen an eine eigene Adresse. Mein Vorschlag:' : 'Dann lese ich beide Postfächer ganz. Mein Vorschlag:')
    + `<div class="plancard" id="plan"><div class="ph">Belegeingang · 4 Wege<small>Entwurf</small></div><ul>${rows.map(([k, ic, b, s, how]) => `<li data-row="${k}">${ic}<b>${b}</b><span>${s}</span><span class="how">${how}</span></li>`).join('')}</ul>
    <div class="pv">Sobald ein Kontoauszug da ist, zeige ich, zu welchen Zahlungen noch ein Beleg fehlt.</div>
    <div class="pa"><button type="button" class="aiact primary" data-act="accept">Übernehmen</button><button type="button" class="aiact" data-act="picker">Einzeln ansehen</button><button type="button" class="aiact" data-act="other">Anders</button></div></div>`, { wait: 1300 });
  return d;
}

function acceptPlan() {
  const card = $('#plan');
  card.querySelector('.ph small').textContent = 'Wird eingerichtet';
  for (const li of card.querySelectorAll('li')) {
    const k = li.dataset.row;
    const auto = k === 'folder' || k === 'bank';
    S.setup.items[k] = auto;
    const action = { imap: '<button type="button" class="aiact" data-act="imap">Passwort eingeben</button>', gmail: '<button type="button" class="aiact" data-act="imap-gmail">App-Passwort eingeben</button>', fwd: '<button type="button" class="aiact" data-act="fwd">Anleitung öffnen</button>' }[k];
    li.insertAdjacentHTML('beforeend', `<span class="state">${auto ? `<span class="ok">✓ eingerichtet</span>` : action}</span>`);
    if (auto) li.classList.add('done');
  }
  card.querySelector('.pa').innerHTML = '<button type="button" class="aiact primary" data-act="switchon" disabled>Einschalten</button><span class="m" style="font-size:12px;align-self:center">Noch 2 Schritte für dich</span>';
  scrollDown();
}

function markDone(k) {
  if (!S.setup || !(k in S.setup.items)) return;
  S.setup.items[k] = true;
  const li = $(`#plan li[data-row="${k}"]`);
  if (li) { li.classList.add('done'); li.querySelector('.state').innerHTML = '<span class="ok">✓ eingerichtet</span>'; }
  const open = Object.values(S.setup.items).filter((v) => !v).length;
  const on = $('#plan [data-act="switchon"]');
  if (on) { on.disabled = open > 0; on.nextElementSibling.textContent = open ? `Noch ${open} Schritt${open > 1 ? 'e' : ''} für dich` : 'Alles bereit · erscheint in Änderungen'; }
}

async function switchOn(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Wird eingeschaltet';
  $('#plan .ph small').textContent = 'Eingeschaltet';
  await ai(p('Eingeschaltet. Ich hole die Belege der letzten drei Monate …'), { wait: 600 });
  await sleep(1400);
  S.mode = 'populated';
  S.channels = [...S.setup.rows];
  S.covered = 55; S.phone = 'none';
  render();
  readArrivals(3);
  window.parent.postMessage({ reached: 'populated' }, '*');
  await ai(p('21 Belege geholt, 18 davon schon einer Zahlung zugeordnet. Die letzten 3 lese ich gerade. Für Kassenzettel: «Handy koppeln» oben, dann gehen auch Fotos aus der Fotomediathek.', 'Zu 6 Zahlungen fehlt noch ein Beleg: 5 Barzahlungen und die Shopify-Rechnung, die nur im Shopify-Admin liegt. Soll ich dich einmal im Monat daran erinnern?')
    + choices([['shopify-yes', 'Ja, monatlich'], ['shopify-no', 'Später']]), { tools: ['Postfach info@ · 3 Monate, 19 Anhänge', 'Ordner «Belege» · 2 Fotos', 'Zuordnung · 18 von 21'], wait: 900 });
}

async function missing() {
  openAI();
  cue('Welche Zahlungen haben keinen Beleg?');
  await flight;
  me('Welche Zahlungen haben keinen Beleg?', 'Belege · Q3 2026');
  await ai(p(`${S.total - S.covered} Zahlungen im Q3 ohne Beleg:`)
    + `<ul class="missing"><li><span>30.09. Shopify Commerce</span><span>29.00</span></li><li><span>22.09. Bargeldbezug</span><span>200.00</span></li><li><span>14.09. Bäckerei Muster</span><span>18.40</span></li><li><span>02.09. SBB Mobile</span><span>8.80</span></li><li><span>27.08. Bargeldbezug</span><span>100.00</span></li><li><span>11.08. Parkhaus Zentrum</span><span>6.00</span></li></ul>`
    + p('Die Shopify-Rechnung kann ich jeden Monat aus dem Admin holen lassen, wenn du dort angemeldet bist. Für die Barbezüge frage ich dich unter Aufgaben, wofür sie waren.'), { wait: 900 });
}

// ---------- Dialogs ----------
function dialog(html) {
  closeDialog();
  const d = document.createElement('div'); d.className = 'mockscrim'; d.id = 'dlg';
  d.innerHTML = `<div class="mockdlg" role="dialog">${html}</div>`;
  d.addEventListener('click', (e) => { if (e.target === d) closeDialog(); });
  document.body.append(d);
  return d;
}
function closeDialog() { const d = $('#dlg'); if (d) d.remove(); }
const head = (title, back) => `<header>${back ? `<button type="button" class="aiact back" data-act="picker">← Zurück</button>` : ''}<b>${title}</b><button type="button" class="aiact icon" data-act="close" aria-label="Schliessen">×</button></header>`;
const tile = (act, ic, b, s, cls = '') => `<button type="button" class="tile ${cls}" data-act="${act}">${ic}<b>${b}</b><span>${s}</span></button>`;

// A QR code look-alike (the real one is made by Firma › Handy): fixed pattern, three finder squares.
function qr(size = 132) {
  const n = 25; let cells = '';
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const finder = (x, y) => (x >= 0 && x < 7 && y >= 0 && y < 7);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const inF = finder(x, y) || finder(x - (n - 7), y) || finder(x, y - (n - 7));
    if (inF) {
      const fx = x >= n - 7 ? x - (n - 7) : x; const fy = y >= n - 7 ? y - (n - 7) : y;
      const ring = fx === 0 || fx === 6 || fy === 0 || fy === 6; const core = fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4;
      if (ring || core) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    } else if (rnd() > 0.52) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  return `<svg class="qr" viewBox="-2 -2 ${n + 4} ${n + 4}" width="${size}" height="${size}" aria-label="QR-Code"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#0b1220">${cells}</g></svg>`;
}

// What the domain says about where the mail lives (the app does an MX lookup; here a table).
function hostOf(addr) {
  const d = (addr.split('@')[1] || '').toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(d)) return { name: 'Google (Gmail)', how: 'gmail.com', imap: 'imap.gmail.com', appPw: true };
  if (/^(outlook|hotmail|live)\.(com|ch|de)$/.test(d)) return { name: 'Microsoft (Outlook.com)', how: d, imap: 'outlook.office365.com', appPw: true };
  if (/^(web\.de|gmx\.(ch|de|net))$/.test(d)) return { name: d === 'web.de' ? 'WEB.DE' : 'GMX', how: d, imap: d === 'web.de' ? 'imap.web.de' : 'imap.gmx.net', appPw: false, imapOff: true };
  if (/^(icloud|me|mac)\.com$/.test(d)) return { name: 'iCloud', how: d, imap: 'imap.mail.me.com', appPw: true };
  if (/^(bluewin|swisscom)\.ch$/.test(d)) return { name: 'Swisscom (bluewin)', how: d, imap: 'imaps.bluewin.ch', appPw: false };
  return { name: 'Infomaniak', how: `MX von ${d}: mx1.mail.infomaniak.com`, imap: 'mail.infomaniak.com', appPw: false, own: true };
}

let W = {};
function picker() {
  W = { addr: W.addr || '', client: null, mixed: false };
  dialog(`<header><b>Weg hinzufügen</b><button type="button" class="aiact" data-act="ai-from-picker">${BOT}Mit KI einrichten</button><button type="button" class="aiact icon" data-act="close" aria-label="Schliessen">×</button></header>
<div class="body">
  <div class="form">
    <label>An welche E-Mail-Adresse kommen deine Rechnungen?<input id="w-addr" type="email" placeholder="z. B. info@deine-firma.ch" value="${W.addr}"></label>
    <div id="w-err"></div>
    <div class="acts"><button type="button" class="aiact primary" data-act="w-next">Weiter</button></div>
  </div>
  <h3>Oder ohne E-Mail</h3>
  <div class="tiles">
    ${tile('phone', I.phone, 'Handy-App', 'Kassenzettel mit dem iPhone fotografieren', 'rec plain')}
    ${tile('folder', I.folder, 'Ordner beobachten', 'iCloud Drive, Dropbox, Downloads')}
    ${tile('bank', I.bank, 'Kontoauszüge', 'camt.053 oder PDF aus dem E-Banking, wann es dir passt')}
    ${tile('all', I.plus, 'Alle Wege', 'Kundenkonto, Rechnungslinks, Nachholen …')}
  </div>
</div>`);
  $('#w-addr').focus();
}

function pickClient() {
  const addr = $('#w-addr').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(addr)) { $('#w-err').innerHTML = '<p class="err">Bitte eine E-Mail-Adresse eingeben, z. B. info@muster-kaffee.ch</p>'; return; }
  W.addr = addr; W.host = hostOf(addr);
  dialog(`${head('Weg hinzufügen')}
<div class="body">
  <p class="known">${I.check}<span><b>${addr}</b> · Mails liegen bei <b>${W.host.name}</b><small>${W.host.how}</small></span></p>
  <h3>Wo liest du diese Mails?</h3>
  <div class="tiles">
    ${tile('c-apple', I.laptop, 'Apple Mail', 'auf diesem Mac')}
    ${tile('c-outlook', I.laptop, 'Outlook', 'auf diesem Mac')}
    ${tile('c-browser', I.globe, 'Im Browser', `${W.host.own ? 'Webmail' : W.host.name}`)}
    ${tile('c-phone', I.phone, 'Nur am Handy', 'Mail-App auf dem iPhone')}
  </div>
  <label class="check"><input type="checkbox" id="w-mixed"> Hier kommen auch private Mails an</label>
</div>`);
}

function suggest(client) {
  W.client = client; W.mixed = $('#w-mixed').checked;
  const h = W.host; const where = { apple: 'Apple Mail', outlook: 'Outlook', browser: 'im Browser', phone: 'am Handy' }[client];
  const local = client === 'apple' || client === 'outlook';
  const opts = [];
  const fwd = ['fwd', I.fwd, 'Weiterleitung an belege@', 'Ein Filter schickt nur Rechnungen weiter. Die App sieht deine privaten Mails nie.'];
  const viaClient = ['client', I.laptop, `Über ${where} lesen`, `${where} ist schon angemeldet: keine neue Anmeldung, auch nicht mit 2FA. Läuft, solange der Mac an ist.`];
  const imap = ['imap', I.mail, 'Postfach direkt verbinden (IMAP)', h.imapOff ? `Bei ${h.name} musst du IMAP zuerst in den Einstellungen einschalten.` : h.appPw ? `${h.name} verlangt dafür ein App-Passwort.` : 'Mit dem Passwort des Postfachs. Läuft auch, wenn der Mac aus ist.'];
  if (W.mixed) opts.push(fwd, local ? viaClient : imap);
  else if (local) opts.push(viaClient, imap);
  else opts.push(imap, fwd);
  if (!opts.includes(fwd) && !W.mixed) opts.push(fwd);
  const [rec, ...alts] = opts;
  const row = ([act, ic, b, s], first) => `<div class="sug${first ? ' rec' : ''}">${ic}<b>${b}</b><span>${s}</span><button type="button" class="aiact${first ? ' primary' : ''}" data-act="sug-${act}">${first ? 'So einrichten' : 'Lieber so'}</button></div>`;
  dialog(`${head('Weg hinzufügen')}
<div class="body">
  <p class="known">${I.check}<span><b>${W.addr}</b> · bei <b>${h.name}</b> · gelesen ${where}${W.mixed ? ' · auch privat' : ''}</span></p>
  <h3>Unser Vorschlag</h3>
  ${row(rec, true)}
  <h3>Geht auch</h3>
  ${alts.slice(0, 2).map((a) => row(a, false)).join('')}
  <p class="foot">Was die App selbst kann, macht sie selbst. Du entscheidest nur, wie viel sie sehen darf.</p>
</div>`);
}

function clientDialog() {
  const where = W.client === 'outlook' ? 'Outlook' : 'Apple Mail';
  dialog(`${head(`Über ${where} lesen`)}
<div class="body"><div class="form">
  <p class="hint">macOS fragt gleich: «Vanilla Accounting möchte ${where} steuern.» Erlaub es einmal. Die App liest dann nur das Postfach ${W.addr || ''}, nur Mails mit Rechnungen, und schreibt nichts.</p>
  <div id="f-out"></div>
  <div class="acts"><button type="button" class="aiact" data-act="close">Abbrechen</button><button type="button" class="aiact primary" data-act="client-test">Erlauben und prüfen</button></div>
</div></div>`);
}
async function clientTest(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Wartet auf macOS';
  await sleep(1400);
  $('#f-out').innerHTML = `<div class="preview"><b>Erlaubt.</b><span>Postfach ${W.addr || 'info@'} in ${W.client === 'outlook' ? 'Outlook' : 'Apple Mail'} gefunden. Letzte 4 Wochen: 41 Mails, davon 12 mit Rechnung.</span><span class="hint">Gelesen wurden nur Kopfzeilen; nichts wurde geholt.</span></div>`;
  btn.disabled = false; btn.textContent = 'Hinzufügen'; btn.dataset.act = 'client-add';
}

const APP_URL = 'apps.apple.com/ch/app/vanilla-belege';
function phoneDialog(step = 'install') {
  if (step === 'install') return dialog(`${head('Handy koppeln')}
<div class="body">
  <div class="steps2"><span class="on">1 · App laden</span><span>2 · Koppeln</span></div>
  <div class="pair">
    ${qr(150)}
    <div class="form">
      <p><b>Scann den Code mit der Kamera deines iPhones.</b> Er öffnet «Vanilla Belege» im App Store.</p>
      <p class="hint">Oder im Browser des iPhones öffnen:</p>
      <div class="url"><code>${APP_URL}</code><button type="button" class="aiact" data-act="copy">Kopieren</button></div>
      <p class="hint">Kostenlos, für iPhone ab iOS 17. Kein iPhone? Dann gleich weiter: im 2. Schritt geht auch die Scan-Seite im Browser.</p>
    </div>
  </div>
  <div class="acts"><button type="button" class="aiact" data-act="close">Später</button><button type="button" class="aiact primary" data-act="pair-step">App ist installiert → Koppeln</button></div>
</div>`);
  dialog(`${head('Handy koppeln')}
<div class="body">
  <div class="steps2"><span>1 · App laden</span><span class="on">2 · Koppeln</span></div>
  <div class="pair">
    ${qr(150)}
    <ol>
      <li><b>App öffnen</b><div>«Mit Mac verbinden» tippen und diesen Code scannen. iPhone und Mac im selben WLAN.</div></li>
      <li><b>Beleg fotografieren</b><div>Mit «Scan», oder ein Foto aus der Fotomediathek wählen. Es landet sofort hier, als PDF und gerade gerichtet.</div></li>
    </ol>
  </div>
  <div id="f-out"></div>
  <div class="acts"><button type="button" class="aiact back" data-act="install-step">← Ich habe die App noch nicht</button><button type="button" class="aiact primary" data-act="phone-wait">Ich habe gescannt</button></div>
</div>`);
}
async function phoneWait(btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Wartet aufs iPhone';
  await sleep(1500);
  $('#f-out').innerHTML = '<div class="preview"><b>Gekoppelt: Annas iPhone.</b><span>Fotografier einen Kassenzettel, er erscheint hier in ein paar Sekunden.</span></div>';
  btn.disabled = false; btn.textContent = 'Fertig'; btn.dataset.act = 'phone-add';
}

function allWays() {
  dialog(`${head('Alle Wege')}
<div class="body">
  <h3>Automatisch · läuft von selbst</h3>
  <div class="tiles">
    ${tile('fwd', I.fwd, 'Weiterleitung', 'Ein Filter schickt nur Rechnungen an belege@')}
    ${tile('imap', I.mail, 'Postfach (IMAP)', 'Adresse, Server und Passwort; läuft auch, wenn der Mac aus ist')}
    ${tile('sug-client', I.laptop, 'Mail-Programm', 'Apple Mail, Outlook, Thunderbird; läuft, solange der Mac an ist')}
    ${tile('folder', I.folder, 'Ordner beobachten', 'iCloud Drive, Dropbox, OneDrive')}
    ${tile('later', I.link, 'Rechnungslinks in Mails', '«Rechnung ansehen» öffnen, wenn es ohne Anmeldung geht')}
  </div>
  <h3>Automatisch, du meldest dich einmal an</h3>
  <div class="tiles">
    ${tile('later', I.key, 'Mit Google oder Microsoft anmelden', 'Kein App-Passwort; hält, bis du es widerrufst', 'later')}
    ${tile('later', I.globe, 'Webmail im Browser', 'web.de, GMX; du meldest dich mit 2FA an, wenn die Sitzung abläuft', 'later')}
    ${tile('later', I.shop, 'Kundenkonto', 'Shopify-Admin, AliExpress; die App holt monatlich, du meldest dich bei Bedarf an', 'later')}
  </div>
  <h3>Von Hand · geht immer</h3>
  <div class="tiles">
    ${tile('phone', I.phone, 'Handy-App', 'Kassenzettel mit dem iPhone fotografieren')}
    ${tile('bank', I.bank, 'Kontoauszüge', 'camt.053 oder PDF aus dem E-Banking, wann es dir passt')}
    ${tile('later', I.print, 'Drucken an Vanilla', 'Webseiten und Bestellungen als PDF')}
    ${tile('later', I.archive, 'Einmal nachholen', 'Export aus Gmail oder dem Mail-Programm (mbox)')}
    ${tile('later', I.down, 'Hierher ziehen', 'PDFs und Fotos auf die Belege-Seite ziehen')}
  </div>
  <p class="foot">Blasse Kacheln kommen später.</p>
</div>`);
}

function imapDialog(which = 'imap') {
  const g = which === 'gmail';
  const fromFlow = which === 'flow';
  const addr = fromFlow ? W.addr : g ? 'anna.muster@gmail.com' : 'info@muster-kaffee.ch';
  const host = fromFlow ? W.host.imap : g ? 'imap.gmail.com' : 'mail.infomaniak.com';
  dialog(`${head(S.warn.imap && !g ? 'Postfach neu anmelden' : 'Postfach verbinden', !S.setup)}
<div class="body"><div class="form">
  ${S.warn.imap && !g ? '<p class="hint">Die Anmeldung bei info@ ist abgelaufen, wahrscheinlich wurde das Passwort geändert. Seit 4 Tagen kam nichts mehr.</p>' : ''}
  <label>Adresse<input id="f-addr" value="${addr}"></label>
  <label>Server<input id="f-host" value="${host}"><span class="hint">${fromFlow ? (W.host.appPw ? `${W.host.name} verlangt ein App-Passwort` : `Erkannt: ${W.host.name}`) : g ? 'Gmail verlangt ein App-Passwort (Google-Konto › Sicherheit › App-Passwörter)' : 'Aus dem DNS erkannt: Infomaniak'}</span></label>
  <label>Passwort<input id="f-pw" type="password" placeholder="${g ? 'App-Passwort, 16 Zeichen' : 'Passwort des Postfachs'}"><span class="hint">Liegt danach im Schlüsselbund dieses Macs, nie in den Büchern und nie im Chat.</span></label>
  <div id="f-out"></div>
  <div class="acts"><button type="button" class="aiact" data-act="close">Abbrechen</button><button type="button" class="aiact primary" data-act="imap-test" data-which="${which}">Verbindung prüfen</button></div>
</div></div>`);
  $('#f-pw').focus();
}

async function imapTest(btn) {
  const out = $('#f-out');
  if (!$('#f-pw').value) { out.innerHTML = '<p class="err">Bitte das Passwort eintragen. Für den Prototyp geht jedes.</p>'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Prüft';
  await sleep(1300);
  const g = btn.dataset.which === 'gmail';
  out.innerHTML = `<div class="preview"><b>Angemeldet.</b><span>Letzte 4 Wochen: ${g ? '186 Mails, davon 9' : '38 Mails, davon 11'} mit Rechnung (Anhang oder Link).</span><span>Würde holen: ${g ? 'Swisscom, Google, Grünkaffee Muster …' : 'Example Cloud, Post CH, Coop Pronto …'}</span><span class="hint">Gelesen wurden nur Kopfzeilen; nichts wurde geholt.</span></div>`;
  btn.disabled = false; btn.textContent = 'Hinzufügen'; btn.dataset.act = 'imap-add';
}

function imapAdd(btn) {
  const k = btn.dataset.which === 'gmail' ? 'gmail' : 'imap';
  if (btn.dataset.which === 'flow') CH.imap = { ...CH.imap, label: W.addr, title: `IMAP bei ${W.host.name}` };
  closeDialog();
  if (S.warn[k]) { delete S.warn[k]; if (S.run) { S.run.sources = S.run.sources.map((x) => (x[0] === k ? [k, 'ok', ['Example Cloud · EUR 39.00', 'Post CH · 217.75', 'Coop Pronto · 79.25', 'SBB Mobile · 8.80']] : x)); S.run.state = 'ok'; S.run.at = 'gerade eben'; } renderStrip(); toast('Wieder verbunden: 4 neue Belege seit dem 13.10.'); readArrivals(4); return; }
  addWay(k);
}

function fwdDialog() {
  dialog(`${head('Weiterleitung einrichten', !S.setup)}
<div class="body"><ol>
  <li><b>Adresse anlegen</b><div>Leg bei Infomaniak die Adresse <b>belege@muster-kaffee.ch</b> an. Die App liest nur diese Adresse.<br><label style="display:flex;gap:6px;align-items:center;margin-top:6px;color:var(--ink)"><input type="checkbox" id="f-made" style="height:auto"> Angelegt</label></div></li>
  <li><b>Filter in Gmail</b><div>Gmail › Einstellungen › Filter › Neuer Filter, Suche einfügen, dann «Weiterleiten an» belege@muster-kaffee.ch:<pre id="f-q">from:(swisscom.ch OR gruenkaffee-muster.ch OR google.com) (rechnung OR invoice OR beleg OR receipt)</pre><button type="button" class="aiact copy" data-act="copy">Kopieren</button></div></li>
  <li><b>Prüfen</b><div>Schick dir eine Mail mit «Rechnung» im Betreff an Gmail. Kommt sie bei belege@ an, stimmt alles.</div></li>
</ol>
<div id="f-out"></div>
<div class="acts"><button type="button" class="aiact" data-act="close">Später</button><button type="button" class="aiact primary" data-act="fwd-test">Prüfen</button></div>
</div>`);
}

async function fwdTest(btn) {
  const out = $('#f-out');
  if (!$('#f-made').checked) { out.innerHTML = '<p class="err">Erst die Adresse anlegen (Schritt 1).</p>'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Wartet auf die Testmail';
  await sleep(1800);
  out.innerHTML = '<div class="preview"><b>Testmail angekommen.</b><span>Von anna.muster@gmail.com, weitergeleitet um 22:41. Der Filter wirkt.</span></div>';
  btn.disabled = false; btn.textContent = 'Fertig'; btn.dataset.act = 'fwd-done';
}

function folderDialog() {
  dialog(`${head('Ordner beobachten', !S.setup)}
<div class="body"><div class="form">
  <label>Ordner<input value="iCloud Drive › Belege" readonly><span class="hint">Was dort landet, kommt zu den Belegen: Fotos vom Handy (Kamera › Teilen › In Dateien sichern), Downloads, Scans.</span></label>
  <div class="acts"><button type="button" class="aiact" data-act="later">Anderen wählen</button><button type="button" class="aiact primary" data-act="folder-add">Hinzufügen</button></div>
</div></div>`);
}

function addWay(k) {
  closeDialog();
  if (S.setup && k in S.setup.items) { markDone(k); return; }
  if (!S.channels.includes(k)) S.channels.push(k);
  if (S.mode === 'blank') { S.mode = 'populated'; S.inbox = k === 'bank' ? 0 : 2; S.covered = 0; S.total = 0; render(); window.parent.postMessage({ reached: 'populated' }, '*'); toast(`${CH[k].label} hinzugefügt`); return; }
  renderStrip(); toast(`${CH[k].label} hinzugefügt`);
}

// ---------- Strip actions ----------
async function fetchNow() {
  const sources = S.channels.filter((k) => ['imap', 'fwd', 'folder', 'gmail', 'applemail'].includes(k));
  S.run = { manual: true, state: 'running', at: 'jetzt', when: 'heute 22:58', sources: sources.map((k) => [k, 'running', []]) };
  renderStrip();
  await sleep(1600);
  const fresh = [['30.09.', 'Swisscom', ' Mobile September', '64.90'], ['29.09.', 'Hostpoint', ' Webhosting', '19.90']];
  S.run.sources = sources.map((k) => (S.warn[k] ? [k, 'fail', [], 'Anmeldung abgelaufen: das Passwort wurde wohl geändert'] : k === 'imap' ? [k, 'ok', fresh.map(([, t, , a]) => `${t} · ${a}`)] : [k, 'ok', []]));
  const failed = S.run.sources.some((x) => x[1] === 'fail');
  S.run.state = failed ? 'fail' : 'ok'; S.run.at = 'gerade eben';
  const n = failed ? 0 : 2;
  renderStrip();
  if (!n) { toast('Belege holen: info@ braucht eine neue Anmeldung'); return; }
  const rows = $('.rows'); const group = rows && rows.querySelector('.group');
  if (group) for (const [d, t, sub, a] of [...fresh].reverse()) group.insertAdjacentHTML('afterend', `<div class="row fresh" role="option" tabindex="-1"><span class="d mono"><span class="dl">${d}2026</span><span class="ds">${d}</span></span><span class="t">${t}<small>${sub}</small><span class="newtag">neu</span></span><span class="a mono">${a}</span></div>`);
  await sleep(500);
  await readArrivals(n);
}

async function readArrivals(n) {
  S.reading += n; renderStrip();
  await sleep(1900);
  S.reading = Math.max(0, S.reading - n);
  const matched = Math.max(0, n - 1);
  S.covered = Math.min(S.total || S.covered + matched, S.covered + matched);
  S.questions += n - matched;
  renderStrip();
  toast(`${n} ${n > 1 ? 'Belege' : 'Beleg'} gelesen${matched ? `, ${matched} zugeordnet` : ''}${n - matched ? ', 1 Frage für dich' : ''}`);
}

function phonePanel() {
  if (S.phone === 'none') return phoneDialog();
  const on = S.phone === 'on';
  dialog(`${head('Handy')}
<div class="body">
  <div class="pair">
    ${qr(130)}
    <div class="form">
      <p class="known">${I.check}<span><b>Annas iPhone</b> · gekoppelt<small>Letzter Beleg heute 14:02 · im selben WLAN</small></span></p>
      <label class="check"><input type="checkbox" id="ph-on"${on ? ' checked' : ''}> Belege vom Handy annehmen</label>
      <p class="hint">${on ? 'Fotos aus der App und aus der Fotomediathek landen hier und werden gleich gelesen.' : 'Aus: das Handy erreicht den Mac nicht. Fotos warten in der App, bis du es einschaltest.'}</p>
      <p class="hint">Weiteres Handy? Den Code mit der App scannen.</p>
    </div>
  </div>
  <div class="acts"><button type="button" class="aiact" data-act="phone-sim">Foto vom iPhone simulieren</button><button type="button" class="aiact primary" data-act="close">Fertig</button></div>
</div>`);
  $('#ph-on').addEventListener('change', (e) => { S.phone = e.target.checked ? 'on' : 'off'; renderStrip(); phonePanel(); });
}

async function phoneSim() {
  closeDialog();
  if (S.phone !== 'on') { toast('Handy ist aus: das Foto wartet in der App.'); return; }
  const rows = $('.rows'); const group = rows && rows.querySelector('.group');
  if (group) group.insertAdjacentHTML('afterend', '<div class="row fresh" role="option" tabindex="-1"><span class="d mono"><span class="dl">30.09.2026</span><span class="ds">30.09.</span></span><span class="t">Bäckerei Muster<small> vom iPhone</small><span class="newtag">neu</span></span><span class="a mono">18.40</span></div>');
  await readArrivals(1);
}

async function processNow(btn) {
  const n = S.inbox;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Liest und ordnet zu …';
  await sleep(1700);
  S.inbox = 0; S.covered = Math.min(S.total, S.covered + Math.max(0, n - 1)); renderStrip();
  toast(`${n} Belege gelesen, ${Math.max(0, n - 1)} einer Zahlung zugeordnet, 1 Frage unter Aufgaben`);
}

// ---------- Wiring ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act], [data-chan], .startai, .otherstarts .tile, .dropzone, .banknote .linkbtn, .row, aside.aside .aiact.icon, .corner button');
  if (!el) return;
  const act = el.dataset.act;
  if (el.matches('.startai') || ['add', 'ai-from-picker', 'missing', 'ai-setup'].includes(act)) origin = el.matches('.startai') ? el.querySelector('b') : el;
  if (el.matches('.startai')) return startSetup();
  if (el.matches('.otherstarts .tile')) return el.textContent.includes('Handy') ? phoneDialog() : picker();
  if (el.matches('.dropzone')) return toast('PDFs hierher ziehen (im Prototyp nicht)');
  if (el.matches('.banknote .linkbtn')) return toast('Kontoauszug einlesen: camt.053 oder PDF wählen (im Prototyp nicht)');
  if (el.matches('aside.aside .aiact.icon')) return closeAI();
  if (el.matches('.corner button') && !act) return openAI();
  if (el.dataset.chan) {
    const k = el.dataset.chan;
    if (S.warn[k] && k === 'imap') return imapDialog('imap');
    if (k === 'bank' && CH.bank.ok === 'bis 31.08.') { CH.bank = { ...CH.bank, ok: 'bis 30.09.' }; S.covered += 4; renderStrip(); return toast('Kontoauszug September eingelesen (hierher gezogen): 4 weitere Zahlungen haben ihren Beleg'); }
    return toast(`${CH[k].title}`);
  }
  if (el.matches('.row') && !act) { document.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel')); el.classList.add('sel'); return; }
  switch (act) {
    case 'picker': return picker();
    case 'drop-pick': return toast('Dateiauswahl öffnet sich · oder PDFs und Fotos einfach auf die Seite ziehen');
    case 'toggle': S.open = !S.open; return renderStrip();
    case 'add': return S.mode === 'blank' ? startSetup() : addViaAI();
    case 'add-gmail': return addGmail(el);
    case 'g-mixed': return gmailAnswer(true, el);
    case 'g-business': return gmailAnswer(false, el);
    case 'add-vendor': return addVendor(el);
    case 'sug-client-ai': W = { addr: 'anna.muster@gmail.com', client: 'apple' }; return clientDialog();
    case 'ai-setup': S.setup = null; return startSetup();
    case 'close': return closeDialog();
    case 'later': return toast('Im Prototyp nicht ausgebaut');
    case 'ai-from-picker': { const r = el.getBoundingClientRect(); closeDialog(); origin = { getBoundingClientRect: () => r }; return S.mode === 'blank' ? startSetup() : addViaAI(); }
    case 'mixed': case 'business': case 'unsure': return answerGmail(act, el);
    case 'accept': return acceptPlan();
    case 'other': me('Lieber nicht über Weiterleitung.'); return ai(p('Gut. Was passt dir besser: Gmail ganz lesen lassen, nur über Apple Mail lesen, oder die Rechnungen von Hand weiterleiten?') + choices([['business', 'Gmail ganz lesen'], ['later', 'Über Apple Mail']]));
    case 'imap': return imapDialog('imap');
    case 'w-next': return pickClient();
    case 'c-apple': return suggest('apple');
    case 'c-outlook': return suggest('outlook');
    case 'c-browser': return suggest('browser');
    case 'c-phone': return suggest('phone');
    case 'sug-fwd': return fwdDialog();
    case 'sug-imap': return imapDialog('flow');
    case 'sug-client': return clientDialog();
    case 'client-test': return clientTest(el);
    case 'client-add': if (W.addr === 'anna.muster@gmail.com') { CH.applemail = { ...CH.applemail, label: 'Gmail über Apple Mail' }; } return addWay('applemail');
    case 'phone': return phoneDialog();
    case 'phone-wait': return phoneWait(el);
    case 'pair-step': return phoneDialog('pair');
    case 'install-step': return phoneDialog('install');
    case 'phone-add': closeDialog(); S.phone = 'on'; if (S.mode === 'blank') { S.mode = 'populated'; S.covered = 0; S.total = 0; render(); window.parent.postMessage({ reached: 'populated' }, '*'); } else renderStrip(); return toast('Handy gekoppelt');
    case 'phone-panel': return phonePanel();
    case 'phone-sim': return phoneSim();
    case 'questions': return toast('Öffnet Aufgaben: «Bäckerei Muster, 18.40: Geschäftlich oder privat?»');
    case 'all': return allWays();
    case 'imap-gmail': return imapDialog('gmail');
    case 'imap-test': return imapTest(el);
    case 'imap-add': return imapAdd(el);
    case 'fwd': return fwdDialog();
    case 'fwd-test': return fwdTest(el);
    case 'fwd-done': return addWay('fwd');
    case 'folder': return folderDialog();
    case 'folder-add': return addWay('folder');
    case 'bank': return addWay('bank');
    case 'copy': el.textContent = 'Kopiert'; return;
    case 'switchon': return switchOn(el);
    case 'shopify-yes': lockChoices(el); me('Ja, monatlich'); S.channels.push('shopify'); renderStrip(); return ai(p('Erledigt: am 2. jedes Monats kommt unter Aufgaben «Shopify-Rechnung holen» mit dem Link zum Admin. Du lädst sie herunter und ziehst sie hierher.'), { wait: 700 });
    case 'shopify-no': lockChoices(el); me('Später'); return ai(p('Gut. Die 6 Zahlungen bleiben unter «ohne Beleg» sichtbar.'), { wait: 600 });
    case 'fetch': return fetchNow();
    case 'run': return runDialog();
    case 'runs-area': closeDialog(); return toast('Öffnet Automatisierung › Läufe, gefiltert auf «Belege holen»');
    case 'process': return processNow(el);
    case 'missing': return missing();
    default: return undefined;
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); if (e.key === 'Enter' && e.target.id === 'w-addr') pickClient(); });
window.addEventListener('message', (e) => { if (e.data && e.data.state) reset(e.data.state); });

reset('blank');
