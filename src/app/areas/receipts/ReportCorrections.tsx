/**
 * The refunds paid in a filed period that a provider's sales report offers as corrections (#231,
 * golden rule 1): the books never carried them, their sales they carry. Each is named with its day,
 * amount and the filing period it belongs to; «Als Korrektur buchen» books it in the open period with
 * `corrects` (POST /api/receipts/:id/report-correction), declared in that period's correction return.
 * One whose sale sits in an old entry naming it beside other orders (`byHand`, #239: a payout entry, which
 * may net the refund already) is named with what to do, without the button: the person books it by hand.
 * Shown on the report's receipt and in the drop row of a report whose taking found them.
 */
import { useState } from 'react';
import type { Index } from '../../../types/index.js';
import { parsePeriod, localToday } from '../../../accounting/periods.js';
import { periodName } from '../../lib/period-label.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { baseCurrency } from '../../../engines/index.js';
import { I } from './icons.js';

const nameOf = (key: string): string => { const p = parsePeriod(key, localToday()); return p ? periodName(p) : key; };

export function ReportCorrections({ receipt, books, canEdit, said }: { receipt: string; books: Index; canEdit: boolean; said(message: string, ok: boolean): void }) {
  const [busy, setBusy] = useState(false);
  const offers = books.receipts.find((r) => r.id === receipt)?.report?.filedRefunds ?? [];
  if (!offers.length) return null;
  const book = (order: string, date: string, period: string) => {
    setBusy(true);
    api.reportCorrection(receipt, order, date)
      .then(() => said(t('receipts.report.corrected', { order, period }), true), (e: unknown) => said(errorText(e), false))
      .finally(() => setBusy(false));
  };
  return (
    <div className="notice" data-testid="report-corrections">
      {I.dot}
      <span>
        {offers.map((f) => {
          const period = nameOf(f.corrects);
          return (
            <span key={`${f.order}-${f.date}`} data-testid="report-correction">
              {t(f.byHand ? 'receipts.report.filedRefundByHand' : 'receipts.report.filedRefund', { order: f.order, date: formatDate(f.date), amount: `${f.currency ?? baseCurrency()} ${fmt(f.amount)}`, period })}{' '}
              {canEdit && !f.byHand ? <button type="button" className="linkbtn" disabled={busy} data-tip={t('receipts.report.correctionTip', { period })} onClick={() => book(f.order, f.date, period)}>{t('receipts.report.bookCorrection')}</button> : null}{' '}
            </span>
          );
        })}
      </span>
    </div>
  );
}
