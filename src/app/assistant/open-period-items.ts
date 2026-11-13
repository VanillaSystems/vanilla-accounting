/**
 * The objects the open period's card names one by one under its lines (#398): each payment with its
 * day, who and how much; each receipt that waits for the person with what it lacks; each receipt
 * without a payment. Each a link to its place, at most ITEMS_SHOWN per line and the rest counted
 * with the way to all of them. Pure: the words come through `say` (t() in the app, a dictionary's own in a test).
 */
import { fmt, formatDate, moneyInText } from '../lib/utils.js';
import type { Location, Route } from '../shell/route.js';
import { payText } from '../areas/bank/model.js';
import { localToday, parsePeriod, periodContaining } from '../../accounting/periods.js';
import { placedReceiptDay } from '../automation/home.js';
import { OPEN_ITEMS } from '../areas/vat/model.js';
import { baseCurrency, chargesVat, filing } from '../../engines/index.js';
import type { OpenLine, OpenPeriodState, YourReceipt } from '../areas/automation/open-period.js';
import { LACK_WORDS } from '../areas/automation/period-issues.js';
import { offersInBooks } from '../../intake/near-pairs.js';
import type { BankTransaction, Index, Receipt } from '../../types/index.js';

export type Say = (key: string, vars?: Record<string, string | number>) => string;

/** `route` in the period that holds `date` (as receipts/view.ts `at`, which this pure module cannot import). */
export const at = (route: Route, date: string | undefined): Location =>
  ({ route, query: { period: parsePeriod(periodContaining(date, undefined, filing().length), localToday()) ?? undefined } });

export const TASKS: Location = { route: { area: 'automation', view: 'tasks' }, query: {} };

/** Firma › Eröffnung, where a bank account's opening balance is entered (#428). */
export const OPENING: Location = { route: { area: 'company', section: 'opening' }, query: {} };

/** A clearing account's ledger in the balance sheet of the period the card is about (#428). */
export const clearingAt = (account: string, s: Pick<OpenPeriodState, 'period'>): Location => at({ area: 'reports', report: 'balance', account }, s.period.to);

/** The return's list «Noch offen» beside it (#341): where a line about the return leads, for a firm that files one. */
export const openList = (s: OpenPeriodState): Location | undefined =>
  (chargesVat() && s.filing.kind !== 'filed' ? { route: { area: 'vat', ziffer: OPEN_ITEMS }, query: { period: s.period } } : undefined);

/** A receipt in the period Belege lists it under (#385 review), in the period the card is about. */
export const receiptAt = (r: Receipt, s: OpenPeriodState, books: Index): Location => at({ area: 'receipts', id: r.id }, placedReceiptDay(books, r, s.period.from));

/** «EUR 3'200.00»: the app's one money format (fmt). */
export const money = (currency: string | undefined, amount: number | undefined) => (amount == null ? '' : `${currency ?? ''} ${fmt(amount)}`.trim());

/** One object of a line (#398): who, how much and when, and for a receipt of hers what it lacks, as Belege's row says it. */
export type Item = { key: string; text: string; go: Location };
export interface Items { items: Item[]; more: number; all?: Location }
export function itemsOf(l: OpenLine, s: OpenPeriodState, books: Index, say: Say, why: (ref: string) => string | undefined = () => undefined): Items {
  // A payment a run left unbooked says why (#470), as its page does.
  const pay = (x: BankTransaction): Item => ({ key: x.ref, go: at({ area: 'bank', payment: x.ref }, x.date), text: [formatDate(x.date), payText(x).name, money(x.currency, x.amount), why(x.ref)].filter(Boolean).join(' · ') });
  // A payment that may fit (#397's near offers, the receipt's page holds the click): said once, on the receipt's line (#398).
  const fits = (x: YourReceipt) => { const o = offersInBooks(books, { receipt: x.receipt.id })[0]; const tx = o && books.transactions.find((y) => y.ref === o.payment); return tx ? `${say('near.maybe')} ${formatDate(tx.date)} ${payText(tx).name} ${money(tx.currency, tx.amount)}` : ''; };
  const mine = (x: YourReceipt): Item => ({ key: x.receipt.id, go: receiptAt(x.receipt, s, books), text: [x.name, x.receipt.date && formatDate(x.receipt.date), money(x.receipt.currency, x.receipt.amount), x.lacks.map((k) => say(LACK_WORDS[k])).join(', '), fits(x)].filter(Boolean).join(' · ') });
  const lone = (r: Receipt): Item => ({ key: r.id, go: receiptAt(r, s, books), text: [r.description ? moneyInText(r.description) : r.filename, r.date && formatDate(r.date), money(r.currency, r.amount)].filter(Boolean).join(' · ') });
  const receipts: Location = at({ area: 'receipts' }, s.period.from);
  switch (l.kind) {
    case 'yours': return { items: l.items.map(mine), more: l.more, all: receipts };
    case 'unbooked': return { items: l.items.map(pay), more: l.more, all: openList(s) ?? at({ area: 'bank' }, s.period.from) };
    case 'unlinked': return { items: l.items.map(lone), more: l.more, all: receipts };
    case 'offers': return { items: l.items.map((o) => ({ key: o.ref, go: at({ area: 'bank', payment: o.ref }, o.date), text: say('openPeriod.offer', { name: o.name, percent: o.percent, account: o.account }) })), more: l.more, all: at({ area: 'bank', payment: l.first.ref }, l.first.date) };
    case 'openings': return { items: l.items.map((o) => ({ key: o.account, go: OPENING, text: say('openPeriod.opening', { label: o.label, amount: money(o.currency ?? baseCurrency(), o.amount), year: o.year }) })), more: l.more, all: OPENING };
    case 'clearing': return { items: l.items.map((c) => ({ key: c.account, go: clearingAt(c.account, s), text: say('openPeriod.clearingItem', { name: c.name, account: c.account, date: formatDate(s.period.to), amount: money(baseCurrency(), c.balance) }) })), more: l.more };
    default: return { items: [], more: 0 };
  }
}


