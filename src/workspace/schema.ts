/**
 * The versions of a workspace's data files, and the steps that bring an older file up to
 * date. The one place the versions are listed; docs/releasing.md says when to bump one.
 *
 *   the books              `schema` of ledger.json (books.json before 2; absent: 1)  BOOKS_MIGRATIONS
 *   belege.workspace.yaml  `schema` (absent: 1)  MANIFEST_MIGRATIONS
 *   invoices.json          `schema`              INVOICES_MIGRATIONS (src/invoices/store.ts)
 *   payroll.json           `schema`              PAYROLL_MIGRATIONS (src/payroll/store.ts)
 *
 * A step `n` turns a file of schema n into schema n + 1. Steps are pure, run forward only, and
 * run in memory on every load (src/books/store.ts loadBooks, src/workspace/manifest.ts), so the
 * app reads old files as they are; `npm run update` writes the result back, after a backup.
 * A books step never changes a record dated on or before closedThrough: the seals of the filed
 * quarters (src/books/seal.ts) are checked after it and refuse books it changed.
 */
import { isMap, isSeq, type Document } from 'yaml';
import { roleBefore } from './banks.js';

/**
 * 2: the books split by fiscal year (ADR 0013); the move itself is the layout migration (src/workspace/layout.ts).
 * 3: money accounts as equals (#88): a movement on any money account, a hand movement a statement
 * confirmed (BankTransaction.statement). An app of schema 2 would book a cash box's movement onto
 * its first bank account and import a confirmed row a second time, so it must refuse these books.
 * 4: reporting dimensions (#127): an entry may carry `tags` ({ projekt: "alpha" }) the reports
 * filter and group by. An app of schema 3 would keep the field it does not know on an entry it
 * edits, but not offer it, check it or carry it into the bookings it makes from that entry
 * (a copy, a correction, an undo), so it must refuse these books.
 * 5: bank statements among the receipts are typed and dated on load (#151); no record of a filed
 * period changes, receipts are not sealed; an older app would show them as receipts again, which
 * is harmless, but the number makes npm run update write the result.
 * 6: a receipt still being processed keeps what the person set by hand (#218): `Receipt.handSet`
 * names the date, amount or description she set, so finishing the read never writes over them;
 * emptied once the receipt is filed. An app of schema 5 would read the receipt and overwrite her
 * values, so it must refuse these books.
 * 7: statement PDFs keep their open question in the books (#254): `statementAsks` (asks.jsonl of a
 * year), a PDF whose movements wait for «Einlesen» or «Als Auszug behalten»; `reconciliations`
 * (reconcile.jsonl of a year), an account's movements read from PDFs set against its bank export or
 * CSV, waiting for the person or confirmed, with the days its bank files cover (`covered`) and the read
 * movements named payments of their own (`own`) (src/books/reconcile.ts); and `waitsForPerson.why:
 * 'filedTwin'` with the `read` movement, a bank movement booked in a filed quarter as a movement read
 * from a PDF. An app of schema 6 would drop the questions and reconciliations on its next save and show
 * the mark nowhere, so it must refuse these books.
 * 8: a card statement's lines as parts a receipt is linked to (#409): `Receipt.cardLines`, read by code
 * (src/books/card-lines.ts), and `Mapping.line`, a bill linked to one line of its settlement. Books of
 * schema 7 hold neither: the step adds nothing, so no sealed record and no filed receipt changes; a card
 * statement of an open period gains its lines on the next run of the inbox (its match step; every drop
 * starts one). An app of schema 7 would read a line's bill as a receipt of the whole
 * settlement and could claim its VAT on every line, so it must refuse these books.
 * 9: a receipt counts its failed VAT reads (#450): `Receipt.vatReadFailures`, and from
 * VAT_READ_TRIES on it is unreadable (src/accounting/receipt-due.ts). Books of schema 8 hold no
 * count: the step adds nothing (absent means 0), so no sealed record and no filed receipt changes.
 * An app of schema 8 would not see the count, read such a receipt on every run and leave its payment
 * waiting with no task, so it must refuse these books.
 *    Also in 9 (unreleased until 0.4.2, so no step of its own): a contribution payment code books to the share the
 *    payslips withheld carries `JournalEntry.by: { kind: 'code', check: 'withheldShare' }` (#489,
 *    src/booking/classify.ts bookWithheldShares). Books of schema 8 hold none, so the step adds nothing; an app of
 *    schema 8 would read the unknown check as no `by` and drop who decided the booking on its next save.
 * 10: a receipt keeps the due date a person set (#571): `Receipt.dueDate`, which wins over the one
 * code reads off its text (src/books/due-date.ts). Books of schema 9 hold none: the step adds nothing,
 * so no sealed record and no filed receipt changes. An app of schema 9 would show the text's due date
 * instead of hers and call a bill overdue or open by it, so it must refuse these books.
 * 11: payroll (docs/specs/payroll.md §9.1, owner 2026-11-14 decision 5): `JournalEntry.by.check` may be
 * `payroll` (the entries a payslip closed in the app books, ref `LR-<yyyy>-<mm>-<employee>`), `payslip`
 * (a payslip of another program booked by code) or `payrollJournal` (a payroll program's journal); a
 * receipt may be of kind `payslip`. Books of schema 10 hold none: the step adds nothing, so no sealed
 * record changes. An app of schema 10 would drop the unknown check on its next save and lose who booked
 * the wage, so it must refuse these books.
 */
