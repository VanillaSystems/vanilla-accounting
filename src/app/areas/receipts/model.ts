/**
 * Belege as the list and detail show them, derived from the books and never stored: which
 * receipts a period holds, the groups ("Braucht dich" first), what is locked, and the payments a
 * receipt could belong to, ranked. Pure, so the list, the keys and the tests read the same order.
 */
import type { BankTransaction, BankTransactionPart, Index, JournalEntry, Receipt, ReceiptPatch } from '../../../types/index.js';
import type { EstvRates } from '../../../accounting/fx-conversion.js';
import type { Period } from '../../../accounting/periods.js';
import type { ReceiptFilter } from '../../shell/route.js';
import { baseCurrency, documents } from '../../../engines/index.js';
import { duplicatesIn, type Twin } from '../../../intake/duplicates.js';
import { documentKind } from '../../../intake/document-kind.js';
import { accountOfStatement, statementFacts, type StatementFacts } from '../../../books/statement-facts.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { isManualRef } from '../../../books/refs.js';
import type { OtherWhy, SupportingWhy } from '../../../core/modules/schema.js';
import { kindByOf, type KindBy } from '../../../intake/unclear.js';

/** Why a file in Belege is no receipt: what its words say it is, or its kind, or that it holds no amount. */
export type NoneWhy = SupportingWhy | OtherWhy | 'supporting' | 'duplicate' | 'statement' | 'empty';

/** Why `r` is no receipt: the word rule that typed it, its kind, else what its text says, else its missing amount. */
export function noneWhyOf(r: Partial<Pick<Receipt, 'kind' | 'kindRule' | 'extractedText'>>): NoneWhy {
  if (r.kind === 'duplicate' || r.kind === 'statement') return r.kind;
  const rule = /^document:(.+)$/.exec(r.kindRule ?? '')?.[1] as SupportingWhy | OtherWhy | undefined;
  if (rule) return rule;
  const text = r.extractedText ? documentKind(r.extractedText, documents()) : undefined;
  if (r.kind === 'supporting') return text?.is === 'supporting' ? text.why : 'supporting';
  if (text?.is === 'other') return text.why;
  return r.kind === 'noise' ? 'no-receipt' : 'empty';
}

/** The kinds of document that are not a receipt of their own. */
const NON_RECEIPT_KINDS: ReadonlyArray<Receipt['kind']> = ['supporting', 'statement', 'noise', 'duplicate'];

export interface ReceiptView {
  r: Receipt;
  /** The receipt's date, else the YYYYMMDD- its file name starts with. */
  date?: string;
  /** The day it counts in a period: its date, else the day it was read. */
  day?: string;
  vendor: string;
  desc: string;
  /** The payments (or bookings without one) it is linked to. */
  links: string[];
  /** The days its linked payments were made: it shows in their periods too. */
  paid: string[];
  /**
   * Needs no payment: typed as supporting/statement/noise/duplicate, or worth exactly 0 (not
   * merely unread) with no VAT and no link (brochures, labels, blank captures).
   */
  none: boolean;
  /** Why it needs no payment, when `none` (shown with it, r5h-28). */
  noneWhy?: NoneWhy;
  /** Who set it aside, when `none`: a person, the model (its reason in `r.kindWhy`), or the app's rules (#186). */
  noneBy?: KindBy;
  /** Linked to a payment or entry of a filed quarter: it never changes again (golden rule 1). */
  locked: boolean;
  /** Another receipt it seems to repeat (asked: «ist dasselbe» or «verschieden»), or the invoice it accompanies. */
  twin?: Twin;
  /** A bank statement's period and account, as its text and file name tell them (#151). */
  statement?: StatementFacts;
}

/** A money account of the manifest, as far as a statement is placed at one. */
export type Account = Pick<LedgerBankAccount, 'bank' | 'currency' | 'account' | 'iban'>;

