/**
 * The firm's own invoice among the receipts, and the number it gives itself (#365): the only
 * receipt money in may pay by its number alone (src/intake/pairing.ts fitOf). Pure and browser-safe.
 */
import type { Receipt } from '../types/index.js';
import type { DocumentsData } from '../core/modules/schema.js';
import { documents } from '../engines/index.js';
import { HEAD, compoundLines } from '../core/modules/words.js';
import { documentKind, titleIn } from './document-kind.js';
import { labelledNumbers } from './duplicates.js';
import { normUid, uidsIn } from '../parsers/receipt-text.js';

/** The firm: its UID (company.uid), its name (company.name) and its owner (company.owner). */
export interface Firm { uid?: string; name?: string; owner?: string }

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether the firm issued the receipt, and how sure that is. `uid`: the firm has a UID, the receipt
 * shows it (the read VAT number, or in its text with or without the VAT word after it: a firm not registered for
 * VAT prints none) and no other UID, compared whole; a supplier's invoice that prints the customer's
 * UID beside its own is none. `name`: the firm has no UID, its name heads the text (the first line,
 * the letterhead) and the text shows no UID; that is no proof (a supplier's logo can be an image, so
 * the addressee is the first line; a supplier's name can hold the firm's), so its pairs are proposed,
 * never linked by code. False: someone else's.
 */
export function issuedByFirm(r: Pick<Receipt, 'vatId' | 'extractedText'>, firm: Firm | undefined): 'uid' | 'name' | false {
  if (!firm) return false;
  const shown = uidsIn(r.extractedText ?? '');
  if (r.vatId) shown.add(normUid(r.vatId));
  if (firm.uid) return shown.size === 1 && shown.has(normUid(firm.uid)) ? 'uid' : false;
  const name = firm.name ? fold(firm.name) : '';
  const first = (r.extractedText ?? '').split('\n').map(fold).find(Boolean);
  return !!name && !shown.size && !!first && first.includes(name) ? 'name' : false;
}

/**
 * The numbers an invoice gives itself: those an invoice word labels («Rechnung 2026-029»,
 * «Invoice # 4471», documents.yaml receipt.number; squashed as tokensIn squashes, four characters at
 * least), also the number of its compound title, the first one of its head («Akontorechnung
 * AK-26-Q3-30871», words.ts compoundLines), never a customer, order, account, phone number, a date
 * or a year alone («Rechnung 2026 Unterhalt»). None for a document whose text names it an offer, an
 * order confirmation, a delivery note or a reminder (documentKind), or whose first lines have no
 * invoice title.
 */
export function ownNumbers(r: Pick<Receipt, 'kind' | 'extractedText'>, words: DocumentsData = documents()): string[] {
  if (r.kind && r.kind !== 'invoice') return [];
  const text = r.extractedText ?? '';
  if (documentKind(text, words).is !== 'receipt' || titleIn(text.slice(0, HEAD), words) === Infinity) return [];
  // The number of its compound title: the first such line of its head, never one below that names another bill («Akontorechnung AK-1 bezahlt» on a final invoice).
  const compound = compoundLines(text.slice(0, HEAD), words.receipt.number, words.notCompound)[0]?.number;
  return [...new Set([...labelledNumbers(text, words), ...(compound ? [compound] : [])])].map((n) => n.replace(/\s/g, '')).filter((n) => !YEAR.test(n));
}

/** A year alone (four digits, 19xx or 20xx) is no invoice number by itself. */
const YEAR = /^(?:19|20)\d{2}$/;

/** A number's shape: digits as 9, letters as A («2026029» → «9999999»): two invoice numbers of one series share it. */
export const shapeOf = (n: string): string => n.replace(/\d/g, '9').replace(/[A-Z]/g, 'A');
