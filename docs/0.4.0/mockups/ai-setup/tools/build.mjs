// Builds the AI-setup mockups from captures of the real app (tools/capture.mjs: demo workspace,
// read-only). The app's DOM and CSS stay as rendered; only the new parts are written in by hand.
// Run from the repo root: node docs/0.4.0/mockups/ai-setup/tools/build.mjs
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.resolve(here, '..');
const caps = path.resolve(here, '../../../../../.verify/ai-setup');
const read = (name) => fs.readFileSync(path.join(caps, `cap-${name}.html`), 'utf8');

// One stylesheet: every capture carries the same app CSS.
const first = read('start');
fs.writeFileSync(path.join(out, 'app.css'), first.slice(first.lastIndexOf('<style>') + 7, first.lastIndexOf('</style>')));

const bodyOf = (html) => html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
  .replace(/<div role="status" data-testid="audit-bar" class="auditbar">.*?<\/div>/, '');
const htmlAttrs = (html) => html.match(/<html([^>]*)>/)[1];
const BODY = { start: bodyOf(first), setup: bodyOf(read('setup')), company: bodyOf(read('company-ai')), journal: bodyOf(read('journal-ai')) };
const ATTRS = { start: htmlAttrs(first), setup: htmlAttrs(read('setup')), company: htmlAttrs(read('company-ai')), journal: htmlAttrs(read('journal-ai')) };

/** Replaces exactly one occurrence, so a changed capture fails loudly instead of building a wrong page. */
function swap(s, from, to) {
  const at = s.indexOf(from);
  if (at < 0 || s.indexOf(from, at + 1) >= 0) throw new Error(`not exactly once: ${from.slice(0, 80)}`);
  return s.slice(0, at) + to + s.slice(at + from.length);
}
/** Replaces from the first `start` to the end of the first `end` after it. */
function cut(s, start, end, to) {
  const a = s.indexOf(start);
  const b = s.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`cut: ${start.slice(0, 60)}`);
  return s.slice(0, a) + to + s.slice(b + end.length);
}

function page(file, kind, body, title) {
  const html = `<!doctype html>
<html${ATTRS[kind]}><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=Instrument+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="ai-setup.css">
<script>try { var t = new URLSearchParams(location.search).get('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}</script>
</head>
<body>${body}</body></html>
`;
  fs.writeFileSync(path.join(out, file), html);
  console.log(file, html.length);
}

// ---------- icons (the app's own stroke icons) ----------
const svg = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const BOT = svg('<path d="M12 8V4H8"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M2 14h2M20 14h2M15 13v2M9 13v2"></path>', 'i bot');
const TERM = svg('<rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="m7.5 9.5 3 2.5-3 2.5M13 15h4"></path>');
const CHECK = svg('<path d="m5 12 5 5 9-10"></path>');
const WARN = svg('<path d="M12 3 2 20h20z"></path><path d="M12 10v4M12 17v.5"></path>');
const OUT = svg('<path d="M14 4h6v6M20 4l-9 9"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>');
const SPIN = '<span class="aispin" aria-hidden="true"></span>';

// ---------- the facts every state shares ----------
const CLI = {
  claude: {
    name: 'Claude Code', vendor: 'Anthropic', plan: 'Claude Pro', plans: 'https://claude.com/pricing', guide: 'https://code.claude.com/docs/en/setup',
    native: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: 'claude auth login', status: 'claude auth status', version: '2.1.211', bin: '~/.local/bin/claude', account: 'Claude-Konto', site: 'claude.ai',
  },
  codex: {
    name: 'Codex', vendor: 'OpenAI', plan: 'ChatGPT Plus', plans: 'https://chatgpt.com/pricing', guide: 'https://developers.openai.com/codex/cli',
    native: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    login: 'codex login', status: 'codex login status', version: '0.164.0', bin: '~/.local/bin/codex', account: 'ChatGPT-Konto', site: 'chatgpt.com',
  },
};
const planLine = (c) => `Mit ${c.plan} oder höher, etwa 20 USD im Monat. <a class="linkbtn" href="${c.plans}" target="_blank" rel="noopener">Abos bei ${c.vendor} ${OUT}</a>`;
const cmd = (text) => `<div class="aicmd"><code>${text}</code><button type="button" class="linkbtn">Kopieren</button></div>`;

