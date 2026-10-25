/**
 * The small download menu beside a ledger: CSV, Excel or PDF of the one account in one click,
 * everything else behind "Weitere Optionen …" (the export dialog).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import './export.css';
import type { Period } from '../../../accounting/periods.js';
import type { Format } from '../../../export/model.js';
import { t } from '../../i18n/index.js';
import { errorText, STATIC_EXPORT } from '../../lib/api.js';
import { periodName } from '../../lib/period-label.js';
import { useShellUi } from '../../shell/ui.js';
import { ICONS } from '../icons.js';
import { download } from './state.js';

interface Props {
  account: string;
  /** "6510 Telefon" or "Ohne Gegenkonto". */
  label: string;
  period: Period;
  toast(msg: string): void;
}

const FORMATS: Array<[Format, 'export.fmt.csv' | 'export.fmt.xlsx' | 'export.fmt.pdf', string]> = [
  ['csv', 'export.fmt.csv', 'export.downloadCsv'], ['xlsx', 'export.fmt.xlsx', '.xlsx'], ['pdf', 'export.fmt.pdf', 'export.downloadPdf'],
];

export function DownloadMenu({ account, label, period, toast }: Props) {
  const ui = useShellUi();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m || !anchor) return;
    // The anchor's rect is in zoomed pixels, the menu's position in page pixels.
    const z = Number(document.documentElement.style.zoom) || 1;
    m.style.left = `${Math.max(16, Math.min(anchor.right / z - m.offsetWidth, innerWidth / z - m.offsetWidth - 16))}px`;
    m.style.top = `${Math.max(16, Math.min(anchor.bottom / z + 6, innerHeight / z - m.offsetHeight - 16))}px`;
    m.querySelector<HTMLElement>('button')?.focus();
  }, [anchor]);

  if (STATIC_EXPORT) return null;
  const close = () => setAnchor(null);

  async function get(format: Format) {
    close();
    try {
      toast(t('export.saving', { name: await download({ period: period.token, items: { ledger: [format] }, sums: false, oneBook: false, account }) }));
    } catch (e) {
      toast(t('export.failed', { error: errorText(e) }));
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = [...ref.current!.querySelectorAll('button')];
    buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + d + buttons.length) % buttons.length].focus();
  }

  return (
    <div className="ldl">
      <button type="button" className="dl inline" data-dlpop aria-haspopup="menu" aria-expanded={!!anchor} data-tip={t('export.downloadTip')} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        {ICONS.download}<span>{t('export.download')}</span>
      </button>
      {anchor && (
        <>
          <div className="scrim" onClick={close} />
          <div className="menu dlpop" role="menu" ref={ref} onKeyDown={onKeyDown}>
            <div className="mh">{t('export.downloadHead', { account: label, period: periodName(period) })}</div>
            {FORMATS.map(([f, name, note]) => (
              <button key={f} type="button" role="menuitem" onClick={() => void get(f)}>
                <b>{t(name)}</b><span className="s">{note.startsWith('.') ? note : t(note as 'export.downloadCsv')}</span>
              </button>
            ))}
            <div className="sep2" />
            <button type="button" role="menuitem" onClick={() => { close(); ui.openExport({ period: period.token, items: { ledger: ['pdf', 'csv'] }, sums: false, oneBook: false, preset: null }); }}>
              {t('export.more')}<span className="s">⇧E</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
