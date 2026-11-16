/**
 * The top bar open or folded to a pill, with the pin at the right end and the tooltip that explains
 * both states (docs/0.4.0/views.md, "The top bar"). The pin lives in bars.ts; the open state while
 * hovered or focused is this component's.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { setPinned, useBarMode } from './bars.js';

const PIN = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5" /><path d="M9 10.8V5h6v5.8l2.5 2.7a1 1 0 0 1-.7 1.7H7.2a1 1 0 0 1-.7-1.7z" /><path d="M8 5h8" /></svg>;

export function Fold({ className, label, pill, hold, children }: {
  className: string;
  label: string;
  /** What the folded bar shows: the company and period. */
  pill: ReactNode;
  /** Kept open regardless: a menu of the bar is open. */
  hold?: boolean;
  children: ReactNode;
}) {
  const pinned = useBarMode() === 'always';
  const [near, setNear] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(leave.current), []);
  const enter = () => { clearTimeout(leave.current); setNear(true); };
  const away = () => { clearTimeout(leave.current); leave.current = setTimeout(() => setNear(false), 450); };
  const open = pinned || near || !!hold;
  return (
    <div
      className={`${className} ${open ? 'open' : 'folded'}`}
      role="toolbar"
      aria-label={label}
      onMouseEnter={enter}
      onMouseLeave={away}
      onFocus={enter}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) away(); }}
    >
      {open ? (
        <>
          {children}
          <span className="sep" />
          <label className={`pin${pinned ? ' on' : ''}`}>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} aria-describedby="top-pintip" data-testid="topbar-pin" />
            {PIN}
            <span className="ptip" id="top-pintip" role="tooltip">
              <b>{t(pinned ? 'bars.pinned' : 'bars.notPinned')}</b>
              <span className={pinned ? 'cur' : ''}>{t('bars.onTop')}</span>
              <span className={pinned ? '' : 'cur'}>{t('bars.offTop')}</span>
            </span>
          </label>
        </>
      ) : (
        <button type="button" className="barpill" onClick={enter}>{pill}</button>
      )}
    </div>
  );
}
