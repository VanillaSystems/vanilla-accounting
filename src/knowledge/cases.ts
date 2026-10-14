/**
 * The casebook: invented but realistic Swiss booking cases, one per booking pattern
 * (examples/cases/<id>.yaml, indexed in docs/casebook.md). Each case says when it applies, shows
 * a receipt, its bank transaction and the journal lines, and declares what it does to the VAT
 * return. Two readers: a person learning how a case is booked, and the classifier of a company
 * with little history of its own, which gets the few cases most like each transaction.
 *
 * The declared effect is checked against the engine (check-processes, tests/casebook.test.ts),
 * so a case cannot teach a figure the code would not produce.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import type { FxResolver } from '../accounting/fx-rates.js';
import type { BankTransaction, JournalEntry, QuarterKey, Receipt } from '../types/index.js';
import { APP_ROOT } from '../workspace/workspace.js';
import { loadChart } from '../workspace/chart.js';
import { vat, baseCurrency } from '../engines/index.js';

export const CASES_DIR = join(APP_ROOT, 'examples', 'cases');
/** The KMU accounts the casebook books on (Kontenrahmen KMU), number → name. */

/** Who is on the other side. Selection infers some of these from a transaction's structure. */
export const COUNTERPARTY_KINDS = [
  'employee', 'social-insurance', 'insurer', 'customer-ch', 'customer-abroad', 'supplier-ch',
  'supplier-foreign-registered', 'supplier-abroad', 'owner', 'bank', 'tax-authority', 'landlord',
  'platform', 'courier',
] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

export const SEGMENTS = ['services', 'goods'] as const;
export type Segment = (typeof SEGMENTS)[number];

/** The receipt as extract-vat reads it: its text and whether it shows Swiss MWST. */
export interface CaseReceipt {
  text: string;
  swissVat: boolean;
}

export interface CaseTransaction {
  amount: number;
  currency: string;
  direction: 'DBIT' | 'CRDT';
  description: string;
  /** The ledger account the money moves on: a bank, or the owner's current account for Auslagen. */
  account: string;
  /** A Sammelzahlung's individual payments (camt053 TxDtls). */
  parts?: Array<{ amount: number; counterparty: string }>;
}

/** One journal row. An empty account is the VAT leg of a single-leg `-2` row. */
export interface CaseLine {
  debit: string;
  credit: string;
  amount: number;
  vatCode?: string;
  description: string;
  /** Foreign amount: its currency and the ESTV daily sell rate of the payment date. */
  currency?: string;
  rate?: number;
  corrects?: QuarterKey;
}

export interface BookingCase {
  id: string;
  /** Position in the casebook: most common first, services before goods. */
  rank: number;
  segment: Segment;
  title: string;
  /** When it applies, in plain English. */
  applies: string;
  /** null: there is no receipt, and that is part of the case. */
  receipt: CaseReceipt | null;
  /** null: a booking without a payment (a private share, a fee deducted from a payout). */
  transaction: CaseTransaction | null;
  date: string;
  lines: CaseLine[];
  /** What the case adds to the VAT return of its quarter (or of the quarter it corrects), by Ziffer. */
  ziffern: Record<string, number>;
  /** Tax to pay (positive) or to get back (negative). */
  payable: number;
  /** Rule ids in processes/*.guide.yaml. */
  rules: string[];
  /** The law: MWSTG articles, ESTV publications. */
  law: string[];
  why: string;
  pitfalls: string[];
  signals: { kind: CounterpartyKind; keywords: string[] };
}

// ─── Loading: parse once at the boundary ─────────────────────────────────────

class CaseError extends Error {}