/**
 * One CLI as the setup shows it. state: missing | installing | signedOut | signingIn | ready | planTooSmall | timeout | optional
 */
function cliCard(id, state, { compact = false, extra = '', actions = true } = {}) {
  const c = CLI[id];
  const pill = {
    missing: ['nicht installiert', ''], optional: ['nicht installiert', ''], installing: [`${SPIN}wird installiert`, 'now'],
    signedOut: ['installiert · nicht angemeldet', 'now'], signingIn: [`${SPIN}Anmeldung läuft`, 'now'],
    ready: [`${CHECK}bereit`, 'ok'], planTooSmall: [`${WARN}Abo reicht nicht`, 'warn'], timeout: [`${WARN}nicht gefunden`, 'warn'],
  }[state];
  let body = '';
  if (state === 'missing') {
    body = `<p class="m">Der offizielle Installer von ${c.vendor}.</p>
      ${cmd(c.native)}
      <span class="ruleacts"><button type="button" class="btn ${id === 'claude' ? 'primary' : ''}">${TERM}Im Terminal installieren</button><a class="linkbtn" href="${c.guide}" target="_blank" rel="noopener">Anleitung von ${c.vendor} ${OUT}</a></span>
`;
  } else if (state === 'optional') {
    body = `<p class="m">Ein zweites Programm brauchst du nicht. Mit beiden kann die App das andere fragen, wenn eins nicht antwortet.</p>
      <span class="ruleacts"><button type="button" class="btn">${TERM}Im Terminal installieren</button></span>`;
  } else if (state === 'installing') {
    body = `<p class="m">Das Terminal ist offen, mit dem Befehl von ${c.vendor}. Drück dort Enter.</p>
      ${cmd(c.native)}
      <p class="aiwait">${SPIN}Warte auf ${c.name}. Die App schaut alle 2 Sekunden nach, ein Neustart ist nicht nötig.</p>
      <span class="ruleacts"><button type="button" class="btn ghost">Terminal wieder zeigen</button><button type="button" class="linkbtn">Abbrechen</button></span>`;
  } else if (state === 'signedOut') {
    body = `<dl class="aifacts"><dt>Version</dt><dd class="mono">${c.version}</dd><dt>Ort</dt><dd class="mono">${c.bin}</dd></dl>
      <p class="m">Jetzt anmelden, mit deinem ${c.account}. Das geht im Browser bei ${c.site}; die App sieht dein Passwort und dein Login nie.</p>
      <span class="ruleacts"><button type="button" class="btn ${id === 'claude' ? 'primary' : ''}">${TERM}Im Terminal anmelden</button></span>
      <small class="m">Öffnet das Terminal mit <code>${c.login}</code>.</small>`;
  } else if (state === 'signingIn') {
    body = `<p class="m">Im Browser ist ${c.site} offen. Melde dich dort an und komm zurück.</p>
      <p class="aiwait">${SPIN}Warte auf die Anmeldung. Die App fragt <code>${c.status}</code>, mehr nicht.</p>
      <span class="ruleacts"><button type="button" class="btn ghost">Terminal wieder zeigen</button><button type="button" class="linkbtn">Abbrechen</button></span>`;
  } else if (state === 'ready') {
    body = `<dl class="aifacts"><dt>Angemeldet</dt><dd>${id === 'claude' ? 'Claude Pro' : 'mit ChatGPT'}</dd><dt>Version</dt><dd class="mono">${c.version}</dd><dt>Probelauf</dt><dd>hat geantwortet, 1.4 s</dd></dl>`;
  } else if (state === 'planTooSmall') {
    body = `<p class="warnline">${WARN}Angemeldet mit einem ${c.account} ohne ${c.name} (Free). ${c.name} gibt es ab ${c.plan}, etwa 20 USD im Monat.</p>
      <span class="ruleacts"><a class="btn ghost" href="${c.plans}" target="_blank" rel="noopener">Abos bei ${c.vendor} ${OUT}</a><button type="button" class="btn ghost">${TERM}Mit anderem Konto anmelden</button><button type="button" class="linkbtn">Nochmals prüfen</button></span>`;
  } else if (state === 'timeout') {
    body = `<p class="warnline">${WARN}Seit 15 Minuten kein ${c.name} gefunden.</p>
      <p class="m">Gesucht in <code>~/.local/bin</code> und im PATH deiner Shell. Zeigt das Terminal einen Fehler, hilft die Anleitung von ${c.vendor} weiter.</p>
      <span class="ruleacts"><button type="button" class="btn ghost">Nochmals prüfen</button><button type="button" class="btn ghost">${TERM}Terminal wieder öffnen</button><a class="linkbtn" href="${c.guide}" target="_blank" rel="noopener">Anleitung von ${c.vendor} ${OUT}</a></span>`;
  }
  // In the conversation the answers below the card are the buttons; the card only states.
  if (!actions) body = body.replace(/<span class="ruleacts">.*?<\/span>\s*/gs, '');
  return `<div class="aicli${compact ? ' compact' : ''}" data-cli="${id}" data-state="${state}">
    <div class="aiclihd"><b>${c.name}</b><span class="aivendor">von ${c.vendor}</span><span class="aipill ${pill[1]}">${pill[0]}</span></div>
    ${state === 'ready' ? '' : `<p class="aiplan">${planLine(c)}</p>`}
    ${body}${extra}
  </div>`;
}


