/**
 * Wissen besides the topic pages (docs/0.4.0/knowledge.md): Lücken, where the app could not go on
 * alone, and Von der App, what the app's public layer (processes/) knows for every company. Both
 * are computed from what exists, the books, the questions, the knowledge files; neither adds a file.
 */
import type { Counterparty, Role } from './counterparties.js';
import type { Gap } from './gaps.js';
import type { Knowledge, Section } from './layers.js';
import { fileNotesOf, type FileNote, type PartnerRow } from './partners.js';
import type { BookedBy, Index, JournalEntry } from '../types/index.js';
import { isBankFee } from '../booking/separate-fee.js';

/** Who decided a payment's booking: a company rule, a check of the app's code, the AI, a person, or the entry does not say. */
export const DECIDERS = ['rule', 'code', 'model', 'person', 'unknown'] as const;
export type Decider = typeof DECIDERS[number];

export interface GapsView {
  year: string;
  /** The open year's payments, apart from bank fee rows. */
  payments: number;
  /** Booked payments by who decided their booking. */
  decided: Record<Decider, number>;
  /** Payments with no entry yet. */
  unbooked: number;
  /** Payments that route to no partner, grouped by their text, the most frequent first. */
  unrouted: Array<Gap & { date: string }>;
  unroutedTotal: number;
  /** Open questions per partner; `partner` absent: on payments of no partner. */
  open: Array<{ partner?: string; name?: string; count: number }>;
  /** Payments an ask rule holds until the person answers. */
  asked: number;
}

/** Pure. Who decided an entry, from its `by`, else from the writer its `origin` names. */
export function deciderOf(e: Pick<JournalEntry, 'by' | 'origin'>): Decider {
  const by: BookedBy | undefined = e.by;
  if (by) return by.kind === 'assistant' || by.kind === 'person' ? 'person' : by.kind;
  if (e.origin === 'manual') return 'person';
  if (e.origin === 'invoice' || e.origin === 'year-close') return 'code';
  return 'unknown';
}

/** Pure. A payment's decider: a person when one changed any of its entries, else the strongest writer among them. */
const ORDER: Decider[] = ['person', 'rule', 'code', 'model', 'unknown'];
export function decidedShares(books: Pick<Index, 'transactions' | 'journalEntries'>, year: string): Pick<GapsView, 'payments' | 'decided' | 'unbooked'> {
  const byRef = new Map<string, Decider[]>();
  for (const e of books.journalEntries ?? []) byRef.set(e.transactionRef, [...(byRef.get(e.transactionRef) ?? []), deciderOf(e)]);
  const decided = Object.fromEntries(DECIDERS.map((d) => [d, 0])) as Record<Decider, number>;
  let payments = 0;
  let unbooked = 0;
  for (const tx of books.transactions) {
    if (!tx.date.startsWith(year) || isBankFee(tx)) continue;
    payments++;
    const ds = byRef.get(tx.ref);
    if (!ds) { unbooked++; continue; }
    decided[ORDER.find((d) => ds.includes(d))!]++;
  }
  return { payments, decided, unbooked };
}

/** Pure. Open questions per partner, the most first; those on payments of no partner in one line. */
export function openByPartner(rows: readonly PartnerRow[], openTotal: number): GapsView['open'] {
  const out: GapsView['open'] = rows.filter((r) => r.open > 0).map((r) => ({ partner: r.id, name: r.name, count: r.open })).sort((a, b) => b.count - a.count);
  const rest = openTotal - out.reduce((n, x) => n + x.count, 0);
  return rest > 0 ? [...out, { count: rest }] : out;
}

/** A step of a process of the app layer: its goal and its sentences. */
export interface AppStep { id: string; goal?: string; rules: Array<{ id: string; when: string; then: string }> }

export interface AppLayerView {
  /** The businesses the app knows for every company; `known`: the company works with it (a partner page exists). */
  partners: Array<{ id: string; name: string; role: Role; notes: FileNote[]; facts: Array<{ id: string; fact: string; source: string }>; known: boolean }>;
  processes: Array<{ file: string; process: string; steps: AppStep[] }>;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : v === undefined ? '' : JSON.stringify(v));

/** Pure. The app layer as Von der App shows it: read only, the company's own files left out. */
export function appLayerOf(k: Pick<Knowledge, 'counterparties' | 'counterpartyFiles' | 'guides'>, partnerIds: ReadonlySet<string>): AppLayerView {
  const vendors = k.counterpartyFiles.filter((f) => f.layer === 'app');
  const byId = new Map<string, Counterparty>(k.counterparties.map((c) => [c.id, c]));
  const partners = vendors.map((f) => {
    const id = f.path.replace(/^.*\//, '').replace(/\.yaml$/, '');
    const c = byId.get(id);
    return { id, name: c?.name ?? f.body.name ?? id, role: f.role, notes: fileNotesOf(f), facts: (f.body.facts ?? []).filter((x): x is { id: string; fact: string; source: string } => !!x.id && !!x.fact && !!x.source), known: partnerIds.has(id) };
  }).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const processes = k.guides.filter((g) => g.layer === 'app').map((g) => ({
    file: g.path,
    process: g.body.process ?? g.path.replace(/^.*\//, '').replace(/\.guide\.yaml$/, ''),
    steps: Object.entries(g.body.steps ?? {}).map(([id, s]: [string, Section]) => ({
      id,
      ...(typeof s?.goal === 'string' ? { goal: s.goal.trim() } : {}),
      rules: (s?.rules ?? []).map((r) => ({ id: asText(r.id), when: asText(r.when), then: asText(r.then) })),
    })),
  }));
  return { partners, processes };
}
