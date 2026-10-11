/**
 * Abschluss: the year-end in seven steps on the left (before, the close, after), the selected
 * step on the right. Every state comes from the close the API computes (src/books/year-close.ts).
 */
import { Fragment } from 'react';
import './close.css';
import type { RouteOf } from '../../shell/route.js';
import { moveKey } from '../../shell/keyboard.js';
import { useShellUi } from '../../shell/ui.js';
import { localToday } from '../../../accounting/periods.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import { I } from '../receipts/icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { closeYear, useYearClose } from './data.js';
import { GROUPS, STEPS, stepLabel, stepOf, stepState } from './steps.js';
import { Detail } from './Detail.js';

type Props = AreaProps<RouteOf<'close'>>;

function List({ route, query, books, nav }: Props) {
  const ui = useShellUi();
  const year = closeYear(query.period, books);
  const { data } = useYearClose(year, books);
  const step = stepOf(route.step);
  const today = localToday();
  const yearOver = today > `${year}-12-31`;
  return (
    <>
      <h1>
        {t('area.close')}
        <button type="button" className="ytag mono" title={t('close.chooseYear')} data-testid="period-picker" onClick={(e) => ui.openPeriod(e.currentTarget)}>{year}</button>
      </h1>
      <div className="counts"><span>{yearOver ? t('close.yearOver') : t('close.yearRuns', { year })}</span></div>
      <div className="rows" role="listbox" aria-label={t('close.steps')}>
        {GROUPS.map(([group, steps]) => (
          <Fragment key={group}>
            <div className="group"><span>{t(group)}</span></div>
            {steps.map((s) => {
              const [st, text] = stepState(s, data, today);
              const sel = s === step;
              return (
                <div
                  key={s}
                  className={`row ystep st-${st}${sel ? ' sel' : ''}`}
                  role="option"
                  aria-selected={sel}
                  tabIndex={sel ? 0 : -1}
                  data-step={s}
                  onClick={() => nav.select({ area: 'close', step: s })}
                >
                  <span className="d mono">{STEPS.indexOf(s) + 1}</span>
                  <span className="t">{stepLabel(s, year)}</span>
                  <span className="a"><span className="pill">{st === 'ok' ? I.check : st === 'warn' ? I.dot : null}{text}</span></span>
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('close.keyStep'), t('close.keyStepTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const close: Area<RouteOf<'close'>> = {
  id: 'close',
  label: () => t('area.close'),
  dock: { key: 'a', icon: ICONS.close, tip: () => t('area.close.tip') },
  List,
  Detail,
  legend,
  periodless: true,
  title: (r, books) => stepLabel(stepOf(r.step), closeYear(undefined, books)),
  keys(e, { route, nav }) {
    if (e.key === 'Enter') {
      document.querySelector<HTMLElement>('.detail button:not(:disabled), .detail input')?.focus();
      return true;
    }
    const d = moveKey(e);
    if (!d) return false;
    const i = STEPS.indexOf(stepOf(route.step));
    nav.select({ area: 'close', step: STEPS[Math.min(STEPS.length - 1, Math.max(0, i + d))] });
    return true;
  },
  palette: ({ nav, query, books }) => STEPS.map((s) => ({
    label: stepLabel(s, closeYear(query.period, books)),
    run: () => nav.go({ route: { area: 'close', step: s }, query: query.period ? { period: query.period } : {} }),
  })),
};
