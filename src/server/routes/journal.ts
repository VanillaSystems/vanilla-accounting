import { Router } from 'express';
import { correctionCaseFor, type CorrectionKind } from '../../accounting/correction.js';
import type { JournalEntry, QuarterKey } from '../../types/index.js';
import { isIsoDate } from '../../accounting/periods.js';
import { patchBody, stringField, updateBooks, withBooks, RequestError, WS } from '../books.js';
import { learnFromCorrection, undoAnswer } from '../questions.js';
import type { EntrySet } from '../../types/assistant.js';
import { addEntry, deleteEntry, link, restoreSaved, setEntry } from '../edits.js';
import { handEdits, recordDeletion } from '../../saving/changes.js';
import { parseBookedBy } from '../../books/booked-by.js';
import { bookPaymentAgain } from './automation.js';
import { bookingWarnings } from '../../accounting/booking-warnings.js';
import { bookedState } from '../../accounting/payment-entries.js';
import type { Books } from '../../books/store.js';
import { UNDO_FIELDS } from '../../books/entry-input.js';

export const router = Router();

function amountField(b: Record<string, unknown>): number {
  if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount === 0) throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.');
  return b.amount;
}

type Origin = NonNullable<JournalEntry['origin']>;
const ORIGINS: readonly Origin[] = ['manual', 'classify', 'invoice', 'year-close'];

/** A change by hand. `origin`, `reason` and `by` come only from its undo, which puts the booking back as it was (null: it had none). */
router.patch('/api/journal-entries/:id', (req, res) => {
  const b = patchBody(req.body, ['date', 'accountDebit', 'accountCredit', 'vatCode', 'description', 'amount', 'receipts', 'origin', 'reason', 'by']);
  const set = b as EntrySet;
  if ('amount' in b) set.amount = amountField(b);
  if ('receipts' in b && !(Array.isArray(b.receipts) && b.receipts.every((id) => typeof id === 'string'))) throw new RequestError(400, 'receipts muss eine Liste von Beleg-Ids sein.');
  if ('origin' in b && b.origin !== null && !ORIGINS.includes(b.origin as Origin)) throw new RequestError(400, `origin: ${ORIGINS.join(', ')}.`);
  if ('reason' in b && b.reason !== null && typeof b.reason !== 'string') throw new RequestError(400, 'reason ist ein Text.');
  if ('by' in b && b.by !== null) {
    const by = parseBookedBy(b.by);
    if (!by) throw new RequestError(400, 'by: rule, code, model oder person.');
    set.by = by;
  }
  const { ref, warnings } = updateBooks((books) => {
    setEntry(books, req.params.id, set);
    const e = books.journalEntries.find((x) => x.id === req.params.id)!;
    return { ref: e.transactionRef, warnings: bookingWarnings(books, e) };
  });
  // The sale question follows the booking: a code or an account set by hand answers it, or answers it anew (r10f-22).
  if ('vatCode' in set || 'accountCredit' in set || 'accountDebit' in set) learnFromCorrection([ref]);
  res.json({ ok: true, warnings });
});


/**
 * A new entry booked by hand (src/server/edits.ts addEntry). `id`, the exchange fields, `origin`
 * and the provenance (UNDO_FIELDS: by, rule, reason, run, receipts) let an undo put a deleted entry
 * back as it was (r8f-46); the provenance is taken only with `id`.
 */
