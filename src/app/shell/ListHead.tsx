import type { ReactNode } from 'react';
import { ICONS } from '../areas/icons.js';
import type { AreaProps } from '../areas/index.js';
import { periodName } from '../lib/period-label.js';
import { t } from '../i18n/index.js';
import { useShellUi } from './ui.js';

/** A list's heading: the area's name, its period (a lock when filed), and its add button. */
export function ListHead({ period, books, canEdit, children, title, noPeriod }: Omit<AreaProps, 'query' | 'nav' | 'route'> & { children?: ReactNode; title?: string; noPeriod?: boolean }) {
  const ui = useShellUi();
  const { area } = ui;
  const closed = books.config?.closedThrough;
  const filed = !!closed && period.kind !== 'all' && period.to <= closed;
  return (
    <header className="lhead">
      <h1>
        {title ?? area.label()}
        {!area.periodless && !noPeriod && (
          <button type="button" className="period" aria-haspopup="dialog" title={t('period.choose')} data-testid="period-picker" onClick={(e) => ui.openPeriod(e.currentTarget)}>
            {periodName(period)}{filed && ICONS.lock}{ICONS.down}
          </button>
        )}
        {area.add && canEdit && (
          <button type="button" className="addbtn" data-add title={t('shell.addKey', { title: area.add.title(ui.route) })} onClick={ui.add}>
            {ICONS.plus}<span>{area.add.label(ui.route)}</span><span className="kb">N</span>
          </button>
        )}
      </h1>
      {children}
    </header>
  );
}
