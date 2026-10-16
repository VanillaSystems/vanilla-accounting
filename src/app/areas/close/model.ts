/**
 * The steps of the year-end page, without the texts (so a test loads them without Vite): seven
 * (docs/year-end.md), six for a legal form without a profit allocation (r10f-28), as
 * modules/ch/year-end.yaml `byLegalForm` has it.
 */
import { resultCloseOf } from '../../../accounting/year-close.js';

export const STEPS = ['q4', 'checks', 'entries', 'close', 'open', 'profit', 'handover'] as const;
export type Step = (typeof STEPS)[number];
export const DEFAULT_STEP: Step = 'checks';
/** The steps of this firm's year-end: «Gewinn verwenden» only where the legal form has a profit allocation (modules/ch/year-end.yaml byLegalForm). */
export const stepsFor = (legalForm: string | undefined): Step[] => STEPS.filter((s) => s !== 'profit' || !!resultCloseOf(legalForm).allocation);
export const stepOf = (s: string | undefined, steps: readonly Step[] = STEPS): Step => (steps as readonly string[]).includes(s ?? '') ? s as Step : DEFAULT_STEP;
/** A link names a step there is none of (urls.md rule 5), or none of this firm's. */
export const stepGone = (s: string | undefined, steps: readonly Step[] = STEPS): boolean => s !== undefined && !(steps as readonly string[]).includes(s);

const GROUPS = [['close.groupBefore', ['q4', 'checks', 'entries']], ['close.groupClose', ['close', 'open']], ['close.groupAfter', ['profit', 'handover']]] as const;
/** The step groups of this firm's year-end, each with the steps it has. */
export const groupsFor = (steps: readonly Step[]): Array<[(typeof GROUPS)[number][0], Step[]]> => GROUPS.map(([g, ss]) => [g, ss.filter((s) => steps.includes(s))]);
