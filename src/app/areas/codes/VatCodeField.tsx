/**
 * A VAT code field (issue #224): type a code («M81»), words of its plain name («material»), or a rate
 * («8.1», which the accounts turn into a code when the form saves). The list shows the codes the
 * firm's form takes, grouped by what the person is doing (pickGroups); ↑/↓ and Enter or a click pick
 * one, Esc closes it. The field holds the code, so a form reads it like any input; the line under it
 * names the code in plain words. `onPick` runs after a pick, `onValue` on every change.
 */
import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { lookupVatCode, parseRate } from '../../../accounting/vat-codes.js';
import { t } from '../../i18n/index.js';
import { fittingGroup, pickGroups } from './model.js';
import { codeText } from './names.js';

interface Props {
  name: string;
  label: ReactNode;
  defaultValue?: string;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  /** The line under the field; absent: the code's plain name. */
  hint?: ReactNode;
  onPick?(code: string): void;
  onValue?(value: string): void;
  /** The line's accounts: the codes that fit them come first, and a typed rate lists only those (#344). */
  accounts?: { debit: string; credit: string };
}

export function VatCodeField({ name, label, defaultValue = '', readOnly, placeholder, className, hint, onPick, onValue, accounts }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  // null: the field as it was when focused, which lists every code.
  const [q, setQ] = useState<string | null>(null);
  // null while typing: the code typed in full, else the first.
  const [chosen, setChosen] = useState<number | null>(-1);
  const [, redraw] = useState(0);
  const fit = accounts ? fittingGroup(accounts.debit, accounts.credit) : undefined;
  const groups = useMemo(() => (open ? pickGroups(q ?? '', codeText, fit) : []), [open, q, fit]);
  // Only the codes of the account's kind are listed: the list says so, with the way to any other.
  const onlyFit = !!fit && !!parseRate((q ?? '').trim()) && groups.length === 1 && groups[0].group === fit;
  const options = groups.flatMap((g) => g.options);
  const exact = options.findIndex((o) => o.code.toLowerCase() === (q ?? '').trim().toLowerCase());
  const active = chosen ?? Math.max(exact, 0);
  const value = input.current?.value ?? defaultValue;

  function show() {
    setQ(null);
    setOpen(true);
    const at = pickGroups('', codeText, fit).flatMap((g) => g.options).findIndex((o) => o.code === input.current?.value);
    setChosen(at);
    if (at >= 0) setTimeout(() => list.current?.querySelector(`[data-code="${CSS.escape(input.current!.value)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }

  function pick(code: string) {
    input.current!.value = code;
    setOpen(false);
    setQ(null);
    redraw((n) => n + 1);
    onValue?.(code);
    if (onPick) setTimeout(() => onPick(code));
  }

  function move(i: number) {
    const next = Math.min(Math.max(i, 0), options.length - 1);
    setChosen(next);
    list.current?.querySelector(`[data-code="${CSS.escape(options[next]?.code ?? '')}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (readOnly) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { show(); e.preventDefault(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowUp') move(active - 1);
    else if (e.key === 'Enter') {
      // A field left as it was, or a typed rate, goes to the form as typed: the accounts decide a rate's code.
      if (q === null || parseRate(q) || !options[active]) { setOpen(false); return; }
      pick(options[active].code);
    } else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  let i = -1;
  return (
    <label className={`acf vcf${className ? ` ${className}` : ''}`}>
      {label}
      <input
        ref={input}
        className="mono"
        name={name}
        defaultValue={defaultValue}
        readOnly={readOnly}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onFocus={(e) => { if (!readOnly) { show(); e.currentTarget.select(); } }}
        // A value the books put in (useBookedFields, after an undo) is no typing: it opens no list.
        onChange={(e) => { if (e.nativeEvent.isTrusted) { setQ(e.target.value); setChosen(null); setOpen(true); } else redraw((n) => n + 1); onValue?.(e.target.value); }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <span className="acn" data-testid="vat-name">{hint ?? (lookupVatCode(value.trim()) ? codeText(value.trim()) : '')}</span>
      {open && (
        <ul ref={list} id={listId} role="listbox" aria-label={t('journal.field.vatCode')} className="acl vpl" tabIndex={-1}>
          {options.length === 0 && <li className="none">{t('combobox.none')}</li>}
          {groups.map((g) => (
            <Fragment key={g.group}>
              <li className="vg" role="presentation">{t(`vatCodes.group.${g.group}`)}</li>
              {g.options.map((o) => {
                const n = ++i;
                return (
                  <li
                    key={o.code}
                    role="option"
                    data-code={o.code}
                    aria-selected={n === active}
                    className={n === active ? 'on' : ''}
                    onMouseDown={(e) => { e.preventDefault(); pick(o.code); }}
                    onMouseMove={() => n !== active && setChosen(n)}
                  >
                    <span className="vn">{o.name}</span><span className="mono">{o.code}</span>
                  </li>
                );
              })}
            </Fragment>
          ))}
          {onlyFit && <li className="none vr" role="presentation" data-testid="vat-fit-only">{t('vatCodes.pick.fitOnly')}</li>}
          {!(q ?? '').trim().startsWith('-') && <li className="none vr" role="presentation">{t('vatCodes.pick.refund')}</li>}
        </ul>
      )}
    </label>
  );
}
