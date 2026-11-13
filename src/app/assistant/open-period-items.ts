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
import { chargesVat, filing } from '../../engines/index.js';
import type { OpenLine, OpenPeriodState, YourReceipt } from '../areas/automation/open-period.js';
import { LACK_WORDS } from '../areas/automation/period-issues.js';
import type { BankTransaction, Index, Receipt } from '../../types/index.js';

export type Say = (key: string, vars?: Record<string, string | number>) => string;

/** `route` in the period that holds `date` (as receipts/view.ts `at`, which this pure module cannot import). */
export const at = (route: Route, date: string | undefined): Location =>
  ({ route, query: { period: parsePeriod(periodContaining(date, undefined, filing().length), localToday()) ?? undefined } });

export const TASKS: Location = { route: { area: 'automation', view: 'tasks' }, query: {} };

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
export function itemsOf(l: OpenLine, s: OpenPeriodState, books: Index, say: Say): Items {
  const pay = (x: BankTransaction): Item => ({ key: x.ref, go: at({ area: 'bank', payment: x.ref }, x.date), text: [formatDate(x.date), payText(x).name, money(x.currency, x.amount)].join(' · ') });
  const mine = (x: YourReceipt): Item => ({ key: x.receipt.id, go: receiptAt(x.receipt, s, books), text: [x.name, x.receipt.date && formatDate(x.receipt.date), money(x.receipt.currency, x.receipt.amount), x.lacks.map((k) => say(LACK_WORDS[k])).join(', ')].filter(Boolean).join(' · ') });
  const lone = (r: Receipt): Item => ({ key: r.id, go: receiptAt(r, s, books), text: [r.description ? moneyInText(r.description) : r.filename, r.date && formatDate(r.date), money(r.currency, r.amount)].filter(Boolean).join(' · ') });
  const receipts: Location = at({ area: 'receipts' }, s.period.from);
  switch (l.kind) {
    case 'yours': return { items: l.items.map(mine), more: l.more, all: receipts };
    case 'unbooked': return { items: l.items.map(pay), more: l.more, all: openList(s) ?? at({ area: 'bank' }, s.period.from) };
    case 'unlinked': return { items: l.items.map(lone), more: l.more, all: receipts };
    default: return { items: [], more: 0 };
  }
}