/** A Terminal window over the app: the official command, waiting for Enter. */
function terminal(lines, title = 'Terminal · zsh') {
  return `<div class="termwin" aria-label="Terminal (macOS)"><div class="termbar"><i></i><i></i><i></i><span>${title}</span></div><pre>${lines}</pre></div>`;
}
const TERM_INSTALL = (c) => terminal(`<span class="tdim">Vanilla Accounting installiert ${c.name} mit dem Befehl von ${c.vendor}:</span>

  <b>${c.native}</b>

<span class="tdim">Enter: starten · Ctrl-C: abbrechen</span>
<span class="tcur"> </span>`);
const TERM_LOGIN = (c) => terminal(`<span class="tdim">~</span> ${c.login}
Opening browser to sign in…
<span class="tdim">Browser did not open? Press c to copy the URL.</span>
<span class="tcur"> </span>`);

// ---------- Erweitert: mit API-Schlüssel (the advanced path) ----------
const KEYS = {
  anthropic: { name: 'Anthropic', page: 'https://platform.claude.com/settings/keys', model: 'Claude Haiku' },
  openai: { name: 'OpenAI', page: 'https://platform.openai.com/api-keys', model: 'GPT-6 Luna' },
};
const KEY_COST = 'Der Anbieter rechnet jeden Aufruf ab, auf deine Rechnung; wie viel, hängt davon ab, wie viele Belege die App liest. Empfohlen bleibt ein Abo: Claude Pro oder ChatGPT Plus, etwa 20 USD im Monat, ohne Rechnung pro Aufruf.';
const KEY_LIMITS = '<p class="aiadvno"><b>Ohne Claude Code oder Codex geht nicht:</b> die KI-Spalte (sie braucht Claude Code) und «Im Terminal» (braucht eins der beiden Programme). Alles andere geht mit dem Schlüssel: Belege lesen, MWST auf dem Beleg, Beleg zur Zahlung, buchen, aus Korrekturen lernen, die Einrichtung im Gespräch.</p>';
const MASKED = 'sk-ant-api03-••••••••••••••••••••••••••••••••';

/**
 * The folded block under the subscription cards. state: folded | open | checked | refused.
 * The check is the app's own (keyed.ts check: the provider's model list, which costs nothing);
 * the test call after it is the one of decision 2.
 */
