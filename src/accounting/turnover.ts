/**
 * The turnover reconciliation of the year close (#569): the turnover the books hold on their
 * revenue accounts, period by period, against the turnover the year's returns declare in their
 * turnover box, as filed and as the books declare it today (with its correction once the
 * period is filed). Every difference is named with the entries behind it and the period it belongs
 * to, as a fact. Pure: the close, the CLI and the tests read it the same way.
 *
 * The journal holds entries gross, as the turnover box declares them, so a revenue account's
 * movement and the box's gross compare without splitting off the tax.
 *
 * A difference is never corrected here: an entry that belongs to a filed period is corrected by a
 * correction entry in the open period (`corrects`), which the period's correction then declares.
 */
import type { JournalEntry, QuarterKey } from '../types/index.js';
import type { ReturnFigures } from '../engines/return.js';
import { chart, filing, vat } from '../engines/index.js';
import { chfAmount } from './ledger.js';
import { fromRappen, toRappen } from './rappen.js';
import { derivePeriod, filingKeyOf } from './periods.js';

/**
 * Why a period's booked turnover and its declared turnover differ, each with the entries behind
 * it. `amount` is what it adds to booked − declared:
 * - `undeclared`: revenue booked without a code that declares turnover (no code, or one that
 *   declares none).
 * - `notRevenue`: turnover declared on an entry that books no revenue (a fixed asset sold, own use
 *   booked on an expense account).
 * - `differs`: an entry books revenue and declares turnover, not the same amount.
 * - `yearEnd`: revenue a year-end entry books without a code (open invoices as receivables on the
 *   cash basis, accrued or deferred income, and their reversal): the turnover is declared when paid.
 * - `declaredIn`: booked in this period, declared in the correction of `in`, the period it corrects.
 * - `bookedIn`: a correction of this period, booked in `in` (dated there), declared here.
 */
export type TurnoverDifference =
  | { code: 'undeclared' | 'notRevenue' | 'differs' | 'yearEnd'; entryIds: string[]; amount: number }
  | { code: 'declaredIn' | 'bookedIn'; in: string; entryIds: string[]; amount: number };

export interface TurnoverPeriod {
  period: QuarterKey;
  /** The revenue accounts' movement of the entries dated in the period: credit minus debit, gross. */
  booked: number;
  /** The turnover box as today's books declare it: the return, its correction included once filed. */
  declared: number;
  /** The turnover box as filed; undefined while the period is not filed. */
  filed?: number;
  /** booked − declared, explained: their amounts add up to it. */
  differences: TurnoverDifference[];
  /** declared − filed: what the period's correction declares; 0 while not filed or nothing changed. */
  correction: number;
  /** The correction entries of the period (`corrects`) behind `correction`. */
  correctionEntryIds: string[];
}

export interface TurnoverReconciliation {
  /** The year's filing periods. */
  periods: TurnoverPeriod[];
  booked: number;
  declared: number;
  /** The filed periods' turnover box. */
  filed: number;
  /** The corrections still to declare: the sum of the filed periods' `correction`. */
  correction: number;
}

const isRevenue = (account: string) => !!account && chart().typeOf(account) === 'revenue';

/** What an entry adds to its revenue accounts (credit plus, debit minus), in rappen. */
function revenueOf(e: JournalEntry): number {
  const chf = toRappen(chfAmount(e));
  return (isRevenue(e.accountCredit) ? chf : 0) - (isRevenue(e.accountDebit) ? chf : 0);
}

/** What an entry declares in the turnover box, in rappen. */
function turnoverOf(e: JournalEntry): number {
  const info = e.vatCode ? vat().codes.parse(e.vatCode) : null;
  if (!info || !vat().codes.sourceBoxes(info).includes(vat().form.turnoverBox)) return 0;
  return toRappen(vat().vatLine(e)?.gross ?? 0);
}

