/**
 * JournalEntry.by as the books' files hold it, parsed where the books are read (src/books/store.ts
 * loadBooks): what does not read as one of its kinds is left out, so the booking page falls back to
 * what `origin` says instead of trusting a shape it cannot show.
 */
import { CODE_CHECKS, type BookedBy, type BookingFields, type CodeCheck } from '../types/index.js';

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function fieldsOf(v: unknown): BookingFields | undefined {
  if (!isMap(v)) return undefined;
  const out: BookingFields = {};
  for (const k of ['date', 'accountDebit', 'accountCredit', 'vatCode'] as const) if (typeof v[k] === 'string') out[k] = v[k] as string;
  if (typeof v.amount === 'number' && Number.isFinite(v.amount)) out.amount = v.amount;
  return Object.keys(out).length ? out : undefined;
}

export function parseBookedBy(v: unknown): BookedBy | undefined {
  if (!isMap(v)) return undefined;
  switch (v.kind) {
    case 'rule': return isText(v.rule) ? { kind: 'rule', rule: v.rule } : undefined;
    case 'code': return CODE_CHECKS.includes(v.check as never) ? { kind: 'code', check: v.check as CodeCheck } : undefined;
    case 'model': return isText(v.model) ? { kind: 'model', model: v.model } : undefined;
    case 'person': {
      if (!isText(v.at)) return undefined;
      const was = fieldsOf(v.was);
      return { kind: 'person', at: v.at, ...(was ? { was } : {}) };
    }
    case 'assistant': {
      if (!isText(v.at) || !isText(v.conversation)) return undefined;
      const was = fieldsOf(v.was);
      return { kind: 'assistant', at: v.at, conversation: v.conversation, ...(was ? { was } : {}) };
    }
    default: return undefined;
  }
}