function keyBlock(state, { provider = 'anthropic' } = {}) {
  const k = KEYS[provider];
  const seg = `<span class="seg2" role="radiogroup" aria-label="Anbieter">${Object.entries(KEYS).map(([id, x]) => `<button type="button" role="radio" aria-checked="${id === provider}" class="${id === provider ? 'on' : ''}">${x.name}</button>`).join('')}</span>`;
  const field = state === 'checked'
    ? `<p class="okline">${CHECK}${k.name} hat den Schlüssel angenommen; er liegt im Schlüsselbund dieses Macs. Ein Probelauf mit ${k.model} hat geantwortet.</p>
       <span class="aikey"><span class="mono">${MASKED}</span><button type="button" class="btn ghost">Entfernen</button></span>`
    : `<form class="aikey${state === 'refused' ? ' bad' : ''}"><input type="password" autocomplete="off" placeholder="API-Schlüssel von ${k.name} einfügen" value="${state === 'refused' ? MASKED : ''}"><button type="button" class="btn${state === 'open' ? '' : ' primary'}" ${state === 'open' ? 'disabled' : ''}>Prüfen und speichern</button></form>
       ${state === 'refused' ? `<p class="warnline">${WARN}Der Anbieter lehnt diesen Schlüssel ab: nichts gespeichert.</p>` : ''}`;
  return `<details class="aiadv"${state === 'folded' ? '' : ' open'}><summary>Erweitert: mit API-Schlüssel</summary><div class="aiadvin">
    <p class="m">Statt eines Abos geht auch ein API-Schlüssel von Anthropic oder OpenAI. ${KEY_COST}</p>
    ${seg}
    ${field}
    <small class="m">Der Schlüssel liegt im Schlüsselbund dieses Macs, nie in der Buchhaltung. <a class="linkbtn" href="${k.page}" target="_blank" rel="noopener">Schlüssel bei ${k.name} erstellen ${OUT}</a></small>
    ${KEY_LIMITS}
  </div></details>`;
}

// ================= Design A: «KI einrichten» before the start screen =================
const START_MAIN = BODY.start.slice(BODY.start.indexOf('<div class="st-main">'), BODY.start.lastIndexOf('</div></div></div>'));

function designA(file, title, { claude, codex, ready = false, overlay = '', note = '' }) {
  const main = `<div class="st-main aisetup">
    <ol class="aisteps2"><li class="now">KI</li><li>Buchhaltung</li></ol>
    <h1>KI einrichten</h1>
    <p class="st-sub">Vanilla Accounting liest Belege und schlägt Buchungen vor. Dafür fragt es ein KI-Programm auf deinem Mac, mit deinem eigenen Abo. Du brauchst eins von beiden; du installierst es selbst, die App merkt es von allein.</p>
    <div class="aiclis">${cliCard('claude', claude)}${cliCard('codex', codex)}</div>
    ${note}
    <div class="st-foot aifoot">
      <button type="button" class="linkbtn st-byhand">Ohne KI weitermachen</button>
      <button type="button" class="btn primary" ${ready ? '' : 'disabled'}>${ready ? 'Weiter zur Buchhaltung' : 'Weiter'}</button>
    </div>
  </div>`;
  page(file, 'start', swap(BODY.start, START_MAIN, main) + overlay, title);
}

designA('a1-nichts.html', 'A1 · nichts installiert', { claude: 'missing', codex: 'missing' });
designA('a2-installiert.html', 'A2 · wird installiert', { claude: 'installing', codex: 'missing', overlay: TERM_INSTALL(CLI.claude) });
designA('a3-nicht-angemeldet.html', 'A3 · nicht angemeldet', { claude: 'signedOut', codex: 'missing' });
designA('a4-anmeldung.html', 'A4 · Anmeldung läuft', { claude: 'signingIn', codex: 'missing', overlay: TERM_LOGIN(CLI.claude) });
designA('a5-bereit.html', 'A5 · bereit', { claude: 'ready', codex: 'optional', ready: true });
designA('a6-fehler.html', 'A6 · Fehler', { claude: 'planTooSmall', codex: 'timeout' });

