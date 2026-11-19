/**
 * The two corrections of an issued document that are no Gutschrift and no Storno (spec 4.4.2, 4.5):
 *
 * - «Zurück zum Entwurf» of a document never sent: its VAT event (the agreed basis, `RE-<n>` or
 *   `GS-<n>`) comes off the books with its link and the receipt its PDF became, so issuing it again
 *   books it afresh with the new PDF. Refused when the event lies in a filed period (golden rule 1).
 * - «Konten ändern» on an issued invoice: the revenue its bookings carry moves to the accounts its
 *   positions now name, code by code, so no amount, rate or code changes. A booking of an open period
 *   changes in place; for one of a filed period a reclassification without a code is booked in the
 *   open period (`RE-<n>-kk-<k>`), and the filed booking stays as filed.
 *
 * Pure over the books (call inside the write door, update in src/books/store.ts); the routes in
 * src/server/routes/invoices.ts save invoices.json beside them.
 */
import type { JournalEntry, Receipt } from '../types/index.js';
import { periodLock, release, type Books } from '../books/store.js';
import { eventRef, reclassRef } from '../books/refs.js';
import { chfAmount } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { vat } from '../engines/index.js';
import { isItem, type Issued } from './model.js';
import { InvoiceRuleError, apportion, revenueSplit, totals } from './rules.js';
import { idSource } from './store.js';
import { TEXTS } from './texts.js';

// ─── back to draft ─────────────────────────────────────────────────────────────

/** The day of the document's VAT event in a period the books no longer take, if any: then it may not go back to draft. */
export function eventLocked(books: Books, inv: Issued): string | undefined {
  const lock = periodLock(books);
  const ref = eventRef(inv, 'issue');
  return books.journalEntries.find((e) => e.transactionRef === ref && lock.isClosed(e.date))?.date;
}

/**
 * Takes the document's VAT event off the books: its entries, every link on its ref, and the sales
 * record its PDF became (`receiptId`), when nothing else holds that receipt; each named with
 * `release` (#405). Returns what went, so the caller removes the receipt's file. Nothing on books
 * without the event (the cash basis).
 */
export function takeBackEvent(books: Books, inv: Issued, receiptId: string): { entries: JournalEntry[]; receipts: Receipt[] } {
  const at = eventLocked(books, inv);
  if (at) throw new InvoiceRuleError('closed', `${inv.number} ist am ${at} in einer eingereichten Periode gebucht und bleibt ausgestellt: eine Gutschrift oder ein Storno korrigiert sie.`);
  const ref = eventRef(inv, 'issue');
  const entries = books.journalEntries.filter((e) => e.transactionRef === ref);
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== ref);
  const links = books.mappings.filter((m) => m.transactionRef === ref);
  release(books, { mappings: links });
  books.mappings = books.mappings.filter((m) => m.transactionRef !== ref);
  const held = books.mappings.some((m) => m.receiptId === receiptId) || books.journalEntries.some((e) => e.receipts?.includes(receiptId));
  const receipts = held ? [] : books.receipts.filter((r) => r.id === receiptId && r.kind === 'sales-record');
  if (receipts.length) {
    release(books, { receipts: receipts.map((r) => r.id) });
    books.receipts = books.receipts.filter((r) => !receipts.includes(r));
  }
  return { entries, receipts };
}

// ─── Konten ändern ─────────────────────────────────────────────────────────────

/** Revenue moved from one account to another, in the booking's currency (a reclassification: the books'). */
export interface AccountMove { from: string; to: string; amount: number }

/** One booking of the invoice whose revenue lines change account. */
export interface AccountRebooking {
  ref: string;
  date: string;
  currency: string;
  /** In a filed period: it stays as filed, the reclassification moves its revenue. */
  filed: boolean;
  moves: AccountMove[];
  /** Its revenue lines as they will be (an open booking), code by code, in its currency. */
  next: Array<{ vatCode?: string; account: string; amount: number }>;
}

export interface AccountChangePlan {
  /** The positions whose account changes (index in `lines`), from the account they book on now. */
  lines: Array<{ line: number; from: string; to: string }>;
  rebook: AccountRebooking[];
  /** The reclassification of what the filed bookings carry, in the books' currency, without a VAT code. */
  reclass?: { ref: string; date: string; moves: AccountMove[] };
  /** Payments a person booked herself: they stay as she booked them. */
  kept: string[];
}

export interface AccountContext {
  /** The firm's revenue account: what a position without one books on. */
  revenueAccount: string;
  isRevenue(account: string): boolean;
  /** The books' currency. */
  base: string;
}

