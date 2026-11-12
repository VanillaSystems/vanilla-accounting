/** A line of the setup conversation (src/onboarding/conversation.ts) in the person's language: its key, a parameter that is a key said too, a date in the Swiss format. */
import { t } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';
import type { Line, Param } from '../../onboarding/conversation.js';

/** The conversation's keys are built by code, so they are looked up untyped; tests/onboarding-conversation.test.ts proves each exists. */
const text = t as (key: string, vars?: Record<string, string | number>) => string;

const value = (p: Param): string | number => (typeof p !== 'object' ? p : 'date' in p ? formatDate(p.date) : 'list' in p ? p.list.map((k) => text(k)).join(', ') : text(p.key));

export function say(line: Line): string {
  return text(line.key, Object.fromEntries(Object.entries(line.params ?? {}).map(([k, p]) => [k, value(p)])));
}