// A7: «Ohne KI weitermachen» and A8: after the setup: the start screen states the AI as a fact.
function startWith(file, title, line, newHint) {
  let b = swap(BODY.start, '</div></div></div></div>', `</div>${line}</div></div></div>`);
  if (newHint) b = swap(b, 'Firma, MWST und Bankkonten in ein paar Fragen. Die App legt den Ordner an.', newHint);
  page(file, 'start', b, title);
}
startWith('a7-ohne-ki.html', 'A7 · ohne KI', `<p class="aistate"><span>KI: keine eingerichtet. Belege erfasst du von Hand, neue Buchhaltungen legst du mit dem Formular an.</span><button type="button" class="linkbtn">KI einrichten</button></p>`, 'Firma, MWST und Bankkonten im Formular. Die App legt den Ordner an.');
startWith('a8-start-bereit.html', 'A8 · Start mit KI', `<p class="aistate ok">${CHECK}<span>KI: Claude Code, angemeldet mit Claude Pro.</span><button type="button" class="linkbtn">Ändern</button></p>`);

// ================= Design B: the setup conversation starts with the AI =================
const OB_FIRST = BODY.setup.slice(BODY.setup.indexOf('<div class="msg ai obsay">'), BODY.setup.indexOf('<div class="obstep" data-step="firm">'));
const OB_FIRM = BODY.setup.slice(BODY.setup.indexOf('<div class="obstep" data-step="firm">'), BODY.setup.indexOf('<div class="obend">'));
const ai = (inner) => `<div class="msg ai obsay">${BOT}<div>${inner}</div></div>`;
const me = (text) => `<div class="obme"><button type="button" class="linkbtn">Ändern</button><div class="msg me">${text}</div></div>`;
const ind = (inner) => `<div class="obind">${inner}</div>`;
const answers = (...btns) => ind(`<div class="qacts" role="group">${btns.join('')}</div>`);
const ans = (label, small = '', primary = false) => `<button type="button" class="btn${primary ? ' primary' : ''}">${label}${small ? `<small>${small}</small>` : ''}</button>`;

const HELLO = ai(`<p>Hallo! Ich richte mit dir Vanilla Accounting ein. Zuerst die KI: Belege lesen und Buchungen vorschlagen mache ich mit einem KI-Programm auf deinem Mac, über dein eigenes Abo. Eins davon reicht.</p>`);
/** The status card inside the conversation: both CLIs in rows, the facts of this Mac below. */
const obCard = (claude, codex) => ind(`<div class="obcard aiobcard">${cliCard('claude', claude, { compact: true, actions: false })}${cliCard('codex', codex, { compact: true, actions: false })}</div>`);
const FIRST_ANSWERS = answers(ans('Claude Code installieren', 'Anthropic · ab Claude Pro', true), ans('Codex installieren', 'OpenAI · ab ChatGPT Plus'), ans('Ohne KI weiter', 'nur Knöpfe und Felder'));

function designB(file, title, turns, { firm = false, talk = 'wait', overlay = '' } = {}) {
  let b = swap(BODY.setup, OB_FIRST, turns);
  b = swap(b, OB_FIRM, firm ? OB_FIRM : '');
  const placeholder = {
    wait: 'Schreiben geht, sobald eine KI bereit ist. Die Knöpfe gehen immer.',
    ready: 'Antworte mit den Knöpfen oder schreib es in deinen Worten, z. B. «Schreinerei in Bern, GmbH, zwei Angestellte»',
    off: 'Ohne KI: antworte mit den Feldern und Knöpfen oben.',
  }[talk];
  b = swap(b, 'placeholder="Antworte mit den Knöpfen oder schreib es in deinen Worten, z. B. «Schreinerei in Bern, GmbH, zwei Angestellte»"', `placeholder="${placeholder}"${talk === 'ready' ? '' : ' disabled=""'}`);
  b = swap(b, '<span><b>Einrichtung</b><small>Fachperson für Vanilla Accounting · richtet deine Buchhaltung mit dir ein</small></span>', '<span><b>Einrichtung</b><small>Fachperson für Vanilla Accounting · richtet die App und deine Buchhaltung mit dir ein</small></span>');
  page(file, 'setup', b + overlay, title);
}

