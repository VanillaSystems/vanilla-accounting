/**
 * What a run page, a task and the process map say in the person's words (r7f-35). Apart from
 * filing-summary.ts, which node tests load: this file reaches the dictionaries.
 */
import { localToday, parsePeriod } from '../../../accounting/periods.js';
import { periodName } from '../../lib/period-label.js';
import { isKey, t } from '../../i18n/index.js';
import type { Index } from '../../../types/index.js';
import { payText, signed } from '../bank/model.js';
import { fmt, formatDate } from '../../lib/utils.js';

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
/** An outcome's word, or nothing where the app has none: for a label that must not show an id. */
export const outcomeWord = (outcome: string): string => (isKey(`automation.outcome.${outcome}`) ? t(`automation.outcome.${outcome}` as 'automation.outcome.done') : '');

export const outcomeText = (outcome: string): string => (isKey(`automation.outcome.${outcome}`) ? t(`automation.outcome.${outcome}` as 'automation.outcome.done') : outcome);

/**
 * The payment a task is about, named so that three tasks with one title read apart (#344): who,
 * how much (money out with its minus), when. Empty for a task about anything else.
 */
export function paymentWords(books: Pick<Index, 'transactions'>, item: { kind: string; id: string }): string {
  const p = item.kind === 'transaction' ? books.transactions.find((x) => x.ref === item.id) : undefined;
  return p ? `${p.counterparty?.trim() || payText(p).name}, ${p.currency} ${fmt(signed(p))}, ${formatDate(p.date)}` : '';
}
