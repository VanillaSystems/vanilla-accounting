import { ExternalLink, X } from 'lucide-react';
import type { Index, BankStatement } from '../../../src/types/index.js';
import { cn } from '../lib/utils.js';
import { PdfFrame } from './pdf-frame.js';
import { useUrlParam } from '../hooks/use-url-state.js';
import { useAutoSelectFirst } from '../hooks/use-auto-select-first.js';
import { SplitPane } from './split-pane.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { monthLocale, t } from '../i18n/index.js';
import { sources } from '../lib/api.js';

interface BankStatementsTabProps {
  index: Index;
}

type ColumnStyle = { header: string; chip: string; chipActive: string };

const PALETTE: ColumnStyle[] = [
  {
    header: 'text-red-700',
    chip: 'bg-red-50 border border-red-200 text-red-800 hover:bg-red-100',
    chipActive: 'bg-red-200 border border-red-400 text-red-900 ring-2 ring-red-400',
  },
  {
    header: 'text-blue-700',
    chip: 'bg-blue-50 border border-blue-200 text-blue-800 hover:bg-blue-100',
    chipActive: 'bg-blue-200 border border-blue-400 text-blue-900 ring-2 ring-blue-400',
  },
  {
    header: 'text-violet-700',
    chip: 'bg-violet-50 border border-violet-200 text-violet-800 hover:bg-violet-100',
    chipActive: 'bg-violet-200 border border-violet-400 text-violet-900 ring-2 ring-violet-400',
  },
  {
    header: 'text-green-700',
    chip: 'bg-green-50 border border-green-200 text-green-800 hover:bg-green-100',
    chipActive: 'bg-green-200 border border-green-400 text-green-900 ring-2 ring-green-400',
  },
];

type StatementAccount = { bank: string; currency: string };

/** A statement's column: its bank account in the manifest. A statement with no currency (bank PDFs that name none) belongs to its bank's first account. */
function columnOf(s: BankStatement, accounts: readonly StatementAccount[]): string {
  const acc = accounts.find((a) => a.bank === s.bank && (!s.currency || a.currency === s.currency));
  if (acc) return `${acc.bank} ${acc.currency}`;
  return s.currency ? `${s.bank} ${s.currency}` : s.bank;
}

/** The manifest's bank accounts in their order, then the account of any statement the manifest lacks. */
function columnsFor(statements: readonly BankStatement[], accounts: readonly StatementAccount[]): string[] {
  return [...new Set([...accounts.map((a) => `${a.bank} ${a.currency}`), ...statements.map((s) => columnOf(s, accounts))])];
}

/** A statement's id in the URL (?statement=): file names are unique per bank. */
const statementKey = (s: BankStatement) => `${s.bank}/${s.filename}`;

function monthLabel(fromDate: string) {
  const [year, month] = fromDate.split('-');
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString(monthLocale(), { month: 'long', year: 'numeric' });
}

export function BankStatementsTab({ index }: BankStatementsTabProps) {
  // The owner's `manual` accounts have no bank statements.
  const accounts = (useWorkspace()?.bankAccounts ?? []).filter((a) => a.bank !== 'manual');
  // Build month → account → statement lookup
  const months = Array.from(
    new Set(index.bankStatements.map((s) => s.fromDate.slice(0, 7)))
  ).sort();

  const columns = columnsFor(index.bankStatements, accounts);
  const styleOf = (column: string) => PALETTE[columns.indexOf(column) % PALETTE.length];
  const grid = new Map<string, Map<string, BankStatement>>();
  for (const s of index.bankStatements) {
    const month = s.fromDate.slice(0, 7);
    if (!grid.has(month)) grid.set(month, new Map());
    grid.get(month)!.set(columnOf(s, accounts), s);
  }

  // The statements in reading order: month by month, each month's columns left to right.
  const ordered = months.flatMap((month) => columns.flatMap((acc) => grid.get(month)!.get(acc) ?? []));
  const [previewKey, setPreviewKey] = useUrlParam('statement');
  const preview = ordered.find((s) => statementKey(s) === previewKey) ?? null;
  const setPreview = (s: BankStatement | null) => setPreviewKey(s && statementKey(s));
  useAutoSelectFirst(ordered.map(statementKey), previewKey, setPreviewKey);

  if (index.bankStatements.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground w-full">
        {t('statements.none', { command: 'npm run extract' })}
      </div>
    );
  }

  return (
    <SplitPane
      storageKey="bank-statements"
      defaultLeft={45}
      leftClassName="overflow-auto"
      left={
        <div className="p-6">
          <table className="border-collapse w-full text-sm">
            <thead>
              <tr>
                <th className="text-left pb-3 pr-6 font-medium text-muted-foreground text-xs uppercase tracking-wide w-36">
                  {t('col.month')}
                </th>
                {columns.map((acc) => (
                  <th key={acc} className={cn('pb-3 px-3 font-semibold text-sm text-left', styleOf(acc).header)}>
                    {acc}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map((month) => {
                const row = grid.get(month)!;
                return (
                  <tr key={month} className="border-t border-border">
                    <td className="py-3 pr-6 text-sm font-medium text-foreground whitespace-nowrap">
                      {monthLabel(month + '-01')}
                    </td>
                    {columns.map((acc) => {
                      const s = row.get(acc);
                      const isActive = preview?.filename === s?.filename;
                      const style = styleOf(acc);
                      return (
                        <td key={acc} className="py-3 px-3">
                          {s ? (
                            <button
                              onClick={() => setPreview(isActive ? null : s)}
                              className={cn(
                                'rounded-md px-3 py-1.5 text-xs font-medium transition-all cursor-pointer',
                                isActive ? style.chipActive : style.chip,
                              )}
                            >
                              PDF
                            </button>
                          ) : (
                            <span className="text-dim text-xs">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      }
      right={preview && (
        <>
          <div className="flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn('text-xs font-semibold px-2 py-0.5 rounded', styleOf(columnOf(preview, accounts)).chip)}>
                {columnOf(preview, accounts)}
              </span>
              <span className="text-sm font-medium text-foreground truncate" title={preview.filename}>
                {monthLabel(preview.fromDate)}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={sources.statement(preview.bank, preview.filename)}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                title={t('common.openInNewTab')}
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              <button
                onClick={() => setPreview(null)}
                title={t('common.close')}
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <PdfFrame
            src={sources.statement(preview.bank, preview.filename)}
            title={preview.filename}
          />
        </>
      )}
    />
  );
}