designB('b1-nichts.html', 'B1 · nichts installiert', HELLO + obCard('missing', 'missing') + ind(keyBlock('folded')) + FIRST_ANSWERS);
designB('b8-schluessel.html', 'B8 · Erweitert: API-Schlüssel', HELLO + obCard('missing', 'missing') + ind(keyBlock('open')) + FIRST_ANSWERS);
designB('b9-schluessel-geprueft.html', 'B9 · Schlüssel geprüft', HELLO + ind(keyBlock('checked'))
  + ai(`<p class="okline">${CHECK}Mit dem Schlüssel von Anthropic geht es. Die App fragt Anthropic für alle Schritte; die KI-Spalte bleibt ohne Claude Code aus.</p><p>In welchen Ordner kommt deine Buchhaltung?</p><p class="obfolder mono">/Users/anna/Buchhaltung/Buchhaltung 2026</p>`)
  + answers(ans('Dieser Ordner passt', '', true), ans('Anderen Ordner wählen'), ans('Ich habe schon eine Buchhaltung', 'öffnen')), { talk: 'ready' });
designB('b10-schluessel-abgelehnt.html', 'B10 · Schlüssel abgelehnt', HELLO + obCard('missing', 'missing') + ind(keyBlock('refused')) + FIRST_ANSWERS);
const ASKED = HELLO + me('Claude Code installieren');
designB('b2-installiert.html', 'B2 · wird installiert', ASKED
  + ai('<p>Ich habe das Terminal geöffnet, mit dem Befehl von Anthropic. Drück dort Enter. Wenn es fertig ist, merke ich es von selbst.</p>')
  + obCard('installing', 'missing'), { overlay: TERM_INSTALL(CLI.claude) });
designB('b3-nicht-angemeldet.html', 'B3 · nicht angemeldet', ASKED
  + ai('<p>Claude Code ist da (Version 2.1.211). Jetzt meldest du dich an, mit deinem Claude-Konto im Browser. Dein Passwort und dein Login sehe ich nie.</p>')
  + answers(ans('Anmelden', 'öffnet das Terminal mit «claude auth login»', true), ans('Doch lieber Codex'), ans('Ohne KI weiter')));
designB('b4-anmeldung.html', 'B4 · Anmeldung läuft', ASKED
  + ai('<p>Claude Code ist da (Version 2.1.211). Jetzt meldest du dich an, mit deinem Claude-Konto im Browser.</p>') + me('Anmelden')
  + ai(`<p>Im Browser ist claude.ai offen. Melde dich dort an; ich warte hier.</p><p class="aiwait">${SPIN}Warte auf die Anmeldung.</p>`), { overlay: TERM_LOGIN(CLI.claude) });
designB('b5-bereit.html', 'B5 · bereit', ASKED + me('Anmelden')
  + ai(`<p class="okline">${CHECK}Claude Code ist bereit: angemeldet mit Claude Pro, ein Probelauf hat geantwortet.</p><p>Codex kannst du später in Firma › KI dazunehmen. Dann legen wir los. In welchen Ordner kommt deine Buchhaltung?</p><p class="obfolder mono">/Users/anna/Buchhaltung/Buchhaltung 2026</p>`)
  + answers(ans('Dieser Ordner passt', '', true), ans('Anderen Ordner wählen'), ans('Ich habe schon eine Buchhaltung', 'öffnen'), ans('Erst die Demo ansehen')), { talk: 'ready' });
designB('b6-fehler.html', 'B6 · Fehler', ASKED + me('Anmelden')
  + ai(`<p class="warnline">${WARN}Angemeldet, aber dein Claude-Konto hat kein Abo mit Claude Code (Free).</p><p>Claude Code gibt es ab Claude Pro, etwa 20 USD im Monat. Mit ChatGPT Plus geht es auch über Codex.</p>`)
  + answers(ans('Abos bei Anthropic', 'claude.com/pricing'), ans('Mit anderem Konto anmelden'), ans('Codex installieren'), ans('Ohne KI weiter')));
designB('b7-ohne-ki.html', 'B7 · ohne KI', HELLO + obCard('missing', 'missing') + me('Ohne KI weiter')
  + ai('<p>Gut. Dann frage ich mit Knöpfen und Feldern; in eigenen Worten schreiben geht erst mit einer KI. Belege erfasst du von Hand. Die KI richtest du jederzeit unter Firma › KI ein.</p>'), { firm: true, talk: 'off' });

