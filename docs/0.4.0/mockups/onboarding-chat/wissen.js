// Two areas of design B (docs/0.4.0/knowledge.md), built from what the conversation in chat.js kept
// (S, CLEAR, MIXED, FLAGS, QUESTIONS, show are its globals, read only when a view renders):
//   Geschäftspartner: a list and one page per partner, prose first: open questions, «Notizen», what
//     the app carries out by itself, the AI's proposals as one batch, what is linked to the partner,
//     and the machine details folded away.
//   Wissen: how the company works, one prose page per topic in the same shape, plus «Lücken» and
//     «Von der App».
// With S.later both show the knowledge as it would be after Q3 2026 (design A's figures and gaps).
'use strict';

const KW = (() => {
  const q = (s, el = document) => el.querySelector(s);
  const chk = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"></path></svg>';
  const chev = '<svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';
  const pillApp = '<span class="wfpill src-app">von der App</span>';
  const months = () => (mid() ? 3 : 9);
  const d = (jan, mitte) => (mid() ? mitte : jan);
  const setupDay = () => (mid() ? '01.07.2026' : '05.01.2026');
  const TODAY = '20.10.2026';
  const applied = (n) => Math.max(1, Math.round((n * months()) / 12));
  const kept = (id) => S.keptList.some((p) => p.id === id);
  const answer = (id) => S.answers.find((a) => a.id === id);
  const opt = (key, v, b, s, rec) => `<button type="button" class="obopt" data-ans="${key}" data-v="${v}"><i class="rd"></i><b>${b}${rec ? '<span class="wfpill">empfohlen</span>' : ''}</b><span>${s || ''}</span></button>`;

  // ── Who the partners are ─────────────────────────────────────────────────────────────────────────
  const META = {
    gruenkaffee: { role: 'Lieferant · Rohkaffee', kind: 'supplier', journal: 'Grünkaffee Muster', short: 'Rohkaffee' },
    swisscom: { role: 'Lieferant · Telefon', kind: 'supplier', short: 'Telefon und Internet' },
    liegenschaften: { role: 'Vermieter', kind: 'supplier', journal: 'Liegenschaften Muster', short: 'Miete Ladenlokal' },
    post: { role: 'Lieferant · Versand', kind: 'supplier', journal: 'Post CH', short: 'Pakete' },
    cloud: { role: 'Lieferant · Ausland', kind: 'supplier', journal: 'Example Cloud', short: 'Kassensystem-Abo' },
    infomaniak: { role: 'Lieferant · Hosting', kind: 'supplier', short: 'Mail und Domain' },
    raiffeisen: { role: 'Bank', kind: 'authority', journal: 'Raiffeisen', short: 'Kontoführung' },
    estv: { role: 'Behörde', kind: 'authority', journal: 'ESTV', short: 'MWST-Zahlung' },
    coop: { role: 'Lieferant · Tankstelle und Laden', kind: 'supplier', journal: 'Coop Pronto Musterdorf', tx: 'Coop Pronto' },
    digitec: { role: 'Lieferant · Informatik', kind: 'supplier', tx: 'Digitec' },
    aliexpress: { role: 'Lieferant · Ausland', kind: 'supplier', tx: 'AliExpress' },
    atelier: { role: 'Lieferant · Ausland', kind: 'supplier', tx: 'Grafik Atelier' },
    payments: { role: 'Zahlungsdienst', kind: 'supplier', journal: 'Muster Payments' },
    vistaprint: { role: 'Lieferant · Drucksachen', kind: 'supplier' },
    hotel: { role: 'Kunde', kind: 'customer' },
  };
  const KINDS = [['all', 'alle'], ['supplier', 'Lieferanten'], ['customer', 'Kunden'], ['authority', 'Banken & Behörden'], ['open', 'Offen']];

  // The notes as the setup drafted them from 2025 and the answers, and as they read after Q3.
  const draft = (p) => {
    const c = p.clear;
    if (p.id === 'gruenkaffee') return S.later
      ? 'Grünkaffee Muster AG liefert unseren Rohkaffee, seit 2025. Die Rechnung kommt am Monatsende per Mail an belege@muster-kaffee.ch; fehlt sie, steht sie im Kundenportal.\n\nDen Kaffee buchen wir auf 4000 Rohkaffee mit 2.6 % (Lebensmittel), Jutesäcke und Verpackung auf 4210 mit 8.1 %. Eine Buchung je Rechnung, auch wenn eine Zahlung zwei begleicht. Gutschriften buchen wir separat, nicht mit der nächsten Rechnung verrechnet.\n\nLieferscheine und Zahlungserinnerungen sind keine Belege, nur die Rechnung. Zahlungsfrist 30 Tage netto, Kundennummer 40112.'
      : 'Grünkaffee Muster AG liefert unseren Rohkaffee, seit 2025, etwa alle zwei Wochen.\n\nDen Kaffee buchen wir auf 4000 Rohkaffee mit 2.6 % (Lebensmittel). Bezahlt wird per QR-Rechnung von der Raiffeisen.';
    if (p.id === 'swisscom') return 'Swisscom liefert Telefon und Internet für den Laden. Die Rechnung kommt am 28. und wird per LSV abgebucht. Wir buchen sie auf 6510 Telefon und Internet mit 8.1 %.';
    if (p.id === 'liegenschaften') return 'Liegenschaften Muster ist unser Vermieter: das Ladenlokal, CHF 2\'400.00 im Monat, fällig am Ersten. Miete ist ohne MWST, wir buchen sie auf 6000 Mietaufwand.' + (S.later ? '\n\nSeit Oktober 2026 kommt die Miete über die neue Verwaltung «Immo Verwaltung Muster».' : '');
    if (p.id === 'coop') {
      const a = answer('coop');
      const how = !a || a.kind === 'skip' ? 'Wofür ich dort einkaufe, ist noch offen.' : a.kind === 'note' ? 'Nach dem Kassenzettel: Benzin auf 6200 Fahrzeugaufwand, Café-Bedarf auf 4210 Verbrauchsmaterial, Lebensmittel für zu Hause privat auf 2451.' : a.kind === 'ask' ? 'Wofür ein Einkauf war, frage ich jedes Mal nach.' : 'Alles auf 6200 Fahrzeugaufwand.';
      return `Coop Pronto Musterdorf ist die Tankstelle mit Laden an der Hauptstrasse. Ich tanke dort den Lieferwagen und kaufe manchmal Café-Bedarf oder etwas für zu Hause.\n\n${how} Coop Pronto weist immer 8.1 % MWST aus.`;
    }
    if (p.id === 'digitec') {
      const a = answer('digitec');
      const how = !a || a.kind === 'skip' ? 'Wie wir das buchen, ist noch offen.' : a.kind === 'note' ? 'Kleines kommt in den Aufwand auf 6570 Informatik, Geräte über ein paar hundert Franken auf 1520 Büromaschinen.' : a.kind === 'ask' ? 'Was ich gekauft habe, sage ich bei jeder Zahlung.' : 'Alles auf 6570 Informatik.';
      return `Bei Digitec Galaxus kaufen wir Informatik und Kleingeräte für den Laden. ${how}`;
    }
    if (p.flag) return `${p.name}: ${p.flag.n}× im Jahr 2025. Gebucht wurde es damals als ${p.flag.was}. Das übernehmen wir nicht: ${p.flag.why} Ab jetzt ${p.flag.now}.`;
    if (p.id === 'payments') return 'Muster Payments zahlt die Kartenumsätze des Cafés aus, abzüglich ihrer Gebühren. Den Umsatz buchen wir brutto auf 3000 Ertrag Café, die Gebühren laut Auszahlungsbericht auf 6840, ohne MWST. Den Bericht gibt es im Händlerportal.';
    if (p.id === 'vistaprint') return 'Vistaprint druckt unsere Flyer und Visitenkarten. Die Rechnung kommt nicht per Mail, sie steht nur im Kundenkonto. Wir buchen sie auf 6600 Werbeaufwand.';
    if (p.id === 'hotel') return 'Muster Hotel GmbH kauft seit März 2026 unsere Kaffeebohnen für das Frühstück, 10 Tage netto. Es bezahlt gesammelt am Monatsende, eine Zahlung für mehrere Rechnungen.';
    if (c) return `${p.name}: ${META[p.id].short}. Wir buchen es auf ${c.acc}, ${c.vat ? `MWST-Code ${c.vat}` : 'ohne MWST'}.${kept(c.id) ? '' : ' Eine Regel wollte ich bei der Einrichtung nicht: die KI schlägt die Buchung von 2025 vor, und ich bestätige.'}`;
    return '';
  };

  // The AI's proposals: sentences it would add to the notes, with what it read them from.
  const PROPOSALS = {
    gruenkaffee: () => (S.later
      ? [['Die QR-Referenz der Zahlung endet mit der Rechnungsnummer.', 'aus den Zahlungen 2026'], ['Bezahlt wird 25 bis 30 Tage nach der Rechnung.', 'aus 26 Zahlungen 2025 und den Zahlungen 2026'], ['Im Dezember kommen oft zwei Lieferungen auf eine Rechnung.', 'aus den Rechnungen Dezember 2025']]
      : [['Zahlungsfrist 30 Tage netto: bezahlt wird 25 bis 30 Tage nach der Rechnung.', 'aus 26 Zahlungen 2025'], ['Verpackung buchen wir auf 4210 mit 8.1 %, sie steht als eigene Zeile auf der Rechnung.', 'aus 4 Rechnungen 2025']]),
    swisscom: () => [['Das Handy-Abo ist auf derselben Rechnung wie das Internet.', 'aus den Rechnungen 2025']],
    post: () => [['Die Pakete für den Webshop zahlen wir am Monatsende gesammelt.', 'aus 12 Zahlungen 2025']],
  };
  // The public layer (processes/): shown grey under the details, never editable here.
  const APP = {
    post: ['Eine Aufgabebestätigung der Post ist kein Beleg. Beleg ist die Rechnung aus dem Geschäftskundenportal.'],
    estv: ['Die MWST-Abrechnung ist 60 Tage nach dem Ende der Periode fällig.', 'Die Zahlung an die ESTV ist keine Ausgabe: sie geht auf das Abrechnungskonto MWST.'],
    coop: ['Coop Pronto weist immer 8.1 % MWST aus. Ist der Kassenzettel unleserlich, darf die KI MWST I81 annehmen.'],
    aliexpress: ['Gültig für die Vorsteuer ist nur die «Tax Invoice» mit der Schweizer MWST-Nummer und 8.1 %. Die «Order Summary» sieht amtlich aus, ist aber kein Beleg.', 'Eine Zahlung kann mehrere Bestellungen umfassen.'],
    cloud: ['Eine Dienstleistung aus dem Ausland ohne Schweizer MWST: Bezugsteuer B81-1.'],
  };

  // ── Edits the person makes in the prototype ──────────────────────────────────────────────────────
  const edits = new Map(); // page key -> { text, by }
  const editing = new Set();
  const gone = new Set(); // proposals and suggestions taken over or dropped
  const added = new Map(); // page key -> rules kept from the notes
  const off = new Set(); // rules switched off
  const answered = new Map(); // question or gap key -> saved text
  const pages = new Map(); // company pages made with «Neue Seite»
  let preOpen = false;
  const notesOf = (key, base) => (edits.has(key) ? edits.get(key).text : base);
  const byOf = (key, by) => (edits.has(key) ? edits.get(key).by : by);

  // A sentence the app could carry out as a rule: «X auf NNNN … mit 8.1 %», «zur Hälfte privat».
  const suggestionsOf = (key, name, text, rules, acc) => {
    const out = [];
    for (const m of text.matchAll(/(?:^|[.;,]\s*)([A-ZÄÖÜa-zäöü][^.;,\n]*?) auf (\d{4})[^.;,\n]*? mit (\d+(?:\.\d)?) ?%/g)) {
      if (rules.some((r) => r.acc === m[2]) || out.some((s) => s.acc === m[2])) continue;
      const what = m[1].replace(/^(Den |Die |Das )/, '').replace(/ buchen wir$/, '');
      out.push({ k: `${key}:s:${m[2]}`, acc: m[2], line: `Zeile «${what}» → ${m[2]}, MWST ${m[3] === '2.6' ? 'M26' : 'I81'}`, evidence: `aus dem Satz «${m[0].replace(/^[.;,]\s*/, '').trim()}»` });
    }
    const half = text.match(/zur Hälfte privat|(\d+) ?% privat/);
    if (half && acc && !rules.some((r) => r.priv)) out.push({ k: `${key}:s:priv`, acc, priv: true, line: `${name} → ${acc}, MWST I81, ${half[1] || 50} % privat auf 2451 ohne MWST`, evidence: `aus dem Satz mit «${half[0]}»` });
    return out.filter((s) => !gone.has(s.k));
  };

  // ── One partner, prose first ─────────────────────────────────────────────────────────────────────
  const partnerOf = (base) => {
    const p = { ...base, ...META[base.id] };
    const c = p.clear, key = 'p:' + p.id;
    p.rules = [];
    if (c && kept(c.id)) p.rules.push({ k: key + ':r', acc: c.acc.split(' ')[0], line: `${META[p.id].short} → ${c.acc.split(' ')[0]}, ${vatText(c.vat)}`, meta: S.later ? `${applied(c.n)}× dieses Jahr` : `bestätigt bei der Einrichtung · ${c.n}× so gebucht 2025` });
    if (p.mixed) {
      const a = answer(p.id), o = a && QUESTIONS[p.id].opts.find((x) => x.v === a.kind);
      if (o && o.v !== 'note') p.rules.push({ k: key + ':r', line: o.know.replace(/^[^:]+: /, ''), meta: o.v === 'ask' && S.later ? `${applied(p.n)}× gefragt dieses Jahr` : 'deine Antwort bei der Einrichtung' });
    }
    if (p.id === 'payments') p.rules.push({ k: key + ':r', line: 'Auszahlung → 3000, MWST V81, Gebühren laut Bericht → 6840, I0', meta: `${months() - 1}× dieses Jahr` });
    if (p.id === 'vistaprint') p.rules.push({ k: key + ':r', acc: '6600', line: 'Drucksachen → 6600, MWST I81', meta: 'aus «Immer so?» · noch nie angewendet' });
    p.rules.push(...(added.get(key) || []));
    p.notes = notesOf(key, draft(p));
    p.by = byOf(key, S.later && ['gruenkaffee', 'liegenschaften', 'payments', 'vistaprint', 'hotel'].includes(p.id) ? 'Anna Muster am 14.08.2026' : `der Einrichtung am ${setupDay()}, aus Buchungen 2025 und deinen Antworten`);
    p.suggest = suggestionsOf(key, p.name, p.notes, p.rules, c && c.acc.split(' ')[0]);
    p.proposals = (PROPOSALS[p.id] ? PROPOSALS[p.id]() : []).map(([t, from]) => ({ k: `${key}:p:${t.slice(0, 30)}`, t, from })).filter((x) => !gone.has(x.k));
    p.questions = [];
    if (p.mixed) { const a = answer(p.id); if (!a || a.kind === 'skip' || answered.has('q:' + p.id)) p.questions.push({ qid: p.id, t: QUESTIONS[p.id].q, m: a ? 'übersprungen bei der Einrichtung · ohne Antwort fragt die App bei jeder Zahlung' : 'noch nicht gefragt' }); }
    if (S.later && p.id === 'gruenkaffee') p.questions.push({ qid: 'roestkurs', t: 'Die Rechnung vom 12.10.2026 hat eine neue Zeile: «Röstkurs für Mitarbeitende», CHF 380.00, MWST 8.1 %. Auf welches Konto?', m: 'von der KI · die Rechnung liegt unter Belege' });
    if (p.flag && S.disputed.includes(p.flag.of)) p.questions.push({ t: 'Du siehst es anders. Was war bei diesen Zahlungen anders?', m: 'aus der Einrichtung · die App fragt bei der nächsten Zahlung mit deinem Grund daneben' });
    p.match = [c ? `Zahlungstext enthält «${c.tx}»` : META[p.id].tx ? `Zahlungstext enthält «${META[p.id].tx}»` : 'IBAN auf dem Kontoauszug'];
    if (S.later && p.id === 'gruenkaffee') p.match.push('UID CHE-999.888.777 auf dem Beleg');
    p.cases = [];
    if (p.flag) p.cases.push(`2025 als ${p.flag.was} gebucht, so nicht übernommen: ${p.flag.now}.`);
    if (S.later && p.id === 'gruenkaffee') p.cases.push(`Gutschrift CHF 140.00 für eine beschädigte Lieferung: eigene Buchung auf 4000, MWST -M26 (entschieden am ${d('14.04.2026', '19.08.2026')}).`, `Gratismuster mit einer Rechnung über CHF 0.00: nichts gebucht, die Rechnung als ergänzender Beleg abgelegt (${d('03.06.2026', '02.09.2026')}).`);
    if (S.later && p.id === 'swisscom' && kept('swisscom')) p.cases.push('Rechnung 02.10.2026 zur Hälfte privat gebucht: das Handy-Abo nutzt du auch privat.');
    p.open = p.questions.filter((x) => !answered.has('q:' + x.qid)).length + p.proposals.length + p.suggest.length;
    return p;
  };
  const partners = () => {
    if (!S.learned) return [];
    return [
      ...CLEAR.map((c) => ({ id: c.id, name: c.name, clear: c, n: c.n })),
      ...MIXED.filter((m) => m.id !== 'bargeld').map((m) => ({ id: m.id, name: m.name, mixed: m, n: m.n })),
      ...FLAGS.filter((f) => f.id).map((f) => ({ id: f.id, name: f.name, flag: f, n: f.n })),
      ...(S.later ? [{ id: 'vistaprint', name: 'Vistaprint', n: 2 }, { id: 'payments', name: 'Muster Payments', n: 0 }, { id: 'hotel', name: 'Muster Hotel GmbH', n: 0 }] : []),
    ].map(partnerOf).sort((a, b) => b.open - a.open || b.n - a.n);
  };

  // What the books link to a partner: its entries in the journal shown, their receipts and payments.
  let journalRows = null;
  const rowsFor = (name) => {
    if (!name) return [];
    if (!journalRows) journalRows = [...q('#m-journal').content.querySelectorAll('.row[data-id]')].map((r) => ({ id: r.dataset.id, d: q('.d', r).textContent.trim(), name: q('.t', r).firstChild.textContent.trim(), tx: ((q('.t small', r) || {}).textContent || '').trim(), dr: q('.dr', r).textContent, cr: q('.cr', r).textContent, a: q('.a', r).textContent }));
    return journalRows.filter((r) => r.name === name);
  };
  const group = (title, n, items, empty) => `<div class="kwlink-g"><h4>${title}<span class="n">${n}</span></h4>${n ? `<ul>${items.slice(0, 3).join('')}</ul>${n > 3 ? `<span class="m">und ${n - 3} weitere</span>` : ''}` : `<span class="m">${empty}</span>`}</div>`;
  const entryLi = (r) => `<li><a href="/journal/${r.id}" data-journal="${r.id}"><span class="mono">${r.d}</span> ${r.tx}</a><span class="mono">${r.a}</span></li>`;
  const linked = (rows, kind) => {
    const pay = rows.filter((r) => r.dr === '1021' || r.cr === '1021');
    const rec = kind === 'supplier' ? rows.filter((r) => r.cr === '1021') : [];
    return `<section class="kwsec"><header><h3>Verknüpft</h3><span class="m">was in den Büchern zu diesem Partner gehört</span></header><div class="kwlinked">
      ${group('Buchungen', rows.length, rows.map(entryLi), 'Noch keine in der gezeigten Periode.')}
      ${group('Belege', rec.length, rec.map((r) => `<li><a href="/receipts/${r.id.split('').reverse().join('')}" data-elsewhere="Belege"><span class="mono">${r.d}</span> Rechnung ${r.tx}.pdf</a></li>`), kind === 'customer' ? 'Keine: an Kunden schreibst du Rechnungen.' : 'Noch keine.')}
      ${group('Zahlungen', pay.length, pay.map((r) => `<li><a href="/bank/1021-${r.d.slice(6, 10)}-${r.d.slice(3, 5)}/${r.id.slice(0, 10)}" data-elsewhere="Kontoauszüge"><span class="mono">${r.d}</span> Raiffeisen 1021</a><span class="mono">${r.a}</span></li>`), 'Noch keine.')}
      ${group('Rechnungen', kind === 'customer' ? 2 : 0, ['<li><a href="/invoices/2026-007" data-elsewhere="Rechnungen"><span class="mono">2026-007</span> Kaffeebohnen September</a><span class="mono">1\'240.00</span></li>', '<li><a href="/invoices/2026-004" data-elsewhere="Rechnungen"><span class="mono">2026-004</span> Kaffeebohnen August</a><span class="mono">980.00</span></li>'], 'Keine: Rechnungen schreibst du an Kunden.')}
    </div></section>`;
  };

  // ── The shape every page shares: notes, what the app does, proposals, details ──────────────────
  const md = (t) => t.split(/\n{2,}/).map((para) => (/^- /m.test(para) ? `<ul>${para.split('\n').map((l) => `<li>${l.replace(/^- /, '')}</li>`).join('')}</ul>` : `<p>${para.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`)).join('');
  const notesBlock = (key, text, by, empty) => (editing.has(key)
    ? `<section class="kwnotes editing"><header><h3>Notizen</h3></header><textarea data-notes="${key}" rows="10" aria-label="Notizen">${text}</textarea><div class="kwnacts"><button type="button" class="btn primary" data-save="${key}">Speichern</button><button type="button" class="btn ghost" data-cancel="${key}">Abbrechen</button><span class="m">Absätze mit einer leeren Zeile, eine Liste mit «- ». Die KI liest diese Seite, wenn sie hier entscheidet.</span></div></section>`
    : `<section class="kwnotes"><header><h3>Notizen</h3><button type="button" class="linkbtn" data-edit="${key}">Bearbeiten</button></header><div class="kwprose">${text ? md(text) : `<p class="m">${empty}</p>`}</div><p class="m kwby">zuletzt geändert von ${by} · <button type="button" class="linkbtn">Verlauf</button></p></section>`);
  const selfBlock = (rules, suggest, empty) => `<section class="kwself"><header><h3>Das macht die App selbst</h3></header>
    ${rules.length ? `<ul>${rules.map((r) => `<li class="${off.has(r.k) ? 'off' : ''}"><b>${r.line}</b><span class="m">${off.has(r.k) ? 'ausgeschaltet' : r.meta}</span><button type="button" class="btn ghost" data-off="${r.k}">${off.has(r.k) ? 'Einschalten' : 'Ausschalten'}</button></li>`).join('')}</ul>` : `<p class="m">${empty}</p>`}
    ${suggest.map((s) => `<div class="kwsugg"><span><small>Aus den Notizen</small><span><b>${s.line}</b> als Regel?</span><span class="m">${s.evidence}</span></span><button type="button" class="btn" data-keep="${s.k}">Behalten</button><button type="button" class="btn ghost" data-drop="${s.k}">Nicht jetzt</button></div>`).join('')}</section>`;
  const proposalsBlock = (key, list) => (list.length ? `<details class="kwprops"><summary>${chev}<b>Vorschläge der KI</b><span class="n">${list.length}</span><span class="m">Sätze für die Notizen, aus dem, was die KI gelesen hat</span></summary><ul>${list.map((x) => `<li><span><b>${x.t}</b><span class="m">${x.from}</span></span><button type="button" class="btn" data-merge="${x.k}" data-page="${key}">In die Notizen übernehmen</button><button type="button" class="btn ghost" data-drop="${x.k}">Verwerfen</button></li>`).join('')}</ul></details>` : '');
  const detailsBlock = (groups, extra = '') => `<details class="kwdetails"><summary>${chev}<b>Details für die App</b><span class="m">woran sie erkennt und was entschieden ist; steht in der Datei</span></summary>${groups.filter(([, xs]) => xs.length).map(([t, xs, grey]) => `<h4>${t}</h4><ul class="${grey ? 'app' : ''}">${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`).join('')}${extra}</details>`;
  const QOPTS = {
    roestkurs: [['5800', 'Konto 5800 Übriger Personalaufwand, MWST I81', 'Kurse von Grünkaffee Muster künftig immer so.', 'Steht jetzt in den Notizen: «Kurse für Mitarbeitende auf 5800 Übriger Personalaufwand.»'], ['once', 'Nur dieses Mal: Konto 5800', 'Bleibt ein einzelner Fall.', 'Gespeichert als Fall vom 20.10.2026. Beim nächsten Kurs fragt die App wieder.']],
  };
  const questionCard = (x) => {
    const key = 'q:' + x.qid;
    const opts = !x.qid ? '' : QUESTIONS[x.qid]
      ? QUESTIONS[x.qid].opts.map((o) => opt(key, o.v, o.l, o.s.replace(/^empfohlen · /, ''), o.primary)).join('')
      : QOPTS[x.qid].map(([v, b, s], n) => opt(key, v, b, s, n === 0)).join('');
    return `<div class="obcase kwq${answered.has(key) ? ' answered' : ''}"><b>${x.t}</b><span class="m">${x.m}</span>${answered.has(key) || !opts ? '' : `<div class="obopts">${opts}</div>`}<div class="saved">${chk}<span>${answered.get(key) || ''}</span></div></div>`;
  };

  const partnerView = (p) => {
    const ex = p.clear ? `<h4>Beispiele aus 2025</h4><ul>${p.clear.ex.map(([dt, a, t]) => `<li><span class="mono">${dt}</span> ${t} · <span class="mono">${p.clear.acc.split(' ')[0]} / 1021 · ${p.clear.vat || 'ohne'} · ${a}</span></li>`).join('')}</ul>${p.clear.n > p.clear.ex.length ? `<p class="m">und ${p.clear.n - p.clear.ex.length} weitere. Die KI schaut hier nach, wenn weder Regel noch Notizen passen, und sagt «wie 2025 gebucht».</p>` : ''}` : '';
    return `${p.questions.map(questionCard).join('')}
      ${notesBlock('p:' + p.id, p.notes, p.by, 'Noch keine Notizen.')}
      ${selfBlock(p.rules, p.suggest, 'Keine Regel. Die KI bucht nach den Notizen und den Beispielen; was sie nicht sicher weiss, fragt sie dich.')}
      ${proposalsBlock('p:' + p.id, p.proposals)}
      ${linked(rowsFor(META[p.id].journal), p.kind)}
      ${detailsBlock([['Erkennung', p.match], ['Entschiedene Fälle', p.cases], ['Von der App', APP[p.id] || [], true]], ex)}`;
  };

  // ── Wissen: how the company works ────────────────────────────────────────────────────────────────
  const TOPICS = () => {
    const b = answer('bargeld');
    return [
      { id: 'fahrzeug', title: 'Fahrzeug und Privatanteil', journal: 'Eigenverbrauch', process: 'Buchen › Privatanteil', file: 'booking',
        notes: 'Der Lieferwagen ist ein Firmenwagen: Treibstoff, Service und Parkgebühren gehören der Firma.\n\nIch fahre ihn auch privat. Darum buchen wir jedes Quartal 30 % des Treibstoffs als Privatanteil auf 2451, mit der Vorsteuerkorrektur K81-B.',
        rules: [], cases: mid() || S.later ? ['Privatanteil Q2 2026: 30 % von CHF 259.10 Treibstoff, CHF 77.73 auf 2451, K81-B.'] : [] },
      { id: 'spesen', title: 'Privates, Spesen und Bargeld', process: 'Buchen › Privat', file: 'booking',
        notes: `Konto 2451 «Kontokorrent Gesellschafterin» ist mein Privatkonto in der Firma. Was ich für zu Hause kaufe, Kaffee, Lebensmittel, Haushalt, kommt dorthin, ohne MWST.\n\n${!b || b.kind === 'skip' ? 'Wofür ich Bargeld abhebe, ist noch offen.' : b.kind === 'ask' ? 'Bargeld hebe ich selten ab. Wofür, sagt der Bankauszug nicht, darum fragt die App jedes Mal.' : 'Bargeld, das ich abhebe, ist privat.'}`,
        rules: b && b.kind !== 'skip' ? [{ k: 't:spesen:r', line: QUESTIONS.bargeld.opts.find((o) => o.v === b.kind).know.replace(/ \(Text enthält[^)]*\)/, ''), meta: S.later && b.kind === 'ask' ? `${applied(8)}× gefragt dieses Jahr · Schritt Buchen` : 'deine Antwort bei der Einrichtung · Schritt Buchen' }] : [],
        cases: ['2025 waren 3 private Einkäufe mit Vorsteuer gebucht. So nicht übernommen: auf Privates gibt es keine Vorsteuer.'],
        question: !b || b.kind === 'skip' || answered.has('q:bargeld') ? { qid: 'bargeld', t: QUESTIONS.bargeld.q, m: b ? 'übersprungen bei der Einrichtung' : 'noch nicht gefragt' } : null },
      { id: 'belege', title: 'Belege sammeln', process: 'Belege holen', file: 'receipt-collection',
        notes: 'Belege kommen per Mail an belege@muster-kaffee.ch. Kassenzettel fotografiere ich mit dem Handy und lade sie hoch.\n\nEin Partner, den wir selten haben: die KI schlägt die Buchung von 2025 vor, und ich bestätige. Wiederholt es sich, fragt sie «Immer so?».',
        rules: [], cases: [] },
      { id: 'mwst', title: 'MWST-Abrechnung', journal: 'ESTV', process: 'MWST-Abrechnung', file: 'vat-return',
        notes: 'Wir rechnen effektiv ab, pro Quartal, nach vereinnahmten Entgelten: es zählt das Zahlungsdatum, nicht das Rechnungsdatum.\n\nVor dem Einreichen sammelt die KI, was offen ist, und fragt mich auf einmal. Ein eingereichtes Quartal ändern wir nie; eine Korrektur kommt ins offene Quartal und in die Korrekturabrechnung.',
        rules: [], cases: mid() && S.filed === 2 ? [S.q2fix === 'q2' ? 'Digitec-Rechnung vom 24.06.2026, bezahlt am 02.07.: in Q2 gelassen, die CHF 12.40 zeigt die Korrekturabrechnung Q2.' : 'Digitec-Rechnung vom 24.06.2026, bezahlt am 02.07.: am Zahlungsdatum ins Q3 gebucht, weil nach vereinnahmten Entgelten.'] : [] },
      ...pages.values(),
    ];
  };
  const PROPOSE_TOPIC = { fahrzeug: () => (S.later ? [['Parkgebühren zahle ich mit TWINT; der Beleg ist die TWINT-Quittung.', 'aus 6 Zahlungen in Q3']] : []), belege: () => [['Die Monatsrechnungen von Swisscom und Infomaniak kommen am Monatsende.', 'aus den Belegen 2025']] };
  const topicOf = (t) => {
    const key = 't:' + t.id;
    const notes = notesOf(key, t.notes);
    const rules = [...t.rules, ...(added.get(key) || [])];
    const proposals = (PROPOSE_TOPIC[t.id] ? PROPOSE_TOPIC[t.id]() : []).map(([x, from]) => ({ k: `${key}:p:${x.slice(0, 30)}`, t: x, from })).filter((x) => !gone.has(x.k));
    return { ...t, key, notes, rules, proposals, suggest: suggestionsOf(key, t.title, notes, rules), by: byOf(key, t.fresh ? 'dir, gerade eben' : `der Einrichtung am ${setupDay()}`) };
  };
  const topicView = (t) => `${t.question ? questionCard(t.question) : ''}
    ${notesBlock(t.key, t.notes, t.by, 'Noch nichts geschrieben. Schreib in deinen Worten, wie ihr es haltet; die KI liest es, wenn es passt.')}
    ${selfBlock(t.rules, t.suggest, `Keine Regel. Die KI liest diese Seite, wenn sie im Schritt «${t.process}» entscheidet.`)}
    ${proposalsBlock(t.key, t.proposals)}
    ${rowsFor(t.journal).length ? `<section class="kwsec"><header><h3>Verknüpft</h3><span class="m">Buchungen zu diesem Thema</span></header><div class="kwlinked">${group('Buchungen', rowsFor(t.journal).length, rowsFor(t.journal).map(entryLi), '')}</div></section>` : ''}
    ${detailsBlock([['Schritt', [`${t.process} · <span class="mono">knowledge/company/${t.id}.md</span>, Regeln in <span class="mono">knowledge/rules/${t.file}.guide.yaml</span>`]], ['Entschiedene Fälle', t.cases]])}`;

  // ── Lücken ───────────────────────────────────────────────────────────────────────────────────────
  const gapCard = ({ key, who, step, n, sum, what, propose, opts, partner }) => `<div class="obcase kwgap${answered.has(key) ? ' answered' : ''}"><b>${partner ? `<button type="button" class="linkbtn" data-partner="${partner}">${who}</button>` : who}<span class="m"> · ${step} · ${n}${sum ? ` · CHF ${sum}` : ''}</span></b>
    ${what ? `<div class="why">${what}</div>` : ''}${propose ? `<div class="kwprop"><small>Schliesst die Lücke</small><span>${propose}</span></div>` : ''}
    ${answered.has(key) ? '' : `<div class="obopts">${opts.map((o, i) => opt(key, o.v, o.b, o.s, i === 0)).join('')}</div>`}
    <div class="saved">${chk}<span>${answered.get(key) || ''}</span></div></div>`;
  const G = (key, o) => ({ key, ...o, opts: o.opts.map(([v, b, s, saved]) => ({ key, v, b, s, saved })) });
  const GAPS = () => [
    answer('coop') && answer('coop').kind !== 'rule' && G('gap:coop', { partner: 'coop', who: 'Coop Pronto Musterdorf', step: 'Buchen', n: '12× gefragt', sum: '640.30', what: 'Die App fragt bei jedem Kassenzettel, den sie nicht sicher zuordnet. Deine 12 Antworten: 9× Benzin, alle über CHF 40; 3× Café-Material, alle darunter.', propose: 'Regel: Coop Pronto Musterdorf über CHF 40 → Konto 6200 Fahrzeugaufwand, MWST I81. Darunter fragt die App weiter. Hätte 9 der 12 Zahlungen so gebucht wie du.', opts: [['keep', 'Als Regel behalten', 'Gilt ab der nächsten Zahlung.', 'Regel gespeichert · Quelle: aus 12 Antworten, bestätigt am 20.10.2026'], ['no', 'Weiter jedes Mal fragen', 'Bleibt, wie es ist.', 'Bleibt so. Die Lücke wird nicht mehr vorgeschlagen.']] }),
    answer('digitec') && answer('digitec').kind === 'note' && G('gap:digitec', { partner: 'digitec', who: 'Digitec Galaxus', step: 'Buchen', n: 'nach den Notizen, 5× von der KI gebucht', what: 'In den Notizen steht «Kleines in den Aufwand, Geräte als Anlage». Die App kann das selbst ausführen.', propose: 'Zwei Regeln aus dem Satz: über CHF 1\'000 → Konto 1520 Büromaschinen; sonst → Konto 6570 Informatik, je MWST I81. Alle 5 Buchungen 2026 stimmen damit überein.', opts: [['keep', 'Als Regeln behalten', 'Der Satz bleibt in den Notizen.', 'Zwei Regeln gespeichert.'], ['no', 'Die KI soll weiter lesen', '', 'Bleibt so.']] }),
    G('gap:landi', { who: 'Landi Musterdorf', step: 'Buchen', n: '3 Fälle gleich entschieden', sum: '214.80', what: 'Dreimal hast du Landi gleich entschieden: Konto 4210 Verbrauchsmaterial Gastronomie, MWST I81 (03.07., 14.08., 22.09.2026).', propose: 'Eine Seite für Landi Musterdorf mit diesem Satz in den Notizen und der Regel → 4210, MWST I81.', opts: [['keep', 'Seite und Regel anlegen', '', 'Angelegt · Quelle: aus 3 Fällen, bestätigt am 20.10.2026'], ['no', 'Nicht jetzt', '', 'Wird beim vierten gleichen Fall wieder vorgeschlagen.']] }),
    kept('swisscom') && G('gap:swisscom', { partner: 'swisscom', who: 'Swisscom (Schweiz) AG', step: 'Buchen', n: 'Regel widerspricht deinem Entscheid', sum: '119.00', what: 'Die Regel bucht Swisscom auf 6510. Am 02.10.2026 hast du die Rechnung zur Hälfte privat gebucht: das Handy-Abo nutzt du auch privat.', propose: 'Regel ändern: Konto 6510, MWST I81, 50 % privat auf 2451 ohne MWST, und den Satz in die Notizen.', opts: [['keep', 'Regel so ändern', '', 'Regel geändert. Gilt ab der nächsten Rechnung; was gebucht ist, bleibt.'], ['no', 'War eine Ausnahme', '', 'Gespeichert als Fall vom 02.10.2026. Die Regel bleibt.']] }),
    kept('liegenschaften') && G('gap:liegenschaften', { partner: 'liegenschaften', who: 'Liegenschaften Muster', step: 'Belege zuordnen', n: 'Regel trifft nicht mehr', sum: '2\'400.00', what: 'Seit Oktober kommt die Miete von einer neuen Verwaltung, «Immo Verwaltung Muster». Die Regel erkennt sie nicht, die KI hat die Oktobermiete aus dem Beispiel gebucht.', propose: 'Erkennung ergänzen: Zahlungstext enthält auch «Immo Verwaltung Muster».', opts: [['keep', 'Erkennung ergänzen', '', 'Gespeichert. Die Regel trifft die Oktobermiete wieder.'], ['no', 'Neuer Partner', '', 'Die App legt eine eigene Seite an und fragt nach Konto und MWST.']] }),
  ].filter(Boolean);
  const PRE = [
    ['Grafik Atelier Wien', 'atelier', 'Rechnung 14.08.2026 ohne Schweizer MWST: Bezugsteuer B81-1?', ['B81-1 buchen', 'Wie bei den Fällen 2025'], ['Hat Schweizer MWST', 'Ich lege den Beleg nach']],
    ['Muster Hotel GmbH', 'hotel', 'Rechnung 2026-007 mit CHF 20.00 weniger bezahlt: Skonto oder noch offen?', ['Skonto', 'Als Erlösminderung'], ['Noch offen', 'Die Rechnung bleibt offen']],
    ['Coop Pronto Musterdorf', 'coop', '2 Kassenzettel mit Café-Material und Benzin auf einem Zettel: aufteilen?', ['Aufteilen', 'Je Zeile ein Konto'], ['Alles Benzin', 'Auf 6200']],
    ['AliExpress', 'aliexpress', '2 Zahlungen ohne Beleg mit Schweizer MWST: ohne Vorsteuer (I0) buchen?', ['Ja, I0', 'Wie der Fall von der Einrichtung'], ['Ich suche die Tax Invoice', 'Die App wartet']],
  ].map(([who, partner, ask, a, b], i) => G('pre:' + i, { who, partner, ask, opts: [['a', a[0], a[1], `${who}: ${a[0]} · gespeichert als Fall, deine Antwort vom 20.10.2026`], ['b', b[0], b[1], `${who}: ${b[0]} · gespeichert als Fall, deine Antwort vom 20.10.2026`]] }));
  const RARE_N = 98;
  const firstDayGaps = () => {
    const out = [];
    for (const m of MIXED) {
      const a = answer(m.id);
      if (a && a.kind !== 'skip' && !answered.has('q:' + m.id)) continue;
      out.push(questionCard({ qid: m.id, t: `${m.name}: ${QUESTIONS[m.id].q}`, m: `Buchen · ${m.n} Zahlungen 2025 · bei der Einrichtung übersprungen; ohne Antwort fragt die App bei jeder Zahlung` }));
    }
    for (const c of CLEAR) {
      const key = 'keep:' + c.id;
      if (kept(c.id) && !answered.has(key)) continue;
      out.push(gapCard({ key, partner: c.id, who: c.name, step: 'Buchen', n: `${c.n} Zahlungen 2025`, what: 'Bei der Einrichtung keine Regel. Die KI schlägt jedes Mal die Buchung von 2025 vor, und du bestätigst.', propose: `Regel: ${c.name} → Konto ${c.acc}, ${vatText(c.vat)}. ${c.n} von ${c.n} Zahlungen 2025 so gebucht.`, opts: [{ v: 'yes', b: 'Doch als Regel behalten', s: 'Gilt ab der nächsten Zahlung.' }, { v: 'no', b: 'So lassen', s: '' }] }));
    }
    return out;
  };
  const gapCount = () => (S.later ? GAPS().filter((g) => !answered.has(g.key)).length + (PRE.some((g) => !answered.has(g.key)) ? 1 : 0) : !S.learned ? 0 : MIXED.filter((m) => { const a = answer(m.id); return !a || a.kind === 'skip'; }).length + CLEAR.filter((c) => !kept(c.id)).length);
  const lueckenFirstDay = () => {
    const all = [...CLEAR.map((c) => [c.n, kept(c.id) ? 'rule' : 'propose']), ...MIXED.map((m) => { const a = answer(m.id); return [m.n, !a || a.kind === 'skip' ? 'propose' : a.kind]; }), ...FLAGS.map((f) => [f.n, 'case']), [RARE_N, 'propose']];
    const sum = (k) => all.filter(([, x]) => k.includes(x)).reduce((s, [n]) => s + n, 0);
    const total = sum(['rule', 'note', 'ask', 'propose', 'case']);
    const gaps = firstDayGaps();
    return `<p class="lead">Gemessen wird ab der ersten Zahlung am ${mid() ? '1. Juli' : '1. Januar'} 2026. Bis dahin rechne ich mit den Zahlungen 2025 nach, wie weit dein Wissen reicht.</p>
    <div class="obstats"><div class="obstat"><b>${Math.round((100 * sum(['rule', 'note', 'case'])) / total)} %</b><span>der Zahlungen an Geschäftspartner 2025 hätte die App selbst gebucht</span></div><div class="obstat"><b>${sum(['ask'])}</b><span>mit einer Frage an dich, wie du es wolltest</span></div><div class="obstat"><b>${sum(['propose'])}</b><span>mit einem Vorschlag, den du bestätigst</span></div><div class="obstat"><b>${gapCount()}</b><span>Lücken aus der Einrichtung</span></div></div>
    <section><h3>Buchen, mit den Zahlungen 2025 nachgerechnet</h3><table class="obmap obz kwsteps"><tbody>
      <tr class="obzh"><td></td><td class="num m">Zahlungen</td><td class="m">woher</td></tr>
      <tr><td>Eine Regel bucht</td><td class="num">${sum(['rule'])}</td><td class="m">${S.kept} Partner aus Buchungen 2025${S.ruleAnswers ? ` und ${S.ruleAnswers} aus deinen Antworten` : ''}</td></tr>
      <tr><td>Die KI bucht nach den Notizen</td><td class="num">${sum(['note', 'case'])}</td><td class="m">Partner, deren Notizen sagen, wie es geht</td></tr>
      <tr><td>Die App fragt dich</td><td class="num">${sum(['ask'])}</td><td class="m">Regeln, die fragen</td></tr>
      <tr><td>Vorschlag, du bestätigst</td><td class="num">${sum(['propose'])}</td><td class="m">75 seltene Partner, Übersprungenes und Partner ohne Regel</td></tr>
    </tbody></table><p class="m">Belege zuordnen, Import und MWST-Abrechnung zählen ab der ersten Zahlung.</p></section>
    <section><h3>Lücken aus der Einrichtung</h3>${gaps.join('') || '<p class="m">Keine. Was du übersprungen oder nicht behalten hast, stünde hier, mit dem einen Schritt, der es schliesst.</p>'}</section>
    <section><h3>Vor der MWST-Abrechnung ${mid() ? 'Q3' : 'Q1'} 2026</h3><p class="m">Vor dem Einreichen prüft die KI das Quartal gegen dein Wissen: jede Buchung, für die weder eine Regel noch die Notizen sagen, wie es geht, jeder Beleg ohne gültige MWST. Was offen ist, kommt dann hier auf einmal. Noch ist nichts gebucht.</p></section>`;
  };
  const stepRow = (s, auto, you, why) => `<tr><td>${s}</td><td class="num">${auto}</td><td class="num">${you}</td><td class="m">${why}</td></tr>`;
  const lueckenLater = () => {
    const gaps = GAPS();
    const pre = preOpen
      ? PRE.map((g) => gapCard({ key: g.key, partner: g.partner, who: g.who, step: 'vor der Abrechnung', n: g.ask, opts: g.opts })).join('')
      : `<table class="obmap kwpre"><tbody>${PRE.map((g) => `<tr class="ask"><td>${g.who}</td><td class="m">${g.ask}</td></tr>`).join('')}</tbody></table><div class="obacts"><button type="button" class="btn primary" data-pre>4 Fragen beantworten</button><span class="m">Jede Antwort kommt in die Notizen des Partners oder wird ein Fall, mit Datum.</span></div>`;
    return `<p class="lead">Wo die App in Q3 nicht allein weiterkam, je Schritt und je Geschäftspartner, das meiste Eingreifen zuerst. Jede Lücke steht mit dem einen Schritt, der sie schliesst. Neues Wissen gilt erst, wenn du es behältst.</p>
    <div class="obstats"><div class="obstat"><b>100 %</b><span>Kontoauszüge Q3 ohne dich importiert</span></div><div class="obstat"><b>94 %</b><span>Belege selbst zugeordnet (212 von 226)</span></div><div class="obstat"><b>87 %</b><span>Zahlungen selbst gebucht (197 von 226)</span></div><div class="obstat"><b>${gaps.length}</b><span>Wissenslücken in Q3</span></div></div>
    <section><h3>Q3 2026 je Schritt</h3><table class="obmap obz kwsteps"><tbody>
      <tr class="obzh"><td></td><td class="num m">von selbst</td><td class="num m">mit dir</td><td class="m">häufigster Grund</td></tr>
      ${stepRow('Import', '3 Auszüge', '0', '')}${stepRow('Belege zuordnen', '212', '14', 'Vistaprint: Rechnung nur im Kundenkonto (4×)')}${stepRow('Buchen', '197', '29', 'Coop Pronto: Café-Material oder Benzin? (12×)')}${stepRow('MWST-Abrechnung', 'bereit', '4 Fragen', 'vor der Abrechnung, siehe unten')}
    </tbody></table><p class="m">Q3 2026, Stand 20.10.2026.</p></section>
    <section><h3>Lücken, nach Aufwand</h3>${gaps.map(gapCard).join('')}</section>
    <section><h3>Vor der MWST-Abrechnung Q3</h3><p class="m">Vor dem Einreichen prüft die KI das Quartal gegen das Wissen. Was offen ist, kommt hier auf einmal, nicht verteilt über das Quartal.</p>${pre}</section>`;
  };
  const appView = () => {
    const names = Object.fromEntries(partners().map((p) => [p.id, p.name]));
    const line = (t, m) => `<div class="kwi app"><div class="kwt"><b>${t}</b><span class="m">${m}</span></div>${pillApp}</div>`;
    const rows = Object.entries(APP).map(([id, xs]) => xs.map((t) => line(t, names[id] ? `<button type="button" class="linkbtn" data-partner="${id}">${names[id]}</button>` : id)).join('')).join('');
    const law = ['Vorsteuer nur mit einem Beleg, der Schweizer MWST ausweist. Ohne Beleg: I0, M0 oder V0.', 'Eine Dienstleistung aus dem Ausland ohne Schweizer MWST: Bezugsteuer B81-1, geschuldet und im selben Zug abgezogen.', 'Auf Privates gibt es keine Vorsteuer.', 'Ein bei der ESTV eingereichtes Quartal bleibt, wie es eingereicht ist. Korrekturen kommen ins offene Quartal und in die Korrekturabrechnung.'].map((t) => line(t, 'gilt für jede Firma')).join('');
    return `<p class="lead">Was die App über bekannte Geschäftspartner, Behörden und das Gesetz mitbringt. Es gilt für jede Firma, steht grau in den Details der Partnerseite und lässt sich hier nicht ändern. Was in deinen Notizen steht, gilt davor.</p>
    <section class="kwsec"><header><h3>Geschäftspartner und Behörden</h3><span class="m">die die App kennt</span></header><div class="kwlist">${rows}</div></section>
    <section class="kwsec"><header><h3>Für jede Firma</h3><span class="m">aus dem Gesetz und den Regeln der App</span></header><div class="kwlist">${law}</div></section>`;
  };

  // ── Answers and edits ────────────────────────────────────────────────────────────────────────────
  const onAnswer = (key, v) => {
    const [kind, id] = key.split(':');
    if (kind === 'q' && QUESTIONS[id]) {
      const a = answer(id); if (a) a.kind = v; else S.answers.push({ id, kind: v });
      S.skipped = S.skipped.filter((n) => n !== MIXED.find((m) => m.id === id).name);
      if (v === 'note') S.notes++; else S.ruleAnswers++;
      answered.set(key, v === 'note' ? 'Steht jetzt in den Notizen · deine Antwort vom 20.10.2026' : 'Regel gespeichert · deine Antwort vom 20.10.2026');
    } else if (kind === 'q') answered.set(key, QOPTS[id].find(([x]) => x === v)[3]);
    else if (kind === 'keep') {
      const c = CLEAR.find((x) => x.id === id);
      if (v === 'yes' && !kept(id)) { S.keptList.push(c); S.kept++; }
      answered.set(key, v === 'yes' ? `Regel gespeichert: ${c.name} → ${c.acc}, ${vatText(c.vat)} · Quelle: Buchungen 2025, von dir bestätigt` : 'Bleibt so. Die KI schlägt weiter die Buchung von 2025 vor.');
    } else answered.set(key, GAPS().concat(PRE).flatMap((g) => g.opts).find((o) => o.key === key && o.v === v).saved);
    refresh();
  };
  const pageText = (key) => {
    const [kind, id] = key.split(':');
    return kind === 'p' ? partners().find((x) => x.id === id).notes : topicOf(TOPICS().find((t) => t.id === id)).notes;
  };
  const toast = (text) => { const el = q('.toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); };
  const onClick = (e, area) => {
    const hit = (s) => e.target.closest(s);
    let x;
    if ((x = hit('[data-kind]'))) { st[area].filter = x.dataset.kind; return render(area); }
    if ((x = hit('[data-edit]'))) { editing.add(x.dataset.edit); render(area); const ta = q('textarea[data-notes]', els[area]); if (ta) ta.focus(); return; }
    if ((x = hit('[data-cancel]'))) { editing.delete(x.dataset.cancel); return render(area); }
    if ((x = hit('[data-save]'))) { const k = x.dataset.save; edits.set(k, { text: q(`textarea[data-notes="${k}"]`, els[area]).value, by: `Anna Muster am ${TODAY}` }); editing.delete(k); return refresh(); }
    if ((x = hit('[data-merge]'))) {
      const k = x.dataset.page, sentence = x.closest('li').querySelector('b').textContent;
      edits.set(k, { text: `${pageText(k)}\n\n${sentence}`, by: `Anna Muster am ${TODAY}, aus einem Vorschlag der KI` });
      gone.add(x.dataset.merge); return refresh();
    }
    if ((x = hit('[data-drop]'))) { gone.add(x.dataset.drop); return refresh(); }
    if ((x = hit('[data-keep]'))) {
      const k = x.dataset.keep, page = k.split(':s:')[0], line = x.closest('.kwsugg').querySelector('b').textContent;
      added.set(page, [...(added.get(page) || []), { k: k + ':r', acc: k.split(':s:')[1], priv: k.endsWith(':priv'), line, meta: `aus deinen Notizen, ${TODAY} · noch nie angewendet` }]);
      gone.add(k); return refresh();
    }
    if ((x = hit('[data-off]'))) { const k = x.dataset.off; if (off.has(k)) off.delete(k); else off.add(k); return render(area); }
    if ((x = hit('[data-ans]'))) return onAnswer(x.dataset.ans, x.dataset.v);
    if (hit('[data-pre]')) { preOpen = true; return render(area); }
    if ((x = hit('[data-partner]'))) return show('partners', 'p:' + x.dataset.partner);
    if ((x = hit('a[data-journal]'))) { e.preventDefault(); return show('journal', x.dataset.journal); }
    if ((x = hit('a[data-elsewhere]'))) { e.preventDefault(); return toast(`${x.dataset.elsewhere} ist im Prototyp nicht nachgebaut. Der Link führt in der App zu ${x.getAttribute('href')}.`); }
    if (hit('[data-newpage]')) {
      const id = 'neu' + (pages.size + 1);
      pages.set(id, { id, title: ['Homeoffice', 'Personal und Lohn', 'Projekte'][pages.size % 3], notes: '', rules: [], cases: [], process: 'Buchen', file: 'booking', fresh: true });
      editing.add('t:' + id); st[area].sel = 't:' + id; return render(area);
    }
    if ((x = hit('[data-sel]'))) { st[area].sel = x.dataset.sel; render(area); q('section.detail', els[area]).scrollTop = 0; }
  };

  // ── The two areas: a list and a detail ───────────────────────────────────────────────────────────
  const els = {};
  const st = { partners: { sel: null, filter: 'all', query: '' }, knowledge: { sel: null } };
  const row = (area, k, inner, cls = '') => `<div class="row ${cls}${st[area].sel === k ? ' sel' : ''}" role="option" aria-selected="${st[area].sel === k}" tabindex="${st[area].sel === k ? 0 : -1}" data-sel="${k}">${inner}</div>`;
  const passes = (p) => {
    const { filter, query } = st.partners;
    return (filter === 'all' || (filter === 'open' ? p.open > 0 : p.kind === filter)) && (!query || p.name.toLowerCase().includes(query.toLowerCase()));
  };
  const rare = () => (S.learned ? '<p class="m kwrare">Dazu 75 seltene Partner, nur mit Beispielen aus 2025. Kommt einer wieder, bekommt er eine eigene Seite.</p>' : '');
  const partnerRows = (ps) => ps.filter(passes).map((p) => {
    const nb = rowsFor(META[p.id].journal).length;
    const chips = [p.notes ? '<span class="kwk">Notizen</span>' : '', p.rules.length ? `<span class="kwk">Regel <b class="mono">${p.rules.length}</b></span>` : '', nb ? `<span class="kwk">Buchungen <b class="mono">${nb}</b></span>` : '', p.n ? `<span class="kwk">Beispiele <b class="mono">${p.n}</b></span>` : '', APP[p.id] ? '<span class="kwk app">App</span>' : ''].join('');
    return row('partners', 'p:' + p.id, `<span class="t">${p.name}<small> ${p.role}</small></span><span class="a">${p.open ? `<span class="kwop">${p.open} offen</span>` : ''}</span><span class="kwks">${chips}</span>`, 'kwrow');
  }).join('') || `<p class="m kwnone">${S.learned ? 'Kein Partner mit diesem Filter.' : 'Noch keine. Sie kommen aus den Buchungen 2025, sobald die Einrichtung sie gelesen hat.'}</p>`;

  const render = (area) => {
    const el = els[area]; if (!el) return;
    const s = st[area];
    let title, small, body;
    if (area === 'partners') {
      const ps = partners();
      const vis = ps.filter(passes);
      if (!s.sel || !ps.some((p) => 'p:' + p.id === s.sel)) s.sel = vis[0] ? 'p:' + vis[0].id : null;
      const n = (f) => ps.filter((p) => f === 'all' || (f === 'open' ? p.open : p.kind === f)).length;
      q('section.list', el).innerHTML = `<h1>Geschäftspartner</h1>
        <div class="counts" role="tablist" aria-label="Filter">${KINDS.map(([f, l]) => `<button type="button" role="tab" aria-selected="${s.filter === f}" class="${s.filter === f ? 'on' : ''}" data-kind="${f}"><span class="n">${n(f)}</span>${l}</button>`).join('')}</div>
        <label class="kwsearch"><span class="sr">Geschäftspartner suchen</span><input type="search" placeholder="Partner suchen" autocomplete="off" value="${s.query}"></label>
        <div class="rows" role="listbox" aria-label="Geschäftspartner">${partnerRows(ps)}${rare()}</div>`;
      const p = ps.find((x) => 'p:' + x.id === s.sel);
      if (!p) { q('section.detail', el).innerHTML = '<div class="detail-empty"><div>Noch keine Geschäftspartner.</div></div>'; return; }
      [title, small, body] = [p.name, p.role + (p.n ? ` · ${p.n} Zahlungen 2025` : ''), partnerView(p)];
    } else {
      const ts = S.learned ? TOPICS().map(topicOf) : [];
      if (!s.sel || (s.sel.startsWith('t:') && !ts.some((t) => t.key === s.sel))) s.sel = 'gaps';
      const gc = gapCount();
      q('section.list', el).innerHTML = `<h1>Wissen</h1><div class="counts"><span>So arbeitet Muster Kaffee GmbH</span></div>
        <div class="rows" role="listbox" aria-label="Wissen">
          ${row(area, 'gaps', `<span class="t">Lücken</span>${gc ? `<span class="a mono kwwarn">${gc} offen</span>` : '<span class="a mono">keine</span>'}`, 'fset kwfix')}
          ${row(area, 'app', '<span class="t">Von der App</span><span class="a mono">nur lesen</span>', 'fset kwfix')}
          <div class="group"><span>Arbeitsweise</span><span>${ts.length || ''}</span></div>
          ${ts.map((t) => row(area, t.key, `<span class="t">${t.title}</span><span class="a mono">${[t.rules.length ? `${t.rules.length} Regel` : '', t.proposals.length + t.suggest.length ? `${t.proposals.length + t.suggest.length} offen` : ''].filter(Boolean).join(' · ')}</span>`, 'fset')).join('') || '<p class="m kwnone">Noch keine Seiten. Die Einrichtung schreibt die ersten aus deinen Antworten.</p>'}
          ${S.learned ? '<p class="kwnew"><button type="button" class="btn ghost" data-newpage>Neue Seite</button></p>' : ''}
        </div>`;
      const t = ts.find((x) => x.key === s.sel);
      [title, small, body] = s.sel === 'gaps' ? ['Lücken', S.later ? 'wo du in Q3 eingreifen musstest' : 'wo die App nicht allein weiterkäme', S.later ? lueckenLater() : lueckenFirstDay()]
        : s.sel === 'app' ? ['Von der App', 'gilt für jede Firma, nicht änderbar', appView()]
          : [t.title, `Arbeitsweise · Schritt ${t.process}`, topicView(t)];
    }
    q('section.detail', el).innerHTML = `<div class="detail-in"><div class="head"><h2 class="who">${title}<small>${small}</small></h2></div><div class="docbody">${body}</div></div>`;
  };

  const mount = (area) => {
    const el = els[area] = document.createElement('main');
    el.className = 'kw';
    el.dataset.area = area;
    el.dataset.phone = 'list';
    el.innerHTML = `<section class="list" id="list" aria-label="${area === 'partners' ? 'Geschäftspartner' : 'Wissen'}"></section><section class="detail" aria-live="polite"></section>`;
    el.addEventListener('click', (e) => onClick(e, area));
    el.addEventListener('input', (e) => {
      if (!e.target.closest('.kwsearch')) return;
      st.partners.query = e.target.value;
      q('.rows', el).innerHTML = partnerRows(partners()) + rare();
    });
    render(area);
    return el;
  };

  // The dock icons fill once the company knows something; they never count or nag.
  const refresh = () => {
    for (const href of ['/partners', '/knowledge']) {
      const a = document.querySelector(`.activity a[href="${href}"]`);
      if (a && S.learned && !a.classList.contains('kwfill')) { a.classList.add('kwfill', 'kwflash'); setTimeout(() => a.classList.remove('kwflash'), 1600); }
    }
    render('partners'); render('knowledge');
  };

  return {
    main: (area) => els[area] || mount(area),
    select: (area, k) => { if (k) st[area].sel = k; render(area); },
    refresh,
    idOfName: (name) => Object.keys(META).find((id) => META[id].journal === name) || null,
  };
})();
