/**
 * What both bars share (docs/0.4.0/views.md, "Both bars"): open or folded to a pill, the pin at
 * the right end with the tooltip that explains both states, and the one-time tip after the bar
 * folds for the first time. The state lives in bars.ts; the open state while hovered or focused
 * is this component's.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { dispatchBar, staysOpen, useBar, type BarId } from './bars.js';

const PIN = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5" /><path d="M9 10.8V5h6v5.8l2.5 2.7a1 1 0 0 1-.7 1.7H7.2a1 1 0 0 1-.7-1.7z" /><path d="M8 5h8" /></svg>;

export function Fold({ id, className, label, pill, hold, children }: {
  id: BarId;
  className: string;
  label: string;
  /** What the folded bar shows: the company and period, or the current area. */
  pill: ReactNode;
  /** Kept open regardless: a menu of the bar is open, G is held for the dock. */
  hold?: boolean;
  children: ReactNode;
}) {
  const state = useBar(id);
  const [near, setNear] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(leave.current), []);
  const enter = () => { clearTimeout(leave.current); setNear(true); };
  const away = () => { clearTimeout(leave.current); leave.current = setTimeout(() => setNear(false), 450); };
  const open = staysOpen(state) || near || !!hold;
  const pinned = state.mode === 'always';
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
            <input type="checkbox" checked={pinned} onChange={(e) => dispatchBar(id, { kind: 'pin', on: e.target.checked })} aria-describedby={`${id}-pintip`} />
            {PIN}
            <span className="ptip" id={`${id}-pintip`} role="tooltip">
              <b>{t(pinned ? 'bars.pinned' : 'bars.notPinned')}</b>
              <span className={pinned ? 'cur' : ''}>{t(id === 'top' ? 'bars.onTop' : 'bars.onDock')}</span>
              <span className={pinned ? '' : 'cur'}>{t(id === 'top' ? 'bars.offTop' : 'bars.offDock')}</span>
            </span>
          </label>
        </>
      ) : (
        <button type="button" className="barpill" onClick={enter}>{pill}</button>
      )}
      {state.tip ? (
        <div className="bartip" role="status">
          <p>{t(id === 'top' ? 'bars.tipTop' : 'bars.tipDock')}</p>
          <span>
            <button type="button" className="btn ghost" onClick={() => dispatchBar(id, { kind: 'tip-always' })}>{t('bars.always')}</button>
            <button type="button" className="btn" onClick={() => dispatchBar(id, { kind: 'tip-ok' })}>{t('bars.ok')}</button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
