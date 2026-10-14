/**
 * The actions of the workflow year-close (workflows/year-close): the exchange differences on
 * 31.12., then, after the person's review, the close of the year (closedThrough to 31.12., the
 * fourth quarter sealed) and the next year's opening. They are the Year-end page's own functions
 * (src/books/year-close.ts); a refusal (an item still open, a rate not published) gets the run
 * stuck with its reason, and «Weiter» takes it up again once that is settled.
 */
import { bookRevaluation, closeYear, openYear } from '../books/year-close.js';
import type { Action } from './actions.js';

const yearOf = (input: Record<string, unknown>): string => {
  const year = String(input.year ?? '');
  if (!/^\d{4}$/.test(year)) throw new Error(`"${year}" is no year`);
  return year;
};

export const YEAR_END_ACTIONS: Record<string, Action> = {
  'accounting.ledger.currencies': {
    outcomes: ['ok'],
    effects: ['books.year-end'],
    run(input, _fx, { ws }) {
      const entries = bookRevaluation(ws, yearOf(input));
      return { outcome: 'ok', output: { revaluation: entries.map((e) => e.id) } };
    },
  },
  'books.close-year': {
    outcomes: ['ok'],
    effects: ['books.close-year'],
    async run(input, _fx, { ws }) {
      const r = await closeYear(ws, yearOf(input));
      return { outcome: 'ok', output: { closed: r.closedThrough } };
    },
  },
  'accounting.ledger.opening-balances': {
    outcomes: ['ok'],
    effects: ['books.open-year'],
    async run(input, _fx, { ws }) {
      const r = await openYear(ws, yearOf(input));
      return { outcome: 'ok', output: { opened: r.opening.year } };
    },
  },
};
