/**
 * A run's refusal in the person's words: the code's text of the dictionary with its parameters
 * (a date among them is written the way the app writes dates); a run stuck without a code (an
 * older run on disk) shows its log line as it is.
 */
import type { Refusal } from '../../types/refusal.js';
import { tWith } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An engine command the server refused (a start, an answer, a replay): the refusal's words, with its detail where the text takes one. */
export const commandRefusalText = (r: { refusal: string; detail?: string }): string => tWith(`automation.refusal.${r.refusal}`, { detail: r.detail ?? '' });

export function refusalText(error: string | undefined, why?: Refusal): string {
  if (!why) return error ?? '';
  const params = Object.fromEntries(Object.entries(why.params).map(([k, v]) => [k, ISO_DATE.test(v) ? formatDate(v) : k === 'n' ? Number(v) : v]));
  return tWith(`runWhy.${why.code}`, params);
}

/** A fault of the app itself, not of the books (#482): its words say only that; the run view adds that «Weiter» tries again, beside the button. */
export const isAppFault = (why?: Refusal): boolean => why?.code === 'emitsExtra' || why?.code === 'leadsNowhere';

/** The payment where a refusal is answered, when it names one: an account's reconciliation shows on the statement of a movement it holds (#254 reconcilePending). */
export const refusalPayment = (why?: Refusal): { payment: string; date: string } | undefined =>
  why?.code === 'reconcilePending' && why.params.payment ? { payment: why.params.payment, date: why.params.date ?? '' } : undefined;
