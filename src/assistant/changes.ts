/**
 * The changes to the books an answer asks for: a ```vanilla-changes block at its end, a JSON list
 * of BookChange (src/types/assistant.ts). The block is cut from the text the person reads; every
 * change is checked here, at the edge, before src/server/edits.ts applies it.
 */
import type { BookChange, EntrySet, ReceiptSet } from '../types/assistant.js';

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
  if ('vat' in s) {
    const v = obj(s.vat, 'vat');
    if (typeof v.hasSwissVat !== 'boolean') throw new ChangesError('vat.hasSwissVat');
    const groups = Array.isArray(v.vatSummary) ? v.vatSummary.map((g) => {
      const o = obj(g, 'vatSummary');
      return { ratePercent: num(o.ratePercent, 'ratePercent'), vat: num(o.vat, 'vat'), ...(o.net !== undefined ? { net: num(o.net, 'net') } : {}), ...(o.gross !== undefined ? { gross: num(o.gross, 'gross') } : {}) };
    }) : [];
    if (v.hasSwissVat && !groups.length) throw new ChangesError('vat.vatSummary');
    out.vat = { hasSwissVat: v.hasSwissVat, vatSummary: groups, ...(typeof v.vatId === 'string' && v.vatId ? { vatId: v.vatId } : {}) };
  }
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

function change(v: unknown): BookChange {
  const c = obj(v, 'change');
  switch (c.kind) {
    case 'receipt': return { kind: 'receipt', id: str(c.id, 'id'), set: receiptSet(c.set) };
    case 'link': case 'unlink': return { kind: c.kind, receipt: str(c.receipt, 'receipt'), payment: str(c.payment, 'payment') };
    case 'entry': return { kind: 'entry', id: str(c.id, 'id'), set: entrySet(c.set) };
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
