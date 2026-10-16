/**
 * A run's refusal in the person's words: the code's text of the dictionary with its parameters
 * (a date among them is written the way the app writes dates); a run stuck without a code (an
 * older run on disk) shows its log line as it is.
 */
import type { Refusal } from '../../types/refusal.js';
import { tWith } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function refusalText(error: string | undefined, why?: Refusal): string {
  if (!why) return error ?? '';
  const params = Object.fromEntries(Object.entries(why.params).map(([k, v]) => [k, ISO_DATE.test(v) ? formatDate(v) : k === 'n' ? Number(v) : v]));
  return tWith(`runWhy.${why.code}`, params);
}
