import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { JournalEntry, QuarterKey } from '../../types/index.js';
import { isIsoDate, parsePeriod } from '../../accounting/periods.js';
import { nextManualRef } from '../../books/refs.js';
import { assertOpen, patchBody, refDates, stringField, withBooks, RequestError } from '../books.js';

export const router = Router();

function amountField(b: Record<string, unknown>): number {
  if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount === 0) throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.');
  return b.amount;
}

router.patch('/api/journal-entries/:id', (req, res) => {
  const { id } = req.params;
  const b = patchBody(req.body, ['date', 'accountDebit', 'accountCredit', 'vatCode', 'description', 'amount']);
  const updates = b as Partial<{ date: string; accountDebit: string; accountCredit: string; vatCode: string; description: string }>;
  const amount = 'amount' in b ? amountField(b) : undefined;

  return withBooks(res, (books) => {
    const entry = books.journalEntries.find((je) => je.id === id);
    if (!entry) throw new RequestError(404, 'Journal entry not found');
    assertOpen(books, [entry.date, updates.date], 'editEntry');
    if (entry.origin === 'year-close') throw new RequestError(400, 'Die Kursdifferenz berechnet der Jahresabschluss: npm run year:close bucht sie neu.', { code: 'yearClose' });

    if (updates.date !== undefined) entry.date = updates.date;
    if (updates.accountDebit !== undefined) entry.accountDebit = updates.accountDebit;
    if (updates.accountCredit !== undefined) entry.accountCredit = updates.accountCredit;
    if (updates.vatCode !== undefined) entry.vatCode = updates.vatCode || undefined;
    if (updates.description !== undefined) entry.description = updates.description || undefined;
    if (amount !== undefined) entry.amount = amount;
    entry.origin = 'manual';
    return { ok: true };
  });
});

type Origin = NonNullable<JournalEntry['origin']>;
const ORIGINS: readonly Origin[] = ['manual', 'classify', 'invoice', 'year-close'];

/** A ref of its own (M2026-004) needs no transaction: a manual entry stands alone. */
const MANUAL_REF = /^M\d{4}-\d{3,}$/;

/**
 * A new entry booked by hand, dated in the open period. Without `transactionRef` it gets the next
 * free M<year>-NNN; with one it joins that payment's entries, which must be open too. `id` and the
 * exchange fields and `origin` let an undo put a deleted entry back as it was; `corrects` names the filed
 * quarter whose Korrekturabrechnung (0535) declares it.
 */
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
  if (corrects && !/^\d{4}-Q[1-4]$/.test(corrects)) throw new RequestError(400, 'corrects: YYYY-Qn.');
  const transactionRef = optional('transactionRef');
  const id = optional('id');
  // An undo puts back an entry without an origin (books from before origins) without one.
  const origin = optional('origin') ?? (id ? undefined : 'manual');
  if (origin && !ORIGINS.includes(origin as Origin)) throw new RequestError(400, `origin: ${ORIGINS.join(', ')}.`);

  return withBooks(res, (books) => {
    assertOpen(books, [date], 'newEntry');
    const closed = books.config.closedThrough;
    if (corrects && !(closed && parsePeriod(corrects, date)!.to <= closed)) throw new RequestError(400, `corrects: ${corrects} ist nicht eingereicht.`);
    if (id && books.journalEntries.some((je) => je.id === id)) throw new RequestError(409, `Buchung ${id} gibt es schon.`);
    if (transactionRef) {
      const dates = refDates(books, transactionRef);
      if (!dates.length && !MANUAL_REF.test(transactionRef)) throw new RequestError(404, 'Transaction not found');
      assertOpen(books, dates, 'newEntry');
    }
    const entry: JournalEntry = {
      id: id ?? randomBytes(8).toString('hex'),
      transactionRef: transactionRef ?? nextManualRef(books, date.slice(0, 4)),
      date,
      accountDebit,
      accountCredit,
      amount,
      ...(vatCode && { vatCode }),
      description,
      ...(exchangeCurrency && { exchangeCurrency, exchangeRate }),
      ...(corrects && { corrects: corrects as QuarterKey }),
      ...(origin && { origin: origin as Origin }),
    };
    books.journalEntries.push(entry);
    return { entry };
  });
});

router.delete('/api/journal-entries/:id', (req, res) => {
  const { id } = req.params;
  return withBooks(res, (books) => {
    const entry = books.journalEntries.find((je) => je.id === id);
    if (!entry) throw new RequestError(404, 'Journal entry not found');
    assertOpen(books, [entry.date], 'deleteEntry');

    books.journalEntries = books.journalEntries.filter((je) => je.id !== id);
    return { ok: true };
  });
});
