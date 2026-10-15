/**
 * The changes to the books an answer asks for: a ```vanilla-changes block at its end, a JSON list
 * of BookChange (src/types/assistant.ts). The block is cut from the text the person reads; every
 * change is checked here, at the edge, before src/server/edits.ts applies it.
 */
import type { BookChange, EntrySet, NewEntry, ReceiptSet } from '../types/assistant.js';
import { parseVatFacts } from '../accounting/vat-facts.js';

const BLOCK = /```vanilla-changes\s*([\s\S]*?)(?:```|$)/;

/** The text without the block; also while it streams in, an unfinished block is not shown. */
export const withoutChanges = (text: string): string => text.replace(BLOCK, '').trimEnd();

export class ChangesError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ChangesError(`${what} fehlt`);
  return v.trim();
};
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ChangesError(`${what} ist keine Zahl`);
  return v;
};
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ChangesError(`${what} fehlt`);
  return v as Record<string, unknown>;
};

function receiptSet(v: unknown): ReceiptSet {
  const s = obj(v, 'set');
  const out: ReceiptSet = {};
  if ('date' in s) {
    if (s.date !== null && !DATE.test(String(s.date))) throw new ChangesError('date muss JJJJ-MM-TT sein');
    out.date = s.date === null ? null : String(s.date);
  }
  if ('amount' in s) out.amount = s.amount === null ? null : num(s.amount, 'amount');
  if ('currency' in s) { const c = str(s.currency, 'currency').toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) throw new ChangesError('currency'); out.currency = c; }
  if ('description' in s) out.description = typeof s.description === 'string' ? s.description : '';
  if ('vat' in s) out.vat = parseVatFacts(s.vat, (what) => { throw new ChangesError(what); });
  if (!Object.keys(out).length) throw new ChangesError('set ist leer');
  return out;
}

function entrySet(v: unknown): EntrySet {
  const s = obj(v, 'set');
  const out: EntrySet = {};
  for (const k of ['accountDebit', 'accountCredit', 'description', 'vatCode'] as const) if (k in s) out[k] = k === 'description' || k === 'vatCode' ? String(s[k] ?? '') : str(s[k], k);
  if ('date' in s) { if (!DATE.test(String(s.date))) throw new ChangesError('date muss JJJJ-MM-TT sein'); out.date = String(s.date); }
  if ('amount' in s) out.amount = num(s.amount, 'amount');
  if (!Object.keys(out).length) throw new ChangesError('set ist leer');
  return out;
}

/** A booking the AI adds: always the person's (origin manual); the exchange rate of a foreign payment comes from its other bookings (src/server/edits.ts). */
function newEntry(v: unknown): NewEntry {
  const e = obj(v, 'entry');
  const date = str(e.date, 'date');
  if (!DATE.test(date)) throw new ChangesError('date muss JJJJ-MM-TT sein');
  const amount = num(e.amount, 'amount');
  if (amount === 0) throw new ChangesError('amount ist 0');
  const text = (k: string) => (typeof e[k] === 'string' && e[k].trim() ? e[k].trim() : undefined);
  const accountDebit = text('accountDebit') ?? '';
  const accountCredit = text('accountCredit') ?? '';
  if (!accountDebit && !accountCredit) throw new ChangesError('accountDebit oder accountCredit fehlt');
  const transactionRef = text('transactionRef');
  const vatCode = text('vatCode');
  const corrects = text('corrects');
  return {
    ...(transactionRef && { transactionRef }), date, accountDebit, accountCredit, amount,
    ...(vatCode && { vatCode }), description: str(e.description, 'description'), ...(corrects && { corrects }), origin: 'manual',
  };
}

function change(v: unknown): BookChange {
  const c = obj(v, 'change');
  switch (c.kind) {
    case 'receipt': return { kind: 'receipt', id: str(c.id, 'id'), set: receiptSet(c.set) };
    case 'link': case 'unlink': return { kind: c.kind, receipt: str(c.receipt, 'receipt'), payment: str(c.payment, 'payment') };
    case 'entry': return { kind: 'entry', id: str(c.id, 'id'), set: entrySet(c.set) };
    case 'newEntry': return { kind: 'newEntry', entry: newEntry(c.entry) };
    case 'deleteEntry': return { kind: 'deleteEntry', id: str(c.id, 'id') };
    default: throw new ChangesError(`unbekannte Änderung ${String(c.kind)}`);
  }
}

/** The changes the answer asks for; none without a block. A block that does not parse throws. */
export function changesIn(text: string): BookChange[] {
  const m = BLOCK.exec(text);
  if (!m) return [];
  let raw: unknown;
  try { raw = JSON.parse(m[1]); } catch { throw new ChangesError('kein gültiges JSON'); }
  if (!Array.isArray(raw)) throw new ChangesError('keine Liste');
  return raw.map(change);
}
