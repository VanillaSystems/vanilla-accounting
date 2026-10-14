/**
 * Änderungen (docs/0.4.0/ui/design.md): what changed in rules, workflows and settings since the last
 * save, the saves the AI prepares, and Verlauf. The books are committed by the app, never here.
 */
import type { RouteOf } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps } from '../index.js';

type Props = AreaProps<RouteOf<'changes'>>;

function List(_: Props) {
  return (
    <>
      <h1>{t('area.changes')}</h1>
      <p className="empty">{t('changes.empty')}</p>
    </>
  );
}

export const changes: Area<RouteOf<'changes'>> = {
  id: 'changes',
  label: () => t('area.changes'),
  dock: { key: 'v', icon: ICONS.changes, tip: () => t('area.changes.tip') },
  List,
  periodless: true,
  title: (r) => r.commit,
};