export interface Ledger {
  views: ReceiptView[];
  byId: Map<string, ReceiptView>;
  txByRef: Map<string, BankTransaction>;
  entriesByRef: Map<string, JournalEntry[]>;
  /** The receipts linked to each ref. */
  receiptsByRef: Map<string, string[]>;
  closedThrough?: string;
  /** The first day of the open quarter: receipts from here on are still being worked on. */
  openFrom: string;
}

const FILE_DATE = /^(20\d\d)(\d\d)(\d\d)-/;

/** "Vendor, what" (or " — ", " - "): the vendor and the rest; else the whole text is the vendor. */
export function splitTitle(text: string): [string, string] {
  const m = /^(.*?)(?:,\s|\s—\s|\s-\s)(.*)$/.exec(text);
  return m ? [m[1], m[2]] : [text, ''];
}

export function ledgerOf(books: Index, openFrom: string): Ledger {
  const closedThrough = books.config?.closedThrough;
  const isClosed = (d: string | undefined) => !!closedThrough && !!d && d <= closedThrough;
  const txByRef = new Map(books.transactions.map((t) => [t.ref, t]));
  const entriesByRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) {
    const list = entriesByRef.get(e.transactionRef);
    if (list) list.push(e); else entriesByRef.set(e.transactionRef, [e]);
  }
  const linksOf = new Map<string, string[]>();
  const receiptsByRef = new Map<string, string[]>();
  for (const m of books.mappings) {
    (linksOf.get(m.receiptId) ?? linksOf.set(m.receiptId, []).get(m.receiptId)!).push(m.transactionRef);
    (receiptsByRef.get(m.transactionRef) ?? receiptsByRef.set(m.transactionRef, []).get(m.transactionRef)!).push(m.receiptId);
  }
  const twins = duplicatesIn(books.receipts, new Set(linksOf.keys()), documents());
  const refClosed = (ref: string) => isClosed(txByRef.get(ref)?.date) || (entriesByRef.get(ref) ?? []).some((e) => isClosed(e.date));

  const views = books.receipts.map((r): ReceiptView => {
    const links = linksOf.get(r.id) ?? [];
    const fileDate = FILE_DATE.exec(r.filename);
    // "" is no date (an old answer of the model): the receipt is undated and needs you.
    const date = r.date || (fileDate ? `${fileDate[1]}-${fileDate[2]}-${fileDate[3]}` : undefined);
    const [vendor, desc] = r.title ? [r.title.vendor, r.title.what] : splitTitle(r.description || r.filename.replace(/\.pdf$/i, ''));
    const none = NON_RECEIPT_KINDS.includes(r.kind)
      || (r.amount === 0 && !(r.vatSummary ?? []).some((g) => g.vat > 0) && links.length === 0);
    const paid = links.flatMap((ref) => txByRef.get(ref)?.date ?? []);
    const twin = twins.get(r.id);
    const statement = r.kind === 'statement' ? statementFacts(r, documents()) : undefined;
    return { r, date, day: date || r.indexedAt.slice(0, 10) || undefined, vendor, desc, links, paid, none, ...(none ? { noneWhy: noneWhyOf(r), noneBy: kindByOf(r) } : {}), locked: links.some(refClosed), ...(twin ? { twin } : {}), ...(statement ? { statement } : {}) };
  });
  return { views, byId: new Map(views.map((v) => [v.r.id, v])), txByRef, entriesByRef, receiptsByRef, closedThrough, openFrom };
}

export const isOpen = (v: ReceiptView) => v.links.length === 0;

/**
 * What a locked receipt refuses (#151): a link or a delete, which would change a filed return.
 * Its date, words and kind still change; its amount, VAT and file stay (the server holds them).
 */
export const lockedRefuses = (act: 'link' | 'edit' | 'del' | 'mark' | 'notreceipt') => act === 'link' || act === 'del';

/** Receipts that may repeat another and wait for «Ist dasselbe» or «Verschieden» (Belege and Aufgaben, r5h-34). */
export const openTwins = (l: Ledger): ReceiptView[] =>
  l.views.filter((v) => v.twin?.relation === 'duplicate' && !v.links.length && v.r.kind !== 'duplicate' && !v.locked && l.byId.has(v.twin.of));

