/**
 * What a person does to an entry, each one write through the API and then the books loaded again.
 * Every change says what it did in the toast and can be taken back there (or with ⌘Z): the undo is
 * the opposite write. A refusal (a filed quarter, the year-end revaluation) shows in the toast.
 */
import type { JournalEntry } from '../../../types/index.js';
import type { BookingLine } from '../../../accounting/manual-booking.js';
import { api, errorText, type JournalEntryInput, type JournalEntryPatch } from '../../lib/api.js';
import { undoInput } from '../../../books/entry-input.js';
import { t } from '../../i18n/index.js';
import { fmt } from '../../lib/utils.js';
import type { Nav } from '../index.js';

async function run<T>(nav: Nav, call: () => Promise<T>, message: (r: T) => string, undo?: (r: T) => Promise<unknown>): Promise<T | undefined> {
  let result: T;
  try {
    result = await call();
  } catch (e) {
    nav.toast(errorText(e));
    return undefined;
  }
  nav.refresh();
  nav.toast(message(result), undo && (() => { undo(result).then(nav.refresh, (e) => nav.toast(errorText(e))); }));
  return result;
}

export type Field = 'accountDebit' | 'accountCredit' | 'vatCode' | 'amount' | 'description' | 'tags';

/** Saves the fields that changed; undo writes back what they were. */
export function saveEntry(nav: Nav, e: JournalEntry, patch: JournalEntryPatch, changed: Field[]) {
  // The undo puts the booking back as it was, with who decided it and why.
  const back: JournalEntryPatch = { origin: e.origin ?? null, reason: e.reason ?? null, by: e.by ?? null };
  for (const f of changed) Object.assign(back, { [f]: f === 'vatCode' || f === 'description' ? e[f] ?? '' : f === 'tags' ? e.tags ?? null : e[f] });
  const fields = changed.map((f) => t(`journal.field.${f}`)).join(', ');
  return run(nav, () => api.patchJournalEntry(e.id, patch), () => t('journal.saved', { fields }), () => api.patchJournalEntry(e.id, back));
}

/** A receipt hung on a booking without a payment (#89); the undo takes it off again. */
export const linkReceipt = (nav: Nav, receiptId: string, ref: string, what: string) =>
  run(nav, () => api.addMapping({ receiptId, transactionRef: ref }), () => t('receipts.linkedTo', { what }), () => api.removeMapping({ receiptId, transactionRef: ref }));

export const deleteEntry = (nav: Nav, e: JournalEntry) =>
  run(nav, () => api.deleteJournalEntry(e.id), () => t('journal.deleted', { id: e.transactionRef }), () => api.createJournalEntry(undoInput(e)));

/** A booking in a toast: Soll / Haben, its code, its amount (r8c-21: not the bank's reference). */
export const bookingLine = (e: Pick<JournalEntry, 'accountDebit' | 'accountCredit' | 'vatCode' | 'amount'>): string =>
  `${e.accountDebit || '–'} / ${e.accountCredit || '–'}${e.vatCode ? ` ${e.vatCode}` : ''} · ${fmt(e.amount)}`;

export const createEntry = (nav: Nav, input: JournalEntryInput) =>
  run(nav, () => api.createJournalEntry(input), (entry) => t('journal.created', { line: bookingLine(entry) }), (entry) => api.deleteJournalEntry(entry.id));

/** An accrual and its reversal on the next 1.1., booked in one step; undo removes both. */
export const createWithReversal = (nav: Nav, input: JournalEntryInput, reversal: JournalEntryInput) =>
  run(nav, async () => {
    const entry = await api.createJournalEntry(input);
    try {
      return { entry, back: await api.createJournalEntry(reversal) };
    } catch (e) {
      await api.deleteJournalEntry(entry.id);
      throw e;
    }
  }, ({ entry, back }) => t('journal.createdReversed', { ref: entry.transactionRef, back: back.transactionRef, date: back.date.split('-').reverse().join('.') }), async ({ entry, back }) => {
    await api.deleteJournalEntry(back.id);
    await api.deleteJournalEntry(entry.id);
  }).then((r) => r?.entry);

/**
 * The payment booked again by the classifier (it asks the model). `overwrite`: the person said a
 * booking of hers may go (the API refuses otherwise). Undo removes its entries and puts the ones
 * before back.
 */
export function reclassify(nav: Nav, ref: string, before: JournalEntry[], overwrite = false) {
  return run(nav, () => api.classifyTransaction(ref, overwrite), (entries) => t('journal.reclassified', { n: entries.length }), async (entries) => {
    for (const e of entries) await api.deleteJournalEntry(e.id);
    for (const e of before) await api.createJournalEntry(undoInput(e));
  });
}

/** A payment booked by hand in one or more lines (src/server/edits.ts bookPayment); undo deletes them again. */
export const bookPayment = (nav: Nav, ref: string, lines: BookingLine[]) =>
  run(nav, () => api.bookPayment(ref, lines), (entries) => (entries.length > 1 ? t('journal.byHand.booked', { n: entries.length, ref }) : t('journal.created', { line: bookingLine(entries[0]) })), async (entries) => {
    for (const e of entries) await api.deleteJournalEntry(e.id);
  });

/** A booking typed without its payment tied to it (src/server/edits.ts attachEntries); undo puts its entries back as they were. */
export const attachEntries = (nav: Nav, ref: string, own: string) =>
  run(nav, () => api.attachEntries(ref, own), () => t('journal.attached', { own, ref }), async (before) => {
    for (const e of before) await api.deleteJournalEntry(e.id);
    for (const e of before) await api.createJournalEntry(undoInput(e));
  });