/** The text every booking of the invoice carries on its revenue lines (src/invoices/payments.ts, events.ts). */
const textOf = (inv: Issued) => `${TEXTS.de.invoice} ${inv.number} ${inv.customer.name}`;

/** The invoice's revenue lines on `ref`: on a revenue account, with the invoice's text, no minus code (a credit note's applied part). */
function revenueLines(books: Books, inv: Issued, ref: string, ctx: AccountContext): JournalEntry[] {
  const neg = vat().codes.negativePrefix;
  return books.journalEntries.filter((e) => e.transactionRef === ref && e.origin === 'invoice' && e.description === textOf(inv)
    && ctx.isRevenue(e.accountCredit) && !ctx.isRevenue(e.accountDebit) && !e.vatCode?.startsWith(neg));
}

/** The positions with the accounts asked, checked: an item position, a revenue account of the chart. */
export function withAccounts(inv: Issued, changes: ReadonlyArray<{ line: number; account: string }>, ctx: AccountContext): Issued {
  if (inv.kind !== 'invoice') throw new InvoiceRuleError('creditNote', 'Konten ändern gilt für eine Rechnung; eine Gutschrift bucht auf die Konten ihrer Positionen.');
  if (inv.cancelled) throw new InvoiceRuleError('cancelled', `Rechnung ${inv.number} ist storniert.`);
  const lines = [...inv.lines];
  for (const c of changes) {
    const l = lines[c.line];
    if (!l || !isItem(l)) throw new InvoiceRuleError('account', `Position ${c.line + 1} ist keine Position mit Betrag.`);
    if (!/^\d{4}$/.test(c.account) || !ctx.isRevenue(c.account)) throw new InvoiceRuleError('account', `${c.account} ist kein Ertragskonto des Kontenplans.`);
    lines[c.line] = { ...l, account: c.account };
  }
  return { ...inv, lines };
}

/** The moves that turn `before` into `after` (account → cents; both add up the same): the largest first. */
function movesOf(before: Map<string, number>, after: Map<string, number>): AccountMove[] {
  const accounts = [...new Set([...before.keys(), ...after.keys()])].sort();
  const delta = accounts.map((a) => [a, (after.get(a) ?? 0) - (before.get(a) ?? 0)] as const).filter(([, d]) => d !== 0);
  const give = delta.filter(([, d]) => d < 0).map(([a, d]) => ({ a, left: -d }));
  const take = delta.filter(([, d]) => d > 0).map(([a, d]) => ({ a, left: d }));
  const out: AccountMove[] = [];
  for (const g of give) {
    for (const t of take) {
      const n = Math.min(g.left, t.left);
      if (n <= 0) continue;
      out.push({ from: g.a, to: t.a, amount: n });
      g.left -= n; t.left -= n;
    }
  }
  return out;
}

const sumBy = <T>(xs: readonly T[], key: (x: T) => string, value: (x: T) => number) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + value(x));
  return m;
};
const merge = (moves: AccountMove[]): AccountMove[] => [...sumBy(moves, (m) => `${m.from}>${m.to}`, (m) => m.amount)].map(([k, amount]) => ({ from: k.split('>')[0], to: k.split('>')[1], amount }));

/**
 * What «Konten ändern» books: for each booking of the invoice (its event, its payments) the revenue
 * of each code spread over the accounts the positions now name, in proportion to how the invoice
 * splits it (revenueSplit), so the code's total stays exact. `next` is the invoice with
 * the new accounts (withAccounts); `date` the open day a reclassification takes.
 */
