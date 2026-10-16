/**
 * A report as files (src/reports/run.ts), with the export's own table, CSV and page code
 * (src/export/bundle.ts): the CSV is the plain table, one row per row of the report (its section
 * and group as the first columns when there are several); the PDF carries the title, the period,
 * the filters in words, each section's table with its group and section totals, the overall
 * totals, the comment with its figures filled in, and the note on the VAT the amounts still hold.
 */
import { csvOf, date, esc, fileStem, money, pageHtml } from '../export/bundle.js';
import type { Table, Words } from '../export/tables.js';

type Key = Parameters<Words['t']>[0];
import { vatParts } from '../accounting/vat-in-figures.js';
import { COLUMNS, type Column } from './spec.js';
import { filtersInWords, groupName, sectionName, spanOf } from './words.js';
import { fillComment } from './run.js';
import type { ReportResult, ReportRow, Totals } from './result.js';

const MONEY: readonly Column[] = ['amount', 'net', 'tax'];

const cell = (r: ReportRow, c: Column): string | number => r[c];

/** Every row of the report as one table: the section and group first when there is more than one of either. */
export function reportTable(r: ReportResult, w: Words): Table {
  const many = r.sections.length > 1;
  const grouped = r.sections.some((s) => s.section.group !== 'none');
  const cols = COLUMNS.filter((c) => r.sections.some((s) => s.section.columns.includes(c)));
  const lead = [...(many ? [w.t('custom.col.section')] : []), ...(grouped ? [w.t('custom.col.group')] : [])];
  const out: Table = { head: [...lead, ...cols.map((c) => w.t(`custom.col.${c}` as Key))], rows: [], styles: [], money: cols.flatMap((c, i) => (MONEY.includes(c) ? [lead.length + i] : [])) };
  r.sections.forEach((s, i) => {
    for (const g of s.groups) {
      for (const row of g.rows) {
        out.rows.push([...(many ? [sectionName(s.section, i, w)] : []), ...(grouped ? [s.section.group === 'none' ? '' : groupName(g, w)] : []), ...cols.map((c) => (s.section.columns.includes(c) ? cell(row, c) : ''))]);
        out.styles.push(undefined);
      }
    }
  });
  return out;
}

export const reportCsv = (r: ReportResult, w: Words): string => csvOf(reportTable(r, w));

const amounts = (t: Totals[], k: 'amount' | 'net' | 'tax') => t.map((x) => (t.length > 1 ? `${x.currency} ${money(x[k])}` : money(x[k]))).join('\n');

/** The comment with its figures filled as the PDF prints them. */
export const commentOf = (r: ReportResult): string | undefined =>
  fillComment(r, (n, c) => `${c} ${money(n)}`, { period: spanOf(r), date });

/** The VAT the amounts still hold, as Bilanz and ER say it. */
export function vatNoteOf(r: ReportResult, w: Words): string | undefined {
  if (!r.vat) return undefined;
  return w.t('custom.vatNote', { net: money(r.vat.net), parts: vatParts(r.vat).filter((x) => x.amount !== 0).map((x) => w.t(x.key, { amount: money(x.amount) })).join(', ') });
}

function sectionHtml(r: ReportResult, i: number, w: Words): string {
  const s = r.sections[i];
  const cols = s.section.columns;
  const isMoney = (c: Column) => MONEY.includes(c);
  const td = (row: ReportRow, c: Column) => {
    const v = cell(row, c);
    return `<td class="${isMoney(c) ? 'n' : ''}">${isMoney(c) ? money(v as number) : esc(c === 'date' ? date(String(v)) : String(v))}</td>`;
  };
  const totalRow = (label: string, t: Totals[], cls: string) => {
    const first = cols.findIndex(isMoney);
    if (first < 0) return `<tr class="${cls}"><td colspan="${cols.length}">${esc(label)} · ${esc(w.t('custom.rows', { n: t.reduce((n, x) => n + x.count, 0) }))}</td></tr>`;
    return `<tr class="${cls}"><td colspan="${first}">${esc(label)}</td>${cols.slice(first).map((c) => `<td class="n">${isMoney(c) ? esc(amounts(t, c as 'amount')).replace(/\n/g, '<br>') : ''}</td>`).join('')}</tr>`;
  };
  let body = '';
  for (const g of s.groups) {
    if (s.section.group !== 'none') body += `<tr class="grp"><td colspan="${cols.length}">${esc(groupName(g, w))}</td></tr>`;
    for (const row of g.rows) body += `<tr>${cols.map((c) => td(row, c)).join('')}</tr>`;
    if (s.section.group !== 'none') body += totalRow(w.t('custom.totalOf', { group: groupName(g, w) }), g.totals, 'strong');
  }
  body += totalRow(w.t('custom.sectionTotal', { section: sectionName(s.section, i, w) }), s.totals, 'tot');
  const head = `<tr>${cols.map((c) => `<th class="${isMoney(c) ? 'n' : ''}">${esc(w.t(`custom.col.${c}` as Key))}</th>`).join('')}</tr>`;
  return `<h2>${esc(sectionName(s.section, i, w))}</h2><div class="lead">${esc(filtersInWords(s.section, w))} · ${esc(w.t('custom.rows', { n: s.count }))}</div><table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/** The report as an A4 page for printPdf (src/invoices/pdf.ts). */
export function reportHtml(r: ReportResult, w: Words, x: { company: string; fonts: string; now: string }): string {
  const vatNote = vatNoteOf(r, w);
  const comment = commentOf(r);
  const overall = r.sections.length > 1
    ? `<table><tbody><tr class="tot"><td>${esc(w.t('custom.overall'))} · ${esc(w.t('custom.rows', { n: r.count }))}</td>${(['net', 'tax', 'amount'] as const).filter((k) => r.sections.some((s) => s.section.columns.includes(k))).map((k) => `<td class="n">${esc(w.t(`custom.col.${k}` as Key))}<br>${esc(amounts(r.totals, k)).replace(/\n/g, '<br>')}</td>`).join('')}</tr></tbody></table>`
    : '';
  const body = [
    ...r.sections.map((_, i) => sectionHtml(r, i, w)),
    overall,
    comment ? `<p class="note">${esc(comment)}</p>` : '',
    vatNote ? `<p class="note lead">${esc(vatNote)}</p>` : '',
    `<p class="note lead">${esc(w.t('custom.madeBy', { date: date(x.now.slice(0, 10)) }))}</p>`,
  ].join('\n');
  const wide = Math.max(...r.sections.map((s) => s.section.columns.length)) > 6;
  return pageHtml({ title: r.spec.title, meta: [x.company, spanOf(r), r.currency].filter(Boolean).join(' · '), footer: `${x.company} · ${r.spec.title} ·`, fonts: x.fonts, landscape: wide }, body);
}

/** The file's name: the title, then the period's dates. */
export const reportFileName = (r: ReportResult, ext: 'pdf' | 'csv'): string =>
  `${fileStem(r.spec.title)}_${r.period.kind === 'all' ? 'all' : `${r.period.from}_${r.period.to}`}.${ext}`;
