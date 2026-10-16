/**
 * A report as the app ran it (src/reports/run.ts), on the sidebar's card and in Eigene Berichte:
 * each section with its filters in words, its rows (each a link to the booking, payment, receipt
 * or invoice it is), its group and section totals, then the overall totals, the comment with its
 * figures filled in and the note on the VAT the amounts still hold. Every figure is the run's.
 */
import { Fragment } from 'react';
import type { Key } from '../../../i18n/types.js';
import { accountingName, t } from '../../../i18n/index.js';
import { fmt, formatDate } from '../../../lib/utils.js';
import { localToday, parsePeriod, periodContaining } from '../../../../accounting/periods.js';
import { filing } from '../../../../engines/index.js';
import { hrefOf } from '../../../shell/history.js';
import type { Location, Route } from '../../../shell/route.js';
import type { Words } from '../../../../export/tables.js';
import type { Column } from '../../../../reports/spec.js';
import { fillComment, type ReportResult, type ReportRow, type Totals } from '../../../../reports/run.js';
import { filtersInWords, groupName, spanOf } from '../../../../reports/words.js';
import { vatParts } from '../model.js';

/** The UI's words for the code that names a report's parts (src/reports/files.ts). */
export const uiWords: Words = { t: (k, v) => t(k as Key, v as never), accountingName };

const MONEY: readonly Column[] = ['amount', 'net', 'tax'];

/** Where a row's object is: its booking, payment, receipt or invoice, in the period of its date. */
export function rowAt(row: ReportRow): Location {
  const route: Route = row.link.kind === 'entry' ? { area: 'journal', id: row.link.id }
    : row.link.kind === 'payment' ? { area: 'bank', payment: row.link.id }
      : row.link.kind === 'receipt' ? { area: 'receipts', id: row.link.id }
        : { area: 'invoices', view: 'list', id: row.link.id };
  return { route, query: row.link.kind === 'invoice' ? {} : { period: parsePeriod(periodContaining(row.date, undefined, filing().length), localToday()) ?? undefined } };
}

const sums = (ts: Totals[], k: 'amount' | 'net' | 'tax') => ts.map((x) => (ts.length > 1 ? `${x.currency} ${fmt(x[k])}` : fmt(x[k]))).join(' · ');

function cell(row: ReportRow, c: Column): string {
  if (MONEY.includes(c)) return fmt(row[c] as number);
  if (c === 'date') return formatDate(row.date);
  return String(row[c] ?? '');
}

/** The comment, filled with the run's figures as the page writes amounts. */
export const commentText = (r: ReportResult): string | undefined =>
  fillComment(r, (n, c) => `${c} ${fmt(n)}`, { period: spanOf(r), date: formatDate });

export function ReportView({ result, preview, go }: { result: ReportResult; preview?: boolean; go(loc: Location): void }) {
  const comment = commentText(result);
  const many = result.sections.length > 1;
  return (
    <div className="rpt" data-testid="report">
      {result.sections.map((s, i) => {
        // The sidebar's card is narrow: a row there is its date, its text and its amount; the whole table is in the PDF, the CSV and Eigene Berichte.
        const money = s.section.columns.filter((c) => MONEY.includes(c));
        const cols = preview ? [...s.section.columns.filter((c) => c === 'date' || c === 'text'), ...money.slice(-1)] : s.section.columns;
        const shown = s.groups.reduce((n, g) => n + g.rows.length, 0);
        const grouped = s.section.group !== 'none';
        const totalRow = (label: string, ts: Totals[], cls: string) => {
          const first = cols.findIndex((c) => MONEY.includes(c));
          return (
            <tr className={cls}>
              <td colSpan={first < 0 ? cols.length : first}>{label}</td>
              {first < 0 ? null : cols.slice(first).map((c) => <td key={c} className="n">{MONEY.includes(c) ? sums(ts, c as 'amount') : ''}</td>)}
            </tr>
          );
        };
        return (
          <section key={i} className="rpts" data-section={i + 1}>
            {many || s.section.title ? <h3>{s.section.title || `${i + 1}. ${uiWords.t(`custom.source.${s.section.source}` as Key)}`}</h3> : null}
            <p className="m rptf">{filtersInWords(s.section, uiWords)} · {t('custom.rows', { n: s.count })}</p>
            {s.count === 0 ? <p className="m">{t('assistant.report.empty')}</p> : (
              <table className={`rptt${preview ? ' compact' : ''}`}>
                <thead><tr>{cols.map((c) => <th key={c} className={MONEY.includes(c) ? 'n' : ''}>{uiWords.t(`custom.col.${c}` as Key)}</th>)}</tr></thead>
                <tbody>
                  {s.groups.map((g) => (
                    <Fragment key={g.key}>
                      {grouped && g.rows.length ? <tr className="grp"><td colSpan={cols.length}>{groupName(g, uiWords)}</td></tr> : null}
                      {g.rows.map((row, j) => (
                        <tr key={`${row.link.id}-${j}`} className="rptr">
                          {cols.map((c, k) => (
                            <td key={c} className={MONEY.includes(c) ? 'n mono' : c === 'date' ? 'mono d' : ''}>
                              {k === 0 ? <a href={hrefOf(rowAt(row))} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); go(rowAt(row)); }}>{cell(row, c)}</a> : cell(row, c)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {grouped && !preview ? totalRow(t('custom.totalOf', { group: groupName(g, uiWords) }), g.totals, 'gtot') : null}
                    </Fragment>
                  ))}
                  {preview && shown < s.count ? <tr className="more"><td colSpan={cols.length}>{t('assistant.report.more', { n: s.count - shown })}</td></tr> : null}
                  {totalRow(t('custom.sectionTotal', { section: s.section.title || uiWords.t(`custom.source.${s.section.source}` as Key) }), s.totals, 'tot')}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
      {many ? (
        <p className="rpto" data-testid="report-total">
          <b>{t('custom.overall')}</b> · {t('custom.rows', { n: result.count })} · {t('custom.col.amount')} <span className="mono">{sums(result.totals, 'amount')}</span>
        </p>
      ) : null}
      {comment ? <p className="rptc" data-testid="report-comment">{comment}</p> : null}
      {result.vat ? <p className="m rptv">{t('custom.vatNote', { net: fmt(result.vat.net), parts: vatParts(result.vat).filter((x) => x.amount !== 0).map((x) => t(x.key, { amount: fmt(x.amount) })).join(', ') })}</p> : null}
    </div>
  );
}
