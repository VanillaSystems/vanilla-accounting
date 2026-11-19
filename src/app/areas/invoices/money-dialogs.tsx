/**
 * The dialogs of the money after an invoice (spec 4.4.6, 4.8): «Zahlungseingang erfassen» (date, a
 * bank or the cash box, the amount, prefilled with what is open), «Rest ausbuchen» (reason, date,
 * amount: three clicks for a loss) and «Ausziffern» of one incoming payment over a customer's open
 * invoices, with what becomes of each rest. Each books through the API at once.
 */
import { useEffect, useState } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { WRITE_OFF_REASONS, type Invoice, type Issued, type WriteOffReason } from '../../../invoices/model.js';
import { openAmount } from '../../../invoices/rules.js';
import type { AllocationItem } from '../../../invoices/payments.js';
import type { BankTransaction } from '../../../types/index.js';
import type { RouteOf } from '../../shell/route.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { api, errorText } from '../../lib/api.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { allocate, handPayment, writeOff } from './actions.js';
import { invoicesNow } from './data.js';
import { parseNumber } from './edit.js';
import { Frame, close } from './frame.js';

type Props = AreaProps<RouteOf<'invoices'>>;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** «Zahlungseingang erfassen»: money the statement does not show yet, on a bank or the cash box of the invoice's currency. */
export function HandPaymentDialog({ inv, invoices, nav }: Props & { inv: Issued; invoices: Invoice[] }) {
  const ws = useWorkspace();
  const accounts = (ws?.bankAccounts ?? []).filter((a) => a.currency === inv.currency && (a.role === 'bank' || a.role === 'cash'));
  const open = openAmount(inv, invoices);
  const [date, setDate] = useState(localToday());
  const [account, setAccount] = useState(accounts.find((a) => a.role === 'cash')?.account ?? accounts[0]?.account ?? '');
  const [amount, setAmount] = useState(fmt(open));
  const n = parseNumber(amount);
  const run = async () => { if (n && n > 0 && account && (await handPayment(nav, inv, { date, account, amount: n }))) close(); };
  return (
    <Frame label={t('invoices.handTitle', { number: inv.number })} title={`${inv.customer.name} · ${t('invoices.openAmount', { amount: `${inv.currency} ${fmt(open)}` })}`}
      foot={<><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button><AsyncButton type="button" className="btn primary" data-act="hand-ok" disabled={!n || n <= 0 || !account} onClick={() => run()}>{t('invoices.book')}</AsyncButton></>}>
      <div className="ibody lkf">
        <label className="lkr"><span>{t('invoices.date')}</span><span className="iin"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></span></label>
        <label className="lkr"><span>{t('invoices.handAccount')}</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)} data-testid="hand-account">
            {accounts.map((a) => <option key={`${a.account}${a.currency}`} value={a.account}>{a.account} · {a.label}</option>)}
          </select>
        </label>
        <label className="lkr"><span>{t('invoices.amount')}</span><input className="mono" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} /></label>
        {!accounts.length && <p className="m ivhint">{t('invoices.handNoAccount', { currency: inv.currency })}</p>}
        <p className="m ivhint">{t('invoices.handHint')}</p>
      </div>
    </Frame>
  );
}

