/**
 * What the composer's «+» can attach to a message (src/app/assistant/Picker.tsx): the page's own
 * reference, and the kinds the server reads when the message is sent (src/assistant/context.ts),
 * each a search over the books or the automation. «@» offers the automation part of it. Pure, so a
 * test can walk it without a browser.
 */
import type { Index } from '../../types/index.js';
import type { ContextRef } from '../../types/assistant.js';
import { fmt, formatDate } from '../lib/utils.js';

/** A row the picker offers: the reference, what tells it apart from its neighbours, and the text a search reads. */
export interface Candidate { ref: ContextRef; detail: string; find: string }

/** The picker's categories, in the order shown. `automation` is what «@» offers: a workflow or a run. */
export const PICK_KINDS = ['receipt', 'entry', 'payment', 'automation'] as const;
export type PickKind = (typeof PICK_KINDS)[number];

/** Where the picker is: its first list, or the search within one category. */
export type PickLevel = 'root' | PickKind;

export type PickRow =
  | { kind: 'page'; ref: ContextRef }
  | { kind: 'category'; of: PickKind }
  | { kind: 'item'; c: Candidate };

const amountOf = (amount: number | undefined, currency?: string) => (amount == null ? '' : `${currency ?? ''} ${fmt(amount)}`.trim());
const newestFirst = <T extends { date?: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
const row = (ref: ContextRef, parts: Array<string | false | undefined>, amount?: number): Candidate => {
  const detail = parts.filter(Boolean).join(' · ');
  return { ref, detail, find: `${ref.label} ${ref.id} ${detail} ${amount?.toFixed(2) ?? ''}`.toLowerCase() };
};

/** The books' receipts, bookings or payments as rows, newest first. */
export function bookCandidates(books: Pick<Index, 'receipts' | 'transactions' | 'journalEntries'>, kind: 'receipt' | 'entry' | 'payment'): Candidate[] {
  switch (kind) {
    case 'receipt': return newestFirst(books.receipts).map((r) => row(
      { kind: 'receipt', id: r.id, label: r.description || r.filename },
      [r.date && formatDate(r.date), amountOf(r.amount, r.currency), !!r.description && r.filename], r.amount,
    ));
    case 'entry': return newestFirst(books.journalEntries ?? []).map((e) => row(
      { kind: 'entry', id: e.id, label: e.description || e.id },
      [formatDate(e.date), fmt(e.amount), e.id], e.amount,
    ));
    case 'payment': return newestFirst(books.transactions).map((x) => row(
      { kind: 'payment', id: x.ref, label: x.description || x.ref },
      [formatDate(x.date), amountOf(x.amount, x.currency)], x.amount,
    ));
  }
}

/** The rows holding every typed word, in the order given, at most `limit`. */
export function search(cands: readonly Candidate[], query: string, limit: number): Candidate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: Candidate[] = [];
  for (const c of cands) {
    if (words.every((w) => c.find.includes(w))) out.push(c);
    if (out.length === limit) break;
  }
  return out;
}

/** In the first list, without a word typed: the page's reference and the categories; with one, the categories it names and the rows of every category it finds. */
export function pickRows(
  level: PickLevel, query: string, page: ContextRef | undefined,
  sources: Record<PickKind, readonly Candidate[]>, categoryLabel: (k: PickKind) => string,
): PickRow[] {
  if (level !== 'root') return search(sources[level], query, 40).map((c) => ({ kind: 'item', c }));
  const q = query.trim().toLowerCase();
  if (!q) return [...(page ? [{ kind: 'page' as const, ref: page }] : []), ...PICK_KINDS.map((of) => ({ kind: 'category' as const, of }))];
  return [
    ...(page && page.label.toLowerCase().includes(q) ? [{ kind: 'page' as const, ref: page }] : []),
    ...PICK_KINDS.filter((k) => categoryLabel(k).toLowerCase().includes(q)).map((of) => ({ kind: 'category' as const, of })),
    ...PICK_KINDS.flatMap((k) => search(sources[k], q, 4).map((c) => ({ kind: 'item' as const, c }))),
  ];
}

export const sameRef = (a: ContextRef, b: ContextRef): boolean => a.kind === b.kind && a.id === b.id;
