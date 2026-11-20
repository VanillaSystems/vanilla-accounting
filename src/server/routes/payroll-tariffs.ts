/**
 * Löhne › Einstellungen › Sozialversicherungen › Quellensteuer and Dokumente (docs/specs/payroll.md §3f,
 * phase B2): the tariff files the workspace has and the regions its people need, «Tarif laden» (fetched
 * from the jurisdiction's source, or a file the person uploads), and the settlement list per region and
 * month with its CSV. A new file a closed payslip would compute otherwise answers with the card of §19.3
 * and changes nothing until the request says how (`backdated`). The files lie in data/, not in the books;
 * a correction is an event of payslips.jsonl, booked when the next open month closes.
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { WS, readBooks } from '../books.js';
import { periodLock } from '../../books/store.js';
import { entriesWithin, valueOn } from '../../core/dated.js';
import { PayrollRefusal } from '../../payroll/close.js';
import { csv } from '../../payroll/documents.js';
import { firmWageTypes } from '../../payroll/catalogue.js';
import { payrollContext } from '../../payroll/service.js';
import { settlementsOf } from '../../payroll/settlement.js';
import { loadTariff } from '../../payroll/tariff-load.js';
import { TariffError, tariffBytesOf, tariffIndexes } from '../../payroll/tariffs.js';
import type { ApiErrorBody } from '../../types/api-error.js';

export const router = Router();

const today = () => new Date().toISOString().slice(0, 10);
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});

/** The most an uploaded tariff file (its text or its zip) may be: the largest canton's text is about 7 MB. */
const UPLOAD_LIMIT_MB = 20;
const tooLarge = (res: Response, mb: number) => res.status(413).json({ error: `Die Datei ist grösser als ${mb} MB: höchstens ${mb} MB pro Tarifdatei.`, code: 'payroll', params: { why: 'tariff', tariff: 'tooLarge', limit: `${mb} MB` } } satisfies ApiErrorBody);

const run = (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (e instanceof TariffError && e.why === 'tooLarge') return void tooLarge(res, UPLOAD_LIMIT_MB);
    if (e instanceof TariffError) return void res.status(e.why === 'network' ? 502 : e.why === 'notFound' ? 404 : 400).json({ error: e.message, code: 'payroll', params: { why: 'tariff', tariff: e.why } } satisfies ApiErrorBody);
    if (e instanceof PayrollRefusal) return void res.status(e.code === 'closedPeriod' ? 403 : 400).json({ error: e.message, code: 'payroll', params: { why: e.code } } satisfies ApiErrorBody);
    next(e);
  });
};

const regionParam = (v: unknown): string => {
  const r = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(r)) throw new PayrollRefusal('badInput', `${r || '–'} ist kein Kanton (zwei Buchstaben).`);
  return r;
};
const yearParam = (v: unknown): string => {
  const y = String(v ?? '');
  if (!/^\d{4}$/.test(y)) throw new PayrollRefusal('badInput', `${y || '–'} ist kein Jahr.`);
  return y;
};
const backdatedOf = (v: unknown): 'correct' | 'keep' | undefined => {
  if (v === undefined) return undefined;
  if (v !== 'correct' && v !== 'keep') throw new PayrollRefusal('badInput', 'backdated: correct oder keep.');
  return v;
};

/** The files the workspace has (each region and year, the current version and the earlier ones) and the regions its people need. */
router.get('/api/payroll/tariffs', run((req, res) => {
  const ctx = payrollContext(WS);
  const year = /^\d{4}$/.test(String(req.query.year ?? '')) ? String(req.query.year) : today().slice(0, 4);
  // The cantons a person is subject in on a day of the year.
  const needed = [...new Set(ctx.store.employees.flatMap((e) => entriesWithin(e.taxAtSource, `${year}-01-01`, `${year}-12-31`).flatMap((s) => (s.entry?.value.subject && s.entry.value.canton ? [s.entry.value.canton.toUpperCase()] : []))))].sort();
  res.json({
    year,
    files: tariffIndexes(WS),
    needed,
    regions: Object.entries(ctx.data.taxAtSource?.regions ?? {}).map(([region, r]) => ({ region, model: r.model })),
    page: ctx.data.taxAtSource?.file.page,
  });
}));

const isClosed = () => { const lock = periodLock(readBooks()); return (d: string) => lock.isClosed(d); };

/** «Tarif laden»: fetches the file of a region and year; a new version goes through the card first. */
router.post('/api/payroll/tariffs', run(async (req, res) => {
  const b = body(req);
  res.json(await loadTariff(WS, regionParam(b.region), yearParam(b.year), { backdated: backdatedOf(b.backdated), isClosed: isClosed() }));
}));

