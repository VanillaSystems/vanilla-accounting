/**
 * Does a booking contradict the receipts of its payment? An input-tax zero code (M0, I0) while a
 * linked receipt shows Swiss VAT loses the input tax; a rate code (M81, I81) while no linked receipt
 * shows it claims input tax without proof. The check only names the code a person's click would set
 * (MISSION.md: a correction is never silently overwritten). Filed quarters, corrections, sales
 * codes, Bezugsteuer and VAT-amount codes are never flagged; a receipt not read yet is no evidence.
 * A line on the import VAT account is never offered a rate (src/booking/customs-invoice.ts
 * ratesImportVat): its input tax is only the one-legged deduction an assessment proves, a rate on
 * the import VAT would claim the rate's tax on the tax itself.
 */
import { baseCurrency, documents, vat } from '../engines/index.js';
import type { InputTaxProof, JournalEntry, Receipt } from '../types/index.js';

/**
 * `decided`: a person or the AI sidebar on her wish chose the code (JournalEntry.by) with the
 * receipts linked now before her: the task explains the contradiction and offers no click, a
 * deliberate code beats the receipt rule's default (r8h-22). A receipt linked after her choice (the
 * entry's `receipts` lacks it: «Ohne Vorsteuer buchen», then the ticket turns up) is evidence she
 * never saw, so the click stays (F13). A minus rate code (-M81, a credit note) lowers the input tax and claims
 * nothing, so it is never flagged without a receipt.
 */
export type EvidenceCheck =
  /** The proposal: the rate code of the entry's family, and the receipts the entry then records as seen. */
  | { kind: 'receiptShowsVat'; rate: number; code: string; receipts: string[]; decided?: true }
  /** The proposal: the zero code of the entry's family. */
  | { kind: 'vatWithoutReceipt'; code: string; decided?: true }
  /**
   * A receipt of several VAT groups (a rate, an export part at 0 %) and a payment booked otherwise
   * (#406): `amount` (in `currency`) the receipt shows at `rate` and the booking does not, `lines`
   * the payment's lines by the receipt's groups (each its own code), absent when they cannot be
   * made to add up to the payment; `entries` the payment's lines on that receipt, which they replace.
   */
  | { kind: 'receiptGroups'; rate: number; amount: number; currency: string; lines?: GroupLine[]; entries: string[]; receipts: string[]; decided?: true };

/** One line of a payment rebooked by its receipt's VAT groups: its gross and its code. */
export interface GroupLine { amount: number; code: string }

/** The Swiss VAT rate a read receipt shows, or undefined (none, or not read). */
const swissRate = (r: Receipt): number | undefined =>
  r.hasSwissVat ? r.vatSummary?.find((g) => g.ratePercent > 0 && vat().isDomesticRate(g.ratePercent))?.ratePercent : undefined;

/** A purchase document: what a vendor charged, with its tax. The company's own sales record shows output tax; a copy or a delivery note proves nothing. */
export const isPurchaseDocument = (r: Pick<Receipt, 'kind'>): boolean => r.kind === undefined || r.kind === 'invoice';

/**
 * The receipts one line of a payment books (#27): of several, the one whose amount, in the line's
 * currency, is the line's, when exactly one is; else all of them (one line for the whole payment).
 */
export function lineReceipts<R extends Pick<Receipt, 'amount' | 'currency'>>(e: Pick<JournalEntry, 'amount' | 'exchangeCurrency'>, linked: readonly R[]): readonly R[] {
  if (linked.length < 2) return linked;
  const currency = e.exchangeCurrency ?? baseCurrency();
  const own = linked.filter((r) => r.amount !== undefined && (r.currency ?? baseCurrency()) === currency && Math.round(Math.abs(r.amount) * 100) === Math.round(Math.abs(e.amount) * 100));
  return own.length === 1 ? own : linked;
}

/** The payment's rounding to five hundredths, and a hundredth of the receipt's own. */
const TOLERANCE = 0.05;
const cents = (n: number): number => Math.round(n * 100) / 100;
const PURCHASE = /^(-?)([MI])(\d+)$/;

