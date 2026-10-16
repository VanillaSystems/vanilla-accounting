/**
 * What the filing workflow hands a person to check (usability finding quarter-close-19): a return
 * by what is to pay and the boxes that are not zero, in the form's order. The words are the
 * area's (automation.tsx); the boxes come from the jurisdiction's form.
 */
import type { PeriodReturn } from '../../../workflows/filing.js';
import { ratesWithoutActivityId, vat } from '../../../engines/index.js';
import type { Task } from '../../../workflows/model.js';
import { localToday, parsePeriod } from '../../../accounting/periods.js';
import { periodName } from '../../lib/period-label.js';
import { isKey, t } from '../../i18n/index.js';

export interface ReturnSummary {
  period: string;
  /** What the return asks: to pay, a credit back, or nothing. */
  due: { kind: 'pay' | 'credit' | 'nothing'; amount: number };
  /** Every box with an amount, in the form's order, the payable and the credit left out (they are `due`). */
  boxes: Array<{ box: string; amount: number }>;
}

export function returnSummary(ret: PeriodReturn): ReturnSummary {
  const { payable, credit } = vat().form;
  const due: ReturnSummary['due'] = ret.payable > 0 ? { kind: 'pay', amount: ret.payable } : ret.payable < 0 ? { kind: 'credit', amount: -ret.payable } : { kind: 'nothing', amount: 0 };
  const boxes = Object.entries(ret.figures)
    .filter(([box, amount]) => amount && box !== payable && box !== credit)
    .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b))
    .map(([box, amount]) => ({ box, amount }));
  return { period: ret.period, due, boxes };
}

/**
 * What the review of a return cannot let through yet: the net tax rates without the authority's
 * activity code, which the XML step would refuse (r6f-22). The task shows it where the person
 * decides and withholds that outcome; undefined when nothing stands in the way.
 */
export function approvalWithheld(task: Pick<Task, 'workflow' | 'step' | 'reads'>): { rates: string[]; outcome: 'approved' } | undefined {
  if (task.workflow !== 'vat-filing' || task.step !== 'review') return undefined;
  const ret = task.reads?.return as PeriodReturn | undefined;
  const rates = ret ? ratesWithoutActivityId(ret.figures) : [];
  return rates.length ? { rates, outcome: 'approved' } : undefined;
}

/** A filing period a step read or a task names («2026-H1»), as the person reads it («1. Semester 2026»); any other value as it is. */
export function periodText(value: string): string {
  const p = parsePeriod(value, localToday());
  return p && p.kind !== 'all' ? periodName(p) : value;
}

/** A task's reads with its period in words, for the title and the lines of the task (r7f-35). */
export function readsInWords(reads: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return reads && typeof reads.period === 'string' ? { ...reads, period: periodText(reads.period) } : reads;
}

/** A step's outcome as the person reads it («Freigegeben», «Zurück»); an outcome without words stays its id. */
export const outcomeText = (outcome: string): string => (isKey(`automation.outcome.${outcome}`) ? t(`automation.outcome.${outcome}` as 'automation.outcome.done') : outcome);

/** The file name of a path, either separator. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
