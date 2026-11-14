// Clickable prototype of «Teilen» (docs/0.4.0/mockups/share). The pages are captures of the real app on
// the demo workspace (Muster Kaffee GmbH); this script adds only the new parts. Nothing talks to a server.
// The page is the file name (anna, anna-changes, papa, papa-journal); the state is the hash.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const svg = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  share: svg('<path d="M12 3v12M8 7l4-4 4 4"></path><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>'),
  check: svg('<path d="M5 12l5 5 9-10"></path>'),
  clock: svg('<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>'),
  eye: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>'),
  pen: svg('<path d="M4 20h4L19 9l-4-4L4 16z"></path>'),
  undo: svg('<path d="M9 14L4 9l5-5"></path><path d="M4 9h10a6 6 0 0 1 0 12h-3"></path>'),
  spark: svg('<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"></path>'),
  box: svg('<path d="M3 7l9-4 9 4v10l-9 4-9-4z"></path><path d="M3 7l9 4 9-4M12 11v10"></path>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"></path>'),
};

const page = (location.pathname.split('/').pop() || '').replace('.html', '');
const state = decodeURIComponent(location.hash.slice(1));

/** Go to another screen: inside the story (index.html) the story follows; alone, the page itself. */
function go(target) {
  if (window.parent !== window) window.parent.postMessage({ shareGo: target }, '*');
  else location.href = target;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-go]');
  if (a) { e.preventDefault(); e.stopPropagation(); go(a.dataset.go); }
}, true);
window.addEventListener('hashchange', () => location.reload());

function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function toast(text, act) {
  const t = el(`<div class="toast show" role="status"><span>${text}</span>${act ? `<button type="button">${act}</button>` : ''}</div>`);
  document.body.append(t);
  return t;
}

// ───────────────────────── Anna, the owner (sender) ─────────────────────────
const SHARE = {
  to: 'Papa', mail: 'peter.muster@example.ch', at: '14.11.2026 16:42', until: '24.11.2026', size: '64 MB',
  msg: 'Hoi Papa, kannst du Q3 anschauen, bevor ich die MWST einreiche? Danke! Anna',
};

function shareChip(on, hint) {
  const exp = $('.topbar button[aria-label="Exportieren"]');
  const chip = el(`<button type="button" class="chip shchip${on ? ' on' : ''}${hint ? ' hint' : ''}" aria-label="Teilen" data-go="${on ? 'anna.html#sent' : 'anna.html#dialog'}">${I.share}<span>${on ? `Bei ${SHARE.to}` : 'Teilen'}</span>${on ? '<span class="dot"></span>' : ''}</button>`);
  exp.before(chip);
  return chip;
}

function popUnder(chip, node) {
  document.body.append(node);
  const r = chip.getBoundingClientRect();
  node.style.top = `${r.bottom + 10}px`;
  node.style.left = `${Math.min(r.left - 40, innerWidth - node.offsetWidth - 16)}px`;
}

function statusCard(kind) {
  const opened = kind === 'opened' || kind === 'back';
  const gone = kind === 'withdrawn';
  return el(`<div class="shpop" role="dialog" aria-label="Geteilt">
    <span class="lbl">Geteilt</span>
    <h3>${gone ? 'Zurückgezogen' : `Gesendet an ${SHARE.to}`}</h3>
    <div class="who">${SHARE.mail}</div>
    <div class="facts2">
      <div>${I.share}<span>Gesendet ${SHARE.at} · ${SHARE.size}</span></div>
      ${gone ? `<div>${I.x}<span>Zurückgezogen 15.11.2026 08:30 · der Link geht nicht mehr</span></div>`
        : `<div>${I.clock}<span>Verfügbar bis ${SHARE.until}</span></div>
      ${opened ? `<div class="ok">${I.check}<span>Geöffnet am 15.11. 19:04</span></div>` : `<div>${I.eye}<span>Noch nicht geöffnet</span></div>`}`}
      <div>${I.lock}<span>Ende-zu-Ende verschlüsselt</span></div>
    </div>
    <div class="m">${gone ? 'Hat Papa sie schon geöffnet, bleibt seine Kopie auf seinem Mac; zurück kommt nichts mehr.' : 'Du buchst weiter wie immer. Was Papa ändert, kommt als Vorschlag zurück; du entscheidest.'}</div>
    <div class="acts">
      ${gone ? '<button type="button" class="btn primary" data-go="anna.html#dialog">Neu teilen</button>' : '<button type="button" class="btn ghost" data-go="anna.html#withdrawn">Zurückziehen</button>'}
      <button type="button" class="quiet2" data-go="anna.html">Schliessen</button>
    </div>
  </div>`);
}

