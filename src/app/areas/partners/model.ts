/**
 * Geschäftspartner and Wissen as data, browser-safe: which partners a filter shows, the notes'
 * prose as blocks a page renders (paragraphs, lists, bold; never HTML), what the books hold for a
 * partner, newest first, and which rules belong to a page.
 */
import type { PartnerRow } from '../../../knowledge/partners.js';
import type { Role } from '../../../knowledge/counterparties.js';
import type { RuleLine } from '../company/rules-model.js';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../../../types/index.js';
import { SENTENCE_END } from '../../../knowledge/note-rules.js';

export const FILTERS = ['all', 'supplier', 'customer', 'authority', 'open'] as const;
export type PartnerFilter = typeof FILTERS[number];

const plays = (r: PartnerRow, role: Role) => r.role === role || r.roles.includes(role);

export function passes(r: PartnerRow, filter: PartnerFilter, q?: string): boolean {
  const byFilter = filter === 'all' || (filter === 'open' ? r.open > 0 : plays(r, filter));
  return byFilter && (!q || r.name.toLowerCase().includes(q.trim().toLowerCase()) || r.id.toLowerCase().includes(q.trim().toLowerCase()));
}

export const countOf = (rows: readonly PartnerRow[], filter: PartnerFilter): number => rows.filter((r) => passes(r, filter)).length;

/** A run of text, bold or not. */
export interface Inline { text: string; bold?: boolean }
export type Block = { kind: 'p'; parts: Inline[] } | { kind: 'ul'; items: Inline[][] } | { kind: 'h'; text: string };

const inline = (s: string): Inline[] => s.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? { text: part.slice(2, -2), bold: true } : { text: part }));

/** Pure. The notes as blocks: a blank line ends a paragraph, «- » starts a list item, «# » a heading, **…** is bold. */
export function proseBlocks(text: string): Block[] {
  return text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).flatMap((para): Block[] => {
    const lines = para.split('\n');
    if (lines.length === 1 && /^#{1,6} /.test(lines[0])) return [{ kind: 'h', text: lines[0].replace(/^#+ /, '') }];
    if (lines.every((l) => /^\s*[-*] /.test(l))) return [{ kind: 'ul', items: lines.map((l) => inline(l.replace(/^\s*[-*] /, ''))) }];
    return [{ kind: 'p', parts: inline(lines.join(' ')) }];
  });
}

/** Pure. A block's runs cut into sentences (SENTENCE_END), each a list of runs; a sentence may span a bold run. */
export function sentenceRuns(parts: readonly Inline[]): Inline[][] {
  const out: Inline[][] = [[]];
  for (const part of parts) {
    const pieces = part.text.split(new RegExp(`(${SENTENCE_END.source})`, 'u'));
    pieces.forEach((piece, i) => {
      if (i % 2) { out.push([]); return; }
      if (piece) out.at(-1)!.push({ ...part, text: piece });
    });
  }
  return out.filter((s) => s.length);
}

export interface Linked {
  entries: JournalEntry[];
  receipts: Receipt[];
  payments: BankTransaction[];
}

const newest = <T extends { date?: string }>(xs: T[]) => xs.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

/** Pure. A partner's records of the open year as the books hold them, newest first. */
export function linkedOf(row: PartnerRow, books: Pick<Index, 'journalEntries' | 'receipts' | 'transactions'>): Linked {
  const ids = (xs: string[]) => new Set(xs);
  const [e, r, p] = [ids(row.entries), ids(row.receipts), ids(row.payments)];
  return {
    entries: newest((books.journalEntries ?? []).filter((x) => e.has(x.id))),
    receipts: newest(books.receipts.filter((x) => r.has(x.id))),
    payments: newest(books.transactions.filter((x) => p.has(x.ref))),
  };
}

/** Pure. The rules a partner's page shows: those in its file, the ones the app carries out first. */
export const partnerRules = (lines: readonly RuleLine[], id: string): RuleLine[] => lines.filter((l) => l.row.business === id);

/** Pure. The company rules (not of one partner) of the steps a topic names: `booking#private` holds booking.guide.yaml#private. */
export function topicRules(lines: readonly RuleLine[], steps: readonly string[]): RuleLine[] {
  const want = new Set(steps.map((s) => { const [p, id] = s.split('#'); return `${p.endsWith('.guide.yaml') ? p : `${p}.guide.yaml`}#${id ?? ''}`; }));
  return lines.filter((l) => !l.row.business && want.has(l.row.step));
}
