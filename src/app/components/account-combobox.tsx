import { useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Account } from '../lib/accounts.js';
import { filterAccounts } from '../lib/account-filter.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';

interface Props {
  /** The accounts offered first: those with entries in the period. */
  accounts: readonly Account[];
  /** The whole chart, offered when "show all" is ticked. */
  allAccounts: readonly Account[];
  value: string;
  onChange: (number: string) => void;
}

/**
 * Picks an account by typing its number ("40" → 4000…4099) or part of its name ("büro", "mwst"),
 * after the ARIA combobox pattern: ↑/↓ move, Enter picks, Esc closes, Tab or a click elsewhere
 * keeps the current account.
 */
export function AccountCombobox({ accounts, allAccounts, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);

  const pool = showAll ? allAccounts : accounts;
  const matches = useMemo(() => filterAccounts(pool, query), [pool, query]);
  const current = allAccounts.find((a) => a.number === value) ?? accounts.find((a) => a.number === value);
  const label = current ? `${current.number} ${current.name}` : value;

  function openList() {
    setOpen(true);
    setQuery('');
    const at = filterAccounts(pool, '').findIndex((m) => m.account.number === value);
    setActive(Math.max(0, at));
  }

  function pick(number: string) {
    onChange(number);
    setOpen(false);
  }

  function moveTo(i: number) {
    const next = Math.min(Math.max(i, 0), matches.length - 1);
    setActive(next);
    list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { openList(); e.preventDefault(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') moveTo(active + 1);
    else if (e.key === 'ArrowUp') moveTo(active - 1);
    else if (e.key === 'Home') moveTo(0);
    else if (e.key === 'End') moveTo(matches.length - 1);
    else if (e.key === 'Enter') { if (matches[active]) pick(matches[active].account.number); }
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
  }

  return (
    <div className="flex items-center gap-3">
      <div className="relative w-80">
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${matches[active].account.number}` : undefined}
          aria-label={t('combobox.label')}
          placeholder={t('combobox.placeholder')}
          value={open ? query : label}
          onFocus={(e) => { openList(); e.currentTarget.select(); }}
          onClick={() => { if (!open) openList(); }}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
          data-testid="account-combobox"
          className="w-full text-sm border border-input rounded px-2 py-1 pr-7 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        {open && (
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label={t('combobox.label')}
            className="absolute left-0 top-full mt-1 z-50 w-full max-h-80 overflow-auto rounded-md border border-border bg-background shadow-lg py-1 text-sm"
          >
            {matches.length === 0 && <li className="px-3 py-2 text-muted-foreground">{t('combobox.none')}</li>}
            {matches.map((m, i) => (
              <li
                key={m.account.number}
                id={`${listId}-${m.account.number}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); pick(m.account.number); }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'px-3 py-1 cursor-pointer truncate',
                  i === active ? 'bg-accent text-foreground' : 'text-foreground',
                  m.account.number === value && 'font-semibold',
                )}
              >
                <Highlighted text={`${m.account.number} ${m.account.name}`} range={m.highlight} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-current" />
        {t('combobox.showAll')}
      </label>
    </div>
  );
}

function Highlighted({ text, range }: { text: string; range: [number, number] | null }) {
  if (!range) return <>{text}</>;
  const chars = [...text];
  return (
    <>
      {chars.slice(0, range[0]).join('')}
      <mark className="bg-amber-100 text-foreground dark:bg-amber-900 rounded-sm">{chars.slice(range[0], range[1]).join('')}</mark>
      {chars.slice(range[1]).join('')}
    </>
  );
}