function shareDialog(second) {
  document.body.append(el('<div class="scrim" style="background: color-mix(in srgb, var(--bg) 45%, transparent)" data-go="anna.html"></div>'));
  const what = second
    ? `<div class="wt"><b>Neu seit der letzten Übergabe (16.11.)</b><span class="mono">12 MB</span></div>
       <div class="wm">Papa hat die Bücher bis 16.11. schon. Es geht nur, was seither dazugekommen ist: 9 Buchungen, 14 Belege, der Kontoauszug November.</div>`
    : `<div class="wt"><b>Die Buchhaltung, Stand jetzt</b><span class="mono">64 MB</span></div>
       <div class="wm">2026 mit Buchungen, Belegen und Kontoauszügen, Stand 14.11.2026. Abgeschlossene Jahre bleiben bei dir. Nächstes Mal geht nur, was neu ist.</div>`;
  document.body.append(el(`<div class="palette shdlg" role="dialog" aria-label="Teilen">
    <div class="xhd"><div><span class="lbl">Teilen</span><b>Muster Kaffee GmbH</b></div><button type="button" class="x" aria-label="Schliessen" data-go="anna.html">×</button></div>
    <div class="shbody form">
      <label>An<input type="email" value="${SHARE.mail}" autocomplete="off"></label>
      <label>Nachricht (freiwillig)<textarea>${second ? 'Hoi Papa, hier noch der Oktober und November. Anna' : SHARE.msg}</textarea></label>
      <div class="what">${what}</div>
      <div class="lock">${I.lock}<span><b>Ende-zu-Ende verschlüsselt</b> — nur Papa kann den Inhalt lesen, der Server nicht. Der Link gilt 10 Tage, bis ${second ? '26.11.' : '24.11.'}</span></div>
    </div>
    <div class="xft"><span class="m">Papa bekommt eine E-Mail mit einem Link. Ohne Konto, ohne PIN.</span><button type="button" class="btn ghost" data-go="anna.html">Abbrechen</button><button type="button" class="btn primary" data-go="anna.html#sent">Senden</button></div>
  </div>`));
}

function anna() {
  const s = state || 'start';
  if (s === 'start') {
    const chip = shareChip(false, true);
    const r = chip.getBoundingClientRect();
    const tip = el('<div class="shtip">Teilen … (⇧S)</div>');
    document.body.append(tip);
    tip.style.top = `${r.bottom + 8}px`; tip.style.left = `${r.left - 10}px`;
  } else if (s === 'dialog' || s === 'dialog2') {
    shareChip(s === 'dialog2');
    shareDialog(s === 'dialog2');
  } else if (s === 'sent' || s === 'opened' || s === 'withdrawn') {
    const chip = shareChip(s !== 'withdrawn');
    if (s === 'withdrawn') chip.querySelector('span').textContent = 'Teilen';
    popUnder(chip, statusCard(s));
    if (s === 'sent') toast(`Gesendet an ${SHARE.to}`);
  } else if (s === 'back') {
    shareChip(true);
    $('.activity a.it[aria-label="Änderungen"]').classList.add('shdot');
    document.body.append(el(`<div class="shnote" role="status">
      <span class="av">PM</span>
      <b>Papa hat 7 Änderungen geschickt</b>
      <span class="m">16.11.2026 21:12 · Muster Kaffee GmbH</span>
      <div class="acts"><button type="button" class="btn primary" data-go="anna-changes.html#review">Durchsehen</button><button type="button" class="btn ghost" data-go="anna.html">Später</button></div>
    </div>`));
  }
}