/**
 * The gross per rate the receipts show, in `currency`: each VAT group, and what their total holds
 * beyond the groups at 0 % (an export part a reader left out). Undefined when a receipt was not
 * read, is in another currency, names a group by its tax alone, or shows groups above its total:
 * then there is nothing to compare a booking with.
 */
function receiptGroups(receipts: readonly Receipt[], currency: string): Map<number, number> | undefined {
  if (!receipts.length) return undefined;
  const groups = new Map<number, number>();
  const add = (rate: number, gross: number) => groups.set(rate, (groups.get(rate) ?? 0) + gross);
  for (const r of receipts) {
    if (r.hasSwissVat === undefined || (r.currency ?? baseCurrency()) !== currency) return undefined;
    const total = r.amount === undefined ? undefined : Math.abs(r.amount);
    let shown = 0;
    for (const g of r.hasSwissVat ? r.vatSummary ?? [] : []) {
      const gross = g.gross ?? (g.net !== undefined ? g.net + g.vat : undefined);
      if (gross === undefined) return undefined;
      add(g.ratePercent, Math.abs(gross));
      shown += Math.abs(gross);
    }
    if (total === undefined) {
      if (!shown) return undefined;
      continue;
    }
    if (shown > total + TOLERANCE) return undefined;
    if (total - shown > TOLERANCE) add(0, total - shown);
  }
  return groups;
}

/** The gross per rate the lines book. */
function bookedGroups(lines: readonly JournalEntry[]): Map<number, number> {
  const booked = new Map<number, number>();
  for (const l of lines) {
    const rate = vat().codes.parse(l.vatCode!)!.rate;
    booked.set(rate, (booked.get(rate) ?? 0) + Math.abs(l.amount));
  }
  return booked;
}

/**
 * The payment's lines by the receipt's groups: each group's gross with the code of the entry's
 * family at that rate, the payment's rounding on the largest. Undefined when a rate has no code or
 * the groups do not add up to what the lines book (a part booked elsewhere, a private share).
 */
function groupLines(groups: Map<number, number>, booked: number, sign: string, family: string): GroupLine[] | undefined {
  const boxes = vat().codes.purchaseBoxes;
  const lines: GroupLine[] = [];
  for (const [rate, gross] of [...groups].sort(([a], [b]) => b - a)) {
    if (gross <= TOLERANCE) continue;
    const code = rate === 0 ? `${family}0` : vat().codes.purchaseAt(rate, family === 'M' ? boxes.costOfGoods : boxes.otherwise);
    if (!code) return undefined;
    lines.push({ amount: cents(gross), code: sign + code });
  }
  const diff = cents(booked - lines.reduce((s, l) => s + l.amount, 0));
  if (!lines.length || Math.abs(diff) > TOLERANCE) return undefined;
  const largest = lines.reduce((a, b) => (b.amount > a.amount ? b : a));
  largest.amount = cents(largest.amount + diff);
  return lines;
}

/**
 * A receipt of several groups against the lines of the payment on it (#406): the booking fits when
 * no rate books more than the receipt shows at it. The first line at a rate booked beyond it
 * carries the finding, which names the amount the receipt shows at another rate. Undefined when
 * the booking fits; `null` when the receipt cannot be compared so (one group, or not read): the
 * check per line then decides.
 */
