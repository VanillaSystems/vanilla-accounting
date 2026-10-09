import { useMemo } from 'react';
import type { Index } from '../../types/index.js';
import { computeIncomeStatement } from '../../accounting/index.js';
import { getAccountMap } from '../lib/accounts.js';
import { cn } from '../lib/utils.js';
import { accountingName, t } from '../i18n/index.js';
import type { IncomeStatementSection } from '../../accounting/income-statement.js';
import type { Period } from '../../accounting/periods.js';

interface Props {
  index: Index;
  period: Period;
}


function fmt(n: number): string {
  return n.toFixed(2);
}

function SectionBlock({ section }: { section: IncomeStatementSection }) {
  if (section.rows.length === 0 && section.total === 0) return null;
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wide px-3 py-1">
        <span>{accountingName(section.title)}</span>
        <span className="normal-case">CHF</span>
      </div>
      {section.rows.map(row => (
        <div key={row.account} className="flex justify-between px-3 py-0.5 text-sm hover:bg-accent">
          <span className="text-foreground">
            <span className="text-muted-foreground mr-2">{row.account}</span>
            {row.name}
          </span>
          <span className="font-mono tabular-nums text-right min-w-[100px]">
            {fmt(row.amount)}
          </span>
        </div>
      ))}
      <div className="flex justify-between px-3 py-0.5 text-sm font-medium border-t border-border mt-0.5">
        <span>{t('income.sectionTotal', { section: accountingName(section.title) })}</span>
        <span className="font-mono tabular-nums text-right min-w-[100px]">
          {fmt(section.total)}
        </span>
      </div>
    </div>
  );
}

function ResultLine({ label, amount, highlight }: { label: string; amount: number; highlight?: boolean }) {
  return (
    <div
      className={cn(
        'flex justify-between px-3 py-1.5 text-sm font-bold rounded',
        highlight
          ? 'bg-primary/10 text-foreground border border-border'
          : 'bg-muted text-foreground',
      )}
    >
      <span>{label}</span>
      <span className={cn(
        'font-mono tabular-nums text-right min-w-[100px]',
        highlight && amount < 0 && 'text-destructive',
      )}>
        {fmt(amount)}
      </span>
    </div>
  );
}

export function IncomeStatementTab({ index, period }: Props) {
  const entries = index.journalEntries ?? [];
  const accountNames = getAccountMap();

  const statement = useMemo(() => {
    return computeIncomeStatement(entries, period.from, period.to, accountNames);
  }, [entries, period, accountNames]);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-2">
        <SectionBlock section={statement.revenue} />
        <SectionBlock section={statement.costOfGoods} />
        <ResultLine label={`= ${t('income.grossProfit')}`} amount={statement.grossProfit} />

        <div className="pt-2">
          <SectionBlock section={statement.operatingExpenses} />
        </div>
        <ResultLine label={`= ${t('income.operatingResult')}`} amount={statement.operatingResult} />

        <div className="pt-2">
          <SectionBlock section={statement.otherIncome} />
          <SectionBlock section={statement.otherExpenses} />
          <SectionBlock section={statement.extraordinaryItems} />
        </div>

        <div className="pt-2">
          <ResultLine label={`= ${t('income.netResult')}`} amount={statement.netResult} highlight />
        </div>
      </div>
    </div>
  );
}
