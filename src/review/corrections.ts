/**
 * What a Treuhänder's click does to the books, as record changes (src/books/changes.ts), with
 * golden rule 1 applied the way the owner's app applies it: an edit, a split or a reversal of
 * an entry in a filed quarter becomes correction entries in the open period with `corrects`, and
 * anything else that touches a filed quarter is refused with the owner's own words. Pure and
 * browser-safe: the review package plans in the browser, the owner's merge plans with the same code.
 */
import type { BankTransaction, JournalEntry, QuarterKey, TransactionPatch } from '../types/index.js';
import { applyChange, currentOf, type RecordChange } from '../books/changes.js';
import { canonical } from '../books/canonical.js';
import { assertOpen, ClosedPeriodError, periodLock, refDates, type Books } from '../books/lock.js';
import { addDays, vatQuarterOf } from '../accounting/periods.js';
import { figuresFromBooks } from '../accounting/return-figures.js';
import { parseVatCode } from '../accounting/vat-report.js';
import type { CorrectionKind } from './types.js';

export type BooksLike = Pick<Books, 'journalEntries' | 'transactions' | 'mappings' | 'receipts' | 'bankStatements' | 'config' | 'statementBalances'>;

/** One line of the entry form. */
export interface EntryLine {
  accountDebit: string;
  accountCredit: string;
  amount: number;
  vatCode?: string;
  description?: string;
}

export type EntryPatch = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'amount' | 'vatCode' | 'description' | 'exchangeRate'>>;

/** What the Treuhänder asked for, before golden rule 1 decides how it reaches the books. */
export type Intent =
  | { kind: 'editEntry'; id: string; patch: EntryPatch }
  | { kind: 'splitEntry'; id: string; lines: EntryLine[] }
  | { kind: 'addEntry'; date: string; lines: EntryLine[] }
  | { kind: 'reverseEntry'; id: string }
  | { kind: 'linkReceipt'; ref: string; receiptId: string }
  | { kind: 'unlinkReceipt'; ref: string; receiptId: string }
  | { kind: 'editTransaction'; ref: string; patch: TransactionPatch };

export interface Planned {
  kind: CorrectionKind;
  changes: RecordChange[];
  /** Set when the intent touched a filed quarter and became correction entries. */
  corrects?: QuarterKey;
}

/** New ids and references. The browser draws random ones; the owner's merge derives them from the correction. */
export interface Ids { entryId(): string; manualRef(books: BooksLike, year: string): string }

export class IntentError extends Error {}

const hex16 = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomIds: Ids = {
  entryId: () => hex16(globalThis.crypto.getRandomValues(new Uint8Array(8))),
  manualRef: nextManualRef,
};

/** Ids that are the same every time for the same seed: an owner's re-plan of the same correction books the same entries. */
export function seededIds(seed: string): Ids {
  let n = 0;
  return {
    entryId: () => fnv64(`${seed}#${n++}`),
    manualRef: nextManualRef,
  };
}

