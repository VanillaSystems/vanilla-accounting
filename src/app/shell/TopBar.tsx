import { t } from '../i18n/index.js';
import { ZOOM_STEPS } from './prefs.js';
import { ICONS } from '../areas/icons.js';
import { dispatchBar } from './bars.js';
import { Fold } from './Fold.js';
import { formatDate } from '../lib/utils.js';
import { shortSum } from '../handover/store.js';
import '../handover/handover.css';

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
  /** «Teilen…»: absent where the books are not shared from (a Durchsicht copy, the read-only modes). */
  onShare?(): void;
  /** The books' content version (src/handover/versions.ts): «Version 12» beside the company, its day and checksum on hover. */
  version?: { n: number; at: string; checksum: string };
  language: string;
  onLanguage(anchor: HTMLElement): void;
}

/** The context bar at the top: company, search, period, zoom, export, theme and language; folded, a pill with company and period. */
export function TopBar(p: Props & { hold?: boolean }) {
  const used = (f: () => void) => () => { dispatchBar('top', { kind: 'used' }); f(); };
  return (
    <Fold id="top" className="topbar" label={t('shell.toolbar')} hold={p.hold}
      pill={<>{p.company ? <b>{p.company}</b> : null}{p.period ? <span className="mono">{p.period}</span> : null}<span aria-hidden="true">▾</span></>}>
      {p.company && (
        <span className="chip" tabIndex={0} data-tip={p.version ? t('version.tip', { date: formatDate(p.version.at.slice(0, 10)), sum: shortSum(p.version.checksum) }) : undefined} data-testid="topbar-company">
          <b style={{ fontWeight: 600 }}>{p.company}</b>{p.version ? <span className="vers">{t('version.short', { n: p.version.n })}</span> : null}
        </span>
      )}
      <span className="sep" />
      <button type="button" className="chip" onClick={used(p.onSearch)}>⌕ {t('shell.search')} <span className="k">⌘K</span></button>
      {p.period && <button type="button" className="chip mono" data-tip={t('period.choose')} onClick={(e) => { dispatchBar('top', { kind: 'used' }); p.onPeriod(e.currentTarget); }}>{p.period} ▾</button>}
      <span className="sep" />
      <span className="zoom" role="group" aria-label={t('shell.zoom')}>
        <button type="button" className="chip" aria-label={t('shell.zoomOut')} disabled={p.zoom <= ZOOM_STEPS[0]} onClick={() => p.onZoom(-1)}>−</button>
        <button type="button" className="chip mono zval" data-tip={t('shell.zoomReset')} aria-label={t('shell.zoomReset')} onClick={() => p.onZoom(0)}>{Math.round(p.zoom * 100)} %</button>
        <button type="button" className="chip" aria-label={t('shell.zoomIn')} disabled={p.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => p.onZoom(1)}>+</button>
      </span>
      <span className="sep" />
      {p.onShare ? <button type="button" className="chip shchip" data-tip={t('share.chipTip')} aria-label={t('share.title')} onClick={used(p.onShare)} data-testid="share-chip">{ICONS.share}<span>{t('share.chip')}</span></button> : null}
      <button type="button" className="chip" data-tip={t('export.chipTip')} aria-label={t('export.dialog')} onClick={used(p.onExport)}>{ICONS.download}</button>
      <button type="button" className="chip" aria-label={t('shell.theme')} onClick={p.onTheme}>◐</button>
      <button type="button" className="chip" aria-label={t('app.language')} aria-haspopup="menu" onClick={(e) => p.onLanguage(e.currentTarget)}>{p.language.toUpperCase()}</button>
    </Fold>
  );
}
