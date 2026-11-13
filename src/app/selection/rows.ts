/**
 * The picked rows of each list as the selection shows them (#216): receipts, payments, entries,
 * each with its date, words, amount, its amount in the books' currency (the official daily rate of its day,
 * as everywhere a foreign amount is shown in the books' currency) and whether a filed period holds it.
 */
import type { Index } from '../../types/index.js';
import { chfAmount } from '../../accounting/ledger.js';
import { baseCurrency } from '../../engines/index.js';
import type { EstvRates } from '../../accounting/fx-conversion.js';
import { localToday } from '../../accounting/periods.js';
import { ledgerFor, at, signed } from '../areas/receipts/view.js';
import { readsPaidPrivately } from '../areas/receipts/actions-menu.js';
import { chfOf } from '../areas/receipts/model.js';
import { journalFor } from '../areas/journal/commands.js';
import { payText } from '../areas/bank/model.js';
import type { SelRow } from './SelectionView.js';

export function receiptRows(books: Index, ids: readonly string[], rates: EstvRates | null): SelRow[] {
  const l = ledgerFor(books);
  const toChf = chfOf(rates);
  return ids.flatMap((id) => {
    const v = l.byId.get(id);
    if (!v) return [];
    const currency = v.r.currency || baseCurrency();
    return [{
      id, date: v.date, title: v.vendor || v.r.filename, sub: v.desc, amount: v.r.amount, currency,
      chf: v.r.amount == null ? undefined : toChf(v.r.amount, currency, v.date ?? localToday()),
      closed: v.locked, at: at({ area: 'receipts', id }, v.day),
    }];
  });
}

export function paymentRows(books: Index, ids: readonly string[], rates: EstvRates | null): SelRow[] {
  const toChf = chfOf(rates);
  const byRef = new Map(books.transactions.map((tx) => [tx.ref, tx]));
  const closed = books.config?.closedThrough;
  return ids.flatMap((ref) => {
    const tx = byRef.get(ref);
    if (!tx) return [];
    const { name, note } = payText(tx);
    return [{
      id: ref, date: tx.date, title: name, sub: note, amount: signed(tx), currency: tx.currency,
      chf: toChf(signed(tx), tx.currency, tx.date), closed: !!closed && tx.date <= closed, at: at({ area: 'bank', payment: ref }, tx.date),
    }];
  });
}

export function entryRows(books: Index, ids: readonly string[]): SelRow[] {
  const j = journalFor(books);
  return ids.flatMap((id) => {
    const v = j.byId.get(id);
    if (!v) return [];
    const { e } = v;
    return [{
      id, date: e.date, title: v.title, sub: `${e.accountDebit || '–'} / ${e.accountCredit || '–'}${e.vatCode ? ` ${e.vatCode}` : ''}`,
      amount: e.amount, currency: e.exchangeCurrency, chf: chfAmount(e), closed: v.locked, at: at({ area: 'journal', id }, e.date),
    }];
  });
}

/** What the picked rows want, for the likely batch: receipts without a payment, payments without a booking or a receipt. */
export function countsOf(kind: 'receipt' | 'payment' | 'entry', rows: readonly SelRow[], books: Index): { n: number; open: number; unbooked: number; noReceipt: number; privately?: number } {
  const ids = new Set(rows.filter((r) => !r.closed).map((r) => r.id));
  const n = ids.size;
  if (kind === 'receipt') {
    const l = ledgerFor(books);
    const open = [...ids].map((id) => l.byId.get(id)).filter((v): v is NonNullable<typeof v> => !!v && !v.none && !v.links.length && !v.orderPage);
    return { n, open: open.length, unbooked: 0, noReceipt: 0, privately: open.filter((v) => readsPaidPrivately(v, l)).length };
  }
  if (kind === 'payment') {
    const booked = new Set((books.journalEntries ?? []).map((e) => e.transactionRef));
    const linked = new Set(books.mappings.map((m) => m.transactionRef));
    const txs = books.transactions.filter((tx) => ids.has(tx.ref));
    return { n, open: 0, unbooked: txs.filter((tx) => tx.amount && !booked.has(tx.ref)).length, noReceipt: txs.filter((tx) => tx.direction === 'DBIT' && !tx.noReceiptNeeded && !linked.has(tx.ref)).length };
  }
  return { n, open: 0, unbooked: 0, noReceipt: 0 };
}
