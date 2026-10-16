/**
 * Who decided a booking, in words (JournalEntry.by): a company rule, a check of the app's code, the
 * AI, or a person. An entry from before the field says what its `origin` says. `say` is the
 * dictionary (t in the app, wordsIn(lang).t in Node).
 */
import type { BookingFields, JournalEntry } from '../../../types/index.js';
import type { Key } from '../../i18n/types.js';
import { fmt, formatDate } from '../../lib/utils.js';

export type Say = (key: Key, vars?: Record<string, string | number>) => string;

/** The booking page's «Erfasst» line. */
export function bookedByText(e: JournalEntry, say: Say): string {
  const by = e.by;
  if (!by) return say(`journal.originText.${e.origin ?? 'other'}`);
  switch (by.kind) {
    case 'rule': return say('journal.byText.rule', { rule: by.rule });
    case 'code': return say('journal.byText.code', { check: say(`journal.check.${by.check}`) });
    case 'model': return say('journal.byText.model', { model: by.model });
    case 'person': return say('journal.byText.person', { date: formatDate(by.at.slice(0, 10)) });
  }
}

/** The reason in the words of who wrote it: a rule's own line, the app's check, the model's words. */
export function reasonText(e: JournalEntry, reason: string, say: Say): string {
  if (e.by?.kind === 'rule') return reason;
  if (e.by?.kind === 'code') return say('journal.why.code', { text: reason });
  return say('journal.why.ai', { text: reason });
}

/** What a person changed: «MWST V0 → V81». */
export function changesText(e: JournalEntry, was: BookingFields, say: Say): string {
  const shown = (k: keyof BookingFields, v: string | number | undefined) => (k === 'amount' && typeof v === 'number' ? fmt(v) : String(v || '–'));
  return (Object.keys(was) as Array<keyof BookingFields>)
    .map((k) => say('journal.why.change', { field: say(`journal.field.${k}`), was: shown(k, was[k]), now: shown(k, e[k]) }))
    .join(', ');
}
