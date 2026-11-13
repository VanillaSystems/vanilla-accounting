/**
 * What a provider's sales or fee report could not book (#203), kept on its receipt by its latest
 * taking: each order with why, its day and gross; at most HELD_KEPT named
 * (src/intake/sales-report-import.ts), the rest counted. An order whose tax shows no one rate (#405:
 * a cart of two rates) has «Aufteilen»: one or two parts, each an amount and a rate of the firm, booked once
 * they add up to the order's gross (POST /api/receipts/:id/held-order). One of a filed period says where its correction goes.
 */
import { useState } from 'react';
import type { Receipt } from '../../../types/index.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { baseCurrency, invoiceRates } from '../../../engines/index.js';
import { I } from './icons.js';

type Held = NonNullable<NonNullable<Receipt['report']>['held']>[number];

const cents = (s: string): number | undefined => {
  const n = Number(s.replace(/['’\s]/g, '').replace(',', '.'));
  return s.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
};

export function ReportHeld({ receipt, report, canEdit, closedThrough, said }: { receipt: string; report: NonNullable<Receipt['report']>; canEdit: boolean; closedThrough?: string; said(message: string, ok: boolean): void }) {
  const held = report.held ?? [];
  const more = report.heldMore ?? 0;
  const [open, setOpen] = useState<string>();
  return (
    <div className="notice" data-testid="report-held">
      {I.dot}
      <span>
        {t('receipts.report.held', { n: held.length + more })}:
        {held.map((h) => (
          <span key={h.order} className="heldline" data-testid="report-held-order">
            {' '}{t(`drop.held.${h.why}`, { order: h.order })}{h.date ? `, ${formatDate(h.date)}` : ''}{h.gross !== undefined ? `, ${h.currency ?? baseCurrency()} ${fmt(h.gross)}` : ''}
            {canEdit && (h.why === 'rate' || h.why === 'rateTooMany') && (h.gross === undefined || !h.date) ? <span className="m" data-testid="held-no-facts">{' '}{t('receipts.report.splitNoFacts')}</span> : null}
            {(h.why === 'rate' || h.why === 'rateTooMany') && h.date && closedThrough && h.date <= closedThrough ? <span className="m" data-testid="held-filed">{' '}{t('receipts.report.splitFiled')}</span> : null}
            {canEdit && (h.why === 'rate' || h.why === 'rateTooMany') && h.gross !== undefined && h.date && !(closedThrough && h.date <= closedThrough) && open !== h.order ? <> <button type="button" className="linkbtn" data-testid="held-split-open" onClick={() => setOpen(h.order)}>{t('receipts.report.split')}</button></> : null}
            {open === h.order ? <SplitForm receipt={receipt} held={h} onDone={(m, ok) => { if (ok) setOpen(undefined); said(m, ok); }} onCancel={() => setOpen(undefined)} /> : null}
          </span>
        ))}
        {more ? ` ${t('receipts.report.heldMore', { n: more, limit: held.length })}` : ''}
      </span>
    </div>
  );
}

function SplitForm({ receipt, held, onDone, onCancel }: { receipt: string; held: Held; onDone(message: string, ok: boolean): void; onCancel(): void }) {
  const rates = invoiceRates().filter((r) => r > 0);
  // The whole order in the first part: one part is enough for an order of one rate; a second is filled for a cart of two.
  const [parts, setParts] = useState(() => [{ amount: (held.gross ?? 0).toFixed(2), rate: rates[0] ?? 0 }, { amount: '', rate: rates[1] ?? rates[0] ?? 0 }]);
  const [busy, setBusy] = useState(false);
  const gross = Math.round((held.gross ?? 0) * 100);
  const filled = parts.filter((p) => cents(p.amount) !== undefined);
  const sum = filled.reduce((s, p) => s + cents(p.amount)!, 0);
  const ready = filled.length > 0 && parts.every((p) => !p.amount.trim() || cents(p.amount) !== undefined) && sum === gross;
  const cur = held.currency ?? baseCurrency();
  const set = (i: number, patch: Partial<(typeof parts)[number]>) => setParts((was) => was.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const book = () => {
    setBusy(true);
    api.heldOrder(receipt, held.order, filled.map((p) => ({ amount: cents(p.amount)! / 100, rate: p.rate })))
      .then(() => onDone(t('receipts.report.splitDone', { order: held.order }), true), (e: unknown) => onDone(errorText(e), false))
      .finally(() => setBusy(false));
  };
  return (
    <span className="heldsplit" data-testid="held-split">
      {parts.map((p, i) => (
        <span key={i} className="heldpart">
          <input type="text" inputMode="decimal" aria-label={t('receipts.report.splitAmount', { n: i + 1 })} placeholder={t('receipts.report.splitAmount', { n: i + 1 })} value={p.amount} onChange={(e) => set(i, { amount: e.target.value })} />
          <select aria-label={t('receipts.report.splitRate', { n: i + 1 })} value={p.rate} onChange={(e) => set(i, { rate: Number(e.target.value) })}>
            {rates.map((r) => <option key={r} value={r}>{`${r} %`}</option>)}
          </select>
        </span>
      ))}
      <span className="m">{t('receipts.report.splitOne')}</span>
      <span className="m" data-testid="held-split-sum">{t(sum === gross ? 'receipts.report.splitEven' : 'receipts.report.splitSum', { sum: `${cur} ${fmt(sum / 100)}`, gross: `${cur} ${fmt(gross / 100)}` })}</span>
      <button type="button" className="btn" disabled={!ready || busy} data-testid="held-split-book" onClick={book}>{t('receipts.report.splitBook')}</button>
      <button type="button" className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
    </span>
  );
}
