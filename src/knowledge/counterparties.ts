/**
 * Counterparty knowledge: one company's match signals, documents, accounts and
 * step rules, and the deterministic routing that picks which counterparty an
 * item belongs to. Its files live in two layers (src/knowledge/layers.ts).
 *
 * Routing is code, never a model: an item gets a counterparty's rules only when
 * exactly one file claims it in the strongest tier that matches anything.
 * Several files in that tier → ambiguous (new_case); nothing → unknown
 * (generic rules only). A weaker tier never overrides or breaks a tie in a
 * stronger one. See docs/adr/0002-counterparty-knowledge-and-lean-calls.md.
 */

import { RECEIPT_KINDS, type BankTransaction, type Receipt, type ReceiptKind } from '../types/index.js';

/** Strongest first. The order is the routing precedence. */
export const TIERS = ['uid', 'domain', 'tx', 'file'] as const;
export type Tier = (typeof TIERS)[number];

/** What a business is to the company. Its main role is the folder of its file; `roles:` lists the others. */
export const ROLES = ['supplier', 'customer', 'authority'] as const;
export type Role = (typeof ROLES)[number];

export interface Matchers {
  /** Swiss UID. Only list one that this counterparty alone prints (the lint proves it on the index). */
  uid: string[];
  /** Sender email domain, at collection. */
  domain: string[];
  /** Case-insensitive substring of the MERCHANT part of a bank description (see merchantOf). */
  tx: string[];
  /** Regex over the archived filename; weakest, because the name was suggested by a model. */
  file: RegExp[];
}


/** A document type a counterparty issues, recognised from the receipt text (every pattern must appear). */
export interface DocumentType {
  id: string;
  kind: ReceiptKind;
  text: RegExp[];
}

/** A fact of the law or of an authority's practice (a period, a deadline, a form), with where it is written. */
export interface Fact {
  id: string;
  fact: string;
  source: string;
}

export interface Counterparty {
  id: string;
  name: string;
  /** The main role, from the folder its file is in. */
  role: Role;
  /** Further roles, e.g. a supplier that is also a customer. */
  roles: Role[];
  match: Matchers;
  /** Several receipts settle in one charge: match as a sum, split one entry per invoice. */
  grouped: boolean;
  /** When present, the only accounts an entry for this counterparty may use. */
  accounts?: string[];
  documents: DocumentType[];
  /** What a flow step names in its `facts:` as <id>#<fact id>, so the flow never repeats it. */
  facts: Fact[];
  /** Raw per-step sections, keyed by the exact `with.guide` string of a flow step. */
  steps: Record<string, unknown>;
  /** The files it was merged from: vendor facts (app layer) and the company's binding (workspace layer). */
  origin: { vendor?: string; binding?: string };
}

export type Routing =
  | { kind: 'known'; counterparty: string; tier: Tier; signal: string }
  | { kind: 'ambiguous'; candidates: string[]; tier: Tier }
  | { kind: 'unknown' };

/** What an item offers for routing. A transaction contributes its merchant; its linked receipts add uid and filename. */
export interface Signals {
  uids: string[];
  domains: string[];
  merchant?: string;
  filenames: string[];
}

const UID_RE = /CHE[-\s]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})/g;

/** The counterparty part of a bank description, without the bank's wrapper text. */
export function merchantOf(description: string): string {
  const d = description.replace(/\s*\(fee: [^)]*\)\s*$/i, '').trim();
  const patterns = [
    /^Card transaction of -?[\d.,]+ [A-Z]{3} issued by (.+)$/i,
    /^Sent money to (.+)$/i,
    /^Received money from (.+?)(?: with reference .*)?$/i,
    /^Paid to (.+)$/i,
    /^Zahlung (.+)$/i,
  ];
  for (const p of patterns) {
    const m = d.match(p);
    if (m) return m[1].trim();
  }
  return d;
}

export function uidsIn(receipt: Pick<Receipt, 'vatId' | 'extractedText'>): string[] {
  const found = new Set<string>();
  if (receipt.vatId) found.add(receipt.vatId);
  for (const m of (receipt.extractedText ?? '').matchAll(UID_RE)) found.add(`CHE-${m[1]}.${m[2]}.${m[3]}`);
  return [...found];
}

export function signalsOfReceipt(r: Receipt): Signals {
  return { uids: uidsIn(r), domains: [], filenames: [r.filename] };
}

