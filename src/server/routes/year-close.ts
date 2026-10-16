/**
 * The Jahresabschluss view's API: the year's checklist, and its four actions (book the
 * Kursdifferenz, mark a guided entry, book an entry, close the year, open the next one).
 * Each goes through src/books/year-close.ts, the same code `npm run year:close` runs.
 */
import { Router, type Response } from 'express';
import { isIsoDate } from '../../accounting/periods.js';
import type { TemplateState } from '../../accounting/year-close.js';
import {
  bookEntry, bookRevaluation, closeYear, markTemplate, openingFor, openYear, reopenTemplate, YearCloseRefused, yearCloseOf,
} from '../../books/year-close.js';
import { RequestError, WS, assertOpen, patchBody, readBooks, stringField } from '../books.js';

export const router = Router();

function yearOf(param: string | undefined): string {
  if (!/^\d{4}$/.test(param ?? '')) throw new RequestError(400, 'Jahr YYYY erwartet.');
  return param!;
}

/** A YearCloseRefused is the user's to fix (409); anything else is the error handler's. Every route awaits it: a rejection nobody awaits leaves the request hanging (r5f-23). */
async function answer(res: Response, run: () => unknown): Promise<void> {
  try {
    res.json(await run());
  } catch (e) {
    // The account refusal has the UI's words already (error.unknownAccount); the others are shown by their `runWhy` code.
    if (e instanceof YearCloseRefused) throw new RequestError(409, e.message, e.why.code === 'accountNotInChart' ? { code: 'unknownAccount', params: { account: e.why.params.account } } : undefined);
    throw e;
  }
}

router.get('/api/year-close/:year', async (req, res) => {
  const year = yearOf(req.params.year);
  await answer(res, () => {
    const close = yearCloseOf(WS, year);
    return { ...close, opening: close.closed ? openingFor(WS, year) : undefined };
  });
});

router.post('/api/year-close/:year/revaluation', async (req, res) => {
  const year = yearOf(req.params.year);
  await answer(res, () => ({ entries: bookRevaluation(WS, year) }));
});

router.put('/api/year-close/:year/templates/:id', async (req, res) => {
  const year = yearOf(req.params.year);
  const b = patchBody(req.body, ['state']);
  const state = b.state === null ? null : stringField(b, 'state');
  if (state !== null && state !== 'done' && state !== 'na') throw new RequestError(400, 'state: done, na oder null.');
  // Open again: the booking the step made goes with it, and the answer names it for the toast and its undo (r9c-16).
  await answer(res, () => (state === null ? reopenTemplate(WS, year, req.params.id) : markTemplate(WS, year, req.params.id, state as TemplateState)));
});

router.post('/api/year-close/:year/entries', async (req, res) => {
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
  await answer(res, () => ({ entry: bookEntry(WS, { date, accountDebit, accountCredit, amount, vatCode: vatCode || undefined, description }, template) }));
});

router.post('/api/year-close/:year/close', async (req, res) => {
  const year = yearOf(req.params.year);
  await answer(res, () => closeYear(WS, year));
});

router.post('/api/year-close/:year/open', async (req, res) => {
  const year = yearOf(req.params.year);
  await answer(res, () => openYear(WS, year));
});
