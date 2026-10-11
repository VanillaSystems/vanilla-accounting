import type { Period } from '../../accounting/periods.js';
import { YearCloseTab } from '../components/year-close-tab.js';

/**
 * The old year-close tab inside the new shell: the shell owns the period, the language, the theme
 * and the URL. Deleted in phase 7 with the components it renders.
 */
export function LegacyTabs({ period, refresh, canEdit }: { period: Period; refresh: () => void; canEdit: boolean }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-muted overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <YearCloseTab period={period} canEdit={canEdit} onRefresh={refresh} />
      </div>
    </div>
  );
}
