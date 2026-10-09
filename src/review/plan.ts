/**
 * The owner's view of a review against TODAY's books: what each correction would do now. Pure;
 * the PR view shows it and the merge (src/review/git.ts) applies it inside mutateJournal.
 *
 * - applicable: every record is as the Treuhänder saw it; his changes apply as they are.
 * - alreadySo: the books already look like his result (merged before, or the owner did the same).
 * - conflict: a record changed since his snapshot. Never applied; the owner redoes it by hand if he agrees.
 * - closedPeriod: the quarter was filed since his snapshot. His entry changes become a Storno and
 *   the corrected entry with `corrects`, by the same rule the review package uses (corrections.ts).
 * - refused: it touches a filed quarter and is no entry change (a receipt link, a transaction).
 */
import type { JournalEntry } from '../types/index.js';
import { applyChange, currentOf, type RecordChange } from '../books/changes.js';
import { canonical } from '../books/canonical.js';
import { periodLock } from '../books/lock.js';
import { applied, firstOpenDay, invertVatCode, nextManualRef, quartersOf, seededIds, touchesClosed, vatEffect, type BooksLike, type VatDelta } from './corrections.js';
import { vatQuarterOf } from '../accounting/periods.js';
import type { Correction, ReviewFile } from './types.js';

export type CorrectionStatus = 'applicable' | 'alreadySo' | 'conflict' | 'closedPeriod' | 'refused';

export interface CorrectionPlan {
  correction: Correction;
  status: CorrectionStatus;
  /** What a merge would apply: the correction's changes, or their conversion for a filed quarter. Empty unless applicable or closedPeriod. */
  changes: RecordChange[];
  /** Why it is a conflict or refused. */
  problem?: string;
  /** The VAT figures it moves, per quarter, against the books as the earlier corrections leave them. */
  vat: VatDelta[];
}

const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/**
 * The same correction for books whose period lock moved past it: a filed entry it edits or
 * removes gets a Storno, the entry it should be is booked new, and an entry it adds into a filed
 * quarter moves to the first open day; all with `corrects`. A string says why it cannot be.
 */
function convert(books: BooksLike, correction: Correction, seed: string): RecordChange[] | string {
  const ids = seededIds(seed);
  const day = firstOpenDay(books)!;
  const ref = nextManualRef(books, day.slice(0, 4));
  const lock = periodLock(books);
  const book = (e: JournalEntry, date: string, corrects: string | undefined, description: string): RecordChange => {
    const x: JournalEntry = { ...e, id: ids.entryId(), transactionRef: ref, date, description, origin: 'manual' };
    if (corrects) x.corrects = corrects as JournalEntry['corrects']; else delete x.corrects;
    if (!x.vatCode) delete x.vatCode;
    return { collection: 'entries', key: x.id, after: x };
  };
  const out: RecordChange[] = [];
  for (const c of correction.changes) {
    if (c.collection !== 'entries') return `${c.collection} ${c.key} gehört zu einer eingereichten Periode`;
    const { before, after } = c;
    if (!before) {
      out.push(lock.isClosed(after!.date) ? book(after!, day, after!.corrects ?? vatQuarterOf(after!.date), after!.description ?? '') : c);
      continue;
    }
    if (!same(currentOf(books, c), before)) return `Buchung ${c.key} hat sich seit dem Stand der Prüfung geändert`;
    if (!lock.isClosed(before.date)) {
      if (after && lock.isClosed(after.date)) return `Buchung ${c.key}: das neue Datum liegt in einer eingereichten Periode`;
      out.push(c);
      continue;
    }
    const filed = vatQuarterOf(before.date);
    out.push(book({ ...before, accountDebit: before.accountCredit, accountCredit: before.accountDebit, vatCode: invertVatCode(before.vatCode) }, day, filed, `Korrektur zu ${before.id}: Storno ${before.description ?? ''}`.trim()));
    if (after) {
      const own = after.date !== before.date && !lock.isClosed(after.date);
      out.push(book(after, own ? after.date : day, own ? undefined : filed, `Korrektur zu ${before.id}: ${after.description ?? ''}`.trim()));
    }
  }
  return out;
}

/** One correction planned against `books` (never written). */
export function planCorrection(books: BooksLike, correction: Correction, reviewId: string): CorrectionPlan {
  const result = (status: CorrectionStatus, changes: RecordChange[], problem?: string): CorrectionPlan => {
    const vat = changes.length ? vatEffect(books, applied(books, changes), quartersOf(changes)) : [];
    return { correction, status, changes, problem, vat };
  };
  const probe = structuredClone(books);
  const statuses = correction.changes.map((c) => applyChange(probe, c));
  if (statuses.every((s) => s === 'alreadySo')) return result('alreadySo', []);
  if (correction.changes.some((c) => touchesClosed(books, c))) {
    const converted = convert(books, correction, `${reviewId}/${correction.id}`);
    return typeof converted === 'string' ? result('refused', [], converted) : result('closedPeriod', converted);
  }
  const conflict = correction.changes.find((_, i) => statuses[i] === 'conflict');
  if (conflict) return result('conflict', [], `${conflict.collection} ${conflict.key} hat sich seit dem Stand der Prüfung geändert`);
  return result('applicable', correction.changes.filter((_, i) => statuses[i] === 'applied'));
}

/**
 * Every correction of the review, in order, each planned against `books` as the earlier
 * applicable ones leave them, as if all were merged. Corrections in `decided` are left out.
 */
export function planReview(books: BooksLike, file: ReviewFile, decided: ReadonlySet<string> = new Set()): CorrectionPlan[] {
  let state = structuredClone(books);
  return file.corrections.filter((c) => !decided.has(c.id)).map((correction) => {
    const plan = planCorrection(state, correction, file.id);
    if (plan.changes.length) state = applied(state, plan.changes);
    return plan;
  });
}