/** «Rest ausbuchen»: reason, date (today), amount (what is open); more than open asks «Trotzdem ausbuchen». */
export function WriteOffDialog({ inv, invoices, nav, reason: proposed, amount: proposedAmount }: Props & { inv: Issued; invoices: Invoice[]; reason?: WriteOffReason; amount?: number }) {
  const open = openAmount(inv, invoices);
  const [reason, setReason] = useState<WriteOffReason>(proposed ?? 'loss');
  const [date, setDate] = useState(localToday());
  const [amount, setAmount] = useState(fmt(proposedAmount ?? open));
  const [note, setNote] = useState('');
  const [above, setAbove] = useState(false);
  const n = parseNumber(amount);
  const run = async (anyway = false) => {
    if (!n || n <= 0) return;
    const out = await writeOff(nav, inv, { reason, date, amount: n, ...(note.trim() ? { note: note.trim() } : {}) }, anyway);
    if (out === 'aboveOpen') setAbove(true);
    else if (out) close();
  };
  return (
    <Frame label={t('invoices.writeOffTitle', { number: inv.number })} title={`${inv.customer.name} · ${t('invoices.openAmount', { amount: `${inv.currency} ${fmt(open)}` })}`}
      foot={<><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        {above ? <AsyncButton type="button" className="btn primary danger" data-act="writeoff-anyway" onClick={() => run(true)}>{t('invoices.writeOffAnyway')}</AsyncButton>
          : <AsyncButton type="button" className="btn primary" data-act="writeoff-ok" disabled={!n || n <= 0} onClick={() => run()}>{t('invoices.writeOffOk')}</AsyncButton>}</>}>
      <div className="ibody lkf">
        <div className="lkr"><span>{t('invoices.writeOffReason')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('invoices.writeOffReason')}>
            {WRITE_OFF_REASONS.map((r) => <button key={r} type="button" role="radio" aria-checked={reason === r} className={reason === r ? 'on' : ''} data-reason={r} onClick={() => setReason(r)}>{t(`invoices.reason.${r}`)}</button>)}
          </span>
        </div>
        <label className="lkr"><span>{t('invoices.date')}</span><span className="iin"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></span></label>
        <label className="lkr"><span>{t('invoices.amount')}</span><input className="mono" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setAbove(false); }} /></label>
        <label className="lkr"><span>{t('invoices.writeOffNote')}</span><input value={note} placeholder={t('invoices.writeOffNotePh')} onChange={(e) => setNote(e.target.value)} /></label>
        {above && <div className="notice warn" role="note" data-testid="writeoff-above"><span>{t('invoices.writeOffAbove', { open: `${inv.currency} ${fmt(open)}` })}</span></div>}
        <p className="m ivhint">{t(`invoices.writeOffHint.${reason === 'loss' ? 'loss' : 'other'}`)}</p>
      </div>
    </Frame>
  );
}

const REST_CHOICES = ['open', ...WRITE_OFF_REASONS] as const;
type RestChoice = (typeof REST_CHOICES)[number];

/**
 * Ausziffern: the payment, the customer's open invoices with code's proposal (the ones the text
 * names first, then the oldest), an amount and the rest's fate per invoice, the sum left; «Buchen».
 * A surplus stays unallocated (phase 1): «Buchen» waits until nothing is left.
 */
export function AllocateDialog(props: Props & { transactionRef: string; customerId?: string }) {
  const [ref, setRef] = useState(props.transactionRef);
  if (!ref) return <PickPayment {...props} onPick={setRef} />;
  return <AllocateRows {...props} transactionRef={ref} />;
}

/** «Ausziffern» from the menu: which incoming payment, first (the open ones of the open periods, newest first). */
function PickPayment({ books, onPick }: Props & { customerId?: string; onPick(ref: string): void }) {
  const closed = books.config?.closedThrough ?? '';
  const loaded = invoicesNow();
  const allocated = new Set((loaded?.invoices ?? []).flatMap((i) => (i.status === 'issued' ? i.payments.map((p) => p.transactionRef) : [])));
  const open = books.transactions.filter((x) => x.direction === 'CRDT' && x.date > closed && !allocated.has(x.ref) && x.amount > 0).sort((a, b) => b.date.localeCompare(a.date));
  const [pick, setPick] = useState('');
  return (
    <Frame label={t('invoices.allocTitle')} title={t('invoices.allocPickTitle')}
      foot={<><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button><button type="button" className="btn primary" disabled={!pick} onClick={() => onPick(pick)}>{t('invoices.allocNext')}</button></>}>
      <div className="ibody lkf">
        <label className="lkr"><span>{t('invoices.allocPick')}</span>
          <select autoFocus value={pick} onChange={(e) => setPick(e.target.value)} data-testid="alloc-pick">
            <option value="">…</option>
            {open.map((x) => <option key={x.ref} value={x.ref}>{formatDate(x.date)} · {x.currency} {fmt(x.amount)} · {x.counterparty || x.description}</option>)}
          </select>
        </label>
        {!open.length && <p className="m">{t('invoices.allocNoPayment')}</p>}
      </div>
    </Frame>
  );
}

