/**
 * Löhne › Einstellungen › Sozialversicherungen › Quellensteuer and Dokumente (docs/specs/payroll.md §3f,
 * phase B2): the tariff files the workspace has and the regions its people need, «Tarif laden» (fetched
 * from the jurisdiction's source, or a file the person uploads), and the settlement list per region and
 * month with its CSV. A new file a closed payslip would compute otherwise answers with the card of §19.3
 * and changes nothing until the request says how (`backdated`). The files lie in data/, not in the books;
 * a correction is an event of payslips.jsonl, booked when the next open month closes.
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { unzipSync } from 'fflate';
import { WS, readBooks } from '../books.js';
import { periodLock } from '../../books/store.js';
import { valueOn } from '../../core/dated.js';
import { PayrollRefusal } from '../../payroll/close.js';
import { csv } from '../../payroll/documents.js';
import { firmWageTypes } from '../../payroll/catalogue.js';
import { payrollContext } from '../../payroll/service.js';
import { settlementsOf } from '../../payroll/settlement.js';
import { loadTariff } from '../../payroll/tariff-load.js';
import { TariffError, tariffIndexes } from '../../payroll/tariffs.js';
import type { ApiErrorBody } from '../../types/api-error.js';

export const router = Router();

const today = () => new Date().toISOString().slice(0, 10);
const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});

const run = (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve().then(() => fn(req, res)).catch((e) => {
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
  const needed = [...new Set(ctx.store.employees.flatMap((e) => (e.taxAtSource ?? []).filter((x) => x.value.subject && x.value.canton).map((x) => x.value.canton!.toUpperCase())))].sort();
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
router.post('/api/payroll/tariffs/:region/:year/file', express.raw({ type: () => true, limit: '20mb' }), run(async (req, res) => {
  const region = regionParam(req.params.region); const year = yearParam(req.params.year);
  const raw = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
  if (!raw.length) throw new PayrollRefusal('badInput', 'Keine Datei.');
  // A zip (PK…) holds the text file: the one inside it.
  const bytes = raw[0] === 0x50 && raw[1] === 0x4b ? Object.values(unzipSync(raw)).find((x) => x.length) ?? raw : raw;
  res.json(await loadTariff(WS, region, year, { bytes, backdated: backdatedOf(req.query.backdated), isClosed: isClosed() }));
}));

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
    const tax = valueOn(e?.taxAtSource, `${s.month}-28`);
    return [s.month, s.region, r.employee, r.name, e?.socialSecurityNumber, e?.birthDate, tax?.municipality, r.code, r.wage, r.income, r.rate, r.tax, r.commission, r.corrects.join(' ')];
  }));
  const totals = lists.map((s) => [s.month, s.region, '', 'Total', '', '', '', '', s.totals.wage, undefined, undefined, s.totals.tax, s.totals.commission, `payable ${s.totals.payable.toFixed(2)}`]);
  const name = `quellensteuer-${year}${month ? `-${month.slice(5)}` : ''}${region ? `-${region.toLowerCase()}` : ''}.csv`;
  res.set('Cache-Control', 'no-store').type('text/csv; charset=utf-8').attachment(name).send(`﻿${csv([head, ...rows, ...totals])}`);
}));
