/**
 * Generate a clean, printable HTML filing summary for the Swiss VAT return (MWST-Abrechnung),
 * with a per-Ziffer transaction breakdown so every figure is traceable. Uses the same engine
 * as the UI and `npm run vat-report`.
 *
 * Usage: npm run vat-report-html -- <outfile.html> [YYYY-Qn ...]
 * Without quarters it covers the filed quarters of the year config.closedThrough falls in.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBooks } from '../books/store.js';
import { derivePeriod } from '../accounting/periods.js';
import { openWorkspace } from '../workspace/workspace.js';
import { vat } from '../engines/index.js';
import type { VatLine } from '../engines/return.js';

const ws = openWorkspace();
const index = loadBooks(ws);
const entries = index.journalEntries ?? [];
const adjustments = index.config?.vatAdjustments ?? [];

const [outArg, ...quarterArgs] = process.argv.slice(2);
const closedThrough = index.config?.closedThrough;
/** Default: the filed quarters of the year the books are closed in. */
const quarterKeys = quarterArgs.length
  ? quarterArgs
  : closedThrough
    ? [1, 2, 3, 4].map((n) => `${closedThrough.slice(0, 4)}-Q${n}`).filter((k) => derivePeriod(k)!.to <= closedThrough)
    : [];
if (!quarterKeys.length) throw new Error('Usage: npm run vat-report-html -- <outfile.html> [YYYY-Qn ...]');

const MONTH_SPANS = ['Januar – März', 'April – Juni', 'Juli – September', 'Oktober – Dezember'];
const QUARTERS = quarterKeys.map((key) => {
  const m = key.match(/^(\d{4})-Q([1-4])$/);
  if (!m) throw new Error(`Not a quarter: ${key} (expected YYYY-Qn)`);
  return { key, title: `${m[2]}. Quartal ${m[1]}`, span: MONTH_SPANS[+m[2] - 1], ...derivePeriod(key)! };
});
const years = [...new Set(quarterKeys.map((k) => k.slice(0, 4)))];
const quartersLabel = years.length === 1 ? `${quarterKeys.map((k) => k.slice(5)).join(' + ')} ${years[0]}` : quarterKeys.join(' + ');

const chf = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, '’');
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function lineRows(lines: VatLine[], field: 'gross' | 'base' | 'tax'): string {
  const rows = lines.slice().sort((a, b) => a.date.localeCompare(b.date));
  const sum = rows.reduce((s, r) => s + r[field], 0);
  const body = rows.map(r => `
    <tr>
      <td class="c-date">${r.date.slice(5)}</td>
      <td class="c-code">${esc(r.code)}</td>
      <td class="c-desc">${esc(r.description)}</td>
      <td class="c-num">${chf(r[field])}</td>
    </tr>`).join('');
  return `${body}
    <tr class="sub">
      <td></td><td></td><td class="c-desc">${rows.length} Buchungen</td>
      <td class="c-num">${chf(sum)}</td>
    </tr>`;
}

/** A breakdown block for one Ziffer. */
function block(zNumber: string, zLabel: string, lines: VatLine[] | undefined, field: 'gross' | 'base' | 'tax', note: string): string {
  if (!lines || !lines.length) return '';
  return `
  <section class="block">
    <div class="block-head">
      <span class="zbadge">${zNumber}</span>
      <h4>${esc(zLabel)}</h4>
      <span class="block-note">${esc(note)}</span>
    </div>
    <div class="tbl-wrap">
      <table class="ledger">
        <thead><tr><th>Datum</th><th>Code</th><th>Buchung</th><th class="c-num">CHF</th></tr></thead>
        <tbody>${lineRows(lines, field)}</tbody>
      </table>
    </div>
  </section>`;
}

