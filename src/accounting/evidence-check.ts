/**
 * Does a booking contradict the receipts of its payment? An input-tax zero code (M0, I0) while a
 * linked receipt shows Swiss VAT loses the input tax; a rate code (M81, I81) while no linked receipt
 * shows it claims input tax without proof. The check only names the code a person's click would set
 * (MISSION.md: a correction is never silently overwritten). Filed quarters, corrections, sales
 * codes, Bezugsteuer and VAT-amount codes are never flagged; a receipt not read yet is no evidence.
 */
import { vat } from '../engines/index.js';
import type { JournalEntry, Receipt } from '../types/index.js';

/**
 * `decided`: a person or the AI sidebar on her wish chose the code (JournalEntry.by): the task
 * explains the contradiction and offers no click, a deliberate code beats the receipt rule's
 * default (r8h-22). A minus rate code (-M81, a credit note) lowers the input tax and claims
 * nothing, so it is never flagged without a receipt.
 */
export type EvidenceCheck =
  /** The proposal: the rate code of the entry's family, and the receipts the entry then records as seen. */
  | { kind: 'receiptShowsVat'; rate: number; code: string; receipts: string[]; decided?: true }
  /** The proposal: the zero code of the entry's family. */
  | { kind: 'vatWithoutReceipt'; code: string; decided?: true };

/** The Swiss VAT rate a read receipt shows, or undefined (none, or not read). */
const swissRate = (r: Receipt): number | undefined =>
  r.hasSwissVat ? r.vatSummary?.find((g) => g.ratePercent > 0 && vat().isDomesticRate(g.ratePercent))?.ratePercent : undefined;

/** A purchase document: what a vendor charged, with its tax. The company's own sales record shows output tax; a copy or a delivery note proves nothing. */
export const isPurchaseDocument = (r: Pick<Receipt, 'kind'>): boolean => r.kind === undefined || r.kind === 'invoice';

/**
 * `linked` are the receipts of the entry's payment; `closedThrough` the period lock. Undefined when
 * the booking fits its evidence, when only a sales record or a supporting document is linked (the
 * payment's purchase side has no evidence either way), or when the entry is out of scope.
 */
export function evidenceCheck(e: JournalEntry, linked: readonly Receipt[], closedThrough: string | undefined): EvidenceCheck | undefined {
  if ((closedThrough && e.date <= closedThrough) || e.corrects) return undefined;
  const receipts = linked.filter(isPurchaseDocument);
  if (linked.length && !receipts.length) return undefined;
  const m = /^(-?)([MI])(\d+)$/.exec(e.vatCode ?? '');
  const info = m && vat().codes.parse(e.vatCode!);
  if (!m || !info) return undefined;
  const [, sign, family] = m;
  const shown = receipts.map(swissRate).find((rate) => rate !== undefined);
  const decided = e.by?.kind === 'person' || e.by?.kind === 'assistant' ? { decided: true as const } : {};
  if (info.rate === 0) {
    if (shown === undefined) return undefined;
    const boxes = vat().codes.purchaseBoxes;
    const code = vat().codes.purchaseAt(shown, family === 'M' ? boxes.costOfGoods : boxes.otherwise);
    return code ? { kind: 'receiptShowsVat', rate: shown, code: sign + code, receipts: receipts.map((r) => r.id), ...decided } : undefined;
  }
  if (sign || shown !== undefined || receipts.some((r) => r.hasSwissVat === undefined)) return undefined;
  return { kind: 'vatWithoutReceipt', code: `${family}0`, ...decided };
}