/**
 * Still waiting for its payment or its date, and not in a filed quarter: what the dock's badge
 * counts. Books that never filed have no quarter to leave behind: a June invoice paid in July
 * needs you as well.
 */
export const needsYou = (v: ReceiptView, l: Ledger) =>
  !v.none && isOpen(v) && !v.locked && (!v.date || v.date >= l.openFrom || !l.closedThrough || v.date > l.closedThrough);

export const badgeCount = (l: Ledger) => l.views.filter((v) => needsYou(v, l)).length;

export type Counts = Record<'alle' | ReceiptFilter, number>;

const FILTERS: Record<ReceiptFilter, (v: ReceiptView) => boolean> = {
  zugeordnet: (v) => !isOpen(v),
  offen: isOpen,
  ohneDatum: (v) => !v.date,
};

/** The text a search looks in: title, description, file, note, date, amount, VAT number. */
function haystack(v: ReceiptView): string {
  const { r } = v;
  return [v.vendor, v.desc, r.description, r.filename, r.remarks, r.kindWhy, v.date, v.date && v.date.split('-').reverse().join('.'), r.amount?.toFixed(2), r.vatId].join(' ').toLowerCase();
}

export interface Visible {
  rows: ReceiptView[];
  counts: Counts;
  /** Files of the period that are no receipt, but for the statements Kontoauszüge shows at their account. */
  hidden: ReceiptView[];
}

/** A statement Kontoauszüge shows at its account and month: its account is told and its last day known. */
export const placedStatement = (v: ReceiptView, accounts: readonly Account[]) =>
  !!v.statement?.to && !!accountOfStatement(v.statement, v.r, accounts);

export function visible(l: Ledger, period: Period, filter: ReceiptFilter | undefined, q: string | undefined, accounts: readonly Account[] = []): Visible {
  // A period shows its own receipts and those of its payments; the working period also what from
  // before it still needs you, and every open receipt without a date, whenever it was read.
  const working = period.from <= l.openFrom && l.openFrom <= period.to;
  const within = (d: string) => d >= period.from && d <= period.to;
  const pool = l.views.filter((v) => !!v.day && (within(v.day) || v.paid.some(within) || (working && (v.day < period.from || !v.date) && needsYou(v, l))));
  const receipts = pool.filter((v) => !v.none);
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const match = (v: ReceiptView) => { const h = haystack(v); return words.every((w) => h.includes(w)); };
  const counts: Counts = {
    alle: receipts.length,
    zugeordnet: receipts.filter(FILTERS.zugeordnet).length,
    offen: receipts.filter(FILTERS.offen).length,
    ohneDatum: receipts.filter(FILTERS.ohneDatum).length,
  };
  const by = filter ? FILTERS[filter] : () => true;
  return {
    rows: receipts.filter(by).filter(match),
    counts,
    hidden: pool.filter((v) => v.none && !placedStatement(v, accounts)).filter(match),
  };
}

export type GroupKey = 'need' | 'noDate' | `month:${string}`;
export interface Group { key: GroupKey; rows: ReceiptView[] }

const byDateDesc = (a: ReceiptView, b: ReceiptView) => (b.date ?? '').localeCompare(a.date ?? '') || a.r.filename.localeCompare(b.r.filename);

/**
 * The list's groups in order, which is also the ↑↓ order: what needs you (a suggestion first),
 * then each month, newest first. An open receipt without a date needs you (last in its group); a
 * linked one without a date comes last as `later`, unless the filter asks for it.
 */