function parseCase(raw: unknown, file: string): BookingCase {
  const fail = (msg: string): never => { throw new CaseError(`${file}: ${msg}`); };
  if (!raw || typeof raw !== 'object') fail('not a YAML mapping');
  const r = raw as Record<string, unknown>;
  const str = (k: string, o: Record<string, unknown> = r): string =>
    typeof o[k] === 'string' && (o[k] as string).trim() ? o[k] as string : fail(`${k} must be a non-empty string`);
  const num = (k: string, o: Record<string, unknown> = r): number =>
    typeof o[k] === 'number' && Number.isFinite(o[k]) ? o[k] as number : fail(`${k} must be a number`);
  const strings = (k: string, o: Record<string, unknown> = r): string[] =>
    Array.isArray(o[k]) && (o[k] as unknown[]).every((s) => typeof s === 'string') ? o[k] as string[] : fail(`${k} must be a list of strings`);
  const oneOf = <T extends string>(k: string, values: readonly T[], o: Record<string, unknown> = r): T =>
    values.includes(o[k] as T) ? o[k] as T : fail(`${k} must be one of ${values.join(', ')}`);
  const obj = (k: string, o: Record<string, unknown> = r) =>
    o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] as Record<string, unknown> : fail(`${k} must be a mapping`);
  const account = (v: unknown, where: string) => (v === '' || (typeof v === 'string' && /^\d{4}$/.test(v)) ? v : fail(`${where} must be a 4-digit account, or "" for a VAT leg`));

  const id = str('id');
  if (id !== basename(file, '.yaml')) fail(`id "${id}" must equal the file name`);
  const date = str('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('date must be YYYY-MM-DD');

  const receipt = r.receipt === 'none' ? null : (() => {
    const o = obj('receipt');
    if (typeof o.swissVat !== 'boolean') fail('receipt.swissVat must be true or false');
    return { text: str('text', o), swissVat: o.swissVat as boolean };
  })();

  const transaction = r.transaction === 'none' ? null : (() => {
    const o = obj('transaction');
    const parts = o.parts === undefined ? undefined : Array.isArray(o.parts)
      ? (o.parts as Record<string, unknown>[]).map((p) => ({ amount: num('amount', p), counterparty: str('counterparty', p) }))
      : fail('transaction.parts must be a list');
    return {
      amount: num('amount', o), currency: str('currency', o), direction: oneOf('direction', ['DBIT', 'CRDT'] as const, o),
      description: str('description', o), account: account(o.account, 'transaction.account') as string,
      ...(parts ? { parts } : {}),
    };
  })();

  if (!Array.isArray(r.lines) || r.lines.length === 0) fail('lines must be a non-empty list');
  const lines = (r.lines as Record<string, unknown>[]).map((l, i): CaseLine => {
    const at = `lines[${i}]`;
    const corrects = l.corrects;
    if (corrects !== undefined && !(typeof corrects === 'string' && /^\d{4}-Q[1-4]$/.test(corrects))) fail(`${at}.corrects must be YYYY-Qn`);
    if ((l.currency === undefined) !== (l.rate === undefined)) fail(`${at}: currency and rate go together`);
    return {
      debit: account(l.debit ?? '', `${at}.debit`) as string,
      credit: account(l.credit ?? '', `${at}.credit`) as string,
      amount: num('amount', l),
      ...(l.vatCode !== undefined ? { vatCode: str('vatCode', l) } : {}),
      description: str('description', l),
      ...(l.currency !== undefined ? { currency: str('currency', l), rate: num('rate', l) } : {}),
      ...(corrects ? { corrects: corrects as QuarterKey } : {}),
    };
  });

  const z = obj('ziffern');
  const ziffern: Record<string, number> = {};
  for (const [k, v] of Object.entries(z)) {
    if (!/^\d{3}$/.test(k) || typeof v !== 'number') fail(`ziffern.${k} must be a 3-digit Ziffer with a number`);
    ziffern[k] = v as number;
  }
  const signals = obj('signals');
  return {
    id, rank: num('rank'), segment: oneOf('segment', SEGMENTS), title: str('title'), applies: str('applies'),
    receipt, transaction, date, lines, ziffern, payable: num('payable'),
    rules: strings('rules'), law: strings('law'), why: str('why'), pitfalls: strings('pitfalls'),
    signals: { kind: oneOf('kind', COUNTERPARTY_KINDS, signals), keywords: strings('keywords', signals).map((k) => k.toLowerCase()) },
  };
}

