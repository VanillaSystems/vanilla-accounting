import { LOCKUP_SVG } from './lockup.js';

const WAVE = 'M5.275,0.35C5.275,0.35 1.437,0.35 1.437,0.35C0.888,0.35 0.437,0.801 0.437,1.35C0.437,1.468 0.458,1.586 0.499,1.697L9.608,26.302C10.564,28.886 13.042,30.611 15.797,30.611C18.553,30.611 21.031,28.886 21.987,26.302L29.41,6.253C29.555,5.862 29.93,5.601 30.348,5.601C30.765,5.601 31.14,5.862 31.285,6.253L36.133,19.347C36.278,19.739 36.653,20 37.071,20C37.071,20 40.91,20 40.91,20C41.459,20 41.91,19.549 41.91,19C41.91,18.882 41.889,18.764 41.848,18.653L36.537,4.308C35.581,1.724 33.103,-0.001 30.348,-0.001C27.592,-0.001 25.114,1.724 24.158,4.308L16.735,24.357C16.59,24.748 16.215,25.009 15.797,25.009C15.38,25.009 15.005,24.748 14.86,24.357L6.213,1.003C6.068,0.611 5.693,0.35 5.275,0.35Z';

/** The app's mark in the product colour (--brand); `label` names it for a screen reader, without one it is decoration. */
export function Wave({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <svg className="wave" viewBox="0.437 -0.001 41.473 30.612" height={size} width={(size * 41.473) / 30.612}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={WAVE} fill="var(--brand)" />
    </svg>
  );
}

/** Wave and wordmark; the wordmark takes the text colour, so it follows light and dark. */
export function Lockup({ height = 48 }: { height?: number }) {
  return (
    <svg className="lockup" viewBox="0 0 697 192" height={height} width={(height * 697) / 192} role="img" aria-label="Vanilla Accounting"
      fill="currentColor" dangerouslySetInnerHTML={{ __html: LOCKUP_SVG }} />
  );
}
