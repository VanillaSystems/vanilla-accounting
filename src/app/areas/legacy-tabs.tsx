import type { Index } from '../../types/index.js';
import type { Period } from '../../accounting/periods.js';
import { FxProvider } from '../hooks/use-fx.js';
import { JournalEntriesTab } from '../components/journal-entries-tab.js';
import { VatCodesView } from '../components/vat-codes-view.js';
import { useUrlParam } from '../hooks/use-url-state.js';
import { YearCloseTab } from '../components/year-close-tab.js';

export type LegacyTab = 'journal-entries' | 'vat-codes' | 'year-close';

/**
 * The old tabs, one at a time, inside the new shell: the shell owns the period, the language,
 * the theme and the URL. Deleted in phase 10 with the components it renders.
 */
export function LegacyTabs({ tab, period, index, refresh, canEdit }: {
  tab: LegacyTab;
  period: Period;
  index: Index;
  refresh: () => void;
  canEdit: boolean;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-muted overflow-hidden">
        <FxProvider index={index}>

          {/* Journal Entries tab */}
          {tab === 'journal-entries' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <JournalEntriesTab index={index} period={period} onRefresh={refresh} canEdit={canEdit} />
          </div>)}

          {tab === 'vat-codes' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <CodesTab index={index} period={period} />
          </div>)}

          {tab === 'year-close' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <YearCloseTab period={period} canEdit={canEdit} onRefresh={refresh} />
          </div>)}
        </FxProvider>

    </div>
  );
}

/** The code catalogue until phase 4 builds its area: ?view=codes&code= as the old MWST tab kept them. */
function CodesTab({ index, period }: { index: Index; period: Period }) {
  const [code, setCode] = useUrlParam('code');
  const [, setView] = useUrlParam('view');
  return <VatCodesView index={index} period={period} code={code} onCode={setCode} onBack={() => { setView(null); setCode(null); }} />;
}