/**
 * The reconciliation of `periods` (one year's filing periods, in order) over every entry of the
 * books: an entry dated in the year that corrects a period of another year is named with that
 * period; one dated after the year that corrects a period of it is declared there. `yearEnd`: the
 * ids of the year-end's own entries (a template's booking, the receivables and their reversal).
 */
export function turnoverReconciliation(entries: readonly JournalEntry[], periods: readonly QuarterKey[], filed: readonly ReturnFigures[], yearEnd: ReadonlySet<string> = new Set()): TurnoverReconciliation {
  const box = vat().form.turnoverBox;
  const rows = periods.map((period): TurnoverPeriod => {
    const { from, to } = derivePeriod(period)!;
    const dated = entries.filter((e) => !!e.date && e.date >= from && e.date <= to);
    const declaredHere = entries.filter((e) => (e.corrects ? e.corrects === period : e.date >= from && e.date <= to));
    const booked = dated.reduce((s, e) => s + revenueOf(e), 0);
    const declared = declaredHere.reduce((s, e) => s + turnoverOf(e), 0);

    const groups = new Map<string, TurnoverDifference>();
    const add = (key: string, make: () => TurnoverDifference, id: string, amount: number) => {
      if (amount === 0) return;
      const g = groups.get(key) ?? groups.set(key, make()).get(key)!;
      g.entryIds.push(id);
      g.amount += amount;
    };
    for (const e of dated) {
      const rev = revenueOf(e), out = turnoverOf(e);
      // A correction of another period: what it declares goes into that period's correction; the rest is named as any entry's.
      const elsewhere = !!e.corrects && e.corrects !== period;
      if (elsewhere) add(`declaredIn:${e.corrects}`, () => ({ code: 'declaredIn', in: e.corrects!, entryIds: [], amount: 0 }), e.id, out);
      const code = out === 0 ? (yearEnd.has(e.id) || e.origin === 'year-close' ? 'yearEnd' : 'undeclared') : rev === 0 ? 'notRevenue' : 'differs';
      add(code, () => ({ code, entryIds: [], amount: 0 }), e.id, rev - out);
    }
    for (const e of declaredHere) {
      if (e.date >= from && e.date <= to) continue;
      const at = filingKeyOf(e.date, filing().length);
      add(`bookedIn:${at}`, () => ({ code: 'bookedIn', in: at, entryIds: [], amount: 0 }), e.id, -turnoverOf(e));
    }
    const differences = [...groups.values()].filter((d) => d.amount !== 0).map((d) => ({ ...d, amount: fromRappen(d.amount) }));

    const asFiled = filed.find((f) => f.period === period);
    const filedTurnover = asFiled ? toRappen(asFiled.ziffern[box] ?? 0) : undefined;
    const correction = filedTurnover === undefined ? 0 : declared - filedTurnover;
    return {
      period,
      booked: fromRappen(booked),
      declared: fromRappen(declared),
      ...(filedTurnover !== undefined && { filed: fromRappen(filedTurnover) }),
      differences,
      correction: fromRappen(correction),
      correctionEntryIds: correction === 0 ? [] : entries.filter((e) => e.corrects === period && turnoverOf(e) !== 0).map((e) => e.id),
    };
  });
  const sum = (f: (p: TurnoverPeriod) => number) => fromRappen(rows.reduce((s, p) => s + toRappen(f(p)), 0));
  return { periods: rows, booked: sum((p) => p.booked), declared: sum((p) => p.declared), filed: sum((p) => p.filed ?? 0), correction: sum((p) => p.correction) };
}

/**
 * Whether the reconciliation names something a person may want to look at: revenue no code
 * declares, or revenue and turnover of one entry that differ. A correction of a filed period is
 * shown, not flagged: the app does not know whether it is filed already.
 */
export const turnoverNeedsLook = (r: TurnoverReconciliation): boolean =>
  r.periods.some((p) => p.differences.some((d) => d.code === 'undeclared' || d.code === 'differs'));
