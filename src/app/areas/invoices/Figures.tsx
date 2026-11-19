/**
 * What an issued invoice's money did (spec 4.8): the four figures above its sheet (Betrag ·
 * erhalten · gutgeschrieben · offen), each naming its sources, and the margin's «Zahlungen»: the
 * payments (from a statement or by hand, with the statement row that confirmed a hand one), the
 * write-offs with «Rückgängig», and the bookings each event made, each a link to its entry.
 * Everything comes from the records (src/invoices/rules.ts figures), never set by hand.
 */
import type { ReactNode } from 'react';
import type { Invoice, Issued } from '../../../invoices/model.js';
import { figures } from '../../../invoices/rules.js';
import { eventRef, writeOffRef } from '../../../books/refs.js';
import type { Index, JournalEntry } from '../../../types/index.js';
import type { Period } from '../../../accounting/periods.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { hrefOf } from '../../shell/history.js';
import { entryAt } from '../vat/links.js';
import { at } from '../receipts/view.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { releasePayment, removeHandPayment, removeWriteOff } from './actions.js';

/** The four figures of an issued invoice; a figure's sources on hover. */
export function FourFigures({ inv, invoices }: { inv: Issued; invoices: readonly Invoice[] }) {
  const f = figures(inv, invoices);
  const money = (n: number) => `${inv.currency} ${fmt(n)}`;
  const received = f.payments.map((p) => t('invoices.fig.payment', { date: formatDate(p.date), amount: money(p.amount), how: t(p.source === 'hand' ? 'invoices.fig.byHand' : 'invoices.fig.byStatement') }));
  const credited = [
    ...f.creditNotes.map((c) => t('invoices.fig.creditNote', { number: c.number, date: formatDate(c.date), amount: money(c.amount) })),
    ...f.writeOffs.map((w) => t('invoices.fig.writeOff', { reason: t(`invoices.reason.${w.reason}`), date: formatDate(w.date), amount: money(w.amount) })),
  ];
  const none = { received: t('invoices.fig.receivedNone'), credited: t('invoices.fig.creditedNone') } as Record<string, string>;
  const cell = (k: 'amount' | 'received' | 'credited' | 'open', n: number, sources: string[], className = '') => (
    <div className={`fig${className}`} data-fig={k} data-tip={sources.length ? sources.join(' · ') : none[k]}>
      <span className="lbl">{t(`invoices.fig.${k}`)}</span>
      <span className="n mono">{money(n)}</span>
    </div>
  );
  return (
    <div className="ivfigs" data-testid="four-figures">
      {cell('amount', f.amount, [t('invoices.fig.amountTip', { date: formatDate(inv.date) })])}
      {cell('received', f.received, received)}
      {cell('credited', f.credited, credited)}
      {cell('open', f.open, f.open < 0 ? [t('invoices.fig.credit')] : [t('invoices.fig.openTip')], f.open > 0 ? ' open' : f.open < 0 ? ' minus' : ' done')}
    </div>
  );
}

