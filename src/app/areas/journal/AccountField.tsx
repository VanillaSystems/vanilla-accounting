/**
 * An account field: type its number ("65" lists 6500…6599) or part of its name ("büro"), pick
 * with ↑/↓ and Enter or a click; Esc closes the list. The field holds the number, so a form reads
 * it like any input; `onPick` runs after a pick (the detail saves then).
 *
 * A typed query also lists the standard chart's accounts the books lack, each as «6600 Werbeaufwand
 * anlegen»: picking one adds it to the chart as Firma › Kontenplan does, then picks it. `offer` is an
 * account a question proposes that the books lack: listed first, and named «wird angelegt» while
 * chosen, since answering the question adds it.
 *
 * `prefer` is the class the field's side takes first (a payment's other side: revenue for money in,
 * expense for money out) and `defaults` the firm's default accounts: the list ranks by them, then by
 * the name (rankAccounts, #344), and a word that names a class («Ertrag», «Aufwand») lists its accounts.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { addAccount, addableAccounts, getAccounts, hintsOf, type Account } from '../../lib/accounts.js';
import { rankAccounts, type AccountContext } from '../../lib/account-filter.js';
import { chart } from '../../../engines/index.js';
import type { AccountType } from '../../../core/modules/schema.js';
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';

/** An option of the list: an account of the books, the question's offer, or one of the standard chart to add. */
interface Option { account: Account; kind: 'have' | 'offer' | 'add' }

const MAX_OPTIONS = 60;

/** Why a form refuses an account number the chart lacks: one of the standard chart is named with the way to add it. */
export function unknownAccountText(number: string): string {
  const standard = addableAccounts().find((a) => a.number === number);
  return standard ? t('journal.errAccountAddable', { account: number, name: standard.name }) : t('journal.errAccount', { account: number });
}

/** The words a person types for a class, from the dictionary (one line of words per class). */
const classWords = (): AccountContext<AccountType>['words'] => ({ revenue: t('accounts.words.revenue').split(/\s+/), expense: t('accounts.words.expense').split(/\s+/) });

export function AccountField({ name, label, defaultValue, readOnly, onPick, offer, prefer, defaults }: { name: string; label: string; defaultValue: string; readOnly?: boolean; onPick?(): void; offer?: Account; prefer?: AccountType; defaults?: readonly string[] }) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  // null: the row of the value the field holds (focused and not typed in yet), so ↵ keeps it; a number once she types or moves.
  const [chosen, setActive] = useState<number | null>(0);
  const [refused, setRefused] = useState<string | null>(null);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const offered = offer && !getAccounts().some((a) => a.number === offer.number) ? offer : undefined;
  const all = useMemo((): Option[] => {
    if (!open) return [];
    const query = value === defaultValue && !/\D/.test(value) ? '' : value;
    const ctx: AccountContext<AccountType> = { typeOf: (n) => chart().typeOf(n), prefer, defaults, words: classWords(), hints: hintsOf };
    const of = (accounts: readonly Account[], kind: Option['kind']) => rankAccounts(accounts, query, ctx).map((m) => ({ account: m.account, kind }));
    return [...of(offered ? [offered] : [], 'offer'), ...of(getAccounts(), 'have'), ...(query ? of(addableAccounts(), 'add') : [])];
  }, [open, value, defaultValue, offered, prefer, defaults]);
  const matches = all.slice(0, MAX_OPTIONS);
  const held = matches.findIndex((m) => m.account.number === value);
  const active = chosen ?? Math.max(0, held);
  const name0 = getAccounts().find((a) => a.number === value)?.name;

  function pick(number: string) {
    setValue(number);
    setOpen(false);
    setRefused(null);
    if (onPick) setTimeout(onPick);
  }

  async function choose(o: Option) {
    if (o.kind !== 'add') { pick(o.account.number); return; }
    // The list stays open while the account is added: closed at once, a click's mouseup would land on what lies beneath and blur the field, and the form would save the typed number before the account exists.
    try {
      await api.setAccountName(o.account.number, o.account.name);
    } catch (err) {
      setOpen(false);
      setRefused(errorText(err));
      return;
    }
    addAccount(o.account);
    pick(o.account.number);
  }

  function move(i: number) {
    const next = Math.min(Math.max(i, 0), matches.length - 1);
    setActive(next);
    list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (readOnly) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); setActive(null); e.preventDefault(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowUp') move(active - 1);
    // ↵ with the list open commits the pick and never reaches the form: a stray ↵ books nothing half typed (r9k-7).
    else if (e.key === 'Enter') { if (matches[active] && !(chosen === null && held < 0 && value)) void choose(matches[active]); else setOpen(false); }
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const shown = name0 ?? (offered && value === offered.number ? t('combobox.offered', { name: offered.name }) : value ? t('journal.noSuchAccount') : t('journal.noAccount'));
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
        data-tip={name0}
        onFocus={(e) => { if (!readOnly) { setOpen(true); setActive(null); e.currentTarget.select(); } }}
        // A value the books put in (useBookedFields, after an undo) is no typing: it opens no list.
        onChange={(e) => { setValue(e.target.value.trim()); setRefused(null); if (e.nativeEvent.isTrusted) { setActive(0); setOpen(true); } }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {refused ? <span className="acn warn" role="alert">{refused}</span> : <span className="acn">{shown}</span>}
      {open && (
        <ul ref={list} id={listId} role="listbox" aria-label={label} className="acl" tabIndex={-1}>
          {matches.length === 0 && <li className="none">{t('combobox.none')}</li>}
          {matches.map((m, i) => (
            <li
              key={`${m.kind}-${m.account.number}`}
              role="option"
              aria-selected={i === active}
              className={[i === active ? 'on' : '', m.kind === 'have' ? '' : 'add'].filter(Boolean).join(' ')}
              data-act={m.kind === 'add' ? 'account-add' : undefined}
              onMouseDown={(e) => { e.preventDefault(); void choose(m); }}
              onMouseMove={() => i !== active && setActive(i)}
            >
              <span className="mono">{m.account.number}</span>{m.kind === 'add' ? t('combobox.add', { name: m.account.name }) : m.kind === 'offer' ? t('combobox.offered', { name: m.account.name }) : m.account.name}
            </li>
          ))}
          {all.length > matches.length && <li className="none">{t('combobox.more', { n: all.length - matches.length, max: MAX_OPTIONS })}</li>}
        </ul>
      )}
    </label>
  );
}