function quarterSection(q: typeof QUARTERS[number]): string {
  const rep = vat().report(entries, q.key, adjustments);
  const L = vat().lines(entries, q.key, adjustments);
  const z = (n: string) => rep.ziffern.find(x => x.number === n)?.amount ?? 0;
  // Gross (VAT-inclusive) total of a Ziffer's lines — the filing is gross (grossOrNet=2),
  // so the ESTV portal shows Ziffer 303 gross, not the net basis.
  const grossOf = (n: string) => (L[n] ?? []).reduce((s, r) => s + r.gross, 0);
  const isCredit = rep.credit > 0;

  const formRow = (n: string, label: string, key = false, indent = false, value?: number) => `
    <tr class="${key ? 'key' : ''}">
      <td class="f-nr">${n}</td>
      <td class="f-label ${indent ? 'ind' : ''}">${esc(label)}</td>
      <td class="f-num">${chf(value ?? z(n))}</td>
    </tr>`;

  return `
  <article class="quarter">
    <header class="q-head">
      <div>
        <h2>${esc(q.title)}</h2>
        <p class="q-span">${esc(q.span)} · ${q.from} – ${q.to}</p>
      </div>
      <div class="result ${isCredit ? 'is-credit' : 'is-pay'}">
        <span class="result-label">${isCredit ? 'Guthaben' : 'Zu bezahlen'}</span>
        <span class="result-amt">CHF ${chf(isCredit ? rep.credit : rep.toPay)}</span>
        <span class="result-sub">Ziffer ${isCredit ? '510' : '500'}</span>
      </div>
    </header>

    <div class="form-wrap">
      <table class="form">
        <tbody>
          <tr class="grp"><td colspan="3">Umsatz</td></tr>
          ${formRow('200', 'Total vereinnahmte Entgelte')}
          ${formRow('220', 'davon steuerbefreit (Exporte)', false, true)}
          ${formRow('289', 'Total Abzüge', false, true)}
          ${formRow('299', 'Steuerbarer Gesamtumsatz', true)}
          <tr class="grp"><td colspan="3">Steuerberechnung</td></tr>
          ${formRow('303', 'Leistungen zum Normalsatz 8.1 % (brutto)', false, false, grossOf('303'))}
          ${formRow('399', 'Total geschuldete Steuer', true)}
          <tr class="grp"><td colspan="3">Vorsteuer</td></tr>
          ${formRow('400', 'Vorsteuer auf Material & Dienstleistungen')}
          ${formRow('405', 'Vorsteuer auf Investitionen & Betriebsaufwand')}
          ${z('415') !== 0 ? formRow('415', 'Vorsteuerkorrekturen (Eigenverbrauch)') : ''}
          ${formRow('479', 'Total Vorsteuer', true)}
        </tbody>
      </table>
    </div>

    <div class="breakdown">
      <h3>Herleitung <span>— wie sich jede Ziffer zusammensetzt</span></h3>
      ${block('303', 'Steuerbare Leistungen 8.1 %', L['303'], 'gross', 'Bruttobeträge inkl. MWST; Steuer (Ziffer 399) = 8.1/108.1 davon.')}
      ${block('220', 'Steuerbefreite Exporte (V0)', L['220'], 'gross', 'Auslandlieferungen — keine MWST.')}
      ${block('400', 'Vorsteuer Material & Dienstleistungen', L['400'], 'tax', 'Enthaltene 8.1 %/2.6 % je Buchung.')}
      ${block('405', 'Vorsteuer Investitionen & Betriebsaufwand', L['405'], 'tax', 'Enthaltene 8.1 %/2.6 % je Buchung.')}
      ${block('415', 'Vorsteuerkorrekturen — Eigenverbrauch (K-Codes)', L['415'], 'tax', 'Rückbelastung Vorsteuer auf Privatanteil (mindert Ziffer 479).')}
    </div>
  </article>`;
}

const generatedNote = 'Aus books.json generiert · vor Einreichung mit den Belegen abgleichen';

