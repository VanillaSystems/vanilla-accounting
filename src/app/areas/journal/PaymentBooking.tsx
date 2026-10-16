/**
 * A payment without a booking, booked by hand right where it shows (Kontoauszüge, the task «Bewegung
 * von Hand buchen», a receipt's payment): Soll, Haben, VAT code (a code, or a rate as typed), amount
 * and text per line, on the payment's date. It opens with what rules decide (bookingDraft), the
 * lines must add up to the payment, and ↵ books them through the API as a person's entries.
 */
import { useMemo, useRef, useState } from 'react';
import type { Index, JournalEntry } from '../../../types/index.js';
import { bookingDraft, inputTaxWithoutReceipt, restOf, unattachedFor, type BookingDraft, type BookingLine, type DraftLine, type Unattached as UnattachedBooking } from '../../../accounting/manual-booking.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { formTakes, parseRate, vatCodeOf } from '../../../accounting/vat-codes.js';
import { withoutInputTax } from '../../../engines/index.js';
import { codeText } from '../codes/vat-card.js';
import { isVatAmountCode } from '../../../accounting/validate.js';
import { getAccountMap } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { AccountField } from './AccountField.js';
import { VatCodeList } from './Detail.js';
import { attachEntries, bookPayment } from './actions.js';
import { useInvoices } from '../invoices/data.js';
import { Go } from '../vat/links.js';
import { at } from '../receipts/view.js';

const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) && s.trim() ? n : null; };
const FIELDS = ['accountDebit', 'accountCredit', 'vatCode', 'amount', 'description'] as const;
type Row = { key: number; init: DraftLine };

type Props = {
  books: Index; nav: Nav; payment: string; narrow?: boolean;
  /** The form, for a «Gebucht» elsewhere that should bring the person here. */
  onForm?(el: HTMLFormElement | null): void;
  onBooked?(entries: JournalEntry[]): void;
};

/** Waits for the workspace's bank accounts: the first lines put the bank on its side. */
export function PaymentBooking(props: Props) {
  const ws = useWorkspace();
  const inv = useInvoices();
  const invoices = inv.state === 'ready' ? inv.data.invoices : undefined;
  const draft = useMemo(() => ws && bookingDraft(props.books, props.payment, ws.bankAccounts, invoices), [ws, props.books, props.payment, invoices]);
  const typed = useMemo(() => (ws ? unattachedFor(props.books, props.payment, ws.bankAccounts) : []), [ws, props.books, props.payment]);
  if (!ws || !draft) return null;
  return (
    <>
      {typed.length ? <Unattached {...props} typed={typed} /> : null}
      <BookingForm {...props} accounts={ws.bankAccounts} draft={draft} />
    </>
  );
}

/**
 * Bookings typed in Buchungen without a payment that add up to this one (treuhaender-22): tied to
 * it with one click, the payment counts as booked and no later run books it a second time.
 */
function Unattached({ nav, payment, typed, onBooked }: Props & { typed: UnattachedBooking[] }) {
  const busy = useRef(false);
  async function attach(own: string) {
    if (busy.current) return;
    busy.current = true;
    const before = await attachEntries(nav, payment, own);
    busy.current = false;
    if (before) onBooked?.(before.map((e) => ({ ...e, transactionRef: payment })));
  }
  return (
    <div className="pbo" data-testid="unattached">
      <b>{t('journal.unattached.title', { n: typed.length })}</b>
      {typed.map((u) => (
        <div key={u.ref} className="pbor" data-ref={u.ref}>
          <span className="mono">{u.ref}</span>
          <span className="mono">{formatDate(u.entries[0].date)}</span>
          <span>{u.entries.map((e) => `${e.accountDebit || '–'} / ${e.accountCredit || '–'}${e.vatCode ? ` ${e.vatCode}` : ''} · ${fmt(e.amount)}`).join(' + ')}</span>
          <span className="m">{u.entries.map((e) => e.description).filter(Boolean).join(' · ')}</span>
          <button type="button" className="btn" onClick={() => void attach(u.ref)}>{t('journal.unattached.attach', { ref: u.ref })}</button>
        </div>
      ))}
    </div>
  );
}

