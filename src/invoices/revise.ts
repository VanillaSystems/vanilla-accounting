/**
 * The two corrections of an issued document that are no Gutschrift and no Storno (spec 4.4.2, 4.5):
 *
 * - «Zurück zum Entwurf» of a document never sent: its VAT event (the agreed basis, `RE-<n>` or
 *   `GS-<n>`) comes off the books with its link and the receipt its PDF became, so issuing it again
 *   books it afresh with the new PDF. Refused when the event lies in a filed period (golden rule 1).
 * - «Konten ändern» on an issued invoice: the revenue its bookings carry, and its credit notes' with
 *   it, moves to the accounts its positions now name, code by code, so no amount, rate or code
 *   changes. A booking of an open period changes in place; for those of a filed period one
 *   reclassification per document without a code is booked in the open period (`RE-<n>-kk-<k>`,
 *   `GS-<n>-kk-<k>`), from where their revenue stands now, and the filed bookings stay as filed.
 *
 * Pure over the books (call inside the write door, update in src/books/store.ts); the routes in
 * src/server/routes/invoices.ts save invoices.json beside them.
 */
import type { JournalEntry, Receipt } from '../types/index.js';
import { periodLock, release, type Books } from '../books/store.js';
import { eventRef, reclassRef } from '../books/refs.js';
import type { Invoice } from './model.js';
import { chfAmount } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import { vat } from '../engines/index.js';
import { isItem, type Issued } from './model.js';
import { InvoiceRuleError, apportion, creditNotesOf, priced, revenueVatCode } from './rules.js';
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
 * `release` (#405). Returns what went, so the caller removes the receipt's file. On the cash basis
 * there is no event, but a payment matched and released again («Lösen») leaves the receipt: it goes
 * the same way.
 */
export function takeBackEvent(books: Books, inv: Issued, receiptId: string): { entries: JournalEntry[]; receipts: Receipt[]; kept?: string } {
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
  // A receipt a person linked elsewhere stays, named: issuing again files the new PDF under a name of its own (invoiceReceipt).
  return { entries, receipts, ...(held && books.receipts.some((r) => r.id === receiptId) ? { kept: receiptId } : {}) };
}

// ─── Konten ändern ─────────────────────────────────────────────────────────────

/** Revenue moved from one account to another, in the booking's currency (a reclassification: the books'). */
export interface AccountMove { from: string; to: string; amount: number }

/** One booking of a document whose revenue lines change account. */
export interface AccountRebooking {
  ref: string;
  /** The document (its number) the booking belongs to. */
  number: string;
  date: string;
  currency: string;
  /** In a filed period: it stays as filed, its document's reclassification moves its revenue. */
  filed: boolean;
  moves: AccountMove[];
  /** Its revenue lines as they will be (an open booking), in its currency, with their amount in the books' currency where it converts. */
  next: Array<{ side: Side; vatCode?: string; account: string; amount: number }>;
  /**
   * A foreign booking split into more lines: each line converts at the official rate on its own, so
   * the converted revenue may move by a cent; by how much, in the books' currency (a fact the dialog
   * names, never a rate of our own). Absent: nothing moves.
   */
  rounding?: number;
}

export interface AccountChangePlan {
  /** The positions whose account changes (index in `lines`), from the account they book on now. */
  lines: Array<{ line: number; from: string; to: string }>;
  /** The credit notes of the invoice whose positions follow (same account changed the same way). */
  notes: Array<{ id: string; number: string; lines: Array<{ line: number; from: string; to: string }> }>;
  rebook: AccountRebooking[];
  /** Per document, the reclassification of what its filed bookings carry, in the books' currency, without a VAT code. */
  reclass: Array<{ ref: string; number: string; date: string; moves: AccountMove[] }>;
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

/** Revenue booked as such (credit), or taken back (debit: a credit note, its applied part, a refund). */
type Side = 'sale' | 'minus';

/** The text every booking of a document carries on its revenue lines (src/invoices/payments.ts, events.ts). */
const textOf = (doc: Issued) => `${doc.kind === 'credit-note' ? TEXTS.de.credit : TEXTS.de.invoice} ${doc.number} ${doc.customer.name}`;

/** The revenue lines on `ref` booked from one of `docs`: one side a revenue account, the other not, with a document's text. */
function revenueLines(books: Books, docs: readonly Issued[], ref: string, ctx: AccountContext): Array<{ e: JournalEntry; side: Side; account: string }> {
  const texts = new Set(docs.map(textOf));
  return books.journalEntries.flatMap((e) => {
    if (e.transactionRef !== ref || e.origin !== 'invoice' || !texts.has(e.description ?? '')) return [];
    const cr = ctx.isRevenue(e.accountCredit), dr = ctx.isRevenue(e.accountDebit);
    return cr === dr ? [] : [{ e, side: cr ? 'sale' as const : 'minus' as const, account: cr ? e.accountCredit : e.accountDebit }];
  });
}

/** A position's part of the revenue, for the weights: its code, the account it books on before and after, its net. */
interface Weight { code: string; from: string; to: string; net: number }

function weightsOf(old: Issued, next: Issued, ctx: AccountContext): Weight[] {
  const a = priced(old).parts, b = priced(next).parts;
  return a.map((p, k) => ({
    code: revenueVatCode(p.line.vatRate, old.exemption, p.line.activity ?? 1) ?? '',
    from: p.line.account ?? ctx.revenueAccount,
    to: b[k]?.line.account ?? ctx.revenueAccount,
    net: Math.abs(p.gross ? Math.round(p.rappen * 100 / (100 + p.line.vatRate)) : p.rappen),
  }));
}

/** The positions with the accounts asked, checked: an item position, a revenue account of the chart. */
export function withAccounts(inv: Issued, changes: ReadonlyArray<{ line: number; account: string }>, ctx: AccountContext): Issued {
  if (inv.kind !== 'invoice') throw new InvoiceRuleError('creditNote', 'Konten ändern gilt für eine Rechnung; ihre Gutschriften folgen ihr.');
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

const changedLines = (old: Issued, next: Issued, ctx: AccountContext) => old.lines.flatMap((l, line) => {
  const n = next.lines[line];
  if (!isItem(l) || !n || !isItem(n)) return [];
  const from = l.account ?? ctx.revenueAccount, to = n.account ?? ctx.revenueAccount;
  return from === to ? [] : [{ line, from, to }];
});

/**
 * The invoice's credit notes with their positions moved as the invoice's: a position on an account
 * the invoice moves to one other account follows it. An account the invoice splits over two new
 * ones leaves a credit note's position on it without an answer: refused (`credited`).
 */
export function notesWithAccounts(inv: Issued, next: Issued, invoices: readonly Invoice[], ctx: AccountContext): Array<{ old: Issued; next: Issued }> {
  const map = new Map<string, Set<string>>();
  inv.lines.forEach((l, k) => {
    const n = next.lines[k];
    if (isItem(l) && n && isItem(n)) map.set(l.account ?? ctx.revenueAccount, (map.get(l.account ?? ctx.revenueAccount) ?? new Set()).add(n.account ?? ctx.revenueAccount));
  });
  return creditNotesOf(inv, invoices).map((old) => ({
    old,
    next: {
      ...old,
      lines: old.lines.map((l, k) => {
        if (!isItem(l)) return l;
        // A credit note of the whole invoice is its positions, prices negated (creditNoteDraft): each follows its own.
        const twin = copied(inv, old) ? next.lines[k] : undefined;
        if (twin && isItem(twin)) return { ...l, ...(twin.account ? { account: twin.account } : {}) };
        const to = map.get(l.account ?? ctx.revenueAccount);
        if (!to) return l;
        if (to.size > 1) throw new InvoiceRuleError('credited', `Gutschrift ${old.number} bucht auf ${l.account ?? ctx.revenueAccount}, das die Rechnung auf ${[...to].join(' und ')} aufteilt: erst die Gutschrift stornieren und neu ausstellen, oder die Konten so ändern, dass jedes Konto auf eines geht.`);
        return { ...l, account: [...to][0] };
      }),
    },
  }));
}

/** Whether a credit note holds its invoice's positions one by one (a credit of the whole invoice). */
const copied = (inv: Issued, cn: Issued): boolean => cn.lines.length === inv.lines.length && cn.lines.every((l, k) => {
  const o = inv.lines[k];
  return isItem(l) ? isItem(o) && l.vatRate === o.vatRate && l.quantity === o.quantity && l.price === -o.price : !isItem(o);
});

/** The moves that turn `before` into `after` (account → cents; both add up the same). */
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

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/**
 * `total` (cents) over the new accounts of the weights of `code` whose old account the booking's
 * lines carry (a line a person changed is no part of it); none of them: every weight of the code.
 */
function spread(total: number, weights: readonly Weight[], code: string, accounts: ReadonlySet<string>): Map<string, number> {
  const ofCode = weights.filter((w) => w.code === code && w.net);
  const owned = ofCode.filter((w) => accounts.has(w.from));
  const ws = owned.length ? owned : ofCode;
  const out = new Map<string, number>();
  if (!ws.length) return out;
  const parts = apportion(total, ws.map((w) => w.net));
  ws.forEach((w, k) => add(out, w.to, parts[k]));
  return out;
}

/**
 * What «Konten ändern» books: for each booking of the invoice and of its credit notes (events,
 * payments, refunds) the revenue of each code and side spread over the accounts the positions now
 * name, in proportion to their nets, so no code's total moves, in its currency nor in the books'.
 * An open booking changes in place. A document's filed bookings are taken together with its earlier
 * reclassifications (`-kk-`): one reclassification moves what their revenue carries now to where
 * the positions put it, so changing and changing back leaves every account right.
 */
export function planAccountChange(books: Books, inv: Issued, next: Issued, date: string, ctx: AccountContext, invoices: readonly Invoice[] = [inv]): AccountChangePlan {
  const notes = notesWithAccounts(inv, next, invoices, ctx);
  const plan: AccountChangePlan = {
    lines: changedLines(inv, next, ctx), rebook: [], reclass: [], kept: [],
    notes: notes.map((n) => ({ id: n.old.id, number: n.old.number, lines: changedLines(n.old, n.next, ctx) })).filter((n) => n.lines.length),
  };
  if (!plan.lines.length) return plan;
  const lock = periodLock(books);
  const neg = vat().codes.negativePrefix;
  const invW = weightsOf(inv, next, ctx);
  const noteW = notes.flatMap((n) => weightsOf(n.old, n.next, ctx));
  const docs = [{ old: inv, next }, ...notes];
  for (const d of docs) {
    const isNote = d.old.kind === 'credit-note';
    const ownW = isNote ? weightsOf(d.old, d.next, ctx) : invW;
    const refs = [...new Set([eventRef(d.old, 'issue'), ...d.old.payments.map((p) => p.transactionRef)])];
    const filedNow = new Map<string, number>(), filedThen = new Map<string, number>();
    for (const ref of refs) {
      const own = revenueLines(books, docs.map((x) => x.old), ref, ctx);
      if (!own.length) {
        if (books.journalEntries.some((e) => e.transactionRef === ref && e.origin !== 'invoice')) plan.kept.push(ref);
        continue;
      }
      const filed = own.some((l) => lock.isClosed(l.e.date));
      const groups = new Map<string, typeof own>();
      for (const l of own) groups.set(`${l.side}|${l.e.vatCode ?? ''}`, [...(groups.get(`${l.side}|${l.e.vatCode ?? ''}`) ?? []), l]);
      const before = new Map<string, number>(), after = new Map<string, number>();
      let rounding = 0;
      const nextLines: AccountRebooking['next'] = [];
      for (const [key, ls] of groups) {
        const [side, code] = key.split('|') as [Side, string];
        // A sale is the document's; a minus line on the invoice's payment is its credit notes' applied part.
        const ws = side === 'minus' && !isNote ? noteW : ownW;
        const base = code.startsWith(neg) ? code.slice(neg.length) : code;
        const accounts = new Set(ls.map((l) => l.account));
        const sign = side === 'sale' ? 1 : -1;
        if (filed) {
          const chf = ls.reduce((s, l) => s + toRappen(chfAmount(l.e)), 0);
          for (const l of ls) add(filedNow, l.account, sign * toRappen(chfAmount(l.e)));
          for (const [a, r] of spread(chf, ws, base, accounts)) add(filedThen, a, sign * r);
          continue;
        }
        const total = ls.reduce((s, l) => s + toRappen(l.e.amount), 0);
        const target = spread(total, ws, base, accounts);
        if (!target.size) { for (const l of ls) nextLines.push({ side, ...(code ? { vatCode: code } : {}), account: l.account, amount: l.e.amount }); continue; }
        // Every line keeps the official rate of its booking (ADR 0001); what the split moves in the books' currency is named.
        const fx = ls[0].e.exchangeRate !== undefined ? { exchangeCurrency: ls[0].e.exchangeCurrency, exchangeRate: ls[0].e.exchangeRate } : {};
        const converted = (amount: number) => toRappen(chfAmount({ ...ls[0].e, ...fx, amount }));
        for (const l of ls) { add(before, l.account, toRappen(l.e.amount)); rounding -= sign * toRappen(chfAmount(l.e)); }
        for (const [a, r] of target) {
          add(after, a, r);
          if (r) { nextLines.push({ side, ...(code ? { vatCode: code } : {}), account: a, amount: fromRappen(r) }); rounding += sign * converted(fromRappen(r)); }
        }
      }
      const moves = movesOf(before, after).map((m) => ({ ...m, amount: fromRappen(m.amount) }));
      const e0 = own[0].e;
      if (filed) plan.rebook.push({ ref, number: d.old.number, date: e0.date, currency: e0.exchangeCurrency ?? ctx.base, filed, moves: [], next: [] });
      else if (moves.length) plan.rebook.push({ ref, number: d.old.number, date: e0.date, currency: e0.exchangeCurrency ?? ctx.base, filed, moves, next: nextLines, ...(rounding ? { rounding: fromRappen(rounding) } : {}) });
    }
    if (!filedNow.size) continue;
    // Where the filed revenue stands now: as filed, moved by the document's earlier reclassifications.
    const prefix = `${eventRef(d.old, 'issue')}-kk-`;
    const earlier = books.journalEntries.filter((e) => e.transactionRef.startsWith(prefix));
    for (const e of earlier) { add(filedNow, e.accountCredit, toRappen(chfAmount(e))); add(filedNow, e.accountDebit, -toRappen(chfAmount(e))); }
    const moves = movesOf(filedNow, filedThen).map((m) => ({ ...m, amount: fromRappen(m.amount) }));
    for (const r of plan.rebook) if (r.filed && r.number === d.old.number) r.moves = moves;
    if (!moves.length) continue;
    const k = Math.max(0, ...earlier.map((e) => Number(e.transactionRef.slice(prefix.length)) || 0)) + 1;
    plan.reclass.push({ ref: reclassRef(d.old, k), number: d.old.number, date, moves });
  }
  return plan;
}

/**
 * Books the plan: each open booking's revenue lines replaced by its `next` (the ids kept where the
 * lines are as many), and each document's reclassification, linked to its receipt when the books
 * hold it (`receiptOf`). Returns the entries the reclassifications booked.
 */
export function applyAccountChange(books: Books, docs: readonly Issued[], plan: AccountChangePlan, ctx: AccountContext, receiptOf: (number: string) => string | undefined = () => undefined): JournalEntry[] {
  for (const r of plan.rebook) {
    if (r.filed) continue;
    const own = revenueLines(books, docs, r.ref, ctx);
    const templates = new Map(own.map((l) => [`${l.side}|${l.e.vatCode ?? ''}`, l.e] as const));
    const ids = own.map((l) => l.e.id);
    const fresh = r.next.map((n, k): JournalEntry => {
      const t = templates.get(`${n.side}|${n.vatCode ?? ''}`)!;
      return {
        ...t, id: ids[k] ?? idSource.bytes(8).toString('hex'), amount: n.amount,
        ...(n.side === 'sale' ? { accountCredit: n.account } : { accountDebit: n.account }),
      };
    });
    const at = books.journalEntries.indexOf(own[0].e);
    const gone = new Set(own.map((l) => l.e));
    books.journalEntries = books.journalEntries.filter((e) => !gone.has(e));
    books.journalEntries.splice(Math.min(at, books.journalEntries.length), 0, ...fresh);
  }
  const out: JournalEntry[] = [];
  for (const { ref, number, date, moves } of plan.reclass) {
    const doc = docs.find((d) => d.number === number)!;
    const id = receiptOf(number);
    const receipt = id && books.receipts.some((r) => r.id === id) ? id : undefined;
    const entries = moves.map((m): JournalEntry => ({
      id: idSource.bytes(8).toString('hex'), transactionRef: ref, date, accountDebit: m.from, accountCredit: m.to, amount: m.amount,
      description: `Kontenänderung ${textOf(doc)}`, origin: 'invoice', ...(receipt ? { receipts: [receipt] } : {}),
    }));
    books.journalEntries.push(...entries);
    if (receipt) books.mappings.push({ transactionRef: ref, receiptId: receipt, by: 'rule', rule: 'invoice-issue' });
    out.push(...entries);
  }
  return out;
}