export const BOOKS_SCHEMA = 11;
/**
 * 2: every money account names its `role` (#88).
 * 3: `company.vat.reportingSince`, the year the basis began (#143). An app of schema 2 would read
 * past it and declare a document of an earlier agreed year on its payment's date, so it must refuse.
 * 4: `company.uid` may be absent (#452): the setup does not ask it; the VAT XML and an invoice with
 * VAT ask for it when they need it. An app of schema 3 would refuse such a manifest with «company.uid
 * must be a non-empty text» instead of saying the app is too old, so it must refuse by the number.
 * 5: the settings of invoicing phase 1 (docs/specs/invoicing.md 4.3): `invoicing.units` (the firm's
 * units with their words in de, fr, it, en), `invoicing.prices` (net or gross per kind),
 * `invoicing.paymentTerms` with `defaultTerms`, `invoicing.writeOffAccount` ({ skonto, loss }) and
 * `invoicing.shortfallLimit`. Absent means the defaults (src/workspace/manifest.ts readInvoicing), so
 * the step changes nothing; an app of schema 4 would refuse these keys as it should, by the number,
 * instead of dropping them on its next save of Firma › Rechnungslayout. Further phase-1 settings
 * ride on this step until it is released.
 */
export const WORKSPACE_SCHEMA = 5;
/**
 * 2: a line may be priced with the VAT in it (`InvoiceLine.vatIncluded`, a credit note of «500 VAT
 * included»). An app of schema 1 would read that price as net and add the VAT to it, so it must refuse.
 * 3: positions of a kind (`InvoiceLine.kind`: item, text, subtotal, discount, pagebreak; an item's
 * `discount` percent) and `prices: 'net' | 'gross'` per document, which replaces the line flag
 * `vatIncluded` (step 2, `pricesOfDocument`). An app of schema 2 would read a Rabatt or a text as a
 * line without price and a gross document's lines as net, so it must refuse.
 *    Also in 3 (unreleased, phase 1 of invoicing, so no step of their own): `InvoiceLine.activity`
 *    (the net tax rate of a position on a firm with two), `payments[].source`, `allocations`,
 *    `writeOffs` and `Issued.terms`. A file of schema 2 holds none: the step adds nothing for them.
 *    Phase 2 (slice F2) adds `Draft.number`, `replaced` and `Issued.accountChanges` (back to draft,
 *    Konten ändern); they need no transform and ride on phase 2's step 3 → 4 (slice G1), so an app of
 *    schema 3 never issues a draft that keeps its number under a new one.
 */
export const INVOICES_SCHEMA = 3;
/** 1: payroll.json starts with dated histories (docs/specs/domain-model.md §5.7), so it needs no step yet. */
export const PAYROLL_SCHEMA = 1;
export const PAYROLL_MIGRATIONS: Ladder<Record<string, unknown>> = {};

/** Step n: schema n → n + 1. */
export type Ladder<T> = Readonly<Record<number, (doc: T) => T>>;

export const BOOKS_MIGRATIONS: Ladder<Record<string, unknown>> = {
  // The records stay as they are; only where they lie changed.
  1: (doc) => doc,
  // The origin was stored already (`source: 'manual'`, absent for a statement row) and a filed
  // record keeps every byte: the records stay; the number makes an older app refuse the books.
  2: (doc) => doc,
  // No record has tags before; the number makes an older app refuse the books.
  3: (doc) => doc,
  // Bank statements among the receipts are typed on every load (src/books/store.ts loadBooks,
  // typeStatements), at any schema; the number says the books may hold typed statements.
  4: (doc) => doc,
  // No receipt has `handSet` before; the number makes an older app refuse the books.
  5: (doc) => doc,
  // No books hold a statement's question or a reconciliation before; the number makes an older app refuse them.
  6: (doc) => doc,
  // No receipt has card lines and no link a line before: nothing is added (an empty `cardLines` would read as «read, no lines»); the number makes an older app refuse them.
  7: (doc) => doc,
  // No receipt counts its failed VAT reads before; absent means none. The number makes an older app refuse the books.
  8: (doc) => doc,
  // No receipt has a due date a person set before; absent means the text's. The number makes an older app refuse the books.
  9: (doc) => doc,
  // No entry carries a payroll check before; the number makes an older app refuse the books.
  10: (doc) => doc,
};
/** On the YAML document, so the comments of the manifest survive the step. */
export const MANIFEST_MIGRATIONS: Ladder<Document> = {
  // Each account gets the role it had implicitly: the owner's for `manual`, a card for a card issuer, else a bank.
  1: (doc) => {
    const seq = doc.get('bankAccounts');
    if (!isSeq(seq)) return doc;
    for (const item of seq.items) if (isMap(item) && !item.has('role')) item.set('role', roleBefore(String(item.get('bank'))));
    return doc;
  },
  // No manifest has the year yet: absent means the basis holds since before the books.
  2: (doc) => doc,
  // Every manifest before has its UID: nothing changes; the number makes an older app refuse one without it.
  3: (doc) => doc,
  // No manifest has the phase-1 invoicing settings before; absent means the defaults. The number makes an older app refuse them.
  4: (doc) => doc,
};