// ─────────────── Anna: the review «Was Papa geändert hat» (Änderungen) ───────────────
const ROWS_BEFORE = [
  { t: 'Zurück von Papa · 7 Änderungen', s: '16.11.2026 21:12 · Peter Muster', sel: true, who: 'person' },
  { t: 'Torrefazione Esempio: Konto geändert', s: '15.11.2026 10:20 · Anna Muster', who: 'person' },
  { t: 'Mit Papa geteilt', s: '14.11.2026 16:42 · Anna Muster', who: 'share' },
  { t: 'Kontoauszug Oktober eingelesen, 21 Zahlungen', s: '03.11.2026 14:00 · Automatisierung', who: 'flow' },
  { t: 'Belege verarbeitet: 11 gelesen, 11 verbucht', s: '03.11.2026 14:00 · Automatisierung', who: 'flow' },
  { t: 'Regel: Swisscom immer auf 6510', s: '28.10.2026 09:12 · Anna Muster', who: 'person' },
];
const PERSON = svg('<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>');
const FLOW = svg('<path d="M5 12h14M13 6l6 6-6 6"></path>');

function changesList(rows) {
  $('section.list p.m')?.remove();
  const box = $('section.list .rows');
  box.innerHTML = '<div class="group"><span>Verlauf</span></div>' + rows.map((r) => `
    <div class="row chrow chsave-row${r.sel ? ' sel' : ''}" role="option" aria-selected="${!!r.sel}">
      <span class="t"><span class="chwho">${r.who === 'flow' ? FLOW : r.who === 'share' ? I.share : PERSON}</span>${r.t}</span>
      <small class="chsub">${r.s}</small>
    </div>`).join('');
}

const GROUPS = [
  {
    id: 'split', t: 'Aufgeteilt: Privatanteil', n: 3,
    sum: '3 Zahlungen an <button type="button" class="golink">Coop Pronto Musterdorf</button>: 30 % privat auf 2451, der Rest bleibt auf 6200 mit Vorsteuer.',
    why: 'Seit Juli fährst du den Wagen auch privat. 30 % laut Fahrtenbuch.',
    rows: [
      { d: '14.07.', t: 'Coop Pronto Musterdorf, Tanken', was: '6200 · I81 · 75.00', now: '6200 · I81 · 52.50 + 2451 · 22.50', amt: '75.00', orig: 'Gebucht von der KI · Beleg Coop Pronto Tanken' },
      { d: '14.08.', t: 'Coop Pronto Musterdorf, Tanken', was: '6200 · I81 · 69.35', now: '6200 · I81 · 48.55 + 2451 · 20.80', amt: '69.35', orig: 'Gebucht von der KI · Beleg Coop Pronto Tanken' },
      { d: '14.09.', t: 'Coop Pronto Musterdorf, Tanken', was: '6200 · I81 · 79.25', now: '6200 · I81 · 55.48 + 2451 · 23.77', amt: '79.25', orig: 'Gebucht von der KI · Beleg Coop Pronto Tanken' },
    ],
  },
  {
    id: 'acct', t: 'Konto und MWST-Code geändert', n: 1,
    rows: [
      { d: '14.07.', t: 'Torrefazione Esempio, Barista-Zubehör (FT 2026/0911)', was: '4210 · M81', now: '1510 · I81', amt: 'EUR 865.50', orig: 'Gebucht von der KI · CHF 806.88 · Vorsteuer 60.46 wandert von Ziffer 400 nach 405',
        why: 'Siebträgermühle, hält Jahre: aktivieren und abschreiben, nicht Verbrauchsmaterial.', conflict: true },
    ],
  },
  {
    id: 'fq', t: 'Korrektur eines eingereichten Quartals', n: 1,
    rows: [
      { d: '30.06.', t: 'Korrektur Q1 2026: Torrefazione Esempio FT 2026/0188 aktivieren', tag: 'korrigiert Q1 2026', was: 'neu', now: '1510 / 4210 · 1\'141.89', amt: '1\'141.89', orig: 'Neue Korrekturbuchung im offenen Quartal, zur Buchung d98d8a21 vom 17.02. · Korrekturabrechnung Q1: Ziffer 400 −85.56, 405 +85.56',
        why: 'Gleiches Zubehör wie im Juli. Q1 ist eingereicht, darum als Korrektur.' },
    ],
  },
  {
    id: 'link', t: 'Beleg zugeordnet', n: 1,
    rows: [
      { d: '30.09.', t: 'Raiffeisen, Kontoführung Q3', was: 'kein Beleg', now: 'Gebührenabrechnung Q3 2026.pdf', amt: '15.00', orig: 'Beleg von Papa hinzugefügt', why: 'Lag im E-Banking, hab sie geholt.' },
    ],
  },
  {
    id: 'note', t: 'Notiz', n: 1,
    rows: [
      { d: '', t: 'Geschäftspartner › Liegenschaften Muster', was: '', now: '«Ab Januar 2027 Miete 2\'550.– (Nachtrag zum Mietvertrag vom 2.10.)»', amt: '', orig: 'Kommt ins Wissen zu Liegenschaften Muster' },
    ],
  },
];

