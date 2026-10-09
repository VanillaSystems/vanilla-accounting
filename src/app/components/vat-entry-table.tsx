import type { JournalEntry } from '../../types/index.js';
import { vatLine, chfAmount } from '../../accounting/index.js';
import { accountTitle } from '../lib/accounts.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import type { Period } from '../../accounting/periods.js';
import { EntryLinks } from './open-in-tab-link.js';
import { ForeignAmount } from './fx-amount.js';

/** The journal entries behind a VAT figure, each with its CHF and tax signed as it counts. */
export function EntryDetail({ entries, title, period }: { entries: JournalEntry[]; title: string; /** The period links keep when it holds an entry. */ period?: Period }) {
  if (entries.length === 0) return (
    <div className="p-4 text-sm text-muted-foreground">{t('vatEntries.none', { title })}</div>
  );

  // A "-" code (refund, reversal) works against the Ziffer: show it negative, so a purchase
  // and its refund visibly cancel out.
  const rows = entries.map((e) => {
    const line = vatLine(e);
    return { e, chf: line?.gross ?? chfAmount(e), tax: line?.tax ?? 0 };
  });
  const sum = (k: 'chf' | 'tax') => rows.reduce((s, r) => s + r[k], 0);
  const signed = (n: number) => cn('px-3 py-1 text-right font-mono tabular-nums', n < 0 && 'text-red-600 dark:text-red-400');

  return (
    <div className="border-t border-border">
      <div className="px-4 py-2 bg-muted text-xs font-semibold text-muted-foreground">
        {title}: {t('common.entryCount', { n: entries.length })}
      </div>
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground border-b border-border">
            <th className="px-3 py-1 text-left w-24">{t('col.date')}</th>
            <th className="px-3 py-1 text-left">{t('col.description')}</th>
            <th className="px-3 py-1 text-left w-16">{t('col.vat')}</th>
            <th className="px-3 py-1 text-left w-14">{t('col.debit')}</th>
            <th className="px-3 py-1 text-left w-14">{t('col.credit')}</th>
            <th className="px-3 py-1 text-right w-32">{t('col.amount')}</th>
            <th className="px-3 py-1 text-right w-24">CHF</th>
            <th className="px-3 py-1 text-right w-20">{t('vat.colTaxChf')}</th>
            <th className="w-12 print:hidden" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {rows.map(({ e, chf, tax }) => (
            <tr key={e.id} className="hover:bg-accent">
              <td className="px-3 py-1 tabular-nums text-muted-foreground">{e.date}</td>
              <td className="px-3 py-1 truncate print:whitespace-normal" title={e.description}>{e.description}</td>
              <td className="px-3 py-1 font-mono text-xs">{e.vatCode}</td>
              <td className="px-3 py-1 font-mono text-xs" title={accountTitle(e.accountDebit)}>{e.accountDebit}</td>
              <td className="px-3 py-1 font-mono text-xs" title={accountTitle(e.accountCredit)}>{e.accountCredit}</td>
              <td className="px-3 py-1 text-right font-mono tabular-nums text-muted-foreground truncate">
                <ForeignAmount entry={e} />
              </td>
              <td className={signed(chf)}>{chf.toFixed(2)}</td>
              <td className={signed(tax)}>{tax.toFixed(2)}</td>
              <td className="px-1 print:hidden"><EntryLinks entry={e} period={period} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold">
            <td className="px-3 py-1" colSpan={6}>{t('common.total')}</td>
            <td className={signed(sum('chf'))}>{sum('chf').toFixed(2)}</td>
            <td className={signed(sum('tax'))}>{sum('tax').toFixed(2)}</td>
            <td className="print:hidden" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