export function planAccountChange(books: Books, inv: Issued, next: Issued, date: string, ctx: AccountContext): AccountChangePlan {
  const lines = inv.lines.flatMap((l, line) => {
    const n = next.lines[line];
    if (!isItem(l) || !n || !isItem(n)) return [];
    const from = l.account ?? ctx.revenueAccount, to = n.account ?? ctx.revenueAccount;
    return from === to ? [] : [{ line, from, to }];
  });
  const plan: AccountChangePlan = { lines, rebook: [], kept: [] };
  if (!lines.length) return plan;
  const lock = periodLock(books);
  // The weights of each code over the new accounts: the invoice's own split of its whole.
  const split = revenueSplit(next, totals(next).gross, ctx.revenueAccount);
  const filedMoves: AccountMove[] = [];
  const refs = [...new Set([eventRef(inv, 'issue'), ...inv.payments.map((p) => p.transactionRef)])];
  for (const ref of refs) {
    const own = revenueLines(books, inv, ref, ctx);
    if (!own.length) {
      if (books.journalEntries.some((e) => e.transactionRef === ref && e.origin !== 'invoice')) plan.kept.push(ref);
      continue;
    }
    const filed = own.some((e) => lock.isClosed(e.date));
    const moves: AccountMove[] = [];
    const after: AccountRebooking['next'] = [];
    for (const [code, es] of groupByCode(own)) {
      const parts = split.filter((p) => (p.vatCode ?? '') === code);
      const weights = sumBy(parts, (p) => p.account, (p) => toRappen(p.amount));
      if (!weights.size) { for (const e of es) after.push({ ...(code ? { vatCode: code } : {}), account: e.accountCredit, amount: e.amount }); continue; }
      const accounts = [...weights.keys()];
      const spread = (total: number) => new Map(apportion(total, accounts.map((a) => weights.get(a)!)).map((r, k) => [accounts[k], r] as const));
      const onAccounts = (v: (e: JournalEntry) => number) => sumBy(es, (e) => e.accountCredit, (e) => toRappen(v(e)));
      const total = es.reduce((s, e) => s + toRappen(e.amount), 0);
      const nextHere = spread(total);
      for (const [account, rappen] of nextHere) if (rappen) after.push({ ...(code ? { vatCode: code } : {}), account, amount: fromRappen(rappen) });
      // A filed booking is moved in the books' currency, by what it carries there.
      if (filed) moves.push(...movesOf(onAccounts(chfAmount), spread(es.reduce((s, e) => s + toRappen(chfAmount(e)), 0))));
      else moves.push(...movesOf(onAccounts((e) => e.amount), nextHere));
    }
    if (!moves.length) continue;
    const merged = merge(moves).map((m) => ({ ...m, amount: fromRappen(m.amount) }));
    plan.rebook.push({ ref, date: own[0].date, currency: own[0].exchangeCurrency ?? ctx.base, filed, moves: merged, next: after });
    if (filed) filedMoves.push(...moves);
  }
  if (filedMoves.length) {
    const taken = books.journalEntries.filter((e) => e.transactionRef.startsWith(`RE-${inv.number}-kk-`)).map((e) => Number(e.transactionRef.slice(`RE-${inv.number}-kk-`.length)) || 0);
    plan.reclass = { ref: reclassRef(inv, Math.max(0, ...taken) + 1), date, moves: merge(filedMoves).map((m) => ({ ...m, amount: fromRappen(m.amount) })) };
  }
  return plan;
}

function groupByCode(es: readonly JournalEntry[]): Map<string, JournalEntry[]> {
  const m = new Map<string, JournalEntry[]>();
  for (const e of es) m.set(e.vatCode ?? '', [...(m.get(e.vatCode ?? '') ?? []), e]);
  return m;
}

/**
 * Books the plan: each open booking's revenue lines replaced by its `next` (the ids kept where the
 * lines are as many), and the reclassification of the filed ones, linked to the invoice's receipt
 * when the books hold it (`receiptId`). Returns the entries the reclassification booked.
 */
export function applyAccountChange(books: Books, inv: Issued, plan: AccountChangePlan, ctx: AccountContext, receiptId?: string): JournalEntry[] {
  for (const r of plan.rebook) {
    if (r.filed) continue;
    const own = revenueLines(books, inv, r.ref, ctx);
    const byCode = groupByCode(own);
    const ids = own.map((e) => e.id);
    const fresh = r.next.map((n, k): JournalEntry => {
      const template = byCode.get(n.vatCode ?? '')![0];
      return { ...template, id: ids[k] ?? idSource.bytes(8).toString('hex'), accountCredit: n.account, amount: n.amount };
    });
    const at = books.journalEntries.indexOf(own[0]);
    books.journalEntries = books.journalEntries.filter((e) => !own.includes(e));
    books.journalEntries.splice(Math.min(at, books.journalEntries.length), 0, ...fresh);
  }
  if (!plan.reclass) return [];
  const { ref, date, moves } = plan.reclass;
  const receipt = receiptId && books.receipts.some((r) => r.id === receiptId) ? receiptId : undefined;
  const entries = moves.map((m): JournalEntry => ({
    id: idSource.bytes(8).toString('hex'), transactionRef: ref, date, accountDebit: m.from, accountCredit: m.to, amount: m.amount,
    description: `Kontenänderung ${textOf(inv)}`, origin: 'invoice', ...(receipt ? { receipts: [receipt] } : {}),
  }));
  books.journalEntries.push(...entries);
  if (receipt) books.mappings.push({ transactionRef: ref, receiptId: receipt, by: 'rule', rule: 'invoice-issue' });
  return entries;
}