// ================= Later: Firma › KI, the AI column, the error line =================
const OLD_PROVIDERS = '<h3>Anbieter</h3><dl class="kv2 wide"><dt>Claude-Abo (Claude Code)</dt><dd class="">bereit</dd>';
const OLD_INTRO = 'Welche KI die App für ihre Schritte fragt, auf diesem Computer. Ohne Einstellung fragt sie Claude über dein Claude-Abo (Claude Code). Die Wahl gilt nur hier, nicht für andere, die dieselbe Buchhaltung öffnen.';

function company(file, title, claude, codex, chooser, keys) {
  let b = swap(BODY.company, OLD_INTRO, 'Welche KI die App auf diesem Mac fragt. Die Wahl gilt nur hier, nicht für andere, die dieselbe Buchhaltung öffnen.');
  b = swap(b, OLD_PROVIDERS, `<h3>KI-Programme auf diesem Mac</h3>
    <p class="m">Über dein eigenes Abo: ${CLI.claude.plan} für Claude Code oder ${CLI.codex.plan} für Codex, je etwa 20 USD im Monat. Die App startet das Programm und sieht dein Login nie.</p>
    <div class="aiclis wide">${cliCard('claude', claude)}${cliCard('codex', codex)}</div>
    ${chooser}
    <details class="aiadv"${keys ? ' open' : ''}><summary>Erweitert: mit API-Schlüssel</summary><div class="aiadvin"><p class="m">Statt eines Abos oder dazu. ${KEY_COST} Ohne Claude Code oder Codex stellt die App alle Schritte auf den Schlüssel; mit einem Abo nur die Schritte, die du unten auf ihn stellst.</p><dl class="kv2 wide">`);
  b = swap(b, '</dl><h3>Modell pro Schritt</h3>', `</dl><small class="m">Der Schlüssel liegt im Schlüsselbund dieses Macs, nie in der Buchhaltung.</small>${KEY_LIMITS}</div></details><h3>Modell pro Schritt</h3>`);
  if (keys) b = keys(b);
  b = b.replaceAll('Claude-Abo (Claude Code)', 'Claude Code');
  page(file, 'company', b, title);
}
company('l1-firma-ki.html', 'Firma › KI', 'ready', 'optional', '<dl class="kv2 wide aichoose"><dt>Die App fragt</dt><dd>Claude Code</dd></dl>');
const keyRow = (provider, inner) => (b) => swap(b, `<dt>${KEYS[provider].name} (API-Schlüssel)</dt><dd><span class="m">kein Schlüssel</span><small>Kostet pro Aufruf, auf deine Rechnung beim Anbieter.</small></dd>`,
  `<dt>${KEYS[provider].name} (API-Schlüssel)</dt><dd>${inner}<small>Kostet pro Aufruf, auf deine Rechnung beim Anbieter. <a class="linkbtn" href="${KEYS[provider].page}" target="_blank" rel="noopener">Schlüssel erstellen ${OUT}</a></small></dd>`);
const emptyKey = (provider) => `<form class="aikey"><input type="password" autocomplete="off" placeholder="API-Schlüssel einfügen"><button type="button" class="btn" disabled>Prüfen und speichern</button></form>`;
company('l6-firma-schluessel.html', 'Firma › KI · API-Schlüssel', 'missing', 'missing', '', (b) => keyRow('openai', emptyKey('openai'))(keyRow('anthropic',
  `<span class="aikey"><span class="mono">${MASKED}</span><button type="button" class="btn ghost">Entfernen</button></span><small class="okline">${CHECK}geprüft: Anthropic hat ihn angenommen, Probelauf mit Claude Haiku hat geantwortet</small>`)(b)));
company('l7-firma-schluessel-abgelehnt.html', 'Firma › KI · Schlüssel abgelehnt', 'ready', 'optional', '<dl class="kv2 wide aichoose"><dt>Die App fragt</dt><dd>Claude Code</dd></dl>', (b) => keyRow('anthropic', emptyKey('anthropic'))(keyRow('openai',
  `<form class="aikey bad"><input type="password" autocomplete="off" value="sk-proj-••••••••••••••••••••••••"><button type="button" class="btn primary">Prüfen und speichern</button></form><small class="warnline">${WARN}Der Anbieter lehnt diesen Schlüssel ab: nichts gespeichert.</small>`)(b)));
