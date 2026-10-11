import { forwardRef } from 'react';
import { t } from '../i18n/index.js';
import { ZOOM_STEPS } from './prefs.js';
import { ICONS } from '../areas/icons.js';
import { Wave } from '../brand/Brand.js';

interface Props {
  company?: string;
  /** The period chip's text; absent on pages without a period. */
  period?: string;
  zoom: number;
  onSearch(): void;
  onPeriod(anchor: HTMLElement): void;
  onZoom(step: -1 | 0 | 1): void;
  onTheme(): void;
  onExport(): void;
  language: string;
  onLanguage(anchor: HTMLElement): void;
}

/** The context bar at the top edge: company, search, period, zoom, export, theme and language. */
export const TopBar = forwardRef<HTMLDivElement, Props>(function TopBar(p, ref) {
  return (
    <div className="topbar" ref={ref} role="toolbar" aria-label={t('shell.toolbar')}>
      <Wave size={17} label="Vanilla Accounting" />
      {p.company && <span className="chip" tabIndex={0}><b style={{ fontWeight: 600 }}>{p.company}</b></span>}
      <span className="sep" />
      <button type="button" className="chip" onClick={p.onSearch}>⌕ {t('shell.search')} <span className="k">⌘K</span></button>
      {p.period && <button type="button" className="chip mono" title={t('period.choose')} onClick={(e) => p.onPeriod(e.currentTarget)}>{p.period} ▾</button>}
      <span className="sep" />
      <span className="zoom" role="group" aria-label={t('shell.zoom')}>
        <button type="button" className="chip" title={t('shell.zoomOut')} aria-label={t('shell.zoomOut')} disabled={p.zoom <= ZOOM_STEPS[0]} onClick={() => p.onZoom(-1)}>−</button>
        <button type="button" className="chip mono zval" title={t('shell.zoomReset')} aria-label={t('shell.zoomReset')} onClick={() => p.onZoom(0)}>{Math.round(p.zoom * 100)} %</button>
        <button type="button" className="chip" title={t('shell.zoomIn')} aria-label={t('shell.zoomIn')} disabled={p.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => p.onZoom(1)}>+</button>
      </span>
      <span className="sep" />
      <button type="button" className="chip" title={t('export.chipTip')} aria-label={t('export.dialog')} onClick={p.onExport}>{ICONS.download}</button>
      <button type="button" className="chip" title={t('shell.theme')} aria-label={t('shell.theme')} onClick={p.onTheme}>◐</button>
      <button type="button" className="chip" aria-label={t('app.language')} aria-haspopup="menu" onClick={(e) => p.onLanguage(e.currentTarget)}>{p.language.toUpperCase()}</button>
    </div>
  );
});
