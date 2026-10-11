/**
 * The old year-close tab inside the new shell until phase 7 builds Abschluss. Deleted then with
 * legacy-tabs.tsx.
 */
import { ListHead } from '../shell/ListHead.js';
import type { RouteOf } from '../shell/route.js';
import type { Area, AreaProps } from './index.js';
import { LegacyTabs } from './legacy-tabs.js';

function LegacyPage({ route, period, books, nav, canEdit }: AreaProps) {
  return (
    <div className="page">
      <ListHead route={route} period={period} books={books} canEdit={canEdit} />
      <LegacyTabs period={period} refresh={nav.refresh} canEdit={canEdit} />
    </div>
  );
}

export function legacyArea(id: 'close', rest: Omit<Area<RouteOf<'close'>>, 'id' | 'List'>): Area<RouteOf<'close'>> {
  return { id, List: LegacyPage, ...rest };
}
