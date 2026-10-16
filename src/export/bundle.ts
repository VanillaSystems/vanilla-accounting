/**
 * The export bundle: the chosen reports, tables and original files of a period as files in
 * folders, a LIESMICH in the user's language, and on request SHA256SUMS.txt and manifest.json.
 * Reads the books, never writes them. One file without sums is downloaded as it is; anything
 * more as one ZIP with a root folder.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import writeXlsxFile, { type Row as XlsxRow } from 'write-excel-file/node';
import type { Index } from '../types/index.js';
import type { Key } from '../app/i18n/types.js';
import { derivePeriod, localToday, type Period } from '../accounting/periods.js';
import type { ExportedFile } from '../audit/manifest.js';
import { appVersion } from '../audit/manifest.js';
import { invoiceFontCss } from '../invoices/fonts.js';
import { filedReturnsOf, receiptPathOf } from '../workspace/reads.js';
import { findFile, yearPaths } from '../workspace/workspace.js';
import type { Workspace } from '../workspace/workspace.js';
import { bananaTsv } from '../providers/banana/banana.js';
import { ITEMS, quartersIn, receiptsIn, statementsIn, type ExportRequest, type Format, type ItemId } from './model.js';
import { tableOf, type Table, type Words } from './tables.js';
import { wordsIn } from './texts.js';

const EXPORT_MANIFEST_FORMAT = 'vanilla-accounting-export/1';

export interface BundleFile { path: string; data: Uint8Array }

export interface Bundle {
  /** The ZIP's root folder, and the prefix of a single file's name. */
  root: string;
  files: BundleFile[];
  /** Originals the books name whose file is not in the workspace. */
  missing: string[];
}

export interface BundleOptions {
  now?: Date;
  /** HTML to PDF (src/invoices/pdf.ts printPdf); only needed when a PDF is chosen. */
  print(html: string, at: string): Promise<Buffer>;
}

type TableId = Exclude<ItemId, 'receipts' | 'statements' | 'filings'>;
type Request = ExportRequest & { range: Period };

const enc = new TextEncoder();
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export const date = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const money = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** "Buchungen (Journal)" → "Buchungen": a file name without the label's explanation. */
export const fileStem = (label: string) => label.replace(/\s*\(.*\)/, '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');

const label = (w: Words, id: ItemId) => w.t(`export.item.${id}` as Key);