company('l5-zweites-programm.html', 'Firma › KI · beide', 'ready', 'ready', `<dl class="kv2 wide aichoose"><dt>Die App fragt</dt><dd><span class="seg2" role="radiogroup"><button type="button" role="radio" aria-checked="true" class="on">Claude Code</button><button type="button" role="radio" aria-checked="false">Codex</button></span><small>Pro Schritt änderbar, unten. Im Terminal öffnet dasselbe.</small></dd><dt>Ist es nicht erreichbar</dt><dd><label class="aicheck"><input type="checkbox" checked> das andere fragen</label><small>Zum Beispiel wenn die Nutzungsgrenze des Abos erreicht ist.</small></dd></dl>`);

const AIEMPTY = BODY.journal.slice(BODY.journal.indexOf('<p class="m aiempty">'), BODY.journal.indexOf('</p>', BODY.journal.indexOf('<p class="m aiempty">')) + 4);
const COMPOSE_PH = 'placeholder="Was soll die KI tun? (+ für einen Verweis, @ für einen Ablauf oder Lauf)"';
function sidebar(file, title, turns, placeholder, disabled) {
  let b = swap(BODY.journal, AIEMPTY, turns);
  b = swap(b, COMPOSE_PH, `placeholder="${placeholder}"${disabled ? ' disabled=""' : ''}`);
  page(file, 'journal', b, title);
}
sidebar('l2-seitenleiste-ohne-ki.html', 'KI-Spalte ohne KI', `<div class="aisidecard">
  <p><b>Keine KI auf diesem Mac.</b> Die KI-Spalte fragt Claude Code oder Codex, über dein eigenes Abo. Alles andere geht ohne: buchen, Belege von Hand, MWST.</p>
  ${cliCard('claude', 'missing', { compact: true })}${cliCard('codex', 'missing', { compact: true })}
</div>`, 'Die KI-Spalte braucht Claude Code oder Codex.', true);
sidebar('l3-seitenleiste-grenze.html', 'KI-Spalte · Grenze erreicht', `<div class="msg me">Lies den Beleg von Post CH und prüf die MWST.</div>
  <div class="msg ai">${BOT}<div><p class="warnline">${WARN}Claude Code meldet: Nutzungsgrenze deines Abos erreicht, wieder ab 18:00.</p><p class="m">Codex ist auf diesem Mac angemeldet.</p>
  <div class="qacts"><button type="button" class="btn primary">Mit Codex fragen</button></div></div></div>`, 'Was soll die KI tun? (+ für einen Verweis, @ für einen Ablauf oder Lauf)', false);

// The error line where error.noClaude shows today: under the step that needed the AI.
const RECEIPT_ANCHOR = '<section class="detail" aria-live="polite">';
function errorLine() {
  const b = BODY.journal;
  const sec = b.indexOf('<aside class="margin"');
  const line = `<div class="aierrline"><p class="warnline">${WARN}Beleg lesen braucht eine KI. Auf diesem Mac ist weder Claude Code noch Codex angemeldet.</p><span class="ruleacts"><button type="button" class="btn ghost">KI einrichten</button><button type="button" class="linkbtn">Von Hand erfassen</button></span><p class="aitoday"><span class="rk">heute:</span> Für Belege lesen und Buchungsvorschläge braucht die App Claude Code: von claude.com/claude-code installieren und einmal im Terminal mit «claude» anmelden. Alles andere geht auch ohne.</p></div>`;
  let out = b.slice(0, sec) + line + b.slice(sec);
  out = swap(out, AIEMPTY, '<p class="m aiempty">Die KI-Spalte braucht Claude Code oder Codex. «KI einrichten» zeigt, wie.</p>');
  if (!out.includes(RECEIPT_ANCHOR)) throw new Error('detail anchor');
  page('l4-fehlerzeile.html', 'journal', out, 'Fehlerzeile');
}
errorLine();
