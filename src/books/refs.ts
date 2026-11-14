/** A ref of its own (M2026-004): a manual transaction's, or an entry's that has no payment. */
export const isManualRef = (ref: string): boolean => /^M\d{4}-\d{3,}$/.test(ref);

/** The VAT events of an issued document on the agreed basis (src/invoices/events.ts): its issue, and its cancellation. */
export type EventKind = 'issue' | 'storno';

/** The ref an event's entries carry: RE-2026-001 for an invoice, GS-2026-004 for a credit note, -storno for a cancellation. */
export const eventRef = (doc: { number: string; kind: 'invoice' | 'credit-note' }, kind: EventKind): string =>
  `${doc.kind === 'credit-note' ? 'GS' : 'RE'}-${doc.number}${kind === 'storno' ? '-storno' : ''}`;

/** Whether the books carry the document's issue: then its payments settle the receivable, whatever the basis is by then. */
export const hasEvent = (books: { journalEntries: ReadonlyArray<{ transactionRef: string }> }, doc: { number: string; kind: 'invoice' | 'credit-note' }): boolean => {
  const ref = eventRef(doc, 'issue');
  return books.journalEntries.some((e) => e.transactionRef === ref);
};

/**
 * A link no module made: a person's (or the AI sidebar's on her wish), or the AI matcher's. A module
 * that takes back or rebooks its own bookings leaves a ref that carries one as it is (#524).
 */
export const isPersonsLink = (m: { by?: string }): boolean => m.by === 'human' || m.by === 'llm';
