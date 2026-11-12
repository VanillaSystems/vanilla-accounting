/**
 * The firm's own invoice among the receipts, and the number it gives itself (#365): the only
 * receipt money in may pay by its number alone (src/intake/pairing.ts fitOf). Pure and browser-safe.
 */
import type { Receipt } from '../types/index.js';
import type { DocumentsData } from '../core/modules/schema.js';
import { documents } from '../engines/index.js';
import { HEAD, wordsRe } from '../core/modules/words.js';
import { documentKind } from './document-kind.js';
import { labelledNumbers } from './duplicates.js';

/** The firm: its UID (company.uid) and its name (company.name). */
export interface Firm { uid?: string; name?: string }

const digits = (s: string | undefined) => s?.replace(/\D/g, '') ?? '';
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether the firm issued the receipt: its VAT number is the firm's UID. A firm without a UID (not
 * registered) issued it when its name heads the text (the first line, the letterhead) and the text
 * shows no UID: on a supplier's invoice the firm's name stands lower, as the addressee.
 */
export function issuedByFirm(r: Pick<Receipt, 'vatId' | 'extractedText'>, firm: Firm | undefined): boolean {
  if (!firm) return false;
  const uid = digits(firm.uid);
  if (uid) return digits(r.vatId) === uid;
  const name = firm.name ? fold(firm.name) : '';
  const first = (r.extractedText ?? '').split('\n').map(fold).find(Boolean);
  return !!name && !r.vatId && !!first && first.includes(name);
}

/**
 * The numbers an invoice gives itself: those an invoice word labels («Rechnung 2026-029»,
 * «Invoice # 77», documents.yaml receipt.number; squashed as tokensIn squashes), never a customer,
 * order, account, phone number or a date. None for a document whose text names it an offer, an
 * order confirmation, a delivery note or a reminder (documentKind), or whose first lines have no
 * invoice title.
 */
export function ownNumbers(r: Pick<Receipt, 'kind' | 'extractedText'>, words: DocumentsData = documents()): string[] {
  if (r.kind && r.kind !== 'invoice') return [];
  const text = r.extractedText ?? '';
  if (documentKind(text, words).is !== 'receipt' || !wordsRe(words.receipt.title).test(text.slice(0, HEAD))) return [];
  return [...labelledNumbers(text, words)].map((n) => n.replace(/\s/g, ''));
}

/** A number's shape: digits as 9, letters as A («2026029» → «9999999»): two invoice numbers of one series share it. */
export const shapeOf = (n: string): string => n.replace(/\d/g, '9').replace(/[A-Z]/g, 'A');