function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const c of new TextEncoder().encode(text)) h = BigInt.asUintN(64, (h ^ BigInt(c)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

/** The next M<year>-<nnn> reference, as a manual transaction gets one (src/server/routes/transactions.ts). */
export function nextManualRef(books: BooksLike, year: string): string {
  const prefix = `M${year}-`;
  const used = [...books.transactions.map((t) => t.ref), ...(books.journalEntries ?? []).map((e) => e.transactionRef)]
    .filter((r) => r.startsWith(prefix))
    .map((r) => Number(r.slice(prefix.length)))
    .filter(Number.isFinite);
  return `${prefix}${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
}

/** The first day after the period lock: where a correction of a filed quarter is dated. */
export const firstOpenDay = (books: Pick<Books, 'config'>): string | undefined => {
  const through = periodLock(books).closedThrough;
  return through ? addDays(through, 1) : undefined;
};

/** -I81 for I81 and I81 for -I81: the code of a Storno. */
export const invertVatCode = (code: string | undefined) => (!code ? undefined : code.startsWith('-') ? code.slice(1) : `-${code}`);

function entryOf(books: BooksLike, id: string): JournalEntry {
  const e = (books.journalEntries ?? []).find((x) => x.id === id);
  if (!e) throw new IntentError(`Buchung ${id} gibt es nicht.`);
  return e;
}

const clean = (e: JournalEntry): JournalEntry =>
  Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined && v !== '')) as unknown as JournalEntry;

export function checkLine(l: EntryLine): void {
  if (!/^\d{4}$/.test(l.accountDebit) && l.accountDebit !== '') throw new IntentError(`Soll-Konto ${l.accountDebit} ist kein Konto.`);
  if (!/^\d{4}$/.test(l.accountCredit) && l.accountCredit !== '') throw new IntentError(`Haben-Konto ${l.accountCredit} ist kein Konto.`);
  if (!l.accountDebit && !l.accountCredit) throw new IntentError('Soll oder Haben fehlt.');
  if (!Number.isFinite(l.amount) || l.amount <= 0) throw new IntentError('Der Betrag muss grösser als 0 sein.');
  if (l.vatCode && !parseVatCode(l.vatCode)) throw new IntentError(`MWST-Code ${l.vatCode} gibt es nicht.`);
}

const cents = (x: number) => Math.round(x * 100);

const unchanged = (a: object, b: object) => {
  const { origin: _a, ...x } = a as { origin?: string };
  const { origin: _b, ...y } = b as { origin?: string };
  return canonical(x) === canonical(y);
};

/**
 * The Storno of a filed entry and, for an edit, the entry as it should have been: both new,
 * dated on the first open day (or the edit's own open date), with `corrects` the filed quarter.
 */
function correctionEntries(books: BooksLike, original: JournalEntry, replacements: JournalEntry[], ids: Ids): { entries: JournalEntry[]; corrects: QuarterKey } {
  const day = firstOpenDay(books)!;
  const corrects = vatQuarterOf(original.date);
  const ref = ids.manualRef(books, day.slice(0, 4));
  const lock = periodLock(books);
  const storno = clean({
    ...original,
    id: ids.entryId(),
    transactionRef: ref,
    date: day,
    accountDebit: original.accountCredit,
    accountCredit: original.accountDebit,
    vatCode: invertVatCode(original.vatCode),
    description: `Korrektur zu ${original.id}: Storno ${original.description ?? ''}`.trim(),
    corrects,
    origin: 'manual',
  });
  const fixed = replacements.map((r) => {
    const ownDate = r.date !== original.date && !lock.isClosed(r.date);
    return clean({
      ...r,
      id: ids.entryId(),
      transactionRef: ref,
      date: ownDate ? r.date : day,
      description: `Korrektur zu ${original.id}: ${r.description ?? ''}`.trim(),
      corrects: ownDate ? undefined : corrects,
      origin: 'manual',
    });
  });
  return { entries: [storno, ...fixed], corrects };
}

const added = (e: JournalEntry): RecordChange => ({ collection: 'entries', key: e.id, after: e });

/**
 * The record changes an intent makes to these books, or a ClosedPeriodError with the owner's
 * refusal, or an IntentError for an intent that makes no sense (an unknown entry, lines that do
 * not sum). Never writes `books`.
 */
export function planIntent(books: BooksLike, intent: Intent, ids: Ids = randomIds): Planned {
  const lock = periodLock(books);
  switch (intent.kind) {
    case 'editEntry': {
      const before = entryOf(books, intent.id);
      const after = clean({ ...before, ...intent.patch, origin: 'manual' });
      if (after.vatCode && !parseVatCode(after.vatCode)) throw new IntentError(`MWST-Code ${after.vatCode} gibt es nicht.`);
      if (!Number.isFinite(after.amount) || after.amount <= 0) throw new IntentError('Der Betrag muss grösser als 0 sein.');
      if (lock.isClosed(before.date)) {
        assertOpen(books, [intent.patch.date], 'editEntry');
        const { entries, corrects } = correctionEntries(books, before, [after], ids);
        return { kind: 'editEntry', changes: entries.map(added), corrects };
      }
      assertOpen(books, [after.date], 'editEntry');
      if (unchanged(before, after)) throw new IntentError('Nichts geändert.');
      return { kind: 'editEntry', changes: [{ collection: 'entries', key: before.id, before, after }] };
    }
    case 'splitEntry': {
      const before = entryOf(books, intent.id);
      if (intent.lines.length < 2) throw new IntentError('Eine Aufteilung hat mindestens zwei Zeilen.');
      intent.lines.forEach(checkLine);
      const sum = intent.lines.reduce((s, l) => s + cents(l.amount), 0);
      if (sum !== cents(before.amount)) {
        throw new IntentError(`Die Zeilen ergeben ${(sum / 100).toFixed(2)}, die Buchung ${before.amount.toFixed(2)}.`);
      }
      // A line's own VAT code and text, never the original's: a split line without a code has none.
      const lines = intent.lines.map((l): JournalEntry => clean({ ...before, vatCode: undefined, description: undefined, ...l, origin: 'manual' }));
      if (lock.isClosed(before.date)) {
        const { entries, corrects } = correctionEntries(books, before, lines, ids);
        return { kind: 'splitEntry', changes: entries.map(added), corrects };
      }
      const [first, ...rest] = lines;
      return {
        kind: 'splitEntry',
        changes: [
          { collection: 'entries', key: before.id, before, after: first },
          ...rest.map((l) => added({ ...l, id: ids.entryId() })),
        ],
      };
    }
    case 'addEntry': {
      if (!intent.lines.length) throw new IntentError('Keine Zeile.');
      intent.lines.forEach(checkLine);
      assertOpen(books, [intent.date], 'editEntry');
      const ref = ids.manualRef(books, intent.date.slice(0, 4));
      return {
        kind: 'addEntry',
        changes: intent.lines.map((l) => added(clean({ ...l, id: ids.entryId(), transactionRef: ref, date: intent.date, origin: 'manual' }))),
      };
    }
    case 'reverseEntry': {
      const before = entryOf(books, intent.id);
      if (lock.isClosed(before.date)) {
        const { entries, corrects } = correctionEntries(books, before, [], ids);
        return { kind: 'reverseEntry', changes: entries.map(added), corrects };
      }
      return { kind: 'reverseEntry', changes: [{ collection: 'entries', key: before.id, before }] };
    }
    case 'linkReceipt':
    case 'unlinkReceipt': {
      if (!books.receipts.some((r) => r.id === intent.receiptId)) throw new IntentError(`Beleg ${intent.receiptId} gibt es nicht.`);
      assertOpen(books, refDates(books, intent.ref), 'mapping');
      const key = `${intent.ref} ↔ ${intent.receiptId}`;
      const mapping = { transactionRef: intent.ref, receiptId: intent.receiptId, by: 'human' as const };
      const existing = books.mappings.find((m) => m.transactionRef === intent.ref && m.receiptId === intent.receiptId);
      if (intent.kind === 'linkReceipt') {
        if (existing) throw new IntentError('Der Beleg ist dieser Transaktion schon zugeordnet.');
        return { kind: 'linkReceipt', changes: [{ collection: 'mappings', key, after: mapping }] };
      }
      if (!existing) throw new IntentError('Der Beleg ist dieser Transaktion nicht zugeordnet.');
      return { kind: 'unlinkReceipt', changes: [{ collection: 'mappings', key, before: existing }] };
    }
    case 'editTransaction': {
      const before = books.transactions.find((t) => t.ref === intent.ref);
      if (!before) throw new IntentError(`Transaktion ${intent.ref} gibt es nicht.`);
      assertOpen(books, [before.date], 'editTransaction');
      const after: BankTransaction = { ...before, ...intent.patch };
      if (!after.remarks) delete after.remarks;
      if (!after.noReceiptNeeded) delete after.noReceiptNeeded;
      if (unchanged(before, after)) throw new IntentError('Nichts geändert.');
      return { kind: 'editTransaction', changes: [{ collection: 'transactions', key: before.ref, before, after }] };
    }
  }
}

/** Applies changes to a copy; throws if one does not apply (the books moved under it). */
export function applied<T extends BooksLike>(books: T, changes: RecordChange[]): T {
  const copy = structuredClone(books);
  for (const c of changes) {
    const status = applyChange(copy, c);
    if (status === 'conflict') throw new IntentError(`${c.collection} ${c.key} hat sich geändert.`);
  }
  return copy;
}

export interface VatDelta { quarter: QuarterKey; ziffer: string; before: number; after: number }

/** The quarters whose return a set of changes can move: the dates of its entries and the quarters they correct. */
export function quartersOf(changes: RecordChange[]): QuarterKey[] {
  const qs = new Set<QuarterKey>();
  for (const c of changes) {
    if (c.collection !== 'entries') continue;
    for (const e of [c.before, c.after]) {
      if (!e) continue;
      if (e.corrects) qs.add(e.corrects);
      else if (e.date) qs.add(vatQuarterOf(e.date));
    }
  }
  return [...qs].sort();
}

/** Every Ziffer of each quarter that differs between two states of the books. */
export function vatEffect(before: BooksLike, after: BooksLike, quarters: QuarterKey[]): VatDelta[] {
  const out: VatDelta[] = [];
  for (const q of quarters) {
    const a = figuresFromBooks(before.journalEntries ?? [], q, before.config?.vatAdjustments ?? []).ziffern;
    const b = figuresFromBooks(after.journalEntries ?? [], q, after.config?.vatAdjustments ?? []).ziffern;
    for (const z of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const x = a[z] ?? 0;
      const y = b[z] ?? 0;
      if (cents(x) !== cents(y)) out.push({ quarter: q, ziffer: z, before: x, after: y });
    }
  }
  return out;
}

/** True when a change would be refused by golden rule 1 in these books. */
export function touchesClosed(books: BooksLike, change: RecordChange): boolean {
  const lock = periodLock(books);
  if (change.collection === 'mappings') {
    const m = (change.after ?? change.before)!;
    return refDates(books, m.transactionRef).some(lock.isClosed);
  }
  const now = currentOf(books, change) as { date?: string } | undefined;
  const dates = [now?.date, (change.before as { date?: string } | undefined)?.date, (change.after as { date?: string } | undefined)?.date];
  return dates.some(lock.isClosed);
}

export { ClosedPeriodError };