export function groups(rows: ReceiptView[], l: Ledger, filter: ReceiptFilter | undefined, suggested: (v: ReceiptView) => boolean): { groups: Group[]; later: ReceiptView[] } {
  const later = filter === 'ohneDatum' ? [] : rows.filter((v) => !v.date && !needsYou(v, l));
  const dated = rows.filter((v) => !later.includes(v));
  const need = dated.filter((v) => needsYou(v, l)).sort((a, b) => Number(suggested(b)) - Number(suggested(a)) || byDateDesc(a, b));
  const rest = dated.filter((v) => !need.includes(v)).sort(byDateDesc);
  const out: Group[] = need.length ? [{ key: 'need', rows: need }] : [];
  const byMonth = new Map<GroupKey, ReceiptView[]>();
  for (const v of rest) {
    const key: GroupKey = v.date ? `month:${v.date.slice(0, 7)}` : 'noDate';
    (byMonth.get(key) ?? byMonth.set(key, []).get(key)!).push(v);
  }
  for (const [key, rs] of byMonth) out.push({ key, rows: rs });
  return { groups: out, later };
}

/** A receipt's amount and a payment's, in CHF, for ranking: the ESTV rate of the payment day, else the amount itself. */
export type ToChf = (amount: number, currency: string, date: string) => number;

export const chfOf = (rates: EstvRates | null): ToChf => (amount, currency, date) =>
  currency === baseCurrency() ? amount : amount * (rates?.on(currency, date)?.rate ?? 1);

export interface Candidate {
  tx: BankTransaction;
  score: number;
  /** Same amount in the same currency: the payment's, or one part's of a collective payment (`part`). */
  sameAmount: boolean;
  /** The payment moved in another currency than the receipt's. */
  otherCurrency: boolean;
  /** Days from the receipt's date, negative when the payment came first; absent without a date. */
  days?: number;
  /** Other receipts already linked to it (a grouped payment can hold several). */
  taken: number;
  /** How its amount fits the receipt's, when it would hold only this receipt. */
  fit?: AmountFit;
  /** The part of a collective payment (Sammelauftrag) of exactly the receipt's amount: the row names it (r8k-5). */
  part?: BankTransactionPart;
  /** Money the wrong way: in for a supplier invoice, out for a credit note or a sale. Never a best fit (r8k-5). */
  wrongWay?: true;
  /** It lies in a filed quarter: choosing it leads to a correction in the open one, never to a link (corner-33). */
  filed?: true;
}

const DAY = 864e5;
const HALF_RAPPEN = 0.005;

/** A payout report by its words (SumUp, TWINT, Stripe: «Auszahlung», «payout», «versement»), for a receipt nobody gave a kind. */
const PAYOUT_WORDS = /auszahlung|payout|versement|accredito/i;
export const readsAsPayout = (r: Pick<Receipt, 'description' | 'extractedText' | 'title'>): boolean =>
  PAYOUT_WORDS.test([r.description ?? '', r.title?.vendor ?? '', (r.extractedText ?? '').slice(0, 400)].join(' '));

/**
 * The way the receipt's money went: `in` for a credit note (its amount below zero), a sale, or a
 * payout report (its kind, else its words: r9k-4), `out` for a supplier invoice; undefined without an amount.
 */
function moneyWay(r: Pick<Receipt, 'amount' | 'kind' | 'description' | 'extractedText' | 'title' | 'payout'>): 'in' | 'out' | undefined {
  if (r.amount == null || r.amount === 0) return undefined;
  if (r.amount < 0 || r.kind === 'sales-record' || r.payout) return 'in';
  return r.kind === undefined && readsAsPayout(r) ? 'in' : 'out';
}

/**
 * The payments a receipt could belong to, best first: close in amount (in CHF), close in date,
 * the same currency. A payment that already has a receipt ranks lower but stays findable
 * (AliExpress, FedEx and Amazon put several receipts on one payment); a search reaches it by its
 * description, the bank's counterparty and the parts of a collective payment. Fees never need a
 * receipt. A best fit is a payment whose amount fits (the same, a Skonto, or a collective
 * payment's part of exactly the amount) with the money going the receipt's way; nothing close
 * means no best fit (r8h-21). A payment of a filed quarter without a receipt is listed, marked
 * `filed`, when it is a best fit or a query finds it: a late receipt is led to its correction
 * (corner-33). With a query, every payment it finds; else up to 3 best and 12 more.
 */
