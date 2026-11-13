/**
 * What the filing workflow hands a person to check (usability finding quarter-close-19): a return
 * by what is to pay and the boxes that are not zero, in the form's order. The words are the
 * area's (automation.tsx); the boxes come from the jurisdiction's form.
 */
import type { PeriodReturn } from '../../../workflows/filing.js';
import { ratesWithoutActivityId, vat } from '../../../engines/index.js';
import type { Task } from '../../../workflows/model.js';
import type { Index } from '../../../types/index.js';
import { openSaleQuestionsIn, type Question } from '../../../questions/model.js';
import type { ProviderIssues } from '../../../booking/provider-issues.js';

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
 * activity code (r6f-22), the owner's open VAT questions about the period's payments (r8h-24),
 * each of which the XML step would refuse, and the orders of the period a provider's sales report
 * holds because it cannot tell their VAT rates apart (#405, `rate`): their turnover is not in the return, and «Aufteilen» is the way
 * out. An order held for another reason (a possible test order, one booked elsewhere) is shown, never withheld for. The task shows it where the person decides and
 * withholds that outcome; undefined when nothing stands in the way.
 */
export function approvalWithheld(task: Pick<Task, 'workflow' | 'step' | 'reads'>, questions: readonly Question[], books: Pick<Index, 'transactions'>, provider?: Pick<ProviderIssues, 'held'>): { rates: string[]; questions: number; held: number; outcome: 'approved' } | undefined {
  if (task.workflow !== 'vat-filing' || task.step !== 'review') return undefined;
  const ret = task.reads?.return as PeriodReturn | undefined;
  if (!ret) return undefined;
  const w = withheldIn(ret.figures, questions, books, ret.from, ret.to, provider);
  return w.rates.length || w.questions || w.held ? { ...w, outcome: 'approved' } : undefined;
}

/**
 * What withholds the approval of the return of the days `from`–`to`, one count per kind: the net tax
 * rates without their activity code (by `figures`, the return's), the open VAT questions about its
 * sales, the orders a sales report held for their rates. The review (approvalWithheld) and the lead
 * of «Noch offen» (period-issues.ts issuesLead) read it alike (#428).
 */
export function withheldIn(figures: Record<string, number> | undefined, questions: readonly Question[], books: Pick<Index, 'transactions'>, from: string, to: string, provider?: Pick<ProviderIssues, 'held'>): { rates: string[]; questions: number; held: number } {
  return {
    rates: figures ? ratesWithoutActivityId(figures) : [],
    questions: openSaleQuestionsIn(questions, books, from, to).length,
    held: (provider?.held ?? []).filter((h) => h.why === 'rate' && !h.filed && h.date >= from && h.date <= to).length,
  };
}

/** The file name of a path, either separator. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
