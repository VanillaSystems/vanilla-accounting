/**
 * Geschäftspartner (docs/0.4.0/knowledge.md): the businesses the company works with, one page each.
 * A partner is a business file of the workspace (knowledge/<role>/<id>.yaml, with the app layer's
 * facts merged in), a public business of the app layer that the open year's payments route to, a
 * business with notes, or a customer of Rechnungen (one partner, two views: the customer list of
 * Rechnungen and this page read the same record). What the books hold for a partner is found by
 * code: a payment by the same routing the booking uses (src/knowledge/counterparties.ts identify),
 * a customer's payments by the invoices they paid.
 */
import type { Counterparty, Role, Tier } from './counterparties.js';
import { identify, signalsOfReceipt, signalsOfTransaction, TIERS } from './counterparties.js';
import type { CounterpartyFile, Section } from './layers.js';
import type { RuleRow } from '../booking/rule-book.js';
import type { InvoiceBook } from '../invoices/model.js';
import type { Question, QuestionTarget } from '../questions/model.js';
import type { Index, Receipt } from '../types/index.js';
import type { Note } from './notes.js';
import { isBankFee } from '../booking/separate-fee.js';

/** Where a partner comes from: the app's public file, the company's own file, Rechnungen's customer list. */
export interface PartnerLayers { app: boolean; workspace: boolean; customer: boolean }

/** One partner as the list shows it, with what the open year's books hold for it, by id. */
export interface PartnerRow {
  id: string;
  name: string;
  role: Role;
  roles: Role[];
  layers: PartnerLayers;
  notes: boolean;
  /** The rules in its file the app carries out. */
  rules: number;
  payments: string[];
  entries: string[];
  receipts: string[];
  /** Invoice ids (Rechnungen) of a customer. */
  invoices: string[];
  /** Questions still open on its payments, receipts or entries. */
  open: number;
}

export interface PartnersView { year: string; partners: PartnerRow[] }

/** A sentence of a business file the app does not carry out: the AI reads it in its step. */
export interface FileNote { step: string; id: string; when: string; then: string; source?: string; layer: 'app' | 'workspace' }

export interface PartnerDetail {
  /** The open year its records are of. */
  year: string;
  row: PartnerRow;
  note?: Note;
  /** How the app recognises it, per signal (the file patterns as written). */
  match: Record<Tier, string[]>;
  /** The names of `match.tx` the company's file learned from confirmed links (src/knowledge/learned-names.ts): a person may take each out, for good. */
  learned: string[];
  documents: Array<{ id: string; kind: string }>;
  accounts?: string[];
  facts: Array<{ id: string; fact: string; source: string }>;
  /** Its files, relative to the app's or the workspace's folder. */
  files: string[];
  /** The sentences of its files the app does not carry out, the app layer's first. */
  fileNotes: FileNote[];
  /** Decided cases (precedents) in its files. */
  cases: number;
  questions: Array<{ id: string; text: string; on: QuestionTarget; askedAt: string }>;
}

export interface PartnerInput {
  /** The open year, YYYY. */
  year: string;
  counterparties: readonly Counterparty[];
  /** Partner notes files by id, with the role of their folder. */
  noted: ReadonlyMap<string, Role>;
  books: Pick<Index, 'transactions' | 'receipts' | 'mappings' | 'journalEntries'>;
  invoices: Pick<InvoiceBook, 'customers' | 'invoices'>;
  questions: readonly Question[];
  rules: readonly RuleRow[];
}

const inYear = (year: string, date: string | undefined) => !!date && date.startsWith(year);
const push = (m: Map<string, Set<string>>, k: string, v: string) => { const s = m.get(k) ?? new Set<string>(); s.add(v); m.set(k, s); };
const sorted = (s: Set<string> | undefined) => [...(s ?? [])];