/** The entries an invoice's events made: its issue, Storno and write-offs, and the lines of its payments that name it. */
export function eventEntries(books: Pick<Index, 'journalEntries'>, inv: Issued): JournalEntry[] {
  const own = new Set([eventRef(inv, 'issue'), eventRef(inv, 'storno'), ...(inv.writeOffs ?? []).map((w) => writeOffRef(inv, w.id))]);
  const paid = new Set(inv.payments.map((p) => p.transactionRef));
  return (books.journalEntries ?? []).filter((e) => own.has(e.transactionRef) || (paid.has(e.transactionRef) && e.origin === 'invoice' && (e.description ?? '').includes(inv.number)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The margin's payments, write-offs and bookings of an issued invoice. */
export function MoneyRows({ inv, books, nav, period, canEdit }: { inv: Issued; books: Index; nav: Nav; period: Period; canEdit: boolean }) {
  const money = (n: number) => `${inv.currency} ${fmt(n)}`;
  const lock = books.config?.closedThrough ?? '';
  const rows: ReactNode[] = [];
  for (const p of inv.payments) {
    const tx = books.transactions.find((x) => x.ref === p.transactionRef);
    // One payment over several invoices (Ausziffern): this invoice's part of it.
    const parts = !!tx && Math.round(tx.amount * 100) !== Math.round((p.amount + (p.fee ?? 0)) * 100);
    rows.push(
      <div key={`p${p.transactionRef}`} className="mrow" data-testid="linked-payment">
        <span className="mono">{formatDate(p.date)}</span>
        <span>
          {t(p.source === 'hand' || tx?.source === 'manual' ? 'invoices.money.hand' : 'invoices.money.statement', { amount: money(p.amount) })}
          {parts && tx ? <small>{t('invoices.money.part', { amount: `${tx.currency} ${fmt(tx.amount)}` })}</small> : null}
          {tx?.source === 'manual' && tx.statement ? <small data-testid="hand-confirmed">{t('invoices.money.confirmed', { ref: tx.statement })}</small> : null}
          {tx?.source === 'manual' && !tx.statement ? <small>{t('invoices.money.unconfirmed')}</small> : null}
        </span>
        <span className="acts">
          <a className="golink" href={hrefOf(at({ area: 'bank', payment: p.transactionRef }, p.date))} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.go(at({ area: 'bank', payment: p.transactionRef }, p.date)); }}>{tx?.source === 'manual' ? t('invoices.money.handLink', { date: formatDate(tx.date) }) : <span className="mono">{p.transactionRef}</span>}</a>
          {canEdit && p.date > lock && (p.source === 'hand' && tx && !tx.statement
            ? <AsyncButton type="button" className="quiet2" data-act="hand-undo" onClick={() => removeHandPayment(nav, inv, p.transactionRef)}>{t('invoices.undo')}</AsyncButton>
            : <AsyncButton type="button" className="quiet2" data-act="release" data-tip={t('invoices.releasePaymentTip')} onClick={() => releasePayment(nav, inv, p.transactionRef)}>{t('invoices.releasePayment')}</AsyncButton>)}
        </span>
      </div>,
    );
  }
  for (const w of inv.writeOffs ?? []) {
    rows.push(
      <div key={`w${w.id}`} className="mrow" data-testid="money-writeoff">
        <span className="mono">{formatDate(w.date)}</span>
        <span>{t('invoices.money.writeOff', { reason: t(`invoices.reason.${w.reason}`), amount: money(w.amount) })}<small>{t(w.by === 'code' ? 'invoices.money.byCode' : 'invoices.money.byPerson')}{w.note ? ` · ${w.note}` : ''}</small></span>
        <span className="acts">{canEdit && w.date > lock && !inv.cancelled && <AsyncButton type="button" className="quiet2" data-act="writeoff-undo" onClick={() => removeWriteOff(nav, inv, w.id)}>{t('invoices.undo')}</AsyncButton>}</span>
      </div>,
    );
  }
  const entries = eventEntries(books, inv);
  return (
    <>
      {rows.length ? <div className="ivmoney">{rows}</div> : <p className="m">{t('invoices.money.none')}</p>}
      {entries.length > 0 && (
        <div className="ivbooked" data-testid="money-bookings">
          <p className="m">{t('invoices.money.bookings')}</p>
          {entries.map((e) => (
            <a key={e.id} className="mrow" href={hrefOf(entryAt(e, period))} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey) return; ev.preventDefault(); nav.go(entryAt(e, period)); }}>
              <span className="mono">{formatDate(e.date)}</span>
              <span className="mono">{e.accountDebit} / {e.accountCredit}{e.vatCode ? ` · ${e.vatCode}` : ''}</span>
              <span className="r mono">{fmt(e.amount)}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