function rowHtml(g, r, i) {
  const ba = r.was === 'neu' ? `<span class="rvnow">${r.now}</span>`
    : r.was ? `<span class="rvwas">${r.was}</span><span class="rvar">→</span><span class="rvnow">${r.now}</span>` : `<span class="rvnow">${r.now}</span>`;
  const conflict = r.conflict ? `
    <div class="rvconf">${I.pen}<span>Du hast diese Buchung am 15.11. auch geändert. Welche gilt?</span></div>
    <div class="rvc" role="radiogroup" aria-label="Welche Version gilt">
      <button type="button" role="radio" aria-checked="false" data-pick="mine"><span class="ck">Deine Version</span><span class="cv">6100 · M81</span><span class="cm">Unterhalt und Ersatz Einrichtungen · von dir, 15.11. 10:20</span></button>
      <button type="button" role="radio" aria-checked="false" data-pick="papa"><span class="ck">Papas Version</span><span class="cv">1510 · I81</span><span class="cm">Mobiliar und Einrichtungen · von Papa, 16.11. 20:48</span></button>
    </div>` : '';
  return `<div class="rvr" data-row="${g.id}-${i}">
    <span class="rvdt">${r.d}</span>
    <div class="rvtx"><button type="button" class="golink">${r.t}</button>${r.tag ? `<span class="rvtag fq">${r.tag}</span>` : ''}
      <div class="rvba">${ba}</div>
      ${r.why ? `<div class="rvwhy">${r.why}</div>` : ''}
      <div class="rvorig">${r.orig}</div>
    </div>
    <div class="rvra"><span class="rvamt">${r.amt}</span><span><button type="button" class="quiet2" data-act="skip">Auslassen</button> · <button type="button" class="quiet2" data-act="ask">Frage zurück</button></span></div>
    ${conflict}
  </div>`;
}

function reviewHead() {
  return `<div class="head"><h2 class="who">Was Papa geändert hat<small>16.11.2026 21:12 · Peter Muster (Treuhänder) · 7 Änderungen auf deinen Stand vom 14.11.</small></h2></div>
    <div class="msgp"><small>Papa schreibt</small>Hoi Anna, sieben Sachen. Das Auto und die Mühle solltest du dir merken, der Rest ist Kleinkram. Gruss Papa</div>
    <div class="effect">
      <div><span class="ek">MWST Q3 2026 · zu bezahlen</span><span class="ev">2'146.30<span class="rvar">→</span>2'151.33</span><span class="ed up">+5.03 Vorsteuer weniger</span></div>
      <div><span class="ek">Korrekturabrechnung Q1 2026</span><span class="ev">±0.00</span><span class="ed">Ziffer 400 −85.56 · 405 +85.56</span></div>
      <div><span class="ek">1510 Mobiliar und Einrichtungen</span><span class="ev">12'000.00<span class="rvar">→</span>13'948.77</span><span class="ed">+1'948.77 aktiviert</span></div>
    </div>`;
}

