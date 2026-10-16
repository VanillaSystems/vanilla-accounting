/**
 * Reports over HTTP (src/reports/): a spec run against the books, and as a file. Both only read
 * the books, so they answer in audit mode too (READONLY=1).
 *
 *   POST /api/reports/run    { spec, period? } → { result }
 *   POST /api/reports/file   { spec, period?, format: pdf | csv, language } → the file
 */
import { Router } from 'express';
import { localToday, parsePeriod, type Period } from '../../accounting/periods.js';
import { vat } from '../../engines/index.js';
import { invoiceFontCss } from '../../invoices/fonts.js';
import { NoBrowserError, printPdf } from '../../invoices/pdf.js';
import { loadInvoices } from '../../invoices/store.js';
import { wordsIn } from '../../export/texts.js';
import { accountsOf } from '../../workspace/reads.js';
import { checkSpec, parseSpec, type ReportRefusal, type ReportSpec } from '../../reports/spec.js';
import { runReport, type ReportResult } from '../../reports/run.js';
import { reportCsv, reportFileName, reportHtml } from '../../reports/files.js';
import { refusalText } from '../../reports/words.js';
import { RequestError, WS, readBooks } from '../books.js';

export const router = Router();

export const chartNames = (): Record<string, string> =>
  Object.fromEntries((accountsOf(WS) as Array<{ number: unknown; name: string }>).map((a) => [String(a.number), a.name]));

/** A spec's refusal as the API's 400: German text, and the code the UI says in the person's words. */
export const refused = (r: ReportRefusal): RequestError =>
  new RequestError(400, wordsIn('de').t('error.report', { why: refusalText(r, wordsIn('de').t) }), { code: 'report', params: { refusal: r } });

/** Why this firm's chart or VAT codes refuse a spec, if they do. */
export const factsRefusal = (spec: ReportSpec): ReportRefusal | undefined =>
  checkSpec(spec, { accounts: chartNames(), takesCode: (c) => !!vat().codes.parse(c) });

/** The spec as sent, checked in its shape and against this firm's chart and VAT codes; throws the refusal. */
export function specOf(raw: unknown): ReportSpec {
  const p = parseSpec(raw);
  if (!p.ok) throw refused(p.refusal);
  const r = factsRefusal(p.value);
  if (r) throw refused(r);
  return p.value;
}

/** The period a run asks for, else the spec's own. */
function periodOf(spec: ReportSpec, token: unknown): Period {
  const t = typeof token === 'string' && token ? token : spec.period;
  const p = parsePeriod(t, localToday());
  if (!p) throw refused({ code: 'period', params: { period: t } });
  return p;
}

export function runSpec(spec: ReportSpec, period?: unknown): ReportResult {
  return runReport(spec, { books: readBooks(), invoices: loadInvoices(WS).invoices, names: chartNames() }, periodOf(spec, period));
}

router.post('/api/reports/run', (req, res) => {
  const b = (req.body ?? {}) as { spec?: unknown; period?: unknown };
  res.json({ result: runSpec(specOf(b.spec), b.period) });
});

router.post('/api/reports/file', async (req, res) => {
  const b = (req.body ?? {}) as { spec?: unknown; period?: unknown; format?: unknown; language?: unknown };
  if (b.format !== 'pdf' && b.format !== 'csv') throw new RequestError(400, 'format: pdf oder csv.');
  const result = runSpec(specOf(b.spec), b.period);
  const words = wordsIn(typeof b.language === 'string' ? b.language : 'de');
  const name = reportFileName(result, b.format);
  let data: Buffer;
  if (b.format === 'csv') data = Buffer.from(reportCsv(result, words));
  else {
    const now = new Date().toISOString();
    data = await printPdf(reportHtml(result, words, { company: WS.company.name, fonts: invoiceFontCss(), now }), now).catch((e: unknown) => {
      throw e instanceof NoBrowserError ? new RequestError(503, e.message, { code: 'noBrowser' }) : e;
    });
  }
  res.setHeader('Content-Type', b.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.end(data);
});
