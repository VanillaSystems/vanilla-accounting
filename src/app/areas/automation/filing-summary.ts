/**
 * What the filing workflow hands a person to check (usability finding quarter-close-19): a return
 * by what is to pay and the boxes that are not zero, in the form's order. The words are the
 * area's (automation.tsx); the boxes come from the jurisdiction's form.
 */
import type { PeriodReturn } from '../../../workflows/filing.js';
import { vat } from '../../../engines/index.js';

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

/** The file name of a path, either separator. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
