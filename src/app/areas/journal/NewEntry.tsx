/**
 * A new entry by hand (the add button and N), or a correction of a filed one: date, Soll, Haben,
 * amount in CHF, VAT code and text, booked in the open period. A correction names the filed
 * quarter it corrects, so the Korrekturabrechnung (0535) declares it.
 */
import { useRef, useState } from 'react';
import { localToday, parsePeriod, parseSwissDate } from '../../../accounting/periods.js';
import { lookupVatCode } from '../../../accounting/vat-codes.js';
import type { RouteOf } from '../../shell/route.js';
import { getAccountMap } from '../../lib/accounts.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { at } from '../receipts/view.js';
import { bookPayment, createEntry } from './actions.js';
import { PaymentField } from './PaymentField.js';
import { bookingDraft } from '../../../accounting/manual-booking.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import type { JournalEntryInput } from '../../lib/api.js';
import { AccountField } from './AccountField.js';
import { VatCodeList } from './Detail.js';
import { listed, setUi, useUi } from './state.js';
import { baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'journal'>>;

const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) && s.trim() ? n : null; };

export function NewEntry(props: Props) {
  const { books, nav } = props;
  const s = useUi();
  const ws = useWorkspace();
  const form = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState('');
  const [round, setRound] = useState(0);
  if (s.overlay?.kind !== 'new') return null;
  const d = s.overlay.draft;
  const close = () => setUi({ overlay: null });
  const filed = d.corrects && parsePeriod(d.corrects, localToday());
  const tx = d.transactionRef ? books.transactions.find((x) => x.ref === d.transactionRef) : undefined;

  /** What the fields hold now, so a payment picked (or dropped) keeps what was typed. */
  function typed(): Partial<JournalEntryInput> {
    const f = Object.fromEntries(new FormData(form.current!)) as Record<string, string>;
    return { ...d, date: parseSwissDate(f.date) ?? d.date, accountDebit: f.accountDebit.trim(), accountCredit: f.accountCredit.trim(), amount: parseAmount(f.amount) ?? undefined, vatCode: f.vatCode.trim(), description: f.description };
  }

  /** A payment picked: the entry books it, on its date, its amount and bank side filled where empty. */
  function pickPayment(ref: string | undefined) {
    const now = typed();
    const p = ref ? books.transactions.find((x) => x.ref === ref) : undefined;
    const draft = p && ws ? bookingDraft(books, p.ref, ws.bankAccounts) : undefined;
    const next: Partial<JournalEntryInput> = p
      ? { ...now, transactionRef: p.ref, date: p.date, amount: now.amount || draft?.lines[0]?.amount || p.amount, description: now.description || draft?.lines[0]?.description || p.description }
      : { ...now, transactionRef: undefined };
    if (draft?.bank && !next[draft.bank.side]) next[draft.bank.side] = draft.bank.account;
    setUi({ overlay: { kind: 'new', draft: next } });
    setRound(round + 1);
    setErr('');
  }

  async function book() {
    const f = Object.fromEntries(new FormData(form.current!)) as Record<string, string>;
    const date = parseSwissDate(f.date);
    const closed = books.config?.closedThrough;
    const accounts = getAccountMap();
    const amount = parseAmount(f.amount);
    const [dr, cr, vat, text] = [f.accountDebit.trim(), f.accountCredit.trim(), f.vatCode.trim(), f.description.trim()];
    const problem = !date && !tx ? t('journal.errDate')
      : !tx && closed && date! <= closed ? t('journal.errFiledDate', { date: formatDate(closed) })
      : [dr, cr].find((n) => n && !accounts[n]) ? t('journal.errAccount', { account: [dr, cr].find((n) => n && !accounts[n])! })
      : !dr && !cr ? t('journal.errNoAccount')
      : vat && !lookupVatCode(vat) ? t('journal.errVat', { code: vat })
      : !amount ? t('journal.errAmount')
      : !text ? t('journal.errText')
      : '';
    if (problem) { setErr(problem); return; }
    if (tx) {
      const entries = await bookPayment(nav, tx.ref, [{ accountDebit: dr, accountCredit: cr, amount: amount!, ...(vat && { vatCode: vat }), description: text }]);
      if (!entries?.length) return;
      close();
      listed.pending = entries[0].id;
      nav.go(at({ area: 'journal', id: entries[0].id }, entries[0].date, props.period));
      return;
    }
    close();
    const entry = await createEntry(nav, { date: date!, accountDebit: dr, accountCredit: cr, amount: amount!, description: text, ...(vat && { vatCode: vat }), ...(d.corrects && { corrects: d.corrects }) });
    if (!entry) return;
    listed.pending = entry.id;
    nav.go(at({ area: 'journal', id: entry.id }, entry.date, props.period));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); book(); }
  }

  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={close} />
      <div className="palette jnew" role="dialog" aria-label={filed ? t('journal.correctionTitle') : t('journal.addTitle')}>
        <div className="ctx">
          <div><span className="lbl">{filed ? t('journal.correctionTitle') : t('journal.addTitle')}</span>{filed ? t('journal.correctionHint', { filed: periodName(filed) }) : t('journal.addHint')}</div>
        </div>
        <form key={round} ref={form} className="form" autoComplete="off" onKeyDown={onKeyDown} onSubmit={(e) => { e.preventDefault(); book(); }}>
          {!filed && <PaymentField books={books} picked={tx} amount={d.amount} onPick={pickPayment} />}
          <div className="two">
            <label>{t('journal.field.date')}<input className="mono" name="date" defaultValue={formatDate(d.date ?? localToday())} readOnly={!!tx} title={tx ? t('journal.payment.dateIs') : undefined} autoFocus={!round} /></label>
            <label>{t('journal.amountIn', { currency: tx?.currency ?? baseCurrency() })}<input className="mono" name="amount" defaultValue={d.amount ? fmt(d.amount) : ''} style={{ textAlign: 'right' }} autoFocus={!!round} /></label>
          </div>
          <div className="two">
            <AccountField name="accountDebit" label={t('journal.field.accountDebit')} defaultValue={d.accountDebit ?? ''} />
            <AccountField name="accountCredit" label={t('journal.field.accountCredit')} defaultValue={d.accountCredit ?? ''} />
          </div>
          <div className="two">
            <label>{t('journal.field.vatCode')}<input className="mono" name="vatCode" defaultValue={d.vatCode ?? ''} list="vat-codes" /></label>
            <span />
          </div>
          <label>{t('journal.field.description')}<input name="description" defaultValue={d.description ?? ''} /></label>
          <VatCodeList />
          <div className="err" role="alert">{err}</div>
          <div className="dacts">
            <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')} <span className="k">{t('codes.escKey')}</span></button>
            <button type="submit" className="btn primary">{t('journal.book')} <span className="k">↵</span></button>
          </div>
        </form>
      </div>
    </>
  );
}