/** A table as CSV: UTF-8 with its BOM, semicolons, CRLF, amounts with two decimals. */
export function csvOf(tb: Table): string {
  const cell = (v: string | number, money: boolean) => {
    const s = typeof v === 'number' ? (money ? v.toFixed(2) : String(v)) : v;
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [tb.head.map((h) => cell(h, false)), ...tb.rows.map((r) => r.map((v, i) => cell(v, tb.money.includes(i))))];
  return '﻿' + lines.map((l) => l.join(';')).join('\r\n') + '\r\n';
}

function jsonOf(tb: Table, title: string, company: string, range: Period): string {
  return JSON.stringify({
    company, from: range.from, to: range.to, currency: 'CHF', table: title, columns: tb.head,
    rows: tb.rows.map((r) => Object.fromEntries(tb.head.map((h, i) => [h, r[i] ?? '']))),
  }, null, 2) + '\n';
}

function sheetOf(tb: Table): XlsxRow[] {
  const bold = { fontWeight: 'bold' as const };
  return [
    tb.head.map((h) => ({ value: h, ...bold })),
    ...tb.rows.map((r, j) => r.map((v, i) => ({
      ...(typeof v === 'number' ? { value: v, type: Number, ...(tb.money.includes(i) && { format: '#,##0.00' }) } : { value: v, type: String }),
      ...((tb.styles[j] === 'total' || tb.styles[j] === 'strong') && bold),
    }))),
  ];
}

const sheetName = (s: string) => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

/** How many leading columns a PDF turns into a heading over its rows: the group, the quarter, the account. */
const LEAD: Partial<Record<TableId, number>> = { income: 1, balance: 1, vat: 1, ledger: 2, ledgers: 2, journal: 1 };

/**
 * The journal as printed (treuhaender-40): per month, each entry with its date, ref, text, Soll,
 * Haben, MWST code, amount and its CHF; the entry id and the rate stay in the CSV.
 */
function journalSheet(tb: Table, w: Words): Table {
  const cols = [0, 2, 3, 4, 5, 6, 7, 8, 10];
  const months = w.t('export.colMonth');
  return {
    head: [months, ...cols.map((i) => tb.head[i])],
    rows: tb.rows.map((r) => { const d = String(r[0]); return [`${d.slice(5, 7)}.${d.slice(0, 4)}`, date(d), ...cols.slice(1).map((i) => r[i])]; }),
    styles: tb.styles,
    money: [7, 9],
  };
}

function reportHtml(id: TableId, tb: Table, title: string, meta: string, footer: string, fonts: string): string {
  const lead = LEAD[id] ?? 0;
  const cols = tb.head.slice(lead);
  const isMoney = (i: number) => tb.money.includes(i + lead);
  const td = (v: string | number, i: number) => `<td class="${isMoney(i) ? 'n' : ''}">${typeof v === 'number' && isMoney(i) ? money(v) : esc(String(v))}</td>`;
  let body = '';
  let group: string | undefined;
  tb.rows.forEach((r, j) => {
    const style = tb.styles[j];
    if (style === 'total' && lead) {
      body += `<tr class="tot"><td colspan="${cols.length - 1}">${esc(String(r[0]))}</td>${td(r[r.length - 1], cols.length - 1)}</tr>`;
      group = undefined;
      return;
    }
    const g = r.slice(0, lead).filter((x) => x !== '').join(' ');
    if (lead && g !== group) { group = g; body += `<tr class="grp"><td colspan="${cols.length}">${esc(g)}</td></tr>`; }
    body += `<tr class="${style ?? ''}">${r.slice(lead).map((v, i) => td(v, i)).join('')}</tr>`;
  });
  const head = `<table><thead><tr>${cols.map((h, i) => `<th class="${isMoney(i) ? 'n' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  return pageHtml({ title, meta, footer, fonts, landscape: cols.length > 6 }, head);
}

/** An A4 page of the export's reports: the title, the line under it, then `body`; the footer with the page number. */
export function pageHtml(p: { title: string; meta: string; footer: string; fonts: string; landscape: boolean }, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)}</title><style>${p.fonts}
@page { size: A4 ${p.landscape ? 'landscape' : 'portrait'}; margin: 16mm 14mm 18mm; @bottom-left { content: "${esc(p.footer)} " counter(page) " / " counter(pages); font: 7.5pt Inter, sans-serif; color: #969ca8; } }
body { font: 8.5pt/1.4 Inter, sans-serif; color: #0b1220; margin: 0; }
h1 { font-size: 15pt; font-weight: 700; margin: 0; }
h2 { font-size: 11pt; font-weight: 700; margin: 16pt 0 2pt; }
.meta { color: #6e7685; margin: 3pt 0 14pt; font-size: 9pt; }
.lead { color: #6e7685; margin: 0 0 6pt; }
.note { margin: 12pt 0 0; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-weight: 600; font-size: 7.5pt; color: #6e7685; border-bottom: 1pt solid #0b1220; padding: 3pt 4pt; }
td { padding: 2.5pt 4pt; border-bottom: .5pt solid #e7eaf0; vertical-align: top; }
td.n, th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
tr.grp td { font-weight: 700; color: #6e7685; font-size: 7.5pt; padding-top: 9pt; }
tr.tot td, tr.strong td { font-weight: 700; }
tr.tot td { border-top: 1pt solid #0b1220; }
tr.open td { color: #6e7685; font-style: italic; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
</style></head><body><h1>${esc(p.title)}</h1><div class="meta">${esc(p.meta)}</div>
${body}</body></html>`;
}

/** The files of filed quarters in the period (returns, seals) from transactional-data/<year>/filings/. */
function filingsIn(ws: Workspace, books: Index, range: Period): Array<{ path: string; src: string }> {
  const closed = books.config?.closedThrough;
  const out: Array<{ path: string; src: string }> = [];
  for (const q of quartersIn(range, localToday(), ws.filingLength)) {
    const [year, n] = [q.slice(0, 4), q.slice(-1)];
    if (!closed || derivePeriod(q)!.to > closed) continue;
    const dir = yearPaths(ws.paths, year).filings;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) if (new RegExp(`(^|[^0-9])Q${n}([^0-9]|$)`).test(f)) out.push({ path: `${year}/${f}`, src: join(dir, f) });
  }
  return out;
}

export async function buildBundle(ws: Workspace, books: Index, names: Record<string, string>, req: Request, opts: BundleOptions): Promise<Bundle> {
  const w = wordsIn(req.language);
  const { t } = w;
  const now = (opts.now ?? new Date()).toISOString();
  const range = req.range;
  const company = ws.company.name;
  const span = range.kind === 'all' ? t('app.allPeriods') : `${date(range.from)} – ${date(range.to)}`;
  const root = `${company.replace(/\s+/g, '-')}_${range.kind === 'all' ? 'all' : `${range.from}_${range.to}`}`;
  const filed = Object.fromEntries([...new Set(quartersIn(range, localToday(), ws.filingLength).map((q) => q.slice(0, 4)))].flatMap((y) => filedReturnsOf(ws, y)).map((r) => [r.period, r]));
  const ctx = { books, period: range, names, words: w, filed, filingLength: ws.filingLength, account: req.account };
  const dir = { reports: t('export.dirReports'), data: t('export.dirData'), documents: '' };

  const files: BundleFile[] = [];
  const missing: string[] = [];
  const book: Array<{ name: string; tb: Table }> = [];
  const xlsxCount = Object.values(req.items).filter((f) => f?.includes('xlsx')).length;
  const oneBook = req.oneBook && xlsxCount > 1;
  const fonts = Object.values(req.items).some((f) => f?.includes('pdf')) ? invoiceFontCss() : '';

  for (const def of ITEMS) {
    const formats = req.items[def.id];
    if (!formats?.length) continue;
    if (def.id === 'receipts') {
      for (const v of receiptsIn(books, range)) {
        const src = receiptPathOf(ws, v.r);
        if (src) files.push({ path: `${t('export.dirReceipts')}/${v.r.filename}`, data: readFileSync(src) });
        else missing.push(v.r.filename);
      }
      continue;
    }
    if (def.id === 'statements') {
      for (const s of statementsIn(books, range)) {
        const src = findFile(ws.paths, 'statements', `${s.bank}/${s.filename}`);
        if (src) files.push({ path: `${t('export.dirStatements')}/${s.bank}/${s.filename}`, data: readFileSync(src) });
        else missing.push(`${s.bank}/${s.filename}`);
      }
      continue;
    }
    if (def.id === 'filings') {
      for (const f of filingsIn(ws, books, range)) files.push({ path: `${t('export.dirFilings')}/${f.path}`, data: readFileSync(f.src) });
      continue;
    }
    const id = def.id as TableId;
    const title = id === 'ledger' ? t('export.ledgerOf', { account: req.account || t('reports.noAccount') }) : label(w, id);
    const tb = tableOf(id, ctx);
    const base = `${dir[def.group]}/${fileStem(title)}`;
    for (const f of formats as Format[]) {
      if (f === 'csv') files.push({ path: `${base}.csv`, data: enc.encode(csvOf(tb)) });
      if (f === 'json') files.push({ path: `${base}.json`, data: enc.encode(jsonOf(tb, title, company, range)) });
      if (f === 'banana') files.push({ path: `${dir.data}/Banana-Import.tsv`, data: enc.encode(bananaTsv(books, range.from, range.to)) });
      if (f === 'xlsx') {
        if (oneBook) book.push({ name: title, tb });
        else files.push({ path: `${base}.xlsx`, data: await writeXlsxFile(sheetOf(tb), { sheet: sheetName(title) }).toBuffer() });
      }
      if (f === 'pdf') {
        const sheet = id === 'journal' ? journalSheet(tb, w) : tb;
        const meta = `${company} · ${span} · CHF${id === 'balance' ? ` · ${t('balance.asOf', { date: date(range.to) })}` : ''}${tb.note ? ` · ${tb.note}` : ''}`;
        files.push({ path: `${base}.pdf`, data: await opts.print(reportHtml(id, sheet, title, meta, `${company} · ${title} ·`, fonts), now) });
      }
    }
  }
  if (book.length) {
    const data = await writeXlsxFile(book.map((b) => ({ data: sheetOf(b.tb), sheet: sheetName(b.name) }))).toBuffer();
    files.push({ path: `${dir.data}/${fileStem(t('export.workbook'))}.xlsx`, data });
  }
  if (files.length === 1 && !req.sums && !missing.length) return { root, files, missing };

  const total = files.length + 1 + (req.sums ? 2 : 0);
  const readme = readmeOf(w, req, { company, span, now, total, missing, banana: files.some((f) => f.path.endsWith('.tsv')), dir });
  files.unshift({ path: t('export.readmeFile'), data: enc.encode(readme) });
  if (req.sums) {
    const listed: ExportedFile[] = files.map((f) => ({ path: f.path, sha256: sha256(f.data), bytes: f.data.length }));
    const manifest = { format: EXPORT_MANIFEST_FORMAT, company, period: range.token, from: range.from, to: range.to, createdAt: now, appVersion: appVersion(), files: listed };
    files.push({ path: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2) + '\n') });
    files.push({ path: 'SHA256SUMS.txt', data: enc.encode(files.map((f) => `${sha256(f.data)}  ${f.path}`).join('\n') + '\n') });
  }
  return { root, files, missing };
}

function readmeOf(w: Words, req: Request, x: { company: string; span: string; now: string; total: number; missing: string[]; banana: boolean; dir: Record<string, string> }): string {
  const { t } = w;
  const chosen = ITEMS.filter((i) => req.items[i.id]?.length).map((i) =>
    `- ${i.id === 'ledger' ? t('export.ledgerOf', { account: req.account || t('reports.noAccount') }) : label(w, i.id)}: ${req.items[i.id]!.map((f) => t(`export.fmt.${f}` as Key)).join(', ')}`);
  return [
    t('export.readmeTitle', { company: x.company, period: x.span }),
    t('export.readmeCreated', { date: `${date(x.now.slice(0, 10))} ${x.now.slice(11, 16)} UTC`, version: appVersion() }),
    '',
    t('export.readmeContents'),
    ...chosen,
    '',
    t('export.readmeFolders', { reports: x.dir.reports, data: x.dir.data, receipts: t('export.dirReceipts'), statements: t('export.dirStatements'), filings: t('export.dirFilings') }),
    t('export.readmeFormat'),
    ...(x.banana ? [t('export.readmeBanana')] : []),
    ...(req.sums ? [t('export.readmeSums')] : []),
    ...(x.missing.length ? [t('export.readmeMissing', { files: x.missing.join(', ') })] : []),
    t('export.readmeFiles', { n: x.total }),
  ].join('\n') + '\n';
}

/** What the browser downloads: the one file as it is, or every file in a ZIP under the root folder. */
export function downloadOf(b: Bundle): { name: string; type: string } {
  if (b.files.length !== 1) return { name: `${b.root}.zip`, type: 'application/zip' };
  const path = b.files[0].path;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const type = { pdf: 'application/pdf', csv: 'text/csv; charset=utf-8', json: 'application/json', tsv: 'text/tab-separated-values; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xml: 'application/xml' }[ext] ?? 'application/octet-stream';
  return { name: `${b.root}_${path.slice(path.lastIndexOf('/') + 1)}`, type };
}

/** The ZIP, chunk by chunk as it is written; PDFs and other originals are stored, text is deflated. */
export function zipBundle(b: Bundle, write: (chunk: Uint8Array) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err);
      write(chunk);
      if (final) resolve();
    });
    for (const f of b.files) {
      const name = `${b.root}/${f.path}`;
      const entry = /\.(pdf|xlsx|png|jpe?g)$/i.test(f.path) ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(f.data, true);
    }
    zip.end();
  });
}

