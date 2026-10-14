/**
 * Automatisierung (docs/0.4.0/ui/design.md): every workflow with its triggers, graph and runs, the
 * process map, the queue and the tasks. Its data comes from GET /api/automation (src/app/automation/).
 */
import type { RouteOf } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps } from '../index.js';

type Props = AreaProps<RouteOf<'automation'>>;

function List(_: Props) {
  return (
    <>
      <h1>{t('area.automation')}</h1>
      <p className="empty">{t('automation.empty')}</p>
    </>
  );
}

export const automation: Area<RouteOf<'automation'>> = {
  id: 'automation',
  label: () => t('area.automation'),
  dock: { key: 'w', icon: ICONS.automation, tip: () => t('area.automation.tip') },
  List,
  periodless: true,
  title: (r) => (r.view === 'workflow' ? r.workflow : r.view === 'run' ? r.run : undefined),
};