function BookingForm({ books, nav, payment, narrow, onForm, onBooked, accounts, draft }: Props & { accounts: readonly LedgerBankAccount[]; draft: BookingDraft }) {
  const [rows, setRows] = useState<Row[]>(() => draft.lines.map((init, key) => ({ key, init })));
  const [, redraw] = useState(0);
  const [err, setErr] = useState('');
  const form = useRef<HTMLFormElement | null>(null);
  const busy = useRef(false);

  /** The lines as typed now; `vat` the code a typed rate stands for, null where it is neither code nor rate. */
  function typed(): Array<{ line: BookingLine; vat: ReturnType<typeof vatCodeOf>; raw: Record<typeof FIELDS[number], string> }> {
    const f = form.current ? new FormData(form.current) : undefined;
    return rows.map(({ key, init }) => {
      const get = (k: typeof FIELDS[number]) => String(f?.get(`${k}-${key}`) ?? (k === 'amount' ? fmt(init.amount) : k === 'vatCode' ? init.vat : init[k])).trim();
      const raw = Object.fromEntries(FIELDS.map((k) => [k, get(k)])) as Record<typeof FIELDS[number], string>;
      const vat = vatCodeOf(raw.vatCode, raw.accountDebit, raw.accountCredit);
      return { raw, vat, line: { accountDebit: raw.accountDebit, accountCredit: raw.accountCredit, amount: parseAmount(raw.amount) ?? 0, ...(vat?.code && { vatCode: vat.code }), description: raw.description } };
    });
  }

  const now = typed();
  const noReceipt = !books.mappings.some((m) => m.transactionRef === payment);
  const rest = restOf(books, payment, now.map((x) => x.line), accounts);

  function addLine() {
    const bank = draft.bank;
    // A rest the bank did not pay (a discount taken off) is the bank's other side.
    const side = bank && (rest >= 0 ? bank.side : bank.side === 'accountDebit' ? 'accountCredit' : 'accountDebit');
    const init: DraftLine = { accountDebit: '', accountCredit: '', amount: Math.abs(rest), vat: '', description: now.at(-1)?.raw.description ?? '' };
    if (bank && side) init[side] = bank.account;
    const key = Math.max(-1, ...rows.map((r) => r.key)) + 1;
    setRows([...rows, { key, init }]);
    setTimeout(() => form.current?.querySelector<HTMLInputElement>(`[name="${side === 'accountDebit' ? 'accountCredit' : 'accountDebit'}-${key}"]`)?.focus());
  }

  async function book() {
    if (busy.current) return;
    const known = getAccountMap();
    const problem = now.map(({ raw, vat }, i): string => {
      const unknown = [raw.accountDebit, raw.accountCredit].find((n) => n && !known[n]);
      if (unknown) return t('journal.errAccount', { account: unknown });
      if (!raw.accountDebit && !raw.accountCredit) return t('journal.errNoAccount');
      if (!vat) return parseRate(raw.vatCode) ? t('journal.errVatRate', { rate: raw.vatCode }) : t('journal.errVat', { code: raw.vatCode });
      if (vat.code && !formTakes(vat.code)) return t(`journal.errVatNotTaken.${withoutInputTax() ?? 'none'}`, { code: vat.code });
      if ((!raw.accountDebit || !raw.accountCredit) && !isVatAmountCode(vat.code)) return t('journal.byHand.errLegs', { n: i + 1 });
      if (!parseAmount(raw.amount)) return t('journal.errAmount');
      if (!raw.description) return t('journal.errText');
      return '';
    }).find(Boolean) ?? (rest ? t('journal.byHand.errRest', { currency: draft.currency, amount: fmt(rest) }) : '');
    if (problem) { setErr(problem); return; }
    setErr('');
    busy.current = true;
    const entries = await bookPayment(nav, payment, now.map((x) => x.line));
    busy.current = false;
    if (entries) onBooked?.(entries);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.defaultPrevented && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void book(); }
  }

  const setForm = (el: HTMLFormElement | null) => { form.current = el; onForm?.(el); };

  return (
    <form ref={setForm} className={`form pbook${narrow ? ' narrow' : ''}`} autoComplete="off" aria-label={t('journal.byHand.title')} data-testid="payment-booking"
      onKeyDown={onKeyDown} onInput={() => redraw((n) => n + 1)} onSubmit={(e) => { e.preventDefault(); void book(); }}>
      <div className="pbh">
        <b>{t('journal.byHand.title')}</b>
        <span className="m">{t('journal.byHand.lead', { date: formatDate(draft.date), currency: draft.currency })}</span>
        {draft.precedent ? <span className="m">{t('journal.byHand.precedent', { date: formatDate(draft.precedent.date) })}</span> : null}
      </div>
      {draft.cancelledInvoice ? (
        <p className="pbw" data-testid="cancelled-invoice" data-number={draft.cancelledInvoice.number}>
          {t('journal.byHand.cancelledInvoice', { number: draft.cancelledInvoice.number })}{' '}
          <Go to={at({ area: 'invoices', view: 'list', id: draft.cancelledInvoice.number }, draft.date)} nav={nav}>{t('journal.byHand.showInvoice')}</Go>
        </p>
      ) : null}
      {rows.map(({ key, init }, i) => {
        const vat = now[i]?.vat;
        const zero = noReceipt ? inputTaxWithoutReceipt(vat?.code) : undefined;
        return (
          <div key={key} className="pbl">
            <AccountField name={`accountDebit-${key}`} label={t('journal.field.accountDebit')} defaultValue={init.accountDebit} onPick={() => redraw((n) => n + 1)} />
            <AccountField name={`accountCredit-${key}`} label={t('journal.field.accountCredit')} defaultValue={init.accountCredit} onPick={() => redraw((n) => n + 1)} />
            <label className="pbv">{t('journal.byHand.vatLabel')}
              <input className="mono" name={`vatCode-${key}`} defaultValue={init.vat} list="vat-codes" placeholder={t('journal.vatPlaceholder')} />
              <span className="acn" data-testid="vat-name" title={vat?.code ? codeText(vat.code) : undefined}>
                {vat?.code ? `${vat.fromRate !== undefined ? `${t('journal.byHand.vatIs', { code: vat.code })} · ` : ''}${codeText(vat.code)}` : vat === null ? '' : t('journal.byHand.noVat')}
              </span>
            </label>
            {zero ? <p className="pbw" data-testid="vat-no-receipt">{t('journal.byHand.noReceiptVat', { code: vat!.code, zero })}</p> : null}
            <label className="pba">{t('journal.amountIn', { currency: draft.currency })}<input className="mono" name={`amount-${key}`} defaultValue={fmt(init.amount)} style={{ textAlign: 'right' }} /></label>
            <label className="pbt">{t('journal.field.description')}<input name={`description-${key}`} defaultValue={init.description} /></label>
            {rows.length > 1 ? <button type="button" className="rm" title={t('journal.byHand.removeLine')} aria-label={t('journal.byHand.removeLine')} onClick={() => setRows(rows.filter((r) => r.key !== key))}>×</button> : null}
          </div>
        );
      })}
      <VatCodeList />
      <div className="pbf">
        <button type="button" className="addlink" title={t('journal.byHand.addLineTip')} onClick={addLine}>+ {t('journal.byHand.addLine')}</button>
        <span className={rest ? 'wn' : 'ok'} data-testid="payment-booking-rest">
          {rest > 0 ? t('journal.byHand.rest', { currency: draft.currency, amount: fmt(rest) })
            : rest < 0 ? t('journal.byHand.over', { currency: draft.currency, amount: fmt(-rest) })
              : t('journal.byHand.adds', { currency: draft.currency, amount: fmt(restOf(books, payment, [], accounts)) })}
        </span>
        <button type="submit" className="btn primary">{t('journal.byHand.submit')} <span className="k">↵</span></button>
      </div>
      <div className="err" role="alert">{err}</div>
    </form>
  );
}