function review(focusConflict) {
  changesList(ROWS_BEFORE);
  const det = $('section.detail .detail-in');
  det.className = 'detail-in chpage rv';
  det.innerHTML = reviewHead() + `
    <div class="all"><button type="button" class="btn primary" data-act="all">${I.check}Alles übernehmen</button><span class="m">oder pro Gruppe · jede Änderung lässt sich danach rückgängig machen</span></div>
    ${GROUPS.map((g) => `<section class="rvg" data-group="${g.id}">
      <div class="gh"><span class="t">${g.t}</span><span class="n">${g.n}</span><button type="button" class="btn" data-act="take">Übernehmen</button></div>
      ${g.sum ? `<div class="sumline">${g.sum}</div>` : ''}
      ${g.why ? `<div class="rvr" style="grid-template-columns:1fr;padding-top:4px"><div class="rvwhy">${g.why}</div></div>` : ''}
      ${g.rows.map((r, i) => rowHtml(g, r, i)).join('')}
    </section>`).join('')}`;
  let pick = '';
  det.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const row = b.closest('.rvr');
    const grp = b.closest('.rvg');
    if (b.dataset.pick) {
      pick = b.dataset.pick;
      $$('.rvc button', det).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    } else if (b.dataset.act === 'skip') {
      row.classList.toggle('skipped');
      b.textContent = row.classList.contains('skipped') ? 'Doch übernehmen' : 'Auslassen';
    } else if (b.dataset.act === 'ask') {
      if (row.querySelector('.rvask, .rvasked')) return;
      const q = { split: 'Steht der Anteil so im Fahrtenbuch, oder ist das geschätzt?', acct: 'Warum aktivieren und nicht als Unterhalt?', fq: 'Muss ich dafür etwas bei der ESTV einreichen?' }[grp.dataset.group] || 'Kannst du mir das erklären?';
      const ask = el(`<div class="rvask"><input type="text" value="${q}" aria-label="Frage an Papa"><button type="button" class="btn" data-act="send">Senden</button></div>`);
      row.append(ask); ask.querySelector('input').focus();
    } else if (b.dataset.act === 'send') {
      const q = row.querySelector('.ask input').value;
      row.querySelector('.rvask').replaceWith(el(`<div class="rvasked">Frage an Papa gesendet: «${q}» · diese Änderung wartet auf seine Antwort</div>`));
      row.classList.add('skipped');
    } else if (b.dataset.act === 'take') {
      grp.classList.add('taken');
      b.replaceWith(el(`<span class="done">${I.check}übernommen</span>`));
    } else if (b.dataset.act === 'all') {
      go(`anna-changes.html#applied${pick === 'mine' ? '-mine' : pick === 'papa' ? '' : '-open'}`);
    }
  });
  if (focusConflict) {
    const c = $('.rvc', det);
    c.scrollIntoView({ block: 'center' });
    $('[data-pick="papa"]', c).classList.add('on');
    pick = 'papa';
  }
}

function applied(variant) {
  changesList([{ t: 'Übernommen von Papa · 7 Änderungen', s: '16.11.2026 21:20 · Anna Muster', sel: true, who: 'person' }, ...ROWS_BEFORE.map((r) => ({ ...r, sel: false }))]);
  const det = $('section.detail .detail-in');
  det.className = 'detail-in chpage rv';
  const conflictLine = variant === 'open'
    ? `<div class="rvopen">${I.pen}<span><b>Torrefazione Esempio</b> <span class="m">· du und Papa habt sie geändert; deine Version gilt, bis du wählst</span></span><button type="button" class="btn" data-go="anna-changes.html#conflict">Wählen</button></div>`
    : variant === 'mine'
      ? `<div class="rvopen">${I.check}<span><b>Torrefazione Esempio</b> <span class="m">· deine Version gilt (6100 · M81); Papas Version bleibt im Verlauf</span></span></div>` : '';
  det.innerHTML = `<div class="head"><h2 class="who">Was Papa geändert hat<small>16.11.2026 21:12 · Peter Muster (Treuhänder) · 7 Änderungen</small></h2></div>
    <div class="rvdone">${I.check}<span><b>Übernommen</b> — von Papa (Treuhänder) · 16.11.2026 21:20</span><button type="button" class="linkbtn" data-go="anna-changes.html#review">rückgängig machen</button></div>
    ${conflictLine}
    <div class="rvlearn">
      <div class="t">${I.spark}Immer so?</div>
      <div class="m">Papa hat 3 Zahlungen an Coop Pronto Musterdorf gleich aufgeteilt. Soll die App die nächsten selbst so buchen?</div>
      <pre>6200 Fahrzeugaufwand, Vorsteuer 8.1 %
30 % privat auf 2451 Kontokorrent Gesellschafterin, ohne Vorsteuer</pre>
      <div class="acts"><button type="button" class="btn primary" data-act="rule">Immer so</button><button type="button" class="btn ghost">Regel ansehen</button><button type="button" class="btn ghost" data-act="no">Nein</button></div>
    </div>
    ${GROUPS.map((g) => `<section class="rvg taken"><div class="gh"><span class="t">${g.t}</span><span class="n">${g.n}</span><span class="done">${I.check}${g.id === 'acct' && variant !== '' ? (variant === 'open' ? 'wartet auf deine Wahl' : 'deine Version') : 'übernommen'}</span></div>
      ${g.rows.map((r) => `<div class="rvr"><span class="rvdt">${r.d}</span><div class="rvtx"><button type="button" class="golink">${r.t}</button><div class="rvba"><span class="rvnow">${r.now}</span></div><div class="rvorig">von Papa${r.why ? ` · «${r.why}»` : ''}</div></div><div class="rvra"><span class="rvamt">${r.amt}</span><button type="button" class="quiet2">rückgängig</button></div></div>`).join('')}
    </section>`).join('')}`;
  det.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const box = b.closest('.rvlearn');
    if (b.dataset.act === 'rule') box.innerHTML = `<div class="t">${I.check}Regel behalten: Coop Pronto Musterdorf, 30 % privat</div><div class="m">Firma › Regeln · bucht ab der nächsten Zahlung so · aus Papas Korrektur vom 16.11.</div>`;
    if (b.dataset.act === 'no') box.innerHTML = '<div class="m">Nicht übernommen. Die drei Buchungen bleiben, wie Papa sie korrigiert hat.</div>';
  });
  toast('7 Änderungen von Papa übernommen', 'Rückgängig');
}