/** Pure. The partners and what the open year's books hold for each, the busiest first, then by name. */
export function partnersOf(input: PartnerInput): PartnersView {
  const { year, counterparties, books, invoices } = input;
  const entries = books.journalEntries ?? [];
  const receipts = new Map(books.receipts.map((r) => [r.id, r]));
  const linked = (ref: string): Receipt[] => books.mappings.filter((m) => m.transactionRef === ref).flatMap((m) => receipts.get(m.receiptId) ?? []);
  const payments = new Map<string, Set<string>>();
  const receiptsOf = new Map<string, Set<string>>();
  const partnerOfPayment = new Map<string, string[]>();
  const known = (r: ReturnType<typeof identify>) => (r.kind === 'known' ? r.counterparty : undefined);

  const entriesOf = new Map<string, Set<string>>();
  const entriesByRef = new Map<string, typeof entries>();
  for (const e of entries) entriesByRef.set(e.transactionRef, [...(entriesByRef.get(e.transactionRef) ?? []), e]);
  const claim = (id: string, ref: string, own: readonly typeof entries[number][]) => {
    push(payments, id, ref);
    partnerOfPayment.set(ref, [...new Set([...(partnerOfPayment.get(ref) ?? []), id])]);
    for (const e of own) push(entriesOf, id, e.id);
  };

  const txs = books.transactions.filter((tx) => inYear(year, tx.date) && !isBankFee(tx));
  for (const tx of txs) {
    const own = linked(tx.ref);
    const booked = entriesByRef.get(tx.ref) ?? [];
    if (tx.parts && tx.parts.length > 1) {
      // A Sammelzahlung pays several payees: each part routes by its own, its receipts by theirs, and
      // an entry belongs to the part of its amount (the entries split a Sammelzahlung by its parts).
      const parts = tx.parts.map((p) => ({ amount: Math.abs(p.amount), id: known(identify({ uids: [], ibans: p.counterpartyIban ? [p.counterpartyIban.replace(/\s+/g, '').toUpperCase()] : [], domains: [], names: [p.counterparty].filter(Boolean), filenames: [] }, counterparties)) }));
      for (const part of parts) {
        if (!part.id) continue;
        claim(part.id, tx.ref, booked.filter((e) => Math.abs(Math.abs(e.amount) - part.amount) < 0.005));
      }
      for (const r of own) { const id = known(identify(signalsOfReceipt(r), counterparties)); if (id) push(receiptsOf, id, r.id); }
      continue;
    }
    const id = known(identify(signalsOfTransaction(tx, own), counterparties));
    if (!id) continue;
    claim(id, tx.ref, booked);
    for (const r of own) push(receiptsOf, id, r.id);
  }
  const mapped = new Set(books.mappings.map((m) => m.receiptId));
  for (const r of books.receipts) {
    if (mapped.has(r.id) || !inYear(year, r.date)) continue;
    const id = known(identify(signalsOfReceipt(r), counterparties));
    if (id) push(receiptsOf, id, r.id);
  }

  const customers = invoices.customers.filter((c) => !c.deleted);
  const invoicesOf = new Map<string, Set<string>>();
  for (const inv of invoices.invoices) {
    if (inv.deleted || !inYear(year, inv.date)) continue;
    push(invoicesOf, inv.customerId, inv.id);
    if (inv.status !== 'issued') continue;
    for (const p of inv.payments) claim(inv.customerId, p.transactionRef, entriesByRef.get(p.transactionRef) ?? []);
  }

  const partnerOfReceipt = new Map<string, string>();
  for (const [id, rs] of receiptsOf) for (const r of rs) partnerOfReceipt.set(r, id);
  const partnersOfEntry = new Map<string, string[]>();
  for (const [id, es] of entriesOf) for (const e of es) partnersOfEntry.set(e, [...(partnersOfEntry.get(e) ?? []), id]);
  const open = new Map<string, number>();
  for (const q of input.questions) {
    if (q.status !== 'open') continue;
    const ids = q.on.kind === 'payment' ? partnerOfPayment.get(q.on.id) ?? []
      : q.on.kind === 'entry' ? partnersOfEntry.get(q.on.id) ?? []
        : [partnerOfReceipt.get(q.on.id)].filter((x): x is string => !!x);
    for (const id of new Set(ids)) open.set(id, (open.get(id) ?? 0) + 1);
  }

  const rulesOf = new Map<string, number>();
  for (const r of input.rules) if (r.business && r.kind === 'rule') rulesOf.set(r.business, (rulesOf.get(r.business) ?? 0) + 1);

  const row = (id: string, name: string, role: Role, roles: Role[], layers: PartnerLayers): PartnerRow => ({
    id, name, role, roles, layers, notes: input.noted.has(id), rules: rulesOf.get(id) ?? 0,
    payments: sorted(payments.get(id)), entries: sorted(entriesOf.get(id)), receipts: sorted(receiptsOf.get(id)), invoices: sorted(invoicesOf.get(id)),
    open: open.get(id) ?? 0,
  });
  const rows: PartnerRow[] = [];
  for (const c of counterparties) {
    const customer = customers.some((x) => x.id === c.id);
    const r = row(c.id, c.name, c.role, c.roles, { app: !!c.origin.vendor, workspace: !!c.origin.binding, customer });
    if (c.origin.binding || r.notes || r.rules || r.payments.length || r.receipts.length || customer) rows.push(r);
  }
  for (const c of customers) {
    if (!rows.some((r) => r.id === c.id)) rows.push(row(c.id, c.name, 'customer', [], { app: false, workspace: false, customer: true }));
  }
  const weight = (r: PartnerRow) => r.payments.length + r.receipts.length + r.invoices.length;
  rows.sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name, 'de'));
  return { year, partners: rows };
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));

