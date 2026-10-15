import { Router } from 'express';
import type { JournalEntry, QuarterKey } from '../../types/index.js';
import { isIsoDate } from '../../accounting/periods.js';
import { patchBody, stringField, withBooks, RequestError } from '../books.js';
import type { EntrySet } from '../../types/assistant.js';
import { addEntry, deleteEntry, setEntry } from '../edits.js';

export const router = Router();

function amountField(b: Record<string, unknown>): number {
  if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount === 0) throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.');
  return b.amount;
}

router.patch('/api/journal-entries/:id', (req, res) => {
  const b = patchBody(req.body, ['date', 'accountDebit', 'accountCredit', 'vatCode', 'description', 'amount']);
  const set = b as EntrySet;
  if ('amount' in b) set.amount = amountField(b);
  return withBooks(res, (books) => {
    setEntry(books, req.params.id, set);
    return { ok: true };
  });
});

type Origin = NonNullable<JournalEntry['origin']>;
const ORIGINS: readonly Origin[] = ['manual', 'classify', 'invoice', 'year-close'];

/** A new entry booked by hand (src/server/edits.ts addEntry). `id`, the exchange fields and `origin` let an undo put a deleted entry back as it was. */
router.post('/api/journal-entries', (req, res) => {
  const b = patchBody(req.body, ['date', 'accountDebit', 'accountCredit', 'amount', 'vatCode', 'description', 'exchangeCurrency', 'exchangeRate', 'corrects', 'transactionRef', 'id', 'origin']);
  const date = stringField(b, 'date');
  if (!isIsoDate(date)) throw new RequestError(400, 'date: YYYY-MM-DD.');
  const amount = amountField(b);
  const optional = (k: string) => (b[k] === undefined ? undefined : stringField(b, k).trim() || undefined);
  const accountDebit = optional('accountDebit') ?? '';
  const accountCredit = optional('accountCredit') ?? '';
  if (!accountDebit && !accountCredit) throw new RequestError(400, 'Soll- oder Habenkonto fehlt.');
  const description = optional('description');
  if (!description) throw new RequestError(400, 'description darf nicht leer sein.');
  const vatCode = optional('vatCode');
  const exchangeCurrency = optional('exchangeCurrency');
  const exchangeRate = b.exchangeRate === undefined ? undefined : Number(b.exchangeRate);
  if (!exchangeCurrency !== (exchangeRate === undefined)) throw new RequestError(400, 'exchangeCurrency und exchangeRate gehören zusammen.');
  if (exchangeRate !== undefined && !(exchangeRate > 0)) throw new RequestError(400, 'exchangeRate muss grösser als 0 sein.');
  const corrects = optional('corrects');
  const transactionRef = optional('transactionRef');
  const id = optional('id');
  // An undo puts back an entry without an origin (books from before origins) without one.
  const origin = optional('origin') ?? (id ? undefined : 'manual');
  if (origin && !ORIGINS.includes(origin as Origin)) throw new RequestError(400, `origin: ${ORIGINS.join(', ')}.`);

  return withBooks(res, (books) => ({
    entry: addEntry(books, {
      ...(id && { id }),
      ...(transactionRef && { transactionRef }),
      date,
      accountDebit,
      accountCredit,
      amount,
      ...(vatCode && { vatCode }),
      description,
      ...(exchangeCurrency && { exchangeCurrency, exchangeRate }),
      ...(corrects && { corrects }),
      ...(origin && { origin: origin as Origin }),
    }),
  }));
});

router.delete('/api/journal-entries/:id', (req, res) => withBooks(res, (books) => {
  deleteEntry(books, req.params.id);
  return { ok: true };
}));