function annaChanges() {
  const s = state || 'review';
  if (s === 'review') review(false);
  else if (s === 'conflict') review(true);
  else if (s.startsWith('applied')) applied(s === 'applied' ? '' : s.slice(8));
}

// ───────────────────────── Papa, the fiduciary (recipient) ─────────────────────────
function recvBanner(web) {
  document.documentElement.classList.add('recv');
  const bar = web
    ? el(`<div class="auditbar shrecv web" role="status"><span><b>Buchhaltung von Muster Kaffee GmbH</b> · Stand 14.11.2026 · von Anna</span><span class="mode">${I.eye}Nur ansehen, im Browser</span><span class="m">Korrigieren geht mit Vanilla Accounting auf einem Mac</span></div>`)
    : el(`<div class="auditbar shrecv" role="status"><span><b>Buchhaltung von Muster Kaffee GmbH</b> · Stand 14.11.2026 · von Anna</span><span class="mode">${I.pen}Prüfmodus für Treuhänder</span><span class="m">Du korrigierst eine Kopie; Anna entscheidet, was sie übernimmt</span></div>`);
  document.body.prepend(bar);
  // The recipient files nothing: «Abrechnung erstellen» is Anna's.
  const wf = $('.wfbuttons');
  if (wf) wf.innerHTML = '<span class="m" style="font-size:12px;color:var(--muted)">Einreichen macht Anna</span>';
}

function returnBar(n) {
  document.body.append(el(`<div class="shret" role="status"><span><b>${n} Änderungen</b></span><button type="button" class="btn primary" data-go="papa-journal.html#send">${I.share}An Anna zurücksenden</button></div>`));
}

function papa() {
  const s = state || 'open';
  recvBanner(s === 'web');
  // The dock: Buchungen opens the journal of the copy.
  const j = $('.activity a.it[aria-label="Buchungen"]');
  if (j && s !== 'web') j.dataset.go = 'papa-journal.html#edit';
  $$('section.list .row').forEach((r) => { if (s !== 'web') r.dataset.go = 'papa-journal.html#edit'; });
  if (s === 'open') {
    document.body.append(el(`<div class="shwelcome" role="dialog" aria-label="Willkommen">
      <h3>Annas Buchhaltung</h3>
      <p>Korrigiere, was nicht stimmt, und schreib dazu, warum. Alles geht mit einem Klick an Anna zurück; ihre Bücher ändern sich erst, wenn sie es übernimmt.</p>
      <div class="msg">Hoi Papa, kannst du Q3 anschauen, bevor ich die MWST einreiche? Danke! Anna<small>Nachricht von Anna · 14.11.2026</small></div>
      <div class="acts"><button type="button" class="btn primary" data-go="papa-journal.html#edit">Zu den Buchungen</button><button type="button" class="btn ghost" data-act="close">Schliessen</button></div>
    </div>`));
    $('.shwelcome [data-act="close"]').addEventListener('click', () => $('.shwelcome').remove());
  }
}