export function signalsOfTransaction(tx: BankTransaction, linked: Receipt[]): Signals {
  return {
    uids: linked.flatMap(uidsIn),
    domains: [],
    merchant: merchantOf(tx.description),
    filenames: linked.map((r) => r.filename),
  };
}

/** Which counterparties a tier claims for these signals. */
export function claims(cp: Counterparty, tier: Tier, s: Signals): string | undefined {
  switch (tier) {
    case 'uid': return cp.match.uid.find((u) => s.uids.includes(u));
    case 'domain': return cp.match.domain.find((d) => s.domains.some((x) => x === d || x.endsWith(`.${d}`)));
    case 'tx': return s.merchant ? cp.match.tx.find((t) => s.merchant!.toLowerCase().includes(t.toLowerCase())) : undefined;
    case 'file': return cp.match.file.find((re) => s.filenames.some((f) => re.test(f)))?.source;
  }
}

export function identify(s: Signals, counterparties: readonly Counterparty[]): Routing {
  for (const tier of TIERS) {
    const hits = counterparties.flatMap((cp) => {
      const signal = claims(cp, tier, s);
      return signal ? [{ id: cp.id, signal }] : [];
    });
    if (hits.length === 1) return { kind: 'known', counterparty: hits[0].id, tier, signal: hits[0].signal };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.map((h) => h.id), tier };
  }
  return { kind: 'unknown' };
}

export type RawCounterparty = {
  id?: string; name?: string; grouped?: boolean; accounts?: string[]; roles?: string[];
  match?: Partial<Record<Tier, string[]>>; steps?: Record<string, unknown>;
  documents?: { id?: string; kind?: string; text?: string[] }[];
  facts?: Partial<Fact>[];
};

/** Validate one counterparty after its layers are merged. Throws naming the file and the fix. */
export function compileCounterparty(raw: RawCounterparty, origin: Counterparty['origin'], role: Role): Counterparty {
  const stem = raw.id!;
  const fail = (msg: string) => { throw new Error(`${origin.binding ?? origin.vendor}: ${msg}`); };
  if (!raw.name) fail('needs a name');
  const roles = raw.roles ?? [];
  for (const r of roles) {
    if (!(ROLES as readonly string[]).includes(r)) fail(`roles: "${r}" is not a role — use ${ROLES.join(', ')}`);
    if (r === role) fail(`roles: "${r}" is already its main role (the folder) — delete it here`);
  }
  const m = raw.match ?? {};
  for (const k of Object.keys(m)) if (!(TIERS as readonly string[]).includes(k)) fail(`match.${k} is not a signal — use ${TIERS.join(', ')}`);
  const match: Matchers = {
    uid: m.uid ?? [], domain: m.domain ?? [], tx: m.tx ?? [],
    file: (m.file ?? []).map((p) => new RegExp(p, 'i')),
  };
  if (TIERS.every((t) => match[t].length === 0)) fail('match needs at least one signal');
  const documents = (raw.documents ?? []).map((d, i) => {
    if (!d.id) fail(`documents[${i}] needs an id`);
    if (!d.kind || !(RECEIPT_KINDS as readonly string[]).includes(d.kind)) fail(`documents ${d.id}: kind must be one of ${RECEIPT_KINDS.join(', ')}`);
    if (!d.text?.length) fail(`documents ${d.id}: text needs at least one pattern`);
    return { id: d.id!, kind: d.kind as ReceiptKind, text: d.text!.map((t) => new RegExp(t, 'i')) };
  });
  const facts = (raw.facts ?? []).map((f, i) => {
    for (const k of ['id', 'fact', 'source'] as const) if (!f[k]) fail(`facts[${i}] needs ${k}`);
    return f as Fact;
  });
  return {
    id: stem, name: raw.name!, role, roles: roles as Role[], match, grouped: raw.grouped === true, documents, facts,
    accounts: raw.accounts, steps: raw.steps ?? {}, origin,
  };
}

/** The document type a counterparty rule assigns to this receipt, if any. */
export function documentTypeOf(r: Pick<Receipt, 'extractedText'>, counterparties: readonly Counterparty[]): { kind: ReceiptKind; rule: string } | null {
  const text = r.extractedText ?? '';
  for (const cp of counterparties) {
    for (const d of cp.documents) if (d.text.every((re) => re.test(text))) return { kind: d.kind, rule: d.id };
  }
  return null;
}
