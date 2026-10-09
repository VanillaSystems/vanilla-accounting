import type { JournalEntry } from '../../types/index.js';
import { vatLine, chfAmount } from '../../accounting/index.js';
import { accountTitle } from '../lib/accounts.js';
import { cn } from '../lib/utils.js';

/** The journal entries behind a VAT figure, each with its CHF and tax signed as it counts. */
export function EntryDetail({ entries, title }: { entries: JournalEntry[]; title: string }) {
  if (entries.length === 0) return (
    <div className="p-4 text-sm text-muted-foreground">{title}: keine Buchungen</div>
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
        {title}: {entries.length} Buchungen
      </div>
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground border-b border-border">
            <th className="px-3 py-1 text-left w-24">Datum</th>
            <th className="px-3 py-1 text-left">Beschreibung</th>
            <th className="px-3 py-1 text-left w-16">MWST</th>
            <th className="px-3 py-1 text-left w-14">Soll</th>
            <th className="px-3 py-1 text-left w-14">Haben</th>
            <th className="px-3 py-1 text-right w-28">Betrag</th>
            <th className="px-3 py-1 text-right w-24">CHF</th>
            <th className="px-3 py-1 text-right w-20">Steuer CHF</th>
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
                {e.exchangeCurrency ? `${e.exchangeCurrency} ${e.amount.toFixed(2)}` : e.amount.toFixed(2)}
              </td>
              <td className={signed(chf)}>{chf.toFixed(2)}</td>
              <td className={signed(tax)}>{tax.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold">
            <td className="px-3 py-1" colSpan={6}>Total</td>
            <td className={signed(sum('chf'))}>{sum('chf').toFixed(2)}</td>
            <td className={signed(sum('tax'))}>{sum('tax').toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
