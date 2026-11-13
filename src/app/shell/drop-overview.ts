/**
 * The overview of a drop of many files (#453): how far the whole drop is and where its files stand,
 * in counts. Each row's stage is a coarser cut of its closing group (closingGroupOf, the state its own
 * row shows), so the counts, the filters, the folded lines and the rows never disagree; the files
 * still uploading count as worked on. Pure, so tests run it as it is.
 */
import type { Key } from '../i18n/types.js';
import type { ClosingGroup } from './drop-summary.js';

/**
 * From this many files the drop window shows the overview: its stages as filters, what needs her
 * listed first, the rest folded into a line per stage. Below it every row stands as it is, the tabs
 * above them: a few rows are read at a glance.
 */
export const OVERVIEW_FROM = 10;

/** The stages in the overview's order: what needs her first, then what is still worked on, then what is done. */
export const STAGES = ['needs', 'working', 'statements', 'matched', 'read', 'other', 'out'] as const;
export type Stage = typeof STAGES[number];

/**
 * The stage of each closing group. What waits for her is what the closing lines say waits for her (an
 * answer in its row, a possible copy, a date or amount missing, a reading, a run that stopped:
 * waitsAfterDrop); what the books took without a payment of its own (a fee bill, a document beside
 * an invoice, a balance sheet, an order page, a report) is «other»; what was not taken is «out».
 * A record over every group: a new group without its stage does not compile.
 */
export const STAGE_OF = {
  asks: 'needs', copy: 'needs', incomplete: 'needs', unread: 'needs', stuck: 'needs',
  working: 'working',
  statement: 'statements',
  matched: 'matched',
  read: 'read',
  feeBill: 'other', supporting: 'other', beside: 'other', balanceSheet: 'other', orderPage: 'other', report: 'other',
  none: 'out', known: 'out', aside: 'out', refused: 'out', undone: 'out',
} as const satisfies Record<ClosingGroup, Stage>;

export interface Overview {
  /** Every file of the drop: its rows and the files still uploading. */
  n: number;
  /** How many files are in each stage; they add up to `n`. */
  counts: Record<Stage, number>;
  /** The files at rest: every file not worked on any more (one that waits for her among them). */
  done: number;
}

/** The overview of rows in these closing groups, with `uploading` files not yet rows. */
export function overviewOf(groups: readonly ClosingGroup[], uploading: number): Overview {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const g of groups) counts[STAGE_OF[g]]++;
  counts.working += uploading;
  const n = groups.length + uploading;
  return { n, counts, done: n - counts.working };
}

/** Each stage's words: a statement read in and a receipt linked say what the closing lines say of them. */
export const STAGE_TEXT = {
  needs: 'drop.ov.needs', working: 'drop.ov.working', statements: 'drop.sum.statements', matched: 'drop.sum.matched',
  read: 'drop.ov.read', other: 'drop.ov.other', out: 'drop.ov.out',
} as const satisfies Record<Stage, Key>;

/** The stages a drop has files in, in their order. */
export const stagesIn = (o: Overview): Stage[] => STAGES.filter((s) => o.counts[s] > 0);