function papaJournal() {
  const s = state || 'edit';
  recvBanner(false);
  // Changed rows carry a dot; the selected one is being edited.
  $$('section.list .row').forEach((r) => { if (/Coop Pronto/.test(r.textContent)) r.querySelector('.t, span')?.insertAdjacentHTML('beforeend', '<span class="shmark" title="von dir geändert"></span>'); });
  const sec = $('[data-sec="buchung"]');
  const val = $('.val', sec); val.textContent = 'bearbeitbar'; val.classList.add('edit');
  $$('input[readonly]', sec).forEach((i) => i.removeAttribute('readonly'));
  const form = $('form', sec);
  const vat = $$('.two', form)[1];
  vat.after(el(`<div class="shsplit">
    <div class="cap"><span>Aufteilen</span><span></span><span>MWST</span><span>CHF</span></div>
    <div class="ln"><input class="mono" value="6200"><span class="acn">Fahrzeugaufwand · 70 %</span><input class="mono" value="I81"><input class="mono" value="55.48" style="text-align:right"></div>
    <div class="ln"><input class="mono" value="2451"><span class="acn">Kontokorrent Gesellschafterin · privat 30 %</span><input class="mono" value="" placeholder="–"><input class="mono" value="23.77" style="text-align:right"></div>
  </div>`));
  $('.err', form).before(el('<label class="rvwhy">Warum? (für Anna)<input value="Seit Juli fährst du den Wagen auch privat. 30 % laut Fahrtenbuch."></label>'));
  $('.err', form).after(el('<div class="fhint">Gespeichert in deiner Kopie · geht mit «An Anna zurücksenden» zu Anna</div>'));
  // The entry's head shows the split too.
  const satz = $('.satz');
  if (satz) satz.insertAdjacentHTML('afterend', '<div class="warnline" style="color:var(--accent)">' + I.pen + '<span>Von dir geändert: 30 % privat auf 2451 · auch 14.07. und 14.08.</span></div>');
  if (s === 'edit') returnBar(3);
  else if (s === 'send') {
    returnBar(7);
    document.body.append(el('<div class="scrim" style="background: color-mix(in srgb, var(--bg) 45%, transparent)" data-go="papa-journal.html#edit"></div>'));
    document.body.append(el(`<div class="palette shdlg" role="dialog" aria-label="An Anna zurücksenden">
      <div class="xhd"><div><span class="lbl">Zurücksenden</span><b>An Anna Muster</b></div><button type="button" class="x" aria-label="Schliessen" data-go="papa-journal.html#edit">×</button></div>
      <div class="shbody form">
        <div class="chg">
          <div class="gh">Deine 7 Änderungen</div>
          <div class="r"><span>Coop Pronto Musterdorf, Tanken: 30 % privat</span><span class="mono">3 Buchungen</span></div>
          <div class="r"><span>Torrefazione Esempio, Barista-Zubehör: 1510 · I81</span><span class="mono">14.07.</span></div>
          <div class="r"><span>Korrektur Q1 2026: Torrefazione aktivieren</span><span class="mono">neu · 30.06.</span></div>
          <div class="r"><span>Raiffeisen, Kontoführung Q3: Beleg zugeordnet</span><span class="mono">30.09.</span></div>
          <div class="r"><span>Notiz zu Liegenschaften Muster</span><span class="mono">Wissen</span></div>
        </div>
        <label>Nachricht (freiwillig)<textarea>Hoi Anna, sieben Sachen. Das Auto und die Mühle solltest du dir merken, der Rest ist Kleinkram. Gruss Papa</textarea></label>
        <div class="lock">${I.lock}<span><b>Ende-zu-Ende verschlüsselt.</b> Anna sieht jede Änderung mit deinem «Warum?» und entscheidet, was sie übernimmt.</span></div>
      </div>
      <div class="xft"><span class="m">48 KB</span><button type="button" class="btn ghost" data-go="papa-journal.html#edit">Abbrechen</button><button type="button" class="btn primary" data-go="papa-journal.html#done">Zurücksenden</button></div>
    </div>`));
  } else if (s === 'done') {
    document.body.append(el(`<div class="shret done" role="status">${I.check}<span><b>An Anna zurückgesendet</b> · 16.11.2026 21:12 · 7 Änderungen</span></div>`));
    toast('Anna sieht deine Änderungen jetzt');
  }
}

({ anna, 'anna-changes': annaChanges, papa, 'papa-journal': papaJournal })[page]?.();
