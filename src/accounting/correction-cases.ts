import type { CorrectionCase, JournalEntry } from '../types/index.js';
import { figuresFromBooks, type ReturnFigures } from './return-figures.js';
import { roundCHF } from './rappen.js';

/** A set of entries' effect on a quarter's return, per form Ziffer; zero Ziffern are left out. */
export type ZifferEffect = Record<string, number>;

export interface CaseEffect {
  /** The original entries as booked: what the filed return should have declared for them. */
  before: ZifferEffect;
  /** The correction entries (corrects === period). */
  correction: ZifferEffect;
  /** What this case adds to the 0535 difference (korrigiert − eingereicht). */
  contribution: ZifferEffect;
}

/**
 * Ziffern a case's effect cannot be summed on: 399 is the tax on each rate's whole
 * turnover, rounded once, and 500/510 clamp at zero. They follow from the others.
 */
const NOT_ADDITIVE = new Set(['399', '500', '510']);

function effectOf(entries: JournalEntry[], ids: string[], c: CorrectionCase): ZifferEffect {
  const wanted = new Set(ids);
  const { ziffern } = figuresFromBooks(entries.filter((e) => wanted.has(e.id)), c.period, []);
  return Object.fromEntries(Object.entries(ziffern).filter(([n, v]) => v !== 0 && n !== '500' && n !== '510'));
}

/**
 * A correction case's effect, computed by the same engine as the return itself.
 * A case without correction entries ("recomputed": the books were right, the filed return
 * missed the originals) contributes its originals; any other case contributes its corrections.
 */
export function caseEffect(c: CorrectionCase, entries: JournalEntry[]): CaseEffect {
  const before = effectOf(entries, c.originalEntryIds, c);
  const correction = effectOf(entries, c.correctionEntryIds, c);
  return { before, correction, contribution: c.correctionEntryIds.length ? correction : before };
}

export interface CaseReconciliation {
  /** Ziffern where the 0535 difference is not the sum of the cases' contributions. */
  unexplained: { ziffer: string; difference: number; explained: number }[];
  /** Entries that correct the quarter but belong to no case. */
  orphans: JournalEntry[];
}

/** Checks that the cases explain every franc of a quarter's Korrekturabrechnung. */
export function reconcileCases(
  cases: CorrectionCase[],
  entries: JournalEntry[],
  filed: ReturnFigures,
  corrected: ReturnFigures,
): CaseReconciliation {
  const mine = cases.filter((c) => c.period === filed.period);
  const explained: Record<string, number> = {};
  for (const c of mine) {
    for (const [n, v] of Object.entries(caseEffect(c, entries).contribution)) explained[n] = (explained[n] ?? 0) + v;
  }
  const ziffern = new Set([...Object.keys(filed.ziffern), ...Object.keys(corrected.ziffern), ...Object.keys(explained)]);
  const unexplained = [...ziffern]
    .filter((n) => !NOT_ADDITIVE.has(n))
    .map((n) => ({
      ziffer: n,
      difference: roundCHF((corrected.ziffern[n] ?? 0) - (filed.ziffern[n] ?? 0)),
      explained: roundCHF(explained[n] ?? 0),
    }))
    .filter((r) => Math.abs(r.difference - r.explained) > 0.02)
    .sort((a, b) => a.ziffer.localeCompare(b.ziffer));

  const inCase = new Set(mine.flatMap((c) => c.correctionEntryIds));
  const orphans = entries.filter((e) => e.corrects === filed.period && !inCase.has(e.id));
  return { unexplained, orphans };
}
