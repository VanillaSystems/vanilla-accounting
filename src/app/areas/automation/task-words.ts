/**
 * A task in words without the dictionaries (node tests load it): the payment it is about, and the
 * line that stands for several tasks of one step (#365). words.ts gives them the viewer's language.
 */
import type { BankTransaction } from '../../../types/index.js';
import { textIn, type Task, type Text } from '../../../workflows/model.js';
import { payText, signed } from '../bank/model.js';
import { fmt, formatDate } from '../../lib/utils.js';

/**
 * The payment a task is about, named so that tasks with one title read apart (#344, #365): who,
 * how much (money out with its minus), when. Empty for a task about anything else.
 */
export function paymentWords(task: Pick<Task, 'payment'>): string {
  const p = task.payment;
  return p ? `${p.counterparty?.trim() || payText(p as BankTransaction).name}, ${p.currency} ${fmt(signed(p as BankTransaction))}, ${formatDate(p.date)}` : '';
}

/** Several tasks of one step in one line, in `lang`: «11 Zahlungen von Hand buchen». */
export const manyText = (many: Text, n: number, lang: string): string => textIn(many, lang).replace(/\{n\}/g, String(n));
