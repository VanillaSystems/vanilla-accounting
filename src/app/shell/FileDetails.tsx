/**
 * What a bank statement file says about itself (#208): the bank as it names itself, the account's
 * currency, IBAN and owner, the period the bank states and the days it booked, the movements,
 * the opening and closing balance with their days, the file. The drop dialog folds it under a row
 * that asks for its account (with the first movements previewed); Kontoauszüge › Dateien shows it
 * for each file read in (with every movement, each a link, as `children`).
 */
import type { ReactNode } from 'react';
import type { StatementDetails } from '../../types/drop.js';
import { fmt, formatDate } from '../lib/utils.js';
import { t } from '../i18n/index.js';

const groupIban = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

/** A balance as the bank states it: amount and day. */
const balanceText = (currency: string, b: { date: string; amount: number }) => t('drop.c.balance', { currency, amount: fmt(b.amount), date: formatDate(b.date) });

export function FileDetails({ d, name, importedAt, children }: { d: StatementDetails; name: string; importedAt?: string; children?: ReactNode }) {
  const bank = [d.bankName, d.bic].filter(Boolean).join(' · ');
  const period = [d.period && t('drop.c.stated', { from: formatDate(d.period.from), to: formatDate(d.period.to) }), d.booked && t('drop.c.booked', { first: formatDate(d.booked.first), last: formatDate(d.booked.last) })].filter(Boolean);
  return (
    <dl className="ddet" data-testid="statement-file-details">
      <dt>{t('drop.c.bank')}</dt><dd>{bank || '–'}</dd>
      <dt>{t('drop.c.account')}</dt><dd>{[d.iban && groupIban(d.iban), d.currency].filter(Boolean).join(' · ')}</dd>
      {d.owner ? <><dt>{t('drop.c.owner')}</dt><dd>{d.owner}</dd></> : null}
      <dt>{t('drop.c.period')}</dt><dd>{period.length ? period.map((x) => <span key={x}>{x}</span>) : '–'}</dd>
      <dt>{t('drop.c.movements')}</dt><dd>{d.movements}</dd>
      {d.opening ? <><dt>{t('drop.c.opening')}</dt><dd>{balanceText(d.currency, d.opening)}</dd></> : null}
      {d.closing ? <><dt>{t('drop.c.closing')}</dt><dd>{balanceText(d.currency, d.closing)}</dd></> : null}
      <dt>{t('drop.c.file')}</dt><dd className="mono">{name}</dd>
      {importedAt ? <><dt>{t('drop.c.imported')}</dt><dd>{formatDate(importedAt)}</dd></> : null}
      {d.preview.length ? (
        <>
          <dt>{t('drop.c.preview')}</dt>
          <dd className="dmoves">
            {d.preview.map((m, i) => (
              <span key={i} className="dmove">
                <span className="mono">{formatDate(m.date)}</span>
                <span className={`mono ${m.amount < 0 ? 'neg' : ''}`}>{fmt(m.amount)}</span>
                <span>{[m.counterparty, m.text].filter(Boolean).join(' · ') || '–'}</span>
              </span>
            ))}
            {d.more ? <span className="m">{t('drop.c.more', { n: d.more, shown: d.preview.length })}</span> : null}
          </dd>
        </>
      ) : null}
      {children}
    </dl>
  );
}