function AllocateRows({ nav, transactionRef, customerId }: Props & { transactionRef: string; customerId?: string }) {
  const [data, setData] = useState<{ transaction: BankTransaction; items: AllocationItem[] } | 'failed'>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [rests, setRests] = useState<Record<string, RestChoice>>({});
  useEffect(() => {
    let live = true;
    api.allocation(transactionRef, customerId).then((r) => {
      if (!live) return;
      setData(r);
      setAmounts(Object.fromEntries(r.items.map((i) => [i.invoiceId, i.proposed ? fmt(i.proposed) : ''])));
    }, (e) => { if (live) { setData('failed'); nav.toast(errorText(e)); } });
    return () => { live = false; };
  }, [transactionRef, customerId]);
  if (!data || data === 'failed') return null;
  const tx = data.transaction;
  const value = (id: string) => parseNumber(amounts[id] ?? '') ?? 0;
  const used = r2(data.items.reduce((s, i) => s + value(i.invoiceId), 0));
  const left = r2(tx.amount - used);
  const parts = data.items.filter((i) => value(i.invoiceId) > 0).map((i) => {
    const rest = rests[i.invoiceId];
    return { invoiceId: i.invoiceId, amount: value(i.invoiceId), ...(rest && rest !== 'open' && value(i.invoiceId) < i.open ? { rest } : {}) };
  });
  const tooMuch = data.items.find((i) => value(i.invoiceId) > i.open);
  const run = async () => { if (await allocate(nav, tx.ref, parts)) close(); };
  return (
    <Frame label={t('invoices.allocTitle')} title={`${formatDate(tx.date)} · ${tx.currency} ${fmt(tx.amount)} · ${tx.counterparty || tx.description}`} className="wide"
      foot={<><span className={`m allocleft${left !== 0 ? ' warn' : ''}`} data-testid="alloc-left">{t('invoices.allocLeft', { amount: `${tx.currency} ${fmt(left)}` })}</span>
        <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <AsyncButton type="button" className="btn primary" data-act="alloc-ok" disabled={!parts.length || left !== 0 || !!tooMuch} onClick={() => run()}>{t('invoices.book')}</AsyncButton></>}>
      <div className="ibody">
        {tx.description && <p className="m">{tx.description}</p>}
        {data.items.length ? (
          <table className="alloc">
            <thead><tr><th>{t('invoices.allocInvoice')}</th><th>{t('invoices.allocDue')}</th><th className="r">{t('invoices.allocOpen')}</th><th className="r">{t('invoices.allocAmount')}</th><th>{t('invoices.allocRest')}</th></tr></thead>
            <tbody>
              {data.items.map((i) => {
                const short = value(i.invoiceId) > 0 && value(i.invoiceId) < i.open;
                return (
                  <tr key={i.invoiceId} data-invoice={i.number}>
                    <td><span className="mono">{i.number}</span> {i.named && <small className="m">{t('invoices.allocNamed')}</small>}<br /><small className="m">{i.customerName}</small></td>
                    <td className="mono">{formatDate(i.dueDate)}</td>
                    <td className="r mono">{fmt(i.open)}</td>
                    <td className="r"><input className="mono" inputMode="decimal" aria-label={t('invoices.allocAmountFor', { number: i.number })} value={amounts[i.invoiceId] ?? ''} placeholder="0.00" onChange={(e) => setAmounts({ ...amounts, [i.invoiceId]: e.target.value })} /></td>
                    <td>{short ? (
                      <select aria-label={t('invoices.allocRestFor', { number: i.number })} value={rests[i.invoiceId] ?? 'open'} onChange={(e) => setRests({ ...rests, [i.invoiceId]: e.target.value as RestChoice })}>
                        {REST_CHOICES.map((c) => <option key={c} value={c}>{c === 'open' ? t('invoices.restOpen', { amount: fmt(r2(i.open - value(i.invoiceId))) }) : t(`invoices.reason.${c}`)}</option>)}
                      </select>
                    ) : <span className="m">–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="m">{t('invoices.allocNone', { currency: tx.currency })}</p>}
        {tooMuch && <div className="notice warn" role="note"><span>{t('invoices.allocAboveOpen', { number: tooMuch.number })}</span></div>}
        {left > 0 && <p className="m ivhint">{t('invoices.allocSurplus')}</p>}
      </div>
    </Frame>
  );
}
