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
import type { InputTaxProof, JournalEntry, Mapping, Receipt } from '../types/index.js';

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
   * `booked`: an over-claim (#469), the lines book `booked` at `rate` and the receipt taxes only
   * `amount` at it; `lines` then never claim more input tax than the receipt shows.
   */
  | { kind: 'receiptGroups'; rate: number; amount: number; currency: string; booked?: number; lines?: GroupLine[]; entries: string[]; receipts: string[]; decided?: true };

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

/** The bills of the lines of a payment's card statement (Mapping.line, #409): each receipt's line. */
export type LineBills = ReadonlyMap<string, number>;

/** The receipts of payment `ref` that are the bill of one line of its card statement, with that line. */
export const lineBillsOf = (mappings: readonly Pick<Mapping, 'transactionRef' | 'receiptId' | 'line'>[], ref: string): Map<string, number> =>
  new Map(mappings.filter((m) => m.transactionRef === ref && m.line !== undefined).map((m) => [m.receiptId, m.line!]));

/**
 * The receipts that are evidence of one line of a payment (#455): a card line's bill only of the
 * lines of its card line (#409). A line is of a card line when it was booked with that card line's
 * bills alone (byParts books each card line with its own), else when its amount is the bill's, or
 * the card line's, of exactly one card line; any other line is of the whole settlement and sees the
 * receipts linked to it as a whole. `unplaced`: such a line beside a bill of a card line that shows
 * a Swiss rate or is not read, which may be its evidence: no proof missing is said for its rate.
 * `whole`: a line of the whole settlement beside line bills, whose rate a statement filed as such
 * (no purchase document) does not leave unjudged.
 */
function evidenceOf(e: JournalEntry, linked: readonly Receipt[], bills: LineBills | undefined): { receipts: readonly Receipt[]; unplaced: boolean; whole?: true } {
  if (!bills?.size || !linked.some((r) => bills.has(r.id))) return { receipts: linked, unplaced: false };
  const of = (lines: ReadonlySet<number>) => ({ receipts: linked.filter((r) => lines.has(bills.get(r.id) ?? -1)), unplaced: false });
  const seen = linked.filter((r) => e.receipts?.includes(r.id));
  const named = new Set(seen.map((r) => bills.get(r.id)));
  if (seen.length && named.size === 1 && !named.has(undefined)) return of(named as Set<number>);
  const currency = e.exchangeCurrency ?? baseCurrency();
  const cardLines = linked.find((r) => r.cardLines?.length)?.cardLines;
  const same = (n: number | undefined) => n !== undefined && toCents(n) === toCents(e.amount);
  const fits = new Set(linked.filter((r) => bills.has(r.id)).filter((r) => {
    const line = cardLines?.[bills.get(r.id)!];
    return ((r.currency ?? baseCurrency()) === currency && same(r.amount)) || (!!line && (line.currency ?? baseCurrency()) === currency && same(line.amount));
  }).map((r) => bills.get(r.id)!));
  if (fits.size === 1) return of(fits);
  // Only a bill that shows a Swiss rate, or is not read yet, may be the proof a whole-settlement line's rate rests on.
  const unplaced = linked.some((r) => bills.has(r.id) && (swissRate(r) !== undefined || r.hasSwissVat === undefined));
  return { receipts: linked.filter((r) => !bills.has(r.id)), unplaced, whole: true };
}
const toCents = (n: number): number => Math.round(Math.abs(n) * 100);

/** The payment's rounding to five hundredths, and a hundredth of the receipt's own. */
const TOLERANCE = 0.05;
const cents = (n: number): number => Math.round(n * 100) / 100;
const PURCHASE = /^(-?)([MI])(\d+)$/;

/**
 * The gross per rate the receipts show, in `currency`: each VAT group read (a receipt without Swiss
 * VAT its whole total at 0 %), and `rest`, what their totals hold beyond the groups read. The rest
 * is no group: a reader may have left out an export part, or a reduced rate, or read a net for a
 * gross; it only excuses a line at the zero code, never accuses a rate (#406 review). A receipt in
 * another currency is left out (#455 review). A group named by its tax alone counts at the gross its
 * tax proves, tax × (100 + rate) / rate; when that is the receipt's total but for the tax's rounding
 * to the cent, it is the total; `slack` is how far such a gross may stand from the true one, which every
 * comparison with it allows. `taxed`: per rate the receipts name, the gross their tax proves taxed at
 * it, tax × (100 + rate) / rate, with `taxSlack` its tax's rounding; absent for a rate a group of
 * which shows no tax (#469). Undefined when no receipt is in `currency`, or one was not read, has
 * a group at a rate not of the jurisdiction (a foreign VAT) or by no amount, or shows groups above
 * its total: then there is nothing to compare a booking with.
 */
function receiptGroups(receipts: readonly Receipt[], currency: string): { groups: Map<number, number>; rest: number; slack: number; taxed: Map<number, number>; taxSlack: Map<number, number> } | undefined {
  if (!receipts.length) return undefined;
  const groups = new Map<number, number>();
  const taxed = new Map<number, number>();
  const taxSlack = new Map<number, number>();
  const untaxed = new Set<number>();
  let rest = 0;
  let slackAll = 0;
  const add = (rate: number, gross: number) => groups.set(rate, (groups.get(rate) ?? 0) + gross);
  const comparable = receipts.filter((r) => (r.currency ?? baseCurrency()) === currency);
  if (!comparable.length) return undefined;
  for (const r of comparable) {
    if (r.hasSwissVat === undefined) return undefined;
    const total = r.amount === undefined ? undefined : Math.abs(r.amount);
    if (!r.hasSwissVat) {
      if (total === undefined) return undefined;
      add(0, total);
      continue;
    }
    let shown = 0;
    // The tax of a group named by it alone is rounded to the cent: its gross is known to half a cent times (100 + rate) / rate.
    let slack = 0;
    let derived: number | undefined;
    for (const g of r.vatSummary ?? []) {
      // A group at 0 % without an amount («0 %» and no figure, as the reader leaves the untaxed part) names nothing: its part is the rest.
      if (g.ratePercent === 0 && g.gross === undefined && g.net === undefined) continue;
      const byTax = g.ratePercent > 0 && g.gross === undefined && g.net === undefined && g.vat !== undefined;
      let gross = g.gross ?? (g.net !== undefined ? g.net + g.vat : byTax ? (g.vat * (100 + g.ratePercent)) / g.ratePercent : undefined);
      if (gross === undefined || (g.ratePercent > 0 && !vat().isDomesticRate(g.ratePercent))) return undefined;
      if (byTax) { slack += (0.005 * (100 + g.ratePercent)) / g.ratePercent; derived = g.ratePercent; }
      if (g.ratePercent > 0) {
        const proved = (Math.abs(g.vat) * (100 + g.ratePercent)) / g.ratePercent;
        const rounding = (0.005 * (100 + g.ratePercent)) / g.ratePercent;
        if (!(Math.abs(g.vat) > 0)) untaxed.add(g.ratePercent);
        // A gross read above what its tax proves (the total read for the group's gross, a net for a gross): the group is what the tax proves, the rest is the rest (#469).
        else if (Math.abs(gross) > proved + rounding) gross = cents(proved);
        taxed.set(g.ratePercent, (taxed.get(g.ratePercent) ?? 0) + proved);
        taxSlack.set(g.ratePercent, (taxSlack.get(g.ratePercent) ?? 0) + rounding);
      }
      add(g.ratePercent, Math.abs(gross));
      shown += Math.abs(gross);
    }
    slackAll += slack;
    if (total === undefined) {
      if (!shown) return undefined;
      continue;
    }
    if (derived !== undefined && Math.abs(total - shown) <= TOLERANCE + slack) {
      add(derived, total - shown);
      shown = total;
    }
    if (shown > total + TOLERANCE + slack) return undefined;
    if (total - shown > TOLERANCE) rest += total - shown;
  }
  for (const rate of untaxed) taxed.delete(rate);
  return { groups, rest, slack: slackAll, taxed, taxSlack };
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

/** Lines one click may book anew by the groups: of one day, on the same accounts, of one code family, with the same tags; never across them (#406 review). */
function oneKind(mates: readonly JournalEntry[]): boolean {
  const key = (l: JournalEntry) => JSON.stringify([l.date, l.accountDebit, l.accountCredit, PURCHASE.exec(l.vatCode ?? '')?.[2], Object.entries(l.tags ?? {}).sort()]);
  return mates.every((l) => key(l) === key(mates[0]));
}

/** A line a person, or the AI sidebar on her wish, decided with these receipts before her (r8h-22); a hand booking from before `by` was recorded counts as hers. */
const decidedBy = (l: JournalEntry, receipts: readonly Receipt[]): boolean =>
  (l.by?.kind === 'person' || l.by?.kind === 'assistant' || (!l.by && l.origin === 'manual')) && (!l.receipts || receipts.every((r) => l.receipts!.includes(r.id)));

/**
 * A receipt of several groups against the lines of the payment on it (#406): the booking fits when
 * no rate books more than the receipt shows at it. A line at a rate is held so against a receipt of
 * one group too (#469): a rate above the receipt's, or on more than it taxes, is an over-claim. The
 * first line at a rate booked beyond it carries the finding, which names the amount the receipt
 * shows at another rate, or for an over-claim at its own rate what it taxes there. The rest of a
 * total beyond its groups only excuses lines at the zero code: while there is one, no rate line is
 * judged by its gross, only by the tax the receipt shows at its rate (#469: the tax is the receipt's
 * own figure, whatever the rest is), and no rebooking is offered but for such an over-claim, whose
 * rebooking books the rest at the zero code. The rebooking (`lines`) also needs the lines to be of one
 * kind (oneKind) and none of the payment's lines on these receipts in a closed period (no mate,
 * and no click); a line a person decided makes the finding `decided`. Undefined when the booking
 * fits; `null` when the receipt cannot be compared so (one group, no group at a rate, or not read):
 * the check per line then decides, as before.
 */
function groupCheck(e: JournalEntry, own: readonly Receipt[], receipts: readonly Receipt[], lines: readonly JournalEntry[], sign: string, family: string, closedThrough: string | undefined): EvidenceCheck | undefined | null {
  const currency = e.exchangeCurrency ?? baseCurrency();
  const read = receiptGroups(own, currency);
  if (!read) return null;
  const { groups, rest, slack, taxed, taxSlack } = read;
  const tolerance = TOLERANCE + slack;
  const open = rest > TOLERANCE;
  const named = [...groups.values()].filter((g) => g > TOLERANCE).length;
  const rateOf = (l: JournalEntry) => vat().codes.parse(l.vatCode!)!.rate;
  // One group and no rest: only a rate line above the group's rate, or at it, is held against it; one below claims less, as before.
  const single = named === 1 && !open && rateOf(e) > 0 && [...groups].some(([rate, gross]) => gross > TOLERANCE && rate > 0 && rate <= rateOf(e));
  if (named < 2 && !(named === 1 && open) && !single) return null;
  // Without a group at a rate read, the receipt proves no input tax: the per-line check zeroes a rate code, as before (#406 review).
  if (![...groups].some(([rate, gross]) => rate > 0 && gross > TOLERANCE)) return null;
  const same = (l: JournalEntry) => {
    const m = PURCHASE.exec(l.vatCode ?? '');
    const theirs = lineReceipts(l, receipts);
    return !!m && m[1] === sign && !l.corrects && !!vat().codes.parse(l.vatCode!) && (l.exchangeCurrency ?? baseCurrency()) === currency
      && theirs.length === own.length && theirs.every((r) => own.includes(r));
  };
  const closed = (l: JournalEntry) => !!closedThrough && l.date <= closedThrough;
  const filed = lines.some((l) => l.id !== e.id && closed(l) && same(l));
  const mates = [e, ...lines.filter((l) => l.id !== e.id && !closed(l))].filter(same).sort((a, b) => lines.indexOf(a) - lines.indexOf(b));
  const booked = bookedGroups(mates);
  const over = (rate: number) => (rate === 0
    ? (booked.get(0) ?? 0) > (groups.get(0) ?? 0) + rest + tolerance
    : open
      ? taxed.has(rate) && (booked.get(rate) ?? 0) > taxed.get(rate)! + TOLERANCE + (taxSlack.get(rate) ?? 0)
      : (booked.get(rate) ?? 0) > (groups.get(rate) ?? 0) + tolerance);
  const first = mates.find((l) => over(rateOf(l)));
  if (first?.id !== e.id) return undefined;
  // What the receipt shows at a rate the booking leaves short: the largest such part of a group read.
  const short = [...groups].map(([rate, gross]) => ({ rate, amount: cents(gross - (booked.get(rate) ?? 0)) })).filter((s) => s.amount > tolerance).sort((a, b) => b.amount - a.amount)[0];
  // A rate booked on more than the receipt taxes at it (#469): what it taxes there, and the rest at the zero code.
  const claimed = rateOf(first) > 0 ? rateOf(first) : undefined;
  if (!short && claimed === undefined) return undefined;
  const total = mates.reduce((s, l) => s + Math.abs(l.amount), 0);
  const beyond = cents(total - [...groups.values()].reduce((s, g) => s + g, 0));
  const byGroups = claimed !== undefined && beyond > TOLERANCE ? new Map([...groups, [0, (groups.get(0) ?? 0) + beyond]]) : groups;
  const proposal = (!open || claimed !== undefined) && !filed && oneKind(mates) ? groupLines(byGroups, total, sign, family) : undefined;
  const decided = mates.some((l) => decidedBy(l, receipts)) ? { decided: true as const } : {};
  const finding = short ?? { rate: claimed!, amount: cents(groups.get(claimed!) ?? 0), booked: cents(booked.get(claimed!) ?? 0) };
  return { kind: 'receiptGroups', ...finding, currency, ...(proposal && { lines: proposal }), entries: mates.map((l) => l.id), receipts: receipts.map((r) => r.id), ...decided };
}

/**
 * A line of a card's whole settlement (evidenceOf `unplaced`) at a rate, with the payment's other
 * lines at that rate, against the tax every purchase receipt of the payment shows at it (#469): its
 * lines' bills and the settlement's own, in the line's currency. Booked beyond the gross that tax
 * proves (tax × (100 + rate) / rate), the first such line of the whole settlement carries the finding,
 * without a click: which card line holds the rest cannot be told. Undefined when the booking fits,
 * or a receipt cannot be set against it: one not read, a group at the rate without its tax, or a
 * receipt in another currency that shows the rate.
 */
function settlementOver(e: JournalEntry, rate: number, linked: readonly Receipt[], lines: readonly JournalEntry[], bills: LineBills, closedThrough: string | undefined): EvidenceCheck | undefined {
  const currency = e.exchangeCurrency ?? baseCurrency();
  const receipts = linked.filter(isPurchaseDocument);
  if (!receipts.length || receipts.some((r) => r.hasSwissVat === undefined || (r.hasSwissVat && !r.vatSummary?.length))) return undefined;
  let taxed = 0;
  let slack = 0;
  let gross = 0;
  for (const r of receipts.filter((x) => x.hasSwissVat)) {
    const at = (r.vatSummary ?? []).filter((g) => g.ratePercent === rate);
    if (!at.length) continue;
    if ((r.currency ?? baseCurrency()) !== currency || at.some((g) => !(Math.abs(g.vat) > 0))) return undefined;
    for (const g of at) {
      taxed += (Math.abs(g.vat) * (100 + rate)) / rate;
      slack += (0.005 * (100 + rate)) / rate;
      gross += Math.abs(g.gross ?? (g.net !== undefined ? g.net + g.vat : (g.vat * (100 + rate)) / rate));
    }
  }
  const atRate = lines.filter((l) => {
    const m = PURCHASE.exec(l.vatCode ?? '');
    return !!m && !l.corrects && vat().codes.parse(l.vatCode!)?.rate === rate && (l.exchangeCurrency ?? baseCurrency()) === currency;
  });
  const booked = atRate.reduce((s, l) => s + (l.vatCode!.startsWith('-') ? -1 : 1) * Math.abs(l.amount), 0);
  if (booked <= taxed + TOLERANCE + slack) return undefined;
  const closed = (l: JournalEntry) => !!closedThrough && l.date <= closedThrough;
  const first = atRate.find((l) => !l.vatCode!.startsWith('-') && !closed(l) && evidenceOf(l, linked, bills).whole);
  if (first?.id !== e.id) return undefined;
  return { kind: 'receiptGroups', rate, amount: cents(gross), booked: cents(booked), currency, entries: [e.id], receipts: receipts.map((r) => r.id) };
}

/**
 * `linked` are the receipts of the entry's payment; each line is checked against its own of them
 * (lineReceipts); `closedThrough` the period lock. Undefined when
 * the booking fits its evidence, when only a sales record or a supporting document is linked (the
 * payment's purchase side has no evidence either way), or when the entry is out of scope. `proof`:
 * the other proof a person named for the payment's input tax (BankTransaction.inputTaxProof, #134),
 * which backs a rate code no receipt shows. `lines`: every line of the payment (the entry among
 * them); a receipt of several VAT groups is compared with all of them (#406), a line at 0 % of a
 * receipt with an export part is no contradiction. `bills`: the receipts that are the bill of one
 * line of the payment's card statement (lineBillsOf), evidence of that line's lines only (#455).
 */
export function evidenceCheck(e: JournalEntry, linked: readonly Receipt[], closedThrough: string | undefined, proof?: InputTaxProof, lines: readonly JournalEntry[] = [e], bills?: LineBills): EvidenceCheck | undefined {
  if ((closedThrough && e.date <= closedThrough) || e.corrects) return undefined;
  const settlement = { linked, lines };
  const scope = evidenceOf(e, linked, bills);
  const ids = (rs: readonly Receipt[]) => rs.map((r) => r.id).join();
  // The payment's other lines on the same evidence: those of another card line are no mates of this one.
  lines = scope.receipts === linked ? lines : lines.filter((l) => l.id === e.id || ids(evidenceOf(l, linked, bills).receipts) === ids(scope.receipts));
  const receipts = scope.receipts.filter(isPurchaseDocument);
  linked = scope.receipts;
  // Only a statement or a supporting document linked: no evidence either way, unless the line is the whole settlement's beside bills of its lines.
  if (linked.length && !receipts.length && !scope.whole) return undefined;
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
    const grouped = groupCheck(e, own, receipts, lines, sign, family, closedThrough);
    if (grouped !== null) return grouped && { ...grouped, ...decided };
  }
  if (info.rate === 0) {
    if (shown === undefined || onImportVat) return undefined;
    // A receipt in another currency than the line, and no groups to compare in the line's currency, while another line on
    // the same receipts books a rate they show: the zero line may be the untaxed part, nothing is said (#455).
    const currency = e.exchangeCurrency ?? baseCurrency();
    const taxedBeside = (l: JournalEntry) => {
      const lm = PURCHASE.exec(l.vatCode ?? '');
      const rate = lm && vat().codes.parse(l.vatCode!)?.rate;
      const theirs = lineReceipts(l, receipts);
      return l.id !== e.id && !!rate && lm![1] === sign && theirs.length === own.length && theirs.every((r) => own.includes(r));
    };
    const read = receiptGroups(own, currency);
    if (!read && own.some((r) => (r.currency ?? baseCurrency()) !== currency) && lines.some(taxedBeside)) return undefined;
    // The rate on the whole line only where the receipt taxes it whole, with what the lines beside it book at the rate (#469).
    // A group whose tax was not read proves no amount: beside a line at its rate the zero line may be the untaxed part, nothing is said.
    const beside = lines.filter((l) => taxedBeside(l) && vat().codes.parse(l.vatCode!)!.rate === shown).reduce((s, l) => s + Math.abs(l.amount), 0);
    if (read && !read.taxed.has(shown) && beside > TOLERANCE) return undefined;
    const at = read?.taxed.has(shown) ? read.groups.get(shown) : undefined;
    if (read && at !== undefined) {
      const left = cents(at - beside);
      const amount = Math.abs(e.amount);
      if (amount > left + TOLERANCE + read.slack) {
        if (left <= TOLERANCE + read.slack) return undefined;
        const split = groupLines(new Map([[shown, left], [0, amount - left]]), amount, sign, family);
        return { kind: 'receiptGroups', rate: shown, amount: left, currency, ...(split && { lines: split }), entries: [e.id], receipts: receipts.map((r) => r.id), ...decided };
      }
    }
    const boxes = vat().codes.purchaseBoxes;
    const code = vat().codes.purchaseAt(shown, family === 'M' ? boxes.costOfGoods : boxes.otherwise);
    return code ? { kind: 'receiptShowsVat', rate: shown, code: sign + code, receipts: receipts.map((r) => r.id), ...decided } : undefined;
  }
  // A line of the whole settlement beside its lines' bills (#469): the payment's lines at its rate against what all its receipts tax at it.
  if (!sign && !proof && !onImportVat && scope.unplaced && bills) {
    const over = settlementOver(e, info.rate, settlement.linked, settlement.lines, bills, closedThrough);
    if (over) return { ...over, ...decided };
  }
  if (sign || proof || shown !== undefined || scope.unplaced || own.some((r) => r.hasSwissVat === undefined)) return undefined;
  return { kind: 'vatWithoutReceipt', code: `${family}0`, ...decided };
}
