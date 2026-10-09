import { useMemo } from 'react';
import type { Index } from '../../types/index.js';
import { computeIncomeStatement } from '../../accounting/index.js';
import { getAccountMap } from '../lib/accounts.js';
import { cn } from '../lib/utils.js';
import { accountingName, t } from '../i18n/index.js';
import type { IncomeStatementSection } from '../../accounting/income-statement.js';
import type { Period } from '../../accounting/periods.js';
import { useUrlParam } from '../hooks/use-url-state.js';
import { SplitPane } from './split-pane.js';
import { AccountPanel, accountRowProps } from './account-panel.js';

interface Props {
  index: Index;
  period: Period;
}


function fmt(n: number): string {
  return n.toFixed(2);
}

interface Selection { selected: string | null; onSelect: (account: string | null) => void }

function SectionBlock({ section, selected, onSelect }: { section: IncomeStatementSection } & Selection) {
  if (section.rows.length === 0 && section.total === 0) return null;
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wide px-3 py-1">
        <span>{accountingName(section.title)}</span>
        <span className="normal-case">CHF</span>
      </div>
      {section.rows.map(row => (
        <div key={row.account} {...accountRowProps(row.account, selected, onSelect, 'flex justify-between px-3 py-0.5 text-sm')}>
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

  const [account, setAccount] = useUrlParam('account');
  const sel: Selection = { selected: account, onSelect: setAccount };

  return (
    <SplitPane
      storageKey="statement-account"
      defaultLeft={55}
      className="flex-1"
      leftClassName="overflow-auto"
      right={account && (
        <AccountPanel index={index} account={account} from={period.from} to={period.to} period={period} onClose={() => setAccount(null)} movementsOnly />
      )}
      left={
    <div className="p-6">
      <div className="max-w-2xl mx-auto space-y-2">
        <p className="text-xs text-dim px-3">{t('accountPanel.hint')}</p>
        <SectionBlock {...sel} section={statement.revenue} />
        <SectionBlock {...sel} section={statement.costOfGoods} />
        <ResultLine label={`= ${t('income.grossProfit')}`} amount={statement.grossProfit} />

        <div className="pt-2">
          <SectionBlock {...sel} section={statement.operatingExpenses} />
        </div>
        <ResultLine label={`= ${t('income.operatingResult')}`} amount={statement.operatingResult} />

        <div className="pt-2">
          <SectionBlock {...sel} section={statement.otherIncome} />
          <SectionBlock {...sel} section={statement.otherExpenses} />
          <SectionBlock {...sel} section={statement.extraordinaryItems} />
        </div>

        <div className="pt-2">
          <ResultLine label={`= ${t('income.netResult')}`} amount={statement.netResult} highlight />
        </div>
      </div>
    </div>
      }
    />
  );
}
