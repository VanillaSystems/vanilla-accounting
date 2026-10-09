import { useMemo } from 'react';
import type { Index } from '../../types/index.js';
import { reconcileMonthly } from '../../accounting/index.js';
import { cn, fmt } from '../lib/utils.js';
import { useWorkspace } from '../hooks/use-workspace.js';

interface Props {
  index: Index;
}

const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function monthLabel(date: string): string {
  const [y, m] = date.split('-');
  return `${MONTHS_DE[parseInt(m, 10) - 1]} ${y}`;
}

export function BankReconciliationTab({ index }: Props) {
  const bankAccounts = useWorkspace()?.bankAccounts;
  const accounts = useMemo(() => reconcileMonthly(index, bankAccounts ?? []), [index, bankAccounts]);

  // Map statement PDF filenames to receipt ids so each bank figure links to its source.
  const receiptByFilename = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of index.receipts) m.set(r.filename, r.id);
    return m;
  }, [index.receipts]);

  const totalRows = accounts.reduce((n, a) => n + a.rows.length, 0);
  const mismatches = accounts.reduce((n, a) => n + a.rows.filter((r) => !r.matched).length, 0);
  const allMatched = mismatches === 0 && totalRows > 0;

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col h-full overflow-auto">
        <Header />
        <div className="p-6 text-sm text-muted-foreground">
          Keine Bankauszüge gefunden. Führe <code className="font-mono">npm run extract-balances</code> aus, um die
          monatlichen Schlusssaldi aus den PDF-Kontoauszügen einzulesen.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      <Header />

      <div className="p-6 space-y-6">
        {/* Summary banner — the headline proof for the auditor */}
        <div
          className={cn(
            'flex items-center justify-between rounded-lg border px-4 py-3',
            allMatched
              ? 'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950'
              : 'border-destructive/40 bg-destructive/10',
          )}
        >
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full text-lg',
                allMatched
                  ? 'bg-green-600 text-white dark:bg-green-500'
                  : 'bg-destructive text-destructive-foreground',
              )}
            >
              {allMatched ? '✓' : '!'}
            </span>
            <div>
              <div className="text-sm font-semibold text-foreground">
                {allMatched
                  ? 'Alle Bankkonten stimmen mit der Buchhaltung überein'
                  : `${mismatches} Abweichung(en) gefunden`}
              </div>
              <div className="text-xs text-muted-foreground">
                {accounts.length} Bilanzkonten · {totalRows} Monatsabschlüsse geprüft gegen die Bank-Kontoauszüge
              </div>
            </div>
          </div>
        </div>

        {/* Per-account reconciliation tables */}
        {accounts.map((acc) => (
          <div key={acc.account} className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between bg-muted px-4 py-2 border-b border-border">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-muted-foreground">{acc.account}</span>
                <span className="text-sm font-semibold text-foreground">{acc.label}</span>
                <span className="text-xs text-muted-foreground">({acc.currency})</span>
              </div>
              <span
                className={cn(
                  'text-xs font-medium px-2 py-0.5 rounded-full',
                  acc.allMatched
                    ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                    : 'bg-destructive/10 text-destructive',
                )}
              >
                {acc.allMatched ? 'abgestimmt' : 'Abweichung'}
              </span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2">Monat</th>
                  <th className="text-right font-medium px-4 py-2">Bankauszug</th>
                  <th className="text-right font-medium px-4 py-2">Unsere Buchhaltung</th>
                  <th className="text-right font-medium px-4 py-2">Differenz</th>
                  <th className="text-center font-medium px-4 py-2">Beleg</th>
                  <th className="text-center font-medium px-4 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {acc.rows.map((r) => {
                  const receiptId = receiptByFilename.get(r.sourceFile);
                  return (
                    <tr key={r.date} className="border-t border-border/50">
                      <td className="px-4 py-1.5 text-foreground whitespace-nowrap">{monthLabel(r.date)}</td>
                      <td className="px-4 py-1.5 text-right font-mono tabular-nums whitespace-nowrap text-foreground">
                        {`${fmt(r.bankBalance)} ${acc.currency}`}
                      </td>
                      <td className="px-4 py-1.5 text-right font-mono tabular-nums whitespace-nowrap text-foreground">
                        {`${fmt(r.bookBalance)} ${acc.currency}`}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-1.5 text-right font-mono tabular-nums whitespace-nowrap',
                          r.matched ? 'text-muted-foreground' : 'text-destructive font-semibold',
                        )}
                      >
                        {`${fmt(r.difference)} ${acc.currency}`}
                      </td>
                      <td className="px-4 py-1.5 text-center">
                        {receiptId ? (
                          <a
                            href={`/api/receipts/${receiptId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-primary hover:underline"
                            title={r.sourceFile}
                          >
                            PDF
                          </a>
                        ) : (
                          <span className="text-xs text-dim" title={r.sourceFile}>—</span>
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-center">
                        <span className={r.matched ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
                          {r.matched ? '✓' : '✗'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        <p className="text-xs text-muted-foreground">
          Der Schlusssaldo jedes Monats stammt aus dem PDF-Kontoauszug der Bank (Spalte „Beleg"). „Unsere Buchhaltung"
          ist der Saldo des Bilanzkontos am Monatsende (Eröffnungssaldo + Buchungen), in Kontowährung. Eine Differenz
          von 0.00 belegt, dass Buchhaltung und Bankauszug übereinstimmen.
        </p>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="bg-muted border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Kontenabgleich</span>
      <span className="text-xs text-muted-foreground">Bankauszüge vs. Buchhaltung — Prüfnachweis</span>
    </div>
  );
}
