/** The frame every dialog of Verkauf shares (dialogs.tsx, bulk.tsx): its scrim, heading and foot; Esc or a click outside closes it. */
import type { ReactNode } from 'react';
import { setUi } from './state.js';

export const close = () => setUi({ dialog: null });

export function Frame({ label, title, children, foot, className = '' }: { label: string; title: ReactNode; children: ReactNode; foot?: ReactNode; className?: string }) {
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 45%, transparent)' }} onClick={close} />
      <div className={`palette idlg ${className}`} role="dialog" aria-label={label} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
        <div className="ihd"><span className="lbl">{label}</span><b>{title}</b></div>
        {children}
        {foot && <div className="ift">{foot}</div>}
      </div>
    </>
  );
}
