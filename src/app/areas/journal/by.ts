/**
 * Who decided a booking, in words (JournalEntry.by): a company rule, a check of the app's code, the
 * AI, a person, or the AI sidebar on a person's wish. An entry from before the field says what its `origin` says. `say` is the
 * dictionary (t in the app, wordsIn(lang).t in Node).
 */
import type { BookingFields, JournalEntry } from '../../../types/index.js';
import type { Key } from '../../i18n/types.js';
import { fmt, formatDate } from '../../lib/utils.js';
import de from '../../i18n/locales/de.js';

/**
 * The bank's fee row: its booking reuses the purchase check's stamp (classify.ts bankFeeEntries), its
 * reason, written in German, says what it is. The «Erfasst» line reads it from there (#398), so a fee
 * is never told in a purchase's words; the stamp stays as it is.
 */
const FEE_REASONS = (['bankFee.reason', 'bankFee.refundReason'] as const).map((k) => de.messages[k].split('{')[0]);
export const isFeeRow = (e: Pick<JournalEntry, 'by' | 'reason'>): boolean => e.by?.kind === 'code' && !!e.reason && FEE_REASONS.some((p) => e.reason!.startsWith(p));

export type Say = (key: Key, vars?: Record<string, string | number>) => string;

/** The booking page's «Erfasst» line. */
export function bookedByText(e: JournalEntry, say: Say): string {
  const by = e.by;
  if (!by) return say(`journal.originText.${e.origin ?? 'other'}`);
  switch (by.kind) {
    case 'rule': return say('journal.byText.rule', { rule: by.rule });
    case 'code': return say('journal.byText.code', { check: say(isFeeRow(e) ? 'journal.check.bankFee' : `journal.check.${by.check}`) });
    case 'model': return say('journal.byText.model', { model: by.model });
    case 'person': return say('journal.byText.person', { date: formatDate(by.at.slice(0, 10)) });
    case 'assistant': return say('journal.byText.assistant', { date: formatDate(by.at.slice(0, 10)) });
  }
}

/** The reason in the words of who wrote it: a rule's own line, the app's check, the model's words. */
export function reasonText(e: JournalEntry, reason: string, say: Say): string {
  if (e.by?.kind === 'rule') return reason;
  if (e.by?.kind === 'code') return say('journal.why.code', { text: reason });
  return say('journal.why.ai', { text: reason });
}

/** What a person, or the AI on her wish, changed, field by field: the code V0 → V81. */
export function changesText(e: JournalEntry, was: BookingFields, say: Say): string {
  const shown = (k: keyof BookingFields, v: string | number | undefined) => (k === 'amount' && typeof v === 'number' ? fmt(v) : String(v || '–'));
  return (Object.keys(was) as Array<keyof BookingFields>)
    .map((k) => say('journal.why.change', { field: say(`journal.field.${k}`), was: shown(k, was[k]), now: shown(k, e[k]) }))
    .join(', ');
}
