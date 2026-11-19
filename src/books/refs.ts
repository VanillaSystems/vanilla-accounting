/** A ref of its own (M2026-004): a manual transaction's, or an entry's that has no payment. */
export const isManualRef = (ref: string): boolean => /^M\d{4}-\d{3,}$/.test(ref);

/**
 * A ref the books give by a pattern of their own: a manual ref, or one that ends as a Storno or a
 * write-off of another (`-storno`, `-wo-<k>`). A document number whose ref would read so is refused
 * (src/workspace/numbering.ts checkFormat `reserved`).
 */
export const isReservedRef = (ref: string): boolean => isManualRef(ref) || /-(storno|wo-\d+)$/i.test(ref);

/** The VAT events of an issued document on the agreed basis (src/invoices/events.ts): its issue, and its cancellation. */
export type EventKind = 'issue' | 'storno';

/**
 * The ref an event's entries carry: RE-2026-001 for an invoice, GS-2026-004 for a credit note, -storno for a
 * cancellation. A number that begins with a letter has its own prefix (RE-2026-00001 of the series of
 * invoicing phase 2): it is the ref itself, never «RE-RE-2026-00001». Refs are only compared, never parsed;
 * issuing refuses a number whose ref another document's already is (src/invoices/rules.ts, `refTaken`).
 */
export const docRef = (doc: { number: string; kind: string }): string =>
  /^[A-Za-z]/.test(doc.number) ? doc.number : `${doc.kind === 'credit-note' ? 'GS' : 'RE'}-${doc.number}`;

export const eventRef = (doc: { number: string; kind: string }, kind: EventKind): string =>
  `${docRef(doc)}${kind === 'storno' ? '-storno' : ''}`;

/**
 * The ref of an invoice's write-off on the agreed basis (src/invoices/payments.ts bookWriteOff):
 * RE-2026-001-wo-1, k from 1 per invoice. No books format change (docs/specs/invoicing.md decision 2):
 * an entry of the shape every entry has.
 */
export const writeOffRef = (doc: { number: string }, id: string): string => `${docRef({ number: doc.number, kind: 'invoice' })}-${id}`;

/**
 * The ref of a reclassification «Konten ändern» books (src/invoices/revise.ts): RE-2026-001-kk-1 (a
 * credit note's GS-2026-004-kk-1), k from 1 per document. It moves revenue a booking of a filed period put on one account to another,
 * dated in the open period, without a VAT code; no books format change (decision 2), as writeOffRef.
 */
export const reclassRef = (doc: { number: string; kind: string }, k: number): string => `${eventRef(doc, 'issue')}-kk-${k}`;

/** Whether the books carry the document's issue: then its payments settle the receivable, whatever the basis is by then. */
export const hasEvent = (books: { journalEntries: ReadonlyArray<{ transactionRef: string }> }, doc: { number: string; kind: string }): boolean => {
  const ref = eventRef(doc, 'issue');
  return books.journalEntries.some((e) => e.transactionRef === ref);
};

/**
 * A link no module made: a person's (or the AI sidebar's on her wish), or the AI matcher's. A module
 * that takes back or rebooks its own bookings leaves a ref that carries one as it is (#524).
 */
export const isPersonsLink = (m: { by?: string }): boolean => m.by === 'human' || m.by === 'llm';
