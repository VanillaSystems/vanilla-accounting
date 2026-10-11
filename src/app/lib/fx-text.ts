import type { Conversion } from '../../accounting/fx-conversion.js';
import { t } from '../i18n/index.js';
import { fmt, formatDate } from './utils.js';

const rateText = (rate: number | undefined) => (rate === undefined ? '—' : String(rate));

/** "EUR <amount> × <rate> = CHF <amount>" */
export function conversionText(c: Conversion): string {
  return t('fx.conversion', { currency: c.currency, amount: fmt(c.amount), rate: rateText(c.rate), chf: fmt(c.chf) });
}

/** Where the rate comes from, or why it is not the ESTV rate of the payment date. */
export function checkText(c: Conversion): string {
  const { check } = c;
  if (check.kind === 'unknown') return t('fx.unknown', { currency: c.currency, paymentDate: formatDate(c.paymentDate) });
  if (check.kind === 'differs') {
    return t('fx.differs', { rate: rateText(check.estv.rate), date: formatDate(check.estv.validOn), paymentDate: formatDate(c.paymentDate) });
  }
  return t('fx.estvSource', { date: formatDate(check.estv.validOn) });
}
