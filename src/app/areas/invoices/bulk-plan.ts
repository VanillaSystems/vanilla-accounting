/** What a bulk action of Verkauf takes and what it leaves out, and why (docs/specs/invoicing.md 4.8): pure, for the dialogs of bulk.tsx. */
import type { Invoice, Issued } from '../../../invoices/model.js';

/** At most this many e-mails go out in one run: a mailbox throttles more, and a mistake stays small. */
export const SEND_LIMIT = 25;
/** At most this many PDFs are saved in one run: a browser asks again for each beyond a few. */
export const PDF_LIMIT = 20;

export type LeftOut = 'draft' | 'cancelled' | 'noEmail' | 'limit';

/** What a bulk send takes and leaves out, in the order ticked: drafts and cancelled ones, those without an e-mail address, those over the limit. */
export function bulkSendPlan(docs: readonly Invoice[], limit = SEND_LIMIT): { take: Issued[]; left: Array<{ inv: Invoice; why: LeftOut }> } {
  const take: Issued[] = [];
  const left: Array<{ inv: Invoice; why: LeftOut }> = [];
  for (const inv of docs) {
    if (inv.status !== 'issued') left.push({ inv, why: 'draft' });
    else if (inv.cancelled) left.push({ inv, why: 'cancelled' });
    else if (!inv.customer.email?.trim()) left.push({ inv, why: 'noEmail' });
    else if (take.length >= limit) left.push({ inv, why: 'limit' });
    else take.push(inv);
  }
  return { take, left };
}

/** What a bulk PDF saves: the issued ones up to the limit; a draft has no PDF until it is issued. */
export function bulkPdfPlan(docs: readonly Invoice[], limit = PDF_LIMIT): { take: Issued[]; left: Array<{ inv: Invoice; why: LeftOut }> } {
  const take: Issued[] = [];
  const left: Array<{ inv: Invoice; why: LeftOut }> = [];
  for (const inv of docs) {
    if (inv.status !== 'issued') left.push({ inv, why: 'draft' });
    else if (take.length >= limit) left.push({ inv, why: 'limit' });
    else take.push(inv);
  }
  return { take, left };
}