/** The manifest document named at the current schema: its `schema:` set where it stands (its comments with it), else added as the first key. */
export function stampManifest(doc: Document): Document {
  if (!isMap(doc.contents)) throw new Error('belege.workspace.yaml: not a YAML mapping');
  if (doc.contents.has('schema')) doc.contents.set('schema', WORKSPACE_SCHEMA);
  else doc.contents.items.unshift(doc.createPair('schema', WORKSPACE_SCHEMA));
  return doc;
}

/** The manifest as text, written as the Firma page writes it: a one-line `{ … }` stays one line. */
export const manifestText = (doc: Document): string => doc.toString({ lineWidth: 0, doubleQuotedAsJSON: true });
export const INVOICES_MIGRATIONS: Ladder<Record<string, unknown>> = {
  // No line has `vatIncluded` before; the number makes an older app refuse the file.
  1: (doc) => doc,
  // Every line is an item (no `kind`); each document names its prices, and a line keeps `vatIncluded` only where it
  // differs from them; an issued document freezes the words its units printed with.
  2: (doc) => ({ ...doc, invoices: Array.isArray(doc.invoices) ? doc.invoices.map((d) => unitsOfIssued(pricesOfDocument(d))) : doc.invoices }),
};

/** The words the units of schema 2 printed with (src/invoices/texts.ts at 0.6.0). */
const UNITS_OF_SCHEMA_2: Record<string, Record<'de' | 'fr' | 'it' | 'en', string>> = {
  h: { de: 'h', fr: 'h', it: 'h', en: 'h' },
  day: { de: 'Tag', fr: 'jour', it: 'giorno', en: 'day' },
  pcs: { de: 'Stk.', fr: 'pce', it: 'pz.', en: 'pcs' },
  flat: { de: 'pauschal', fr: 'forfait', it: 'forfait', en: 'flat rate' },
  km: { de: 'km', fr: 'km', it: 'km', en: 'km' },
};

/**
 * Step 2 → 3 on an issued document: `units`, the words its units printed with, so a reminder prints
 * them as the invoice did (the app's defaults since name the hour «Std.»).
 */
export function unitsOfIssued(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || (raw as { status?: unknown }).status !== 'issued') return raw;
  const doc = raw as { lines?: Array<{ unit?: unknown }> };
  const named = [...new Set((doc.lines ?? []).flatMap((l) => (typeof l.unit === 'string' && UNITS_OF_SCHEMA_2[l.unit] ? [l.unit] : [])))];
  return named.length ? { ...doc, units: named.map((id) => ({ id, ...UNITS_OF_SCHEMA_2[id] })) } : raw;
}

/**
 * Step 2 → 3 on one document: `prices: 'gross'` when every line at a rate above 0 has
 * `vatIncluded` (a credit note «by amount»), else `net`; a line whose flag equals its document's
 * prices drops it, one that differs keeps it as `true` or `false`, so every figure stays as issued.
 */
export function pricesOfDocument(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { lines?: unknown }).lines)) return raw;
  const doc = raw as { lines: Array<Record<string, unknown>> };
  const taxed = doc.lines.filter((l) => typeof l.vatRate === 'number' && l.vatRate > 0);
  const gross = taxed.length > 0 && taxed.every((l) => l.vatIncluded === true);
  const lines = doc.lines.map((l) => {
    const { vatIncluded, ...rest } = l;
    const own = vatIncluded === true;
    return own === gross || !(typeof l.vatRate === 'number' && l.vatRate > 0) ? rest : { ...rest, vatIncluded: own };
  });
  return { ...doc, prices: gross ? 'gross' : 'net', lines };
}

/** A file written by a newer version of the app than this one. */
export class SchemaTooNewError extends Error {}

/** The schema a file names; a file from before versioning names none and is schema 1. */
export function schemaOf(value: unknown, file: string): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${file}: schema must be a whole number from 1 (found ${String(value)})`);
  return value as number;
}

/** `doc` (schema `from`) brought to `to` by the steps of `ladder`. Pure: `doc` is not changed. */
export function climb<T>(doc: T, from: number, to: number, ladder: Ladder<T>, file: string, clone: (doc: T) => T): T {
  if (from > to) {
    throw new SchemaTooNewError(`${file} has schema ${from}; this version of the app reads up to ${to}. Update the app: npm run update`);
  }
  let out = from < to ? clone(doc) : doc;
  for (let n = from; n < to; n++) {
    const step = ladder[n];
    if (!step) throw new Error(`${file}: no migration from schema ${n} to ${n + 1} (src/workspace/schema.ts)`);
    out = step(out);
  }
  return out;
}
