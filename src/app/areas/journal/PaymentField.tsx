/**
 * The payment a new entry books (Buchungen › N, treuhaender-22): search the unbooked payments by
 * date, amount or text, pick with ↑/↓ and Enter or a click. Picked, the entry carries its ref, so
 * the payment counts as booked; × books the entry without a payment again.
 */
import { useId, useMemo, useState } from 'react';
import type { BankTransaction, Index } from '../../../types/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { unbookedPayments } from './model.js';
import { useWorkspace } from '../../hooks/use-workspace.js';

const signed = (p: BankTransaction) => `${p.currency} ${p.direction === 'DBIT' ? '−' : ''}${fmt(p.amount)}`;
const line = (p: BankTransaction) => `${formatDate(p.date)} · ${p.bank} · ${signed(p)} · ${p.description}`;

export function PaymentField({ books, picked, amount, onPick }: { books: Index; picked?: BankTransaction; amount?: number; onPick(ref: string | undefined): void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const accounts = useWorkspace()?.bankAccounts ?? [];
  const matches = useMemo(() => (open ? unbookedPayments(books, q, amount, accounts).slice(0, 8) : []), [open, books, q, amount, accounts]);

  if (picked) {
    return (
      <div className="payf picked" data-testid="payment-field" data-ref={picked.ref}>
        <span className="lbl">{t('journal.payment.label')}</span>
        <span className="mono">{line(picked)}</span>
        <button type="button" className="rm" aria-label={t('journal.payment.drop')} onClick={() => onPick(undefined)}>×</button>
      </div>
    );
  }

  function pick(ref: string) {
    setOpen(false);
    setQ('');
    onPick(ref);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && e.key === 'ArrowDown') { setOpen(true); setActive(0); e.preventDefault(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') setActive(Math.min(active + 1, matches.length - 1));
    else if (e.key === 'ArrowUp') setActive(Math.max(active - 1, 0));
    else if (e.key === 'Enter' && matches[active]) pick(matches[active].ref);
    else if (e.key === 'Escape') setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <label className="payf acf" data-testid="payment-field">
      {t('journal.payment.label')}
      <input
        value={q}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={t('journal.payment.placeholder')}
        onChange={(e) => { setQ(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => { if (q) setOpen(true); }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <span className="acn">{t('journal.payment.hint')}</span>
      {open && (
        <ul id={listId} role="listbox" aria-label={t('journal.payment.label')} className="acl" tabIndex={-1}>
          {matches.length === 0 && <li className="none">{t('journal.payment.none')}</li>}
          {matches.map((p, i) => (
            <li key={p.ref} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} data-ref={p.ref}
              onMouseDown={(e) => { e.preventDefault(); pick(p.ref); }} onMouseMove={() => i !== active && setActive(i)}>
              <span className="mono">{formatDate(p.date)}</span>{signed(p)} · {p.description}
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}
