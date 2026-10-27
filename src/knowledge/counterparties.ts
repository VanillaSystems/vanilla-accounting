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
import { HEAD, wordsRe } from '../core/modules/words.js';

/** Strongest first. The order is the routing precedence. */
export const TIERS = ['uid', 'iban', 'domain', 'tx', 'file'] as const;
export type Tier = (typeof TIERS)[number];

/** What a business is to the company. Its main role is the folder of its file; `roles:` lists the others. */
export const ROLES = ['supplier', 'customer', 'authority'] as const;
export type Role = (typeof ROLES)[number];

export interface Matchers {
  /** Swiss UID. Only list one that this counterparty alone prints (the lint proves it on the index). */
  uid: string[];
  /** The IBAN it pays from or is paid to, as the bank statement names the other party (no spaces, any case). */
  iban: string[];
  /** Sender email domain, at collection. */
  domain: string[];
  /** Case-insensitive substring of the bank's counterparty name or of the MERCHANT part of its description (see merchantOf). */
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
  /**
   * UIDs it prints that do not say a document is its own, because others print them too (a
   * courier's, on the customs office's assessments of its shipments): never a routing signal; a
   * receipt that carries only such UIDs (and the buyer's) is read by its text (signalsOfReceiptRead).
   */
  sharedUid?: string[];
  /** A file of it says `grouped` at all, true or false: the app offers no «Immer so?» to say it again (#190). */
  groupedSaid?: true;
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

/**
 * What an item offers for routing. A transaction contributes its names (the bank's counterparty
 * field and the merchant of its text: a bank puts the name in either) and the other party's IBAN;
 * its linked receipts add uid and filename.
 */
export interface Signals {
  uids: string[];
  ibans: string[];
  domains: string[];
  names: string[];
  /** The archived names: the receipt's name as the app or the person last gave it, so they decide. */
  filenames: string[];
  /** The names the receipts came with, a fallback: they route only when no business's file pattern matches an archived name (a stale original must not outvote the archived name). */
  originalFilenames?: string[];
  /** A receipt's text where it names who wrote it (its first and last lines): a `tx` signal counts in it as a whole word only (signalsOfReceiptRead). */
  texts?: string[];
}

const ibanOf = (iban: string) => iban.replace(/\s+/g, '').toUpperCase();

// Extraction wraps a UID across lines after "CHE-" on some invoices, or spaces its groups out.
const UID_RE = /CHE[-\s]*(\d{3})[.\s]*(\d{3})[.\s]*(\d{3})/g;

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

/** The names a receipt came with (a shop or a mailbox gave them, e.g. `{orderId}_payment.pdf`), when they differ from the archived one. */
const originalsOf = (r: Pick<Receipt, 'filename' | 'originalFilename'>): string[] =>
  r.originalFilename && r.originalFilename !== r.filename ? [r.originalFilename] : [];

export function signalsOfReceipt(r: Receipt): Signals {
  return { uids: uidsIn(r), ibans: [], domains: [], names: [], filenames: [r.filename], originalFilenames: originalsOf(r) };
}

const digitsOf = (uid: string) => uid.replace(/\D/g, '');

/** The UIDs that say nothing of who wrote a receipt: the buyer's own (company.uid) and those a business's file names as shared (Counterparty.sharedUid), as digits. */
export function silentUids(counterparties: readonly Counterparty[], buyerUid?: string): Set<string> {
  return new Set([...(buyerUid ? [buyerUid] : []), ...counterparties.flatMap((c) => c.sharedUid ?? [])].map(digitsOf).filter(Boolean));
}

// An address of the sender: an e-mail's domain or a web address, as invoices print them.
const DOMAIN_RE = /(?:[\w.+-]+@|https?:\/\/|www\.)((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;

/**
 * What a receipt says of who wrote it, read off it (#190): its UIDs and filenames, as
 * signalsOfReceipt, and the vendor of its title (the model's reading of the sender), where a `tx`
 * signal counts as a whole word only. A receipt without a UID of its own also offers the domains of the addresses in the lines where a
 * document names its sender (its first and last HEAD characters) and its first HEAD characters,
 * where a `tx` signal counts as a whole word only. A receipt that carries a UID of its own is never
 * routed by that text: a shop's invoice names the courier it ships with («Versand: FedEx
 * Express»), a tracking link (fedex.com) or the way it was paid («Amazon Pay») in those lines too,
 * and its UID says it is the shop's. A UID in `silent` is not its own: the buyer's (many receipts
 * print only the buyer's UID), or one a file names as shared (FedEx's, which the customs office's
 * assessments print too). Its UID routes it when a file names it (the uid tier comes
 * first), else only its title's vendor and its filename do: an AliExpress Tax Invoice prints
 * Alibaba's UID, which no file names (alibaba.com receipts print it too), and is recognised by its
 * filename ({orderId}_payment.pdf, archived as <date>-aliexpress-…) or a title naming AliExpress.
 * Used where a receipt alone must say whose it is (a batch payer's receipts,
 * src/intake/batch-payers.ts).
 */
export function signalsOfReceiptRead(r: Receipt, silent: ReadonlySet<string> = new Set()): Signals {
  const own = signalsOfReceipt(r);
  const title = r.title?.vendor ? [r.title.vendor] : [];
  if (own.uids.some((u) => !silent.has(digitsOf(u)))) return { ...own, texts: title };
  const text = r.extractedText ?? '';
  const ends = text.length > 2 * HEAD ? `${text.slice(0, HEAD)}\n${text.slice(-HEAD)}` : text;
  const domains = [...new Set([...ends.matchAll(DOMAIN_RE)].map((m) => m[1].toLowerCase().replace(/^www\./, '')))];
  return { ...own, domains, texts: [...title, text.slice(0, HEAD)] };
}

export function signalsOfTransaction(tx: BankTransaction, linked: Receipt[]): Signals {
  return {
    uids: linked.flatMap(uidsIn),
    ibans: tx.counterpartyIban ? [ibanOf(tx.counterpartyIban)] : [],
    domains: [],
    names: [tx.counterparty, merchantOf(tx.description)].filter((n): n is string => !!n?.trim()),
    filenames: linked.map((r) => r.filename),
    originalFilenames: linked.flatMap(originalsOf),
  };
}

const wordRes = new Map<string, RegExp>();
const wholeWord = (t: string): RegExp => { let re = wordRes.get(t); if (!re) wordRes.set(t, (re = wordsRe([t]))); return re; };

/** Which counterparties a tier claims for these signals. */
export function claims(cp: Counterparty, tier: Tier, s: Signals): string | undefined {
  switch (tier) {
    case 'uid': return cp.match.uid.find((u) => s.uids.includes(u));
    case 'iban': return cp.match.iban.find((i) => s.ibans.includes(ibanOf(i)));
    case 'domain': return cp.match.domain.find((d) => s.domains.some((x) => x === d || x.endsWith(`.${d}`)));
    case 'tx': return cp.match.tx.find((t) => s.names.some((n) => n.toLowerCase().includes(t.toLowerCase())) || !!s.texts?.some((x) => wholeWord(t).test(x)));
    case 'file': return cp.match.file.find((re) => s.filenames.some((f) => re.test(f)))?.source
      ?? cp.match.file.find((re) => s.originalFilenames?.some((f) => re.test(f)))?.source;
  }
}

export function identify(s: Signals, counterparties: readonly Counterparty[]): Routing {
  for (const tier of TIERS) {
    // The archived name decides; the original name is asked only when no file pattern matches an archived one.
    const byArchived = tier === 'file' && counterparties.some((cp) => claims(cp, tier, { ...s, originalFilenames: [] }));
    const seen = byArchived ? { ...s, originalFilenames: [] } : s;
    const hits = counterparties.flatMap((cp) => {
      const signal = claims(cp, tier, seen);
      return signal ? [{ id: cp.id, signal }] : [];
    });
    if (hits.length === 1) return { kind: 'known', counterparty: hits[0].id, tier, signal: hits[0].signal };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.map((h) => h.id), tier };
  }
  return { kind: 'unknown' };
}

export type RawCounterparty = {
  id?: string; name?: string; grouped?: boolean; sharedUid?: string[]; accounts?: string[]; roles?: string[];
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
    uid: m.uid ?? [], iban: m.iban ?? [], domain: m.domain ?? [], tx: m.tx ?? [],
    file: (m.file ?? []).map((p) => new RegExp(p, 'i')),
  };
  if (TIERS.every((t) => match[t].length === 0)) fail('match needs at least one signal');
  const sharedUid = raw.sharedUid ?? [];
  for (const u of sharedUid) {
    if (!/^CHE-\d{3}\.\d{3}\.\d{3}$/.test(u)) fail(`sharedUid "${u}" must look like CHE-###.###.###`);
    if (match.uid.includes(u)) fail(`sharedUid "${u}" is in match.uid too — a shared UID identifies nobody; keep it in one of them`);
  }
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
    id: stem, name: raw.name!, role, roles: roles as Role[], match, grouped: raw.grouped === true, ...(sharedUid.length ? { sharedUid } : {}), ...(raw.grouped !== undefined ? { groupedSaid: true as const } : {}), documents, facts,
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