router.post('/api/journal-entries', (req, res) => {
  const b = patchBody(req.body, ['date', 'accountDebit', 'accountCredit', 'amount', 'vatCode', 'description', 'exchangeCurrency', 'exchangeRate', 'corrects', 'transactionRef', 'id', 'origin', 'correctsEntry', 'correction', 'receipt', ...UNDO_FIELDS]);
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
  // A correction of a filed entry names it and what was wrong: its case explains the correction return (r8c-6).
  const correctsEntry = optional('correctsEntry');
  const correction = optional('correction');
  if (correction && !(['vat', 'account', 'storno'] as const).includes(correction as CorrectionKind)) throw new RequestError(400, 'correction: vat, account oder storno.');
  if (correctsEntry && !corrects) throw new RequestError(400, 'correctsEntry braucht corrects.');
  const transactionRef = optional('transactionRef');
  const receipt = optional('receipt');
  const id = optional('id');
  // An undo puts back an entry without an origin (books from before origins) without one.
  const origin = optional('origin') ?? (id ? undefined : 'manual');
  if (origin && !ORIGINS.includes(origin as Origin)) throw new RequestError(400, `origin: ${ORIGINS.join(', ')}.`);
  const provenance = provenanceOf(b, !!id);

  return withBooks(res, (books) => {
    const original = correctsEntry ? books.journalEntries.find((e) => e.id === correctsEntry) : undefined;
    if (correctsEntry && !original) throw new RequestError(404, `Buchung ${correctsEntry} gibt es nicht.`, { code: 'gone', params: { what: 'entry' } });
    const entry = addEntry(books, {
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
      // Booked by hand now, not put back by an undo: a person decided it (Änderungen lists it).
      ...(id ? provenance : { by: { kind: 'person' as const, at: new Date().toISOString() } }),
    });
    if (original && corrects) books.config.correctionCases = [...(books.config.correctionCases ?? []), correctionCaseFor(original, entry, (correction ?? 'vat') as CorrectionKind, corrects)];
    // The receipt the booking is for (r10h-6): linked to it, so the receipt shows its booking and the input tax has its voucher;
    // a late receipt of a filed payment points at that payment, which itself takes no link (its quarter is sealed).
    if (receipt) {
      const r = books.receipts.find((x) => x.id === receipt);
      if (!r) throw new RequestError(404, `Beleg ${receipt} gibt es nicht.`, { code: 'gone', params: { what: 'receipt' } });
      if (books.transactions.some((t) => t.ref === entry.transactionRef)) link(books, receipt, entry.transactionRef);
      else books.mappings.push({ transactionRef: entry.transactionRef, receiptId: receipt, by: 'human' });
      if (original && !r.filedPayment && books.transactions.some((t) => t.ref === original.transactionRef)) r.filedPayment = original.transactionRef;
    }
    return withWarnings(books, entry);
  });
});

/** The provenance an undo sends (UNDO_FIELDS), each checked; refused on a new booking, which is its author's. */
function provenanceOf(b: Record<string, unknown>, undo: boolean): Pick<JournalEntry, (typeof UNDO_FIELDS)[number]> {
  const sent = UNDO_FIELDS.filter((k) => b[k] !== undefined);
  if (!sent.length) return {};
  if (!undo) throw new RequestError(400, `Nur ein Rückgängig (mit id) setzt ${sent.join(', ')}.`);
  const out: Pick<JournalEntry, (typeof UNDO_FIELDS)[number]> = {};
  if (b.by !== undefined) {
    const by = parseBookedBy(b.by);
    if (!by) throw new RequestError(400, 'by: rule, code, model, person oder assistant.');
    out.by = by;
  }
  for (const k of ['rule', 'reason', 'run'] as const) if (b[k] !== undefined) out[k] = stringField(b, k);
  if (b.receipts !== undefined) {
    if (!(Array.isArray(b.receipts) && b.receipts.every((r) => typeof r === 'string'))) throw new RequestError(400, 'receipts muss eine Liste von Beleg-Ids sein.');
    out.receipts = b.receipts as string[];
  }
  return out;
}

/** The saved booking with what code can say against it (r8k-8): a warning, never a refusal. */
const withWarnings = (books: Books, entry: JournalEntry) => ({ entry, warnings: bookingWarnings(books, entry) });

/**
 * Änderungen › «Rückgängig» of a booking a person changed or made since the last save: back as
 * saved, or gone. A bank payment the undo leaves without a booking gets its booking run again, so
 * the question the person had answered by booking it is back under Aufgaben (r8k-6). A booking an
 * answer changed is taken back with the answer: the booking as before it (and the payer rule an
 * answer kept before #38, with that rule's bookings), the question open again (r9n-20, src/server/questions.ts undoAnswer).
 */
router.post('/api/journal-entries/:id/as-saved', async (req, res) => {
  const edit = (await handEdits(WS)).find((h) => h.id === req.params.id);
  if (!edit) throw new RequestError(404, 'Diese Buchung hat seit dem letzten Speichern keine Änderung von Hand.', { code: 'gone', params: { what: 'handEdit' } });
  if (edit.answer) { undoAnswer(edit.answer, WS.company.owner); res.json({ ok: true, answer: edit.answer }); return; }
  const unbooked = updateBooks((books) => {
    restoreSaved(books, edit.id, edit.saved, edit.kept);
    // Not booked any more: no entry left, or the lines left fall short of the payment (one line of a split undone, r9k-2).
    return books.transactions.some((t) => t.ref === edit.ref && t.source !== 'manual') && bookedState(books, edit.ref, WS.bankAccounts) !== 'booked';
  });
  if (unbooked) await bookPaymentAgain(edit.ref);
  res.json({ ok: true });
});

/** A deletion by hand: the booking goes, and is recorded for Änderungen's «Rückgängig» also when no save held it (r7h-31). */
router.delete('/api/journal-entries/:id', (req, res) => withBooks(res, (books) => {
  const gone = deleteEntry(books, req.params.id);
  recordDeletion(WS, gone, books.journalEntries.filter((e) => e.transactionRef === gone.transactionRef).map((e) => e.id));
  return { ok: true };
}));
