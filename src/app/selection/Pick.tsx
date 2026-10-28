/**
 * The checkbox of a row (#216): it shows on hover, and on every row while anything is picked
 * (the list carries `picking`, selection.css). A click toggles only its row and opens nothing.
 */
import { t } from '../i18n/index.js';
import type { SelectKind } from './model.js';
import { checkRow } from './store.js';
import './selection.css';

export function Pick({ kind, id, on, label, toast }: { kind: SelectKind; id: string; on: boolean; label: string; toast(msg: string): void }) {
  return (
    <span
      className={`pick${on ? ' on' : ''}`}
      role="checkbox"
      aria-checked={on}
      aria-label={t(on ? 'selection.unpick' : 'selection.pick', { what: label })}
      data-pick={id}
      tabIndex={-1}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); checkRow(kind, id, toast); }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
    </span>
  );
}
