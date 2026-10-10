import type { RouteOf } from '../shell/route.js';
import { ListHead } from '../shell/ListHead.js';
import { t } from '../i18n/index.js';
import { ICONS } from './icons.js';
import { Soon } from './company/company.js';
import type { Area, AreaProps } from './index.js';

/** Rechnungen: built in phases 8 and 9; until then its page says so. */
function List(props: AreaProps<RouteOf<'invoices'>>) {
  return (
    <div className="page">
      <ListHead {...props} />
      <div className="lbody"><Soon /></div>
    </div>
  );
}

export const invoices: Area<RouteOf<'invoices'>> = {
  id: 'invoices',
  label: () => t('area.invoices'),
  dock: { key: 'i', icon: ICONS.invoices, tip: () => t('area.invoices.tip') },
  List,
  title: (r) => r.id,
};
