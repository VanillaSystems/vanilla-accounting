/**
 * Firma: the company's settings, one section per row. Darstellung (theme, language, zoom) works
 * now; the other sections come in phase 7 and say so.
 */
import { Fragment } from 'react';
import './company.css';
import { COMPANY_SECTIONS, type CompanySection, type RouteOf } from '../../shell/route.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { LOCALES, t } from '../../i18n/index.js';
import { formatDate } from '../../lib/utils.js';
import { useShellUi } from '../../shell/ui.js';
import { moveKey } from '../../shell/keyboard.js';
import type { Theme } from '../../shell/prefs.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps } from '../index.js';

type Props = AreaProps<RouteOf<'company'>>;

const GROUPS: Array<['company.groupMaster' | 'company.groupBooks' | 'company.groupApp', CompanySection[]]> = [
  ['company.groupMaster', ['profile', 'vat', 'banks', 'invoice-layout']],
  ['company.groupBooks', ['accounts', 'periods', 'opening']],
  ['company.groupApp', ['display']],
];

const THEMES: Theme[] = ['light', 'dark', 'system'];
const themeLabel = (th: Theme) => t(th === 'light' ? 'app.themeLight' : th === 'dark' ? 'app.themeDark' : 'app.themeSystem');

function List({ route, books, nav }: Props) {
  const ws = useWorkspace();
  const ui = useShellUi();
  const side: Partial<Record<CompanySection, string>> = {
    profile: ws?.company.uid,
    banks: ws ? String(ws.bankAccounts.length) : undefined,
    periods: books.config?.closedThrough && formatDate(books.config.closedThrough),
    display: themeLabel(ui.theme),
  };
  return (
    <>
      <h1>{ws?.company.name ?? t('area.company')}</h1>
      <div className="counts"><span>{ws?.company.owner}</span></div>
      <div className="rows" role="listbox" aria-label={t('company.list')}>
        {GROUPS.map(([group, sections]) => (
          <Fragment key={group}>
            <div className="group"><span>{t(group)}</span></div>
            {sections.map((s) => {
              const sel = s === route.section;
              return (
                <div
                  key={s}
                  className={`row fset${sel ? ' sel' : ''}`}
                  role="option"
                  aria-selected={sel}
                  tabIndex={sel ? 0 : -1}
                  onClick={() => nav.select({ area: 'company', section: s })}
                >
                  <span className="t">{t(`company.${s}`)}</span>
                  <span className="a mono">{side[s] ?? ''}</span>
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </>
  );
}

function Detail({ route }: Props) {
  const ws = useWorkspace();
  return (
    <div className="detail-in" key={route.section}>
      <div className="head"><h2 className="who">{t(`company.${route.section}`)}<small>{ws?.company.name}</small></h2></div>
      <div className="docbody">{route.section === 'display' ? <Display /> : <Soon />}</div>
    </div>
  );
}

function Display() {
  const ui = useShellUi();
  return (
    <>
      <dl className="kv2 wide">
        <dt>{t('display.color')}</dt>
        <dd>
          <span className="seg2" role="radiogroup" aria-label={t('company.display')}>
            {THEMES.map((th) => (
              <button key={th} type="button" role="radio" aria-checked={ui.theme === th} className={ui.theme === th ? 'on' : ''} onClick={() => ui.setTheme(th)}>{themeLabel(th)}</button>
            ))}
          </span>{' '}
          <span className="m">{ui.theme === 'system' ? t('display.followsOs', { mode: t(ui.dark ? 'display.modeDark' : 'display.modeLight') }) : t('display.toggleHint')}</span>
        </dd>
        <dt>{t('app.language')}</dt>
        <dd>{LOCALES.find((l) => l.code === ui.language)?.name} <span className="m">{t('display.languageHint')}</span></dd>
        <dt>{t('shell.zoom')}</dt>
        <dd><span className="mono">{Math.round(ui.zoom * 100)} %</span> <span className="m">{t('display.zoomHint')}</span></dd>
      </dl>
      <p className="m src-note">{t('display.local')}</p>
    </>
  );
}

export function Soon() {
  return (
    <div className="empty">
      <h2>{t('area.soon')}</h2>
      <p>{t('area.soonHint')}</p>
    </div>
  );
}

export const company: Area<RouteOf<'company'>> = {
  id: 'company',
  label: () => t('area.company'),
  dock: { key: 'f', icon: ICONS.company, tip: () => t('area.company.tip') },
  List,
  Detail,
  periodless: true,
  title: (r) => t(`company.${r.section}`),
  keys(e, { route, nav }) {
    if (e.key === 'Enter') {
      document.querySelector<HTMLElement>('.detail button, .detail a, .detail input')?.focus();
      return true;
    }
    const d = moveKey(e);
    if (!d) return false;
    const i = COMPANY_SECTIONS.indexOf(route.section);
    nav.select({ area: 'company', section: COMPANY_SECTIONS[Math.min(COMPANY_SECTIONS.length - 1, Math.max(0, i + d))] });
    return true;
  },
};
