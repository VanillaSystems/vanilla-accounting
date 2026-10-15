/**
 * An account field: type its number ("65" lists 6500…6599) or part of its name ("büro"), pick
 * with ↑/↓ and Enter or a click; Esc closes the list. The field holds the number, so a form reads
 * it like any input; `onPick` runs after a pick (the detail saves then).
 */
import { useId, useMemo, useRef, useState } from 'react';
import { getAccounts } from '../../lib/accounts.js';
import { filterAccounts } from '../../lib/account-filter.js';
import { t } from '../../i18n/index.js';

export function AccountField({ name, label, defaultValue, readOnly, onPick }: { name: string; label: string; defaultValue: string; readOnly?: boolean; onPick?(): void }) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const matches = useMemo(() => (open ? filterAccounts(getAccounts(), value === defaultValue && !/\D/.test(value) ? '' : value).slice(0, 60) : []), [open, value, defaultValue]);
  const name0 = getAccounts().find((a) => a.number === value)?.name;

  function pick(number: string) {
    setValue(number);
    setOpen(false);
    if (onPick) setTimeout(onPick);
  }

  function move(i: number) {
    const next = Math.min(Math.max(i, 0), matches.length - 1);
    setActive(next);
    list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (readOnly) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); setActive(0); e.preventDefault(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowUp') move(active - 1);
    else if (e.key === 'Enter' && matches[active]) pick(matches[active].account.number);
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <label className="acf">
      {label}
      <input
        className="mono"
        name={name}
        value={value}
        readOnly={readOnly}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        title={name0}
        onFocus={(e) => { if (!readOnly) { setOpen(true); setActive(0); e.currentTarget.select(); } }}
        onChange={(e) => { setValue(e.target.value.trim()); setActive(0); setOpen(true); }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <span className="acn">{name0 ?? (value ? t('journal.noSuchAccount') : t('journal.noAccount'))}</span>
      {open && (
        <ul ref={list} id={listId} role="listbox" aria-label={label} className="acl" tabIndex={-1}>
          {matches.length === 0 && <li className="none">{t('combobox.none')}</li>}
          {matches.map((m, i) => (
            <li
              key={m.account.number}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : ''}
              onMouseDown={(e) => { e.preventDefault(); pick(m.account.number); }}
              onMouseMove={() => i !== active && setActive(i)}
            >
              <span className="mono">{m.account.number}</span>{m.account.name}
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}