export function candidates(v: ReceiptView, l: Ledger, toChf: ToChf, query = ''): { best: Candidate[]; more: Candidate[] } {
  const { r } = v;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const cur = r.currency || baseCurrency();
  const way = moneyWay(r);
  const all: Candidate[] = [];
  for (const tx of l.txByRef.values()) {
    if (tx.amount === 0 || tx.type === 'wise-fee' || v.links.includes(tx.ref)) continue;
    const filed = !!l.closedThrough && tx.date <= l.closedThrough;
    if (words.length) {
      const parts = (tx.parts ?? []).flatMap((p) => [p.counterparty, p.reference, Math.abs(p.amount).toFixed(2)]);
      const h = [tx.description, tx.counterparty, tx.reference, tx.bank, tx.date, tx.date.split('-').reverse().join('.'), Math.abs(tx.amount).toFixed(2), tx.remarks, ...parts].join(' ').toLowerCase();
      if (!words.every((w) => h.includes(w))) continue;
    }
    const otherCurrency = tx.currency !== cur;
    const part = r.amount == null || otherCurrency ? undefined : (tx.parts ?? []).find((p) => p.currency === cur && Math.abs(Math.abs(p.amount) - Math.abs(r.amount!)) < HALF_RAPPEN);
    const sameAmount = !!part || (r.amount != null && !otherCurrency && Math.abs(Math.abs(tx.amount) - Math.abs(r.amount)) < HALF_RAPPEN);
    const days = v.date ? Math.round((Date.parse(tx.date) - Date.parse(v.date)) / DAY) : undefined;
    const want = r.amount == null ? undefined : Math.abs(toChf(r.amount, cur, tx.date));
    const dAmt = part ? 0 : want === undefined ? 1 : Math.abs(Math.abs(toChf(tx.amount, tx.currency, tx.date)) - want) / Math.max(1, want);
    const taken = (l.receiptsByRef.get(tx.ref) ?? []).length;
    const wrongWay = !!way && (tx.direction === 'CRDT') !== (way === 'in');
    // A collective payment holds one receipt per part: another receipt on it does not make it taken for this one.
    const score = dAmt * 100 + Math.abs(days ?? 0) * 0.6 + (otherCurrency ? 8 : 0) + (taken && !part ? 30 : 0) + (wrongWay ? 30 : 0);
    const fit = part ? { kind: 'same' as const } : taken ? undefined : amountFit(r, tx, toChf);
    const c: Candidate = { tx, score: score + (filed ? 0.5 : 0), sameAmount, otherCurrency, days, taken, ...(fit ? { fit } : {}), ...(part ? { part } : {}), ...(wrongWay ? { wrongWay: true as const } : {}), ...(filed ? { filed: true as const } : {}) };
    if (filed && (taken || (!words.length && !isBest(c)))) continue;
    all.push(c);
  }
  all.sort((a, b) => a.score - b.score || b.tx.date.localeCompare(a.tx.date));
  if (words.length) return { best: [], more: all.slice(0, 40) };
  const best = all.filter(isBest).slice(0, 3);
  return { best, more: all.filter((c) => !best.includes(c)).slice(0, 12) };
}

/** A booking without a payment a receipt can hang on (#89): its ref, its first line, and whether a line is the receipt's amount. */
export interface Unpaid { ref: string; date: string; amount: number; currency: string; description: string; sameAmount: boolean }

/**
 * The bookings without a payment of the open period (a depreciation, an accrual, a private share,
 * a correction; src/server/edits.ts withoutPayment) the receipt could hang on, not yet linked to it:
 * those with a line of the receipt's amount, nearest in date first. With a query, every one whose
 * text, ref, amount or date hold every word (a depreciation books less than the invoice it carries).
 */