/** Pure. The sentences of a file's steps that are no rule the app carries out (no `then` map), with their step. */
export function fileNotesOf(file: CounterpartyFile): FileNote[] {
  const out: FileNote[] = [];
  for (const [step, s] of Object.entries(file.body.steps ?? {})) {
    for (const raw of (s as Section | undefined)?.rules ?? []) {
      const r = raw as unknown as Record<string, unknown>;
      if (r.then && typeof r.then === 'object') continue;
      out.push({ step, id: asText(r.id), when: asText(r.when), then: asText(r.then), ...(typeof r.source === 'string' ? { source: r.source } : {}), layer: file.layer });
    }
  }
  return out;
}

/** Pure. A partner's page, apart from its notes: how it is recognised, its files and their sentences, its open questions. */
export function partnerDetailOf(row: PartnerRow, cp: Counterparty | undefined, files: readonly CounterpartyFile[], questions: readonly Question[], refs: { payments: ReadonlySet<string>; receipts: ReadonlySet<string>; entries: ReadonlySet<string> }): Omit<PartnerDetail, 'note' | 'year'> {
  const own = files.filter((f) => cp && (f.path === cp.origin.vendor || f.path === cp.origin.binding));
  const match = Object.fromEntries(TIERS.map((t) => [t, cp ? (t === 'file' ? cp.match.file.map((re) => re.source) : [...cp.match[t]]) : []])) as Record<Tier, string[]>;
  const cases = Object.values(cp?.steps ?? {}).reduce<number>((n, s) => n + ((s as Section | undefined)?.precedents?.length ?? 0), 0);
  const asked = questions.filter((q) => q.status === 'open' && (q.on.kind === 'payment' ? refs.payments.has(q.on.id) : q.on.kind === 'receipt' ? refs.receipts.has(q.on.id) : refs.entries.has(q.on.id)));
  return {
    row,
    match,
    learned: (cp?.learnedTx ?? []).filter((n) => cp!.match.tx.includes(n)),
    documents: (cp?.documents ?? []).map((d) => ({ id: d.id, kind: d.kind })),
    ...(cp?.accounts ? { accounts: cp.accounts } : {}),
    facts: (cp?.facts ?? []).map((f) => ({ id: f.id, fact: f.fact, source: f.source })),
    files: own.map((f) => f.path),
    fileNotes: [...own.filter((f) => f.layer === 'app'), ...own.filter((f) => f.layer === 'workspace')].flatMap(fileNotesOf),
    cases,
    questions: asked.map((q) => ({ id: q.id, text: q.text, on: q.on, askedAt: q.askedAt })),
  };
}

/** The open year's records of a partner, for code outside the view (the questions on them). */
export const refsOf = (row: PartnerRow) => ({ payments: new Set(row.payments), receipts: new Set(row.receipts), entries: new Set(row.entries) });