/** The same with a file the person downloaded herself (the text file or its zip): for a computer without the network. */
router.post('/api/payroll/tariffs/:region/:year/file', express.raw({ type: () => true, limit: `${UPLOAD_LIMIT_MB}mb` }), run(async (req, res) => {
  const region = regionParam(req.params.region); const year = yearParam(req.params.year);
  // A body sent as JSON was read by the app's JSON parser already: it is no file.
  if (!Buffer.isBuffer(req.body)) return void res.status(415).json({ error: 'Eine Tarifdatei kommt als Datei (application/octet-stream), nicht als JSON.', code: 'payroll', params: { why: 'tariff', tariff: 'notAFile' } } satisfies ApiErrorBody);
  const raw = new Uint8Array(req.body);
  if (!raw.length) throw new PayrollRefusal('badInput', 'Keine Datei.');
  // A zip holds the region's text file, found by its name (tarJJkt.txt), never the first entry.
  const bytes = tariffBytesOf(raw, region, year);
  res.json(await loadTariff(WS, region, year, { bytes, backdated: backdatedOf(req.query.backdated), isClosed: isClosed() }));
}));

/**
 * The upload's refusals before the route reads it (the API's error handler asks): a body over the limit, a body
 * sent as JSON that is none. True when it answered.
 */
export function tariffUploadRefusal(err: unknown, req: Request, res: Response): boolean {
  if (!/^\/api\/payroll\/tariffs\/[^/]+\/[^/]+\/file$/.test(req.path)) return false;
  const type = (err as { type?: string } | undefined)?.type;
  if (type === 'entity.too.large') { tooLarge(res, UPLOAD_LIMIT_MB); return true; }
  if (type === 'entity.parse.failed') { res.status(415).json({ error: 'Eine Tarifdatei kommt als Datei (application/octet-stream), nicht als JSON.', code: 'payroll', params: { why: 'tariff', tariff: 'notAFile' } } satisfies ApiErrorBody); return true; }
  return false;
}

/** The settlement lists of a year: per month and region, from the closed payslips. */
router.get('/api/payroll/documents/:year/tax-at-source', run((req, res) => {
  const year = yearParam(req.params.year);
  const ctx = payrollContext(WS);
  res.json({ year, settlements: settlementsOf([...ctx.history.closed.values()], year, ctx.data, firmWageTypes(ctx.data, ctx.store), ctx.store) });
}));

/** One settlement list as a table (or the year's, without ?month): with the social security numbers, never cached. */
router.get('/payroll/documents/:year/tax-at-source.csv', run((req, res) => {
  const year = yearParam(req.params.year);
  const month = typeof req.query.month === 'string' ? req.query.month : undefined;
  const region = typeof req.query.region === 'string' ? req.query.region.toUpperCase() : undefined;
  const ctx = payrollContext(WS);
  const lists = settlementsOf([...ctx.history.closed.values()], year, ctx.data, firmWageTypes(ctx.data, ctx.store), ctx.store)
    .filter((s) => (!month || s.month === month) && (!region || s.region === region));
  const person = (id: string) => ctx.store.employees.find((e) => e.id === id);
  const head = ['month', 'region', 'employee', 'name', 'ssn', 'birthDate', 'municipality', 'code', 'wage', 'rateIncome', 'rate', 'tax', 'commission', 'corrects'];
  const rows = lists.flatMap((s) => s.rows.map((r) => {
    const e = person(r.employee);
    // A correction row names the municipality of the month it corrects.
    const tax = valueOn(e?.taxAtSource, `${r.corrects ?? s.month}-28`);
    return [s.month, s.region, r.employee, r.name, e?.socialSecurityNumber, e?.birthDate, tax?.municipality, r.code, r.wage, r.income, r.rate, r.tax, r.commission, r.corrects ?? (r.yearEnd ? `year ${year}` : '')];
  }));
  const totals = lists.map((s) => [s.month, s.region, '', 'Total', '', '', '', '', s.totals.wage, undefined, undefined, s.totals.tax, s.totals.commission, `payable ${s.totals.payable.toFixed(2)}`]);
  const name = `quellensteuer-${year}${month ? `-${month.slice(5)}` : ''}${region ? `-${region.toLowerCase()}` : ''}.csv`;
  res.set('Cache-Control', 'no-store').type('text/csv; charset=utf-8').attachment(name).send(`﻿${csv([head, ...rows, ...totals])}`);
}));