function groupCheck(e: JournalEntry, own: readonly Receipt[], receipts: readonly Receipt[], lines: readonly JournalEntry[], sign: string, family: string): EvidenceCheck | undefined | null {
  const currency = e.exchangeCurrency ?? baseCurrency();
  const groups = receiptGroups(own, currency);
  if (!groups || [...groups.values()].filter((g) => g > TOLERANCE).length < 2) return null;
  const same = (l: JournalEntry) => {
    const m = PURCHASE.exec(l.vatCode ?? '');
    const theirs = lineReceipts(l, receipts);
    return !!m && m[1] === sign && !l.corrects && !!vat().codes.parse(l.vatCode!) && (l.exchangeCurrency ?? baseCurrency()) === currency
      && theirs.length === own.length && theirs.every((r) => own.includes(r));
  };
  const mates = [e, ...lines.filter((l) => l.id !== e.id)].filter(same).sort((a, b) => lines.indexOf(a) - lines.indexOf(b));
  const booked = bookedGroups(mates);
  const over = (rate: number) => (booked.get(rate) ?? 0) > (groups.get(rate) ?? 0) + TOLERANCE;
  const first = mates.find((l) => over(vat().codes.parse(l.vatCode!)!.rate));
  if (first?.id !== e.id) return undefined;
  // What the receipt shows at a rate the booking leaves short: the largest such part.
  const short = [...groups].map(([rate, gross]) => ({ rate, amount: cents(gross - (booked.get(rate) ?? 0)) })).filter((s) => s.amount > TOLERANCE).sort((a, b) => b.amount - a.amount)[0];
  if (!short) return undefined;
  const total = mates.reduce((s, l) => s + Math.abs(l.amount), 0);
  const proposal = groupLines(groups, total, sign, family);
  return { kind: 'receiptGroups', rate: short.rate, amount: short.amount, currency, ...(proposal && { lines: proposal }), entries: mates.map((l) => l.id), receipts: receipts.map((r) => r.id) };
}

/**
 * `linked` are the receipts of the entry's payment; each line is checked against its own of them
 * (lineReceipts); `closedThrough` the period lock. Undefined when
 * the booking fits its evidence, when only a sales record or a supporting document is linked (the
 * payment's purchase side has no evidence either way), or when the entry is out of scope. `proof`:
 * the other proof a person named for the payment's input tax (BankTransaction.inputTaxProof, #134),
 * which backs a rate code no receipt shows. `lines`: every line of the payment (the entry among
 * them); a receipt of several VAT groups is compared with all of them (#406), a line at 0 % of a
 * receipt with an export part is no contradiction.
 */
export function evidenceCheck(e: JournalEntry, linked: readonly Receipt[], closedThrough: string | undefined, proof?: InputTaxProof, lines: readonly JournalEntry[] = [e]): EvidenceCheck | undefined {
  if ((closedThrough && e.date <= closedThrough) || e.corrects) return undefined;
  const receipts = linked.filter(isPurchaseDocument);
  if (linked.length && !receipts.length) return undefined;
  const m = PURCHASE.exec(e.vatCode ?? '');
  const info = m && vat().codes.parse(e.vatCode!);
  if (!m || !info) return undefined;
  const [, sign, family] = m;
  const own = lineReceipts(e, receipts);
  const shown = own.map(swissRate).find((rate) => rate !== undefined);
  const sawAll = !e.receipts || receipts.every((r) => e.receipts!.includes(r.id));
  const decided = (e.by?.kind === 'person' || e.by?.kind === 'assistant') && sawAll ? { decided: true as const } : {};
  const importVat = documents().customs?.positions.importVat.account;
  const onImportVat = !!importVat && (e.accountDebit === importVat || e.accountCredit === importVat);
  // A minus rate code lowers the input tax: it claims nothing a receipt must show.
  if (!onImportVat && (info.rate === 0 ? shown !== undefined : !sign)) {
    const grouped = groupCheck(e, own, receipts, lines, sign, family);
    if (grouped !== null) return grouped && { ...grouped, ...decided };
  }
  if (info.rate === 0) {
    if (shown === undefined || onImportVat) return undefined;
    const boxes = vat().codes.purchaseBoxes;
    const code = vat().codes.purchaseAt(shown, family === 'M' ? boxes.costOfGoods : boxes.otherwise);
    return code ? { kind: 'receiptShowsVat', rate: shown, code: sign + code, receipts: receipts.map((r) => r.id), ...decided } : undefined;
  }
  if (sign || proof || shown !== undefined || own.some((r) => r.hasSwissVat === undefined)) return undefined;
  return { kind: 'vatWithoutReceipt', code: `${family}0`, ...decided };
}