/** Every case in `dir`, most common first. Throws naming the file and the field. */
export function loadCases(dir: string = CASES_DIR): BookingCase[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
    .map((f) => parseCase(parse(readFileSync(join(dir, f), 'utf8')), f))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

/** The casebook's chart, the app's one KMU chart (reference/charts/ch-kmu.yaml): account number → name. */
export function loadCaseChart(): Map<string, string> {
  return new Map(loadChart().accounts.map((a) => [a.number, a.name]));
}

// ─── The case as journal entries, and its effect on the return ───────────────

const quarterOf = (date: string): QuarterKey => `${Number(date.slice(0, 4))}-Q${Math.ceil(Number(date.slice(5, 7)) / 3) as 1 | 2 | 3 | 4}`;

/** The quarter whose return declares the case: the one its lines correct, else the one it is dated in. */
export function casePeriod(c: BookingCase): QuarterKey {
  return c.lines.find((l) => l.corrects)?.corrects ?? quarterOf(c.date);
}

export function caseEntries(c: BookingCase): JournalEntry[] {
  return c.lines.map((l, i) => ({
    id: `case-${c.id}-${i + 1}`,
    transactionRef: `case-${c.id}`,
    date: c.date,
    accountDebit: l.debit,
    accountCredit: l.credit,
    amount: l.amount,
    ...(l.vatCode ? { vatCode: l.vatCode } : {}),
    description: l.description,
    ...(l.currency ? { exchangeCurrency: l.currency, exchangeRate: l.rate } : {}),
    ...(l.corrects ? { corrects: l.corrects } : {}),
  }));
}

/** Ziffern the effect leaves out: 500/510 are a clamp of the payable, which `payable` states signed. */
const UNDECLARED = new Set(['500', '510']);

/** The case's own return: every Ziffer it moves, and the tax payable. What `ziffern`/`payable` must say. */
export function zifferEffect(c: BookingCase): { ziffern: Record<string, number>; payable: number } {
  const figures = vat().figures(caseEntries(c), casePeriod(c), []);
  const ziffern = Object.fromEntries(Object.entries(figures.ziffern)
    .filter(([z, v]) => v !== 0 && !UNDECLARED.has(z))
    .sort(([a], [b]) => Number(a) - Number(b)));
  return { ziffern, payable: figures.payable };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** About 300 tokens per case in a prompt; the same chars-per-token estimate check-processes uses. */
export const CASE_TOKEN_LIMIT = 300;
export const caseTokens = (c: BookingCase) => Math.round(formatCase(c).length / 3.7);

const sameFigures = (a: Record<string, number>, b: Record<string, number>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Every way a case can be wrong, each naming its fix. Empty when the case is sound. */
export function validateCase(c: BookingCase, ctx: { chart: ReadonlyMap<string, string>; ruleIds: ReadonlySet<string>; fx: FxResolver }): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(`examples/cases/${c.id}.yaml: ${msg}`);

  for (const id of c.rules) if (!ctx.ruleIds.has(id)) err(`rule "${id}" is in no processes/*.guide.yaml — fix the id`);
  if (c.rules.length === 0 && c.law.length === 0) err('name a rule or a law that decides the case');

  c.lines.forEach((l, i) => {
    const at = `lines[${i + 1}]`;
    for (const a of [l.debit, l.credit]) if (a && !ctx.chart.has(a)) err(`${at}: account ${a} is not in reference/charts/ch-kmu.yaml — use a KMU account or add it there`);
    const info = l.vatCode ? vat().codes.parse(l.vatCode) : null;
    if (l.vatCode && !info) err(`${at}: VAT code ${l.vatCode} is not one the engine knows (reference/MWST-codes.txt)`);
    if (!l.debit && !l.credit) err(`${at}: both accounts are empty`);
    if ((!l.debit || !l.credit) && info?.amountIs !== 'tax') err(`${at}: a single-leg row needs a -2 code (the amount is the VAT itself); otherwise fill both accounts`);
    if (l.amount <= 0) err(`${at}: amount must be positive — a refund inverts the code (-I81), not the sign`);
    if (l.currency) {
      const estv = ctx.fx.daily(l.currency, c.date);
      if (l.rate !== estv) err(`${at}: rate ${l.rate} is not the ESTV daily sell rate of ${c.date} for ${l.currency} (${estv}, reference/estv-daily-rates-2026.json)`);
    }
  });
  const periods = new Set(c.lines.map((l) => l.corrects ?? ''));
  if (periods.size > 1) err('either every line corrects the same quarter, or none does');
  const corrected = c.lines[0]?.corrects;
  if (corrected && quarterOf(c.date) <= corrected) err(`a correction of ${corrected} is dated in a later, open quarter (golden rule 1)`);

  const tx = c.transaction;
  if (tx) {
    const native = (l: CaseLine) => (l.currency ? l.currency === tx.currency : tx.currency === baseCurrency());
    const moved = c.lines.reduce((s, l) => s
      + (l.debit === tx.account && native(l) ? (tx.direction === 'CRDT' ? l.amount : -l.amount) : 0)
      + (l.credit === tx.account && native(l) ? (tx.direction === 'DBIT' ? l.amount : -l.amount) : 0), 0);
    if (Math.round(moved * 100) !== Math.round(tx.amount * 100)) err(`the lines move ${moved} on ${tx.account}, the transaction ${tx.amount} ${tx.currency} — they must agree`);
    if (tx.parts && Math.round(tx.parts.reduce((s, p) => s + p.amount, 0) * 100) !== Math.round(tx.amount * 100)) err('the parts must sum to the transaction amount');
    if (tx.currency !== baseCurrency() && c.lines.some((l) => (l.debit === tx.account || l.credit === tx.account) && l.currency !== tx.currency)) err(`a ${tx.currency} transaction's bank rows carry currency ${tx.currency} and the ESTV rate`);
  }

  const effect = zifferEffect(c);
  if (!sameFigures(effect.ziffern, c.ziffern) || effect.payable !== c.payable) {
    err(`declared effect differs from the engine — write ziffern: ${JSON.stringify(effect.ziffern)} and payable: ${effect.payable}`);
  }
  const t = caseTokens(c);
  if (t > CASE_TOKEN_LIMIT) err(`~${t} tokens in a prompt, the limit is ${CASE_TOKEN_LIMIT} — shorten applies, a description or the first pitfall`);
  return errors;
}

// ─── In the classify prompt ──────────────────────────────────────────────────

const first = (s: string) => s.trim().split(/(?<=\.)\s/)[0];

/**
 * The case as a few compact prompt lines. The transaction's own account is written "bank":
 * the classifier leaves that side empty for the system to fill.
 */
export function formatCase(c: BookingCase): string {
  const side = (a: string) => (a === '' ? '(VAT leg)' : a === c.transaction?.account ? 'bank' : a);
  const lines = c.lines.map((l) => {
    const fx = l.currency ? ` ${l.currency}` : '';
    const tags = [l.vatCode ?? 'no code', l.corrects ? `corrects ${l.corrects}` : ''].filter(Boolean).join(', ');
    return `  D ${side(l.debit)} / C ${side(l.credit)} ${l.amount}${fx} [${tags}] "${l.description}"`;
  });
  const tx = c.transaction;
  const head = tx ? `${tx.direction} ${tx.amount} ${tx.currency}, receipt: ${c.receipt ? (c.receipt.swissVat ? 'Swiss MWST' : 'no Swiss MWST') : 'none'}` : 'no payment';
  return [
    `Case ${c.id}: ${c.title} (${head})`,
    `  When: ${first(c.applies)}`,
    ...lines,
    `  Why: ${first(c.why)}${c.rules.length ? ` [${c.rules.join(', ')}]` : ''}`,
    ...(c.pitfalls[0] ? [`  Pitfall: ${first(c.pitfalls[0])}`] : []),
  ].join('\n');
}

/**
 * Below this many booked rows of its own (journal entries plus the prior year's sample), a
 * company's history says too little about how it books, and the classify prompt gets casebook
 * examples. About one quarter of a small services company; past it, its own entries are the
 * better examples and the prompt stays smaller.
 */
export const OWN_HISTORY_THRESHOLD = 100;

export type SelectionReceipt = Pick<Receipt, 'extractedText' | 'hasSwissVat' | 'vatId' | 'description'>;
export type SelectionTransaction = Pick<BankTransaction, 'direction' | 'currency' | 'description'>;

/** A web address or legal form outside Switzerland in the receipt: a sign of a supplier abroad. */
export const FOREIGN_HINT = /\b[\w-]+\.(?:com|io|ai|net|org|de|fr|it|at|ie|nl|co|us|uk|eu)\b|\b(?:inc|llc|ltd|limited|gmbh & co|b\.v|s\.a\.r\.l)\b|\bvat (?:id|no|number)\b|\bust-?id/i;

/** The counterparty kinds a transaction's structure alone points at. Keywords decide the rest. */
function inferredKinds(tx: SelectionTransaction, receipts: readonly SelectionReceipt[]): Set<CounterpartyKind> {
  const kinds = new Set<CounterpartyKind>();
  const foreignCurrency = tx.currency !== baseCurrency();
  const text = receipts.map((r) => r.extractedText ?? '').join('\n');
  const swissUid = receipts.some((r) => r.vatId?.startsWith('CHE'));
  const foreign = foreignCurrency || FOREIGN_HINT.test(text);
  if (tx.direction === 'CRDT') kinds.add(foreignCurrency ? 'customer-abroad' : 'customer-ch');
  if (tx.direction === 'DBIT' && receipts.length > 0) {
    if (receipts.some((r) => r.hasSwissVat)) kinds.add(foreign ? 'supplier-foreign-registered' : 'supplier-ch');
    else if (foreign && !swissUid) kinds.add('supplier-abroad');
  }
  return kinds;
}

/**
 * The k cases most like a transaction, best first: deterministic, no model. Keywords of the
 * case in the bank text or receipts weigh most, then the counterparty kind the structure
 * implies, the receipt's VAT facts, the direction and foreign currency. Ties go to the more
 * common case. A case with no keyword hit and no matching kind is never returned, and neither
 * is one whose receipt contradicts the transaction's receipts on Swiss MWST.
 */
export function selectCases(tx: SelectionTransaction, receipts: readonly SelectionReceipt[], cases: readonly BookingCase[], k = 4): BookingCase[] {
  const haystack = [tx.description, ...receipts.flatMap((r) => [r.description ?? '', r.extractedText ?? ''])].join('\n').toLowerCase();
  const kinds = inferredKinds(tx, receipts);
  const swissVat = receipts.some((r) => r.hasSwissVat);
  const scored = cases.map((c) => {
    const hits = c.signals.keywords.filter((kw) => haystack.includes(kw)).length;
    let score = Math.min(hits, 2) * 4;
    if (kinds.has(c.signals.kind)) score += 3;
    const ctx = c.transaction;
    const vatFits = receipts.length === 0 ? c.receipt === null : !!c.receipt && c.receipt.swissVat === swissVat;
    // A case whose receipt says the opposite about Swiss MWST would teach the wrong code.
    const contradicts = receipts.length > 0 && !!c.receipt && c.receipt.swissVat !== swissVat;
    const structural = (vatFits ? 2 : 0) + (ctx?.direction === tx.direction ? 2 : 0) + ((ctx?.currency ?? baseCurrency()) !== baseCurrency() === (tx.currency !== baseCurrency()) ? 1 : 0);
    return { c, score: score + structural, relevant: !contradicts && (hits > 0 || kinds.has(c.signals.kind)) };
  });
  return scored.filter((s) => s.relevant)
    .sort((a, b) => b.score - a.score || a.c.rank - b.c.rank)
    .slice(0, k)
    .map((s) => s.c);
}
