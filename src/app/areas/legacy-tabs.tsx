import type { Index } from '../../types/index.js';
import type { Period } from '../../accounting/periods.js';
import { FxProvider } from '../hooks/use-fx.js';
import { JournalEntriesTab } from '../components/journal-entries-tab.js';
import { TrialBalanceTab } from '../components/trial-balance-tab.js';
import { BalanceSheetTab } from '../components/balance-sheet-tab.js';
import { IncomeStatementTab } from '../components/income-statement-tab.js';
import { VatReportTab } from '../components/vat-report-tab.js';
import { AccountLedgerTab } from '../components/account-ledger-tab.js';
import { YearCloseTab } from '../components/year-close-tab.js';

export type LegacyTab = 'journal-entries' | 'trial-balance' | 'balance-sheet'
  | 'income-statement' | 'vat-report' | 'account-ledger' | 'year-close';

/**
 * The old tabs, one at a time, inside the new shell: the shell owns the period, the language,
 * the theme and the URL. Deleted in phase 10 with the components it renders.
 */
export function LegacyTabs({ tab, period, index, refresh, canEdit, onPeriod }: {
  tab: LegacyTab;
  period: Period;
  index: Index;
  refresh: () => void;
  canEdit: boolean;
  onPeriod: (token: string) => void;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-muted overflow-hidden">
        <FxProvider index={index}>

          {/* Journal Entries tab */}
          {tab === 'journal-entries' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <JournalEntriesTab index={index} period={period} onRefresh={refresh} canEdit={canEdit} />
          </div>)}

          {/* Saldobilanz tab */}
          {tab === 'trial-balance' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <TrialBalanceTab index={index} period={period} />
          </div>)}

          {/* Bilanz tab */}
          {tab === 'balance-sheet' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <BalanceSheetTab index={index} period={period} />
          </div>)}

          {/* Erfolgsrechnung tab */}
          {tab === 'income-statement' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <IncomeStatementTab index={index} period={period} />
          </div>)}

          {/* MWST-Abrechnung tab */}
          {tab === 'vat-report' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <VatReportTab index={index} period={period} onPeriod={onPeriod} />
          </div>)}

          {/* Kontoauszug tab */}
          {tab === 'account-ledger' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <AccountLedgerTab index={index} period={period} />
          </div>)}

          {tab === 'year-close' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <YearCloseTab period={period} canEdit={canEdit} onRefresh={refresh} />
          </div>)}
        </FxProvider>

    </div>
  );
}