const html = `<style>
  :root {
    --paper:#FBFBF9; --ink:#191A1C; --muted:#71767B; --faint:#9AA0A6;
    --hair:#E4E3DE; --hair-strong:#CFCEC7; --band:#F2F1EC;
    --accent:#A21D24; --credit:#2F6F4F;
    --sans:-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:var(--sans);
    font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased; }
  .sheet { max-width:940px; margin:0 auto; padding:56px 40px 80px; }
  .masthead { border-bottom:2px solid var(--accent); padding-bottom:20px; margin-bottom:8px;
    display:flex; justify-content:space-between; align-items:flex-end; gap:24px; flex-wrap:wrap; }
  .masthead h1 { font-size:26px; font-weight:700; letter-spacing:-0.01em; margin:0; text-wrap:balance; }
  .masthead .sub { color:var(--muted); font-size:13px; margin-top:6px; }
  .masthead .meta { text-align:right; font-size:12px; color:var(--muted); font-family:var(--mono); line-height:1.7; }
  .lede { color:var(--muted); font-size:13.5px; max-width:62ch; margin:18px 0 40px; }

  .quarter { margin-bottom:64px; }
  .q-head { display:flex; justify-content:space-between; align-items:center; gap:24px;
    padding-bottom:14px; border-bottom:1px solid var(--hair-strong); margin-bottom:22px; flex-wrap:wrap; }
  .q-head h2 { font-size:20px; margin:0; font-weight:650; letter-spacing:-0.01em; }
  .q-span { margin:4px 0 0; color:var(--muted); font-size:12.5px; font-family:var(--mono); }
  .result { text-align:right; display:grid; gap:1px; padding:8px 16px; border-radius:2px; min-width:210px; }
  .result.is-pay { background:#FBECEC; box-shadow:inset 3px 0 0 var(--accent); }
  .result.is-credit { background:#EBF3EE; box-shadow:inset 3px 0 0 var(--credit); }
  .result-label { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }
  .result-amt { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
  .is-pay .result-amt { color:var(--accent); } .is-credit .result-amt { color:var(--credit); }
  .result-sub { font-size:11px; color:var(--faint); font-family:var(--mono); }

  .form-wrap { border:1px solid var(--hair); border-radius:3px; overflow:hidden; margin-bottom:34px; }
  table.form { width:100%; border-collapse:collapse; }
  table.form td { padding:9px 16px; font-variant-numeric:tabular-nums; }
  table.form tr:not(.grp):not(:last-child) td { border-bottom:1px solid var(--hair); }
  .form .grp td { background:var(--band); font-size:11px; text-transform:uppercase; letter-spacing:0.1em;
    color:var(--muted); padding:7px 16px; font-weight:600; }
  .form .f-nr { font-family:var(--mono); font-size:12px; color:var(--faint); width:52px; }
  .form .f-label.ind { padding-left:20px; color:var(--muted); }
  .form .f-num { text-align:right; font-variant-numeric:tabular-nums; width:150px; }
  .form tr.key td { font-weight:700; background:#FCFBF7; }
  .form tr.key .f-nr { color:var(--accent); }

  .breakdown > h3 { font-size:13px; text-transform:uppercase; letter-spacing:0.09em; color:var(--ink);
    margin:0 0 4px; padding-bottom:8px; border-bottom:1px solid var(--hair-strong); }
  .breakdown > h3 span { text-transform:none; letter-spacing:0; color:var(--faint); font-weight:400; font-size:12.5px; }
  .block { margin-top:22px; }
  .block-head { display:flex; align-items:baseline; gap:12px; margin-bottom:8px; }
  .zbadge { font-family:var(--mono); font-size:11px; font-weight:600; color:var(--accent);
    border:1px solid var(--hair-strong); border-radius:2px; padding:1px 6px; }
  .block-head h4 { font-size:14px; margin:0; font-weight:600; }
  .block-note { color:var(--faint); font-size:12px; margin-left:auto; }
  .tbl-wrap { overflow-x:auto; border:1px solid var(--hair); border-radius:3px; }
  table.ledger { width:100%; border-collapse:collapse; font-size:13px; min-width:520px; }
  table.ledger th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:0.06em;
    color:var(--muted); font-weight:600; padding:7px 12px; background:var(--band); border-bottom:1px solid var(--hair); }
  table.ledger td { padding:6px 12px; border-bottom:1px solid var(--hair); vertical-align:top; }
  .ledger .c-date { font-family:var(--mono); color:var(--muted); white-space:nowrap; }
  .ledger .c-code { font-family:var(--mono); font-size:12px; color:var(--ink); white-space:nowrap; }
  .ledger .c-desc { color:var(--ink); }
  .ledger .c-num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .ledger tr.sub td { border-top:1px solid var(--hair-strong); border-bottom:none; font-weight:650;
    color:var(--ink); background:#FCFBF7; }
  .ledger tr.sub .c-desc { color:var(--muted); font-weight:400; font-size:12px; }
  .ledger tbody tr:last-child td { border-bottom:none; }

  footer { margin-top:56px; padding-top:16px; border-top:1px solid var(--hair);
    color:var(--faint); font-size:11.5px; display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; }

  @media print {
    body { background:#fff; font-size:11px; }
    .sheet { padding:0; max-width:none; }
    .quarter { break-inside:avoid; }
    .block, .form-wrap { break-inside:avoid; }
    .result.is-pay, .result.is-credit { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
</style>

<div class="sheet">
  <div class="masthead">
    <div>
      <h1>Mehrwertsteuer-Abrechnung ${years.join(' / ')}</h1>
      <div class="sub">Effektive Methode · Abrechnung nach vereinnahmten Entgelten (Ist-Prinzip)</div>
    </div>
    <div class="meta">
      ${quartersLabel}<br>ESTV — SuisseTax<br>MWST-Nr.: CHE-___.___.___
    </div>
  </div>
  <p class="lede">Vorbereitung zur quartalsweisen Einreichung. Jedes Quartal zeigt zuerst die
    Formular-Ziffern für das ESTV-Portal, danach die Herleitung — jede zusammengesetzte Ziffer
    mit den einzelnen Buchungen, aus denen sie besteht.</p>

  ${QUARTERS.map(quarterSection).join('\n')}

  <footer>
    <span>${esc(generatedNote)}</span>
    <span>Vanilla Accounting</span>
  </footer>
</div>`;

const out = outArg || join(ws.paths.data, `vat-filing-${years.join('-')}.html`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`✓ wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);