export function bookingsWithoutPayment(v: ReceiptView, l: Ledger, query = ''): Unpaid[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const cur = v.r.currency || baseCurrency();
  const near = (d: string) => (v.date ? Math.abs(Date.parse(d) - Date.parse(v.date)) : 0);
  const out: Unpaid[] = [];
  for (const [ref, es] of l.entriesByRef) {
    if (!isManualRef(ref) || l.txByRef.has(ref) || v.links.includes(ref) || es.some((e) => !!l.closedThrough && e.date <= l.closedThrough)) continue;
    const [e] = es;
    const h = es.flatMap((x) => [x.description, x.amount.toFixed(2)]).concat(ref, e.date, e.date.split('-').reverse().join('.')).join(' ').toLowerCase();
    if (!words.every((w) => h.includes(w))) continue;
    const sameAmount = v.r.amount != null && es.some((x) => (x.exchangeCurrency ?? baseCurrency()) === cur && Math.abs(x.amount - Math.abs(v.r.amount!)) < HALF_RAPPEN);
    if (!words.length && !sameAmount) continue;
    out.push({ ref, date: e.date, amount: e.amount, currency: e.exchangeCurrency ?? baseCurrency(), description: e.description ?? ref, sameAmount });
  }
  return out.sort((a, b) => Number(b.sameAmount) - Number(a.sameAmount) || near(a.date) - near(b.date) || a.ref.localeCompare(b.ref)).slice(0, words.length ? 40 : 8);
}

/** A best fit: the amount fits (the same, a Skonto, an exact part) and the money goes the receipt's way. */
const isBest = (c: Candidate) => !!c.fit && c.fit.kind !== 'off' && !c.wrongWay;

/** What a key does in the link dialog's list: picks a row, chooses the picked one, closes; undefined for a key the search takes. */
export type LinkKey = { kind: 'pick'; idx: number } | { kind: 'choose'; idx: number } | { kind: 'close' };

/**
 * The link dialog's keys over `count` rows, `idx` the row picked so far (undefined: none). ↓ and ↑
 * pick, wrapping; ↵ chooses the picked row, and with none picked only picks the first: a stray ↵
 * links nothing (r8h-21, r7h-23). Esc closes.
 */
export function linkKey(idx: number | undefined, key: string, count: number): LinkKey | undefined {
  if (!count) return key === 'Escape' ? { kind: 'close' } : undefined;
  if (key === 'ArrowDown') return { kind: 'pick', idx: idx === undefined ? 0 : (idx + 1) % count };
  if (key === 'ArrowUp') return { kind: 'pick', idx: idx === undefined ? count - 1 : (idx - 1 + count) % count };
  if (key === 'Enter') return idx === undefined ? { kind: 'pick', idx: 0 } : { kind: 'choose', idx: Math.min(idx, count - 1) };
  if (key === 'Escape') return { kind: 'close' };
  return undefined;
}

/**
 * The payment to offer with one key: the only open payment of exactly this amount, in this
 * currency, within a month of the receipt, that has no receipt yet.
 */
export function suggestion(v: ReceiptView, l: Ledger, toChf: ToChf): Candidate | undefined {
  if (!needsYou(v, l) || v.r.amount == null || v.twin?.relation === 'duplicate') return undefined;
  const fits = candidates(v, l, toChf).best.filter((c) => c.sameAmount && !c.taken && !c.filed && Math.abs(c.days ?? 99) <= 31);
  return fits.length === 1 ? fits[0] : undefined;
}

/**
 * How a payment's amount fits a receipt's: the same (in another currency within 5 %, the bank's
 * rate is not the ESTV's), less by up to 5 % as a cash discount (Skonto) leaves it, or off by
 * `diff` (payment minus receipt, in the payment's currency, or CHF across currencies).
 */
export type AmountFit = { kind: 'same' } | { kind: 'skonto'; percent: number } | { kind: 'off'; diff: number; currency: string };

const CENTS = 0.05;
const SKONTO = 0.05;

