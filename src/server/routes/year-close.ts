/**
 * The Jahresabschluss view's API: the year's checklist, and its four actions (book the
 * Kursdifferenz, mark a guided entry, book an entry, close the year, open the next one).
 * Each goes through src/books/year-close.ts, the same code `npm run year:close` runs.
 */
import { Router, type Response } from 'express';
import { isIsoDate } from '../../accounting/periods.js';
import type { TemplateState } from '../../accounting/year-close.js';
import {
  bookEntry, bookRevaluation, closeYear, markTemplate, openingFor, openYear, YearCloseRefused, yearCloseOf,
} from '../../books/year-close.js';
import { RequestError, WS, assertOpen, patchBody, readBooks, stringField } from '../books.js';

export const router = Router();

function yearOf(param: string | undefined): string {
  if (!/^\d{4}$/.test(param ?? '')) throw new RequestError(400, 'Jahr YYYY erwartet.');
  return param!;
}

/** A YearCloseRefused is the user's to fix (409); anything else is the error handler's. */
function answer(res: Response, run: () => unknown): void {
  try {
    res.json(run());
  } catch (e) {
    if (e instanceof YearCloseRefused) throw new RequestError(409, e.message);
    throw e;
  }
}

router.get('/api/year-close/:year', (req, res) => {
  const year = yearOf(req.params.year);
  answer(res, () => {
    const close = yearCloseOf(WS, year);
    return { ...close, opening: close.closed ? openingFor(WS, year) : undefined };
  });
});

router.post('/api/year-close/:year/revaluation', (req, res) => {
  const year = yearOf(req.params.year);
  answer(res, () => ({ entries: bookRevaluation(WS, year) }));
});

router.put('/api/year-close/:year/templates/:id', (req, res) => {
  const year = yearOf(req.params.year);
  const b = patchBody(req.body, ['state']);
  const state = b.state === null ? null : stringField(b, 'state');
  if (state !== null && state !== 'done' && state !== 'na') throw new RequestError(400, 'state: done, na oder null.');
  answer(res, () => markTemplate(WS, year, req.params.id, state as TemplateState | null));
});

router.post('/api/year-close/:year/entries', (req, res) => {
  yearOf(req.params.year);
  const b = patchBody(req.body, ['date', 'accountDebit', 'accountCredit', 'amount', 'vatCode', 'description', 'template']);
  const date = stringField(b, 'date');
  if (!isIsoDate(date)) throw new RequestError(400, 'date: YYYY-MM-DD.');
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new RequestError(400, 'amount muss grösser als 0 sein.');
  const accountDebit = stringField(b, 'accountDebit').trim();
  const accountCredit = stringField(b, 'accountCredit').trim();
  if (!accountDebit && !accountCredit) throw new RequestError(400, 'Soll- oder Habenkonto fehlt.');
  const description = stringField(b, 'description').trim();
  if (!description) throw new RequestError(400, 'description darf nicht leer sein.');
  const vatCode = b.vatCode === undefined ? '' : stringField(b, 'vatCode').trim();
  const template = b.template === undefined ? undefined : stringField(b, 'template');
  assertOpen(readBooks(), [date], 'newTransaction');
  answer(res, () => ({ entry: bookEntry(WS, { date, accountDebit, accountCredit, amount, vatCode: vatCode || undefined, description }, template) }));
});

router.post('/api/year-close/:year/close', (req, res) => {
  const year = yearOf(req.params.year);
  answer(res, () => closeYear(WS, year));
});

router.post('/api/year-close/:year/open', (req, res) => {
  const year = yearOf(req.params.year);
  answer(res, () => openYear(WS, year));
});