export function amountFit(r: Pick<Receipt, 'amount' | 'currency'>, tx: BankTransaction, toChf: ToChf): AmountFit | undefined {
  if (r.amount == null || r.amount === 0) return undefined;
  const cur = r.currency || baseCurrency();
  if (cur !== tx.currency) {
    const want = Math.abs(toChf(r.amount, cur, tx.date));
    const paid = Math.abs(toChf(tx.amount, tx.currency, tx.date));
    return Math.abs(paid - want) <= SKONTO * want ? { kind: 'same' } : { kind: 'off', diff: Math.round((paid - want) * 100) / 100, currency: baseCurrency() };
  }
  const want = Math.abs(r.amount);
  const diff = Math.round((Math.abs(tx.amount) - want) * 100) / 100;
  if (Math.abs(diff) <= CENTS) return { kind: 'same' };
  if (diff < 0 && -diff <= SKONTO * want) return { kind: 'skonto', percent: Math.round((-diff / want) * 1000) / 10 };
  return { kind: 'off', diff, currency: cur };
}

/** The fit of a receipt and the one payment it is linked to, when that payment holds only this receipt (a grouped payment adds up several). */
export function linkFit(v: ReceiptView, l: Ledger, toChf: ToChf): AmountFit | undefined {
  if (v.links.length !== 1) return undefined;
  const tx = l.txByRef.get(v.links[0]);
  // An owner's payment of a business part is less than the receipt on purpose (#87): the rest was private.
  if (!tx || tx.businessPart || (l.receiptsByRef.get(tx.ref) ?? []).length !== 1) return undefined;
  return amountFit(v.r, tx, toChf);
}

/**
 * The amount the receipt's Swiss VAT belongs to, when that is more than the receipt's amount (the
 * amount changed by hand, or misread): the VAT would claim tax on money not paid. Each rate's
 * total, else net + tax, else what its tax at its rate makes. Less is no sign: a receipt may hold
 * items without VAT that its VAT block leaves out.
 */
export function vatMisfit(r: Receipt): number | undefined {
  const groups = r.vatSummary ?? [];
  if (!r.hasSwissVat || r.amount == null || !groups.some((g) => g.ratePercent > 0 && g.vat)) return undefined;
  const totals = groups.map((g) => g.gross ?? (g.net != null ? g.net + g.vat : g.ratePercent > 0 ? g.vat * (100 + g.ratePercent) / g.ratePercent : undefined));
  if (totals.some((x) => x === undefined)) return undefined;
  const gross = totals.reduce((sum: number, x) => sum + x!, 0);
  const exact = groups.every((g) => g.gross != null || g.net != null);
  return gross - Math.abs(r.amount) > (exact ? CENTS : Math.max(0.1, 0.005 * gross)) ? Math.round(gross * 100) / 100 : undefined;
}

/** The saves of one receipt's fields in a row: one toast names them all, its undo writes `back`. */
export interface Saves<F extends string> { id: string; fields: F[]; back: ReceiptPatch; at: number }

const TOGETHER_MS = 10_000;

/** A save joins the one before it on the same receipt within a few seconds; what a field was before the first save wins. */
export function together<F extends string>(before: Saves<F> | undefined, next: Saves<F>): Saves<F> {
  if (!before || before.id !== next.id || next.at - before.at > TOGETHER_MS) return next;
  return { id: next.id, fields: [...new Set([...before.fields, ...next.fields])], back: { ...next.back, ...before.back }, at: next.at };
}

/**
 * The VAT chip beside a receipt's facts when it shows no Swiss VAT line: `unread`, the VAT step has
 * not read it yet; `none`, it shows none. A firm not registered has no VAT step, so an unread
 * receipt shows no chip at all rather than a false «keine CH-MWST» beside an 8.1 % line (r7f-4).
 */
export function vatChipOf(hasSwissVat: boolean | undefined, noInputTax: 'none' | 'net-rate' | undefined): 'unread' | 'none' | undefined {
  if (hasSwissVat !== undefined) return 'none';
  return noInputTax === 'none' ? undefined : 'unread';
}
