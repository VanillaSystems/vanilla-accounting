/**
 * Zahlung verknüpfen: the payments ranked for this receipt (best first), a search over all of
 * them, and "paid privately or in cash" last. ↑↓ pick, ↵ links the picked row (with nothing
 * picked it only picks the first: a stray ↵ links nothing, r8h-21), Esc closes. The chosen payment
 * says when its amount is off the receipt's, before it is linked; a collective payment's row names
 * the part that pays the receipt (r8k-5). A receipt that has a payment says so at the top, and a
 * second payment is linked only after ↵ a second time. «Privat oder bar bezahlt» opens its form
 * (PrivateForm): the whole receipt or only its business part (#87). A payment of a filed quarter is marked:
 * ↵ on it opens its correction in the open quarter and links nothing (corner-33). Below the
 * best payments, the bookings without a payment of the open period of the receipt's amount (a
 * search finds the others: a depreciation, an accrual, #89) take the receipt as a payment does.
 * Under the search, a chip filter (#232, link-filter.ts): ⌥1…9 toggles the money accounts in the
 * order shown, «Passt am besten» is ranked within the filter and a line says when the filter hides
 * a best fit; the account chips stay chosen for the next receipt in this tab.
 */
import { ownerOf } from '../../../workspace/money-accounts.js';
import { useMemo, useRef, useState } from 'react';
import type { RouteOf } from '../../shell/route.js';
import { useFx } from '../../hooks/use-fx.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import type { BankTransaction } from '../../../types/index.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { bookingsWithoutPayment, candidates, chfOf, linkable, linkKey, type Candidate, type Ledger, type ReceiptView, type Unpaid } from './model.js';
import { ACCOUNT, accountName, accountValue, hiddenBest, linkFields, rememberAccounts, rememberedAccounts, rowOfTx, rowOfUnpaid, toggleAccount } from './link-filter.js';
import { ChipFilter, chipWords } from '../../shell/ChipFilter.js';
import { chipTest, knownChips, type Chip } from '../../shell/chips.js';
import { bankOf, dayText, fitText, signed, txLine } from './view.js';
import { correctFiled, linkPayment } from './actions.js';
import { PrivateForm } from './PrivateForm.js';
import { EmployeeForm } from './EmployeeForm.js';
import { Kbd } from './commands.js';
import { ui } from './state.js';
import { withoutInputTax, baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'receipts'>> & { v: ReceiptView; l: Ledger; onClose(): void };

const NO_ACCOUNTS: LedgerBankAccount[] = [];

/** A booking without a payment in a toast: its day, text and amount. */
const bookingLine = (u: Unpaid) => `${formatDate(u.date)} · ${u.description} · ${fmt(u.amount)}`;

function why(c: Candidate): string {
  return [
    c.part ? t('receipts.whyPart', { amount: `${c.part.currency} ${fmt(Math.abs(c.part.amount))}`, who: c.part.counterparty })
      : c.sameAmount ? t('receipts.whySameAmount') : c.otherCurrency ? t('receipts.whyAccount', { currency: c.tx.currency }) : '',
    c.fit?.kind === 'skonto' ? fitText(c.fit) : '',
    c.days !== undefined ? dayText(c.days) : '',
    c.taken ? t('receipts.whyTaken', { n: c.taken }) : '',
    c.filed ? t(noCorrection(c) ? 'receipts.whyFiledNoInputTax' : 'receipts.whyFiled') : '',
  ].filter(Boolean).join(' · ');
}

/** A payment of a filed period in a firm without input tax (r8f-34): a receipt changes nothing on it, there is no input tax to claim in a correction. */
const noCorrection = (c: Candidate): boolean => !!c.filed && !!withoutInputTax() && c.tx.direction === 'DBIT';

export function LinkDialog({ v, l, nav, books, onClose }: Props) {
  const { r } = v;
  const { rates } = useFx();
  const accounts = useWorkspace()?.bankAccounts ?? NO_ACCOUNTS;
  const owner = ownerOf(accounts)?.account;
  const fields = useMemo(() => linkFields(accounts, l, chipWords), [accounts, l]);
  const [chips, setChipsNow] = useState<Chip[]>(() => knownChips(rememberedAccounts(), fields));
  const search = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  /** undefined: nothing picked yet; ↓ or ↵ picks the first row. */
  const [idx, setIdx] = useState<number | undefined>();
  /** A second payment for a receipt that has one: picked once, linked on the next ↵ or click. */
  const [second, setSecond] = useState<Candidate>();
  /** «Privat oder bar bezahlt» picked: its form replaces the list. */
  const [privately, setPrivately] = useState(() => ui().linkStart === 'private');
  /** «Von Mitarbeitenden bezahlt» (#216): its form replaces the list. */
  const [byEmployee, setByEmployee] = useState(() => ui().linkStart === 'employee');
  const pass = useMemo(() => chipTest(chips, fields), [chips, fields]);
  const { best, more } = useMemo(() => candidates(v, l, chfOf(rates), q, chips.length ? (tx) => pass(rowOfTx(tx)) : undefined), [v, l, rates, q, chips.length, pass]);
  const unpaid = useMemo(() => bookingsWithoutPayment(v, l, q, chips.length ? (u) => pass(rowOfUnpaid(u)) : undefined), [v, l, q, chips.length, pass]);
  /** The best fits without the filter that it hides: said above the list. */
  const hidden = useMemo(() => (chips.length && !q ? hiddenBest(v, l, chfOf(rates), pass) : 0), [v, l, rates, q, chips.length, pass]);
  const rows = useMemo(() => [...l.txByRef.values()].filter((tx) => linkable(v, tx)).map(rowOfTx), [v, l]);
  function setChips(next: Chip[]) {
    setChipsNow(next); rememberAccounts(next); setIdx(undefined); setSecond(undefined);
  }
  const items: Array<Candidate | Unpaid | 'private'> = [...best, ...unpaid, ...more, 'private'];
  const at = idx === undefined ? -1 : Math.min(idx, items.length - 1);
  const paid = v.links.map((ref) => l.txByRef.get(ref)).filter((tx): tx is BankTransaction => !!tx);

  function choose(item: Candidate | Unpaid | 'private' | undefined) {
    if (!item) return;
    if (item === 'private') { setPrivately(true); return; }
    if (!('tx' in item)) { onClose(); linkPayment(nav, v, item.ref, bookingLine(item)); return; }
    if (noCorrection(item)) return;
    if (item.filed) { onClose(); correctFiled(nav, books, l, item.tx.ref, r.id); return; }
    if (paid.length && second !== item) { setSecond(item); return; }
    onClose();
    linkPayment(nav, v, item.tx.ref, txLine(item.tx), item.fit, paid.length > 0);
  }

  /** ⌥1…9 (by the key's place: ⌥1 types «¡» on a Mac) toggles a money account's chip, wherever the focus is in the dialog. */
  function onAccountKey(e: React.KeyboardEvent) {
    const n = e.altKey && !e.metaKey && !e.ctrlKey ? /^Digit([1-9])$/.exec(e.code)?.[1] : undefined;
    const next = n ? toggleAccount(chips, accounts, Number(n)) : undefined;
    if (!next) return;
    e.preventDefault();
    setChips(next);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const k = linkKey(idx, e.key, items.length);
    if (!k) return;
    e.preventDefault();
    if (k.kind === 'close') { e.stopPropagation(); onClose(); }
    else if (k.kind === 'pick') { setIdx(k.idx); setSecond(undefined); }
    else choose(items[k.idx]);
  }
  const pick = (i: number) => { if (i !== at) { setIdx(i); setSecond(undefined); } };

  let k = 0;
  const row = (c: Candidate) => {
    const i = k++;
    const w = why(c);
    return (
      <div key={c.tx.ref} className={`o tx2${i === at ? ' on' : ''}${c.filed ? ' filed' : ''}`} role="option" aria-selected={i === at} data-ref={c.tx.ref} data-filed={c.filed ? '' : undefined} onMouseMove={() => pick(i)} onClick={() => choose(c)}>
        <span className="d mono">{formatDate(c.tx.date)}</span>
        <span className="t"><span>{c.tx.description}</span><small>{bankOf(c.tx)}{w && ` · ${w}`}{i === at && c.fit?.kind === 'off' && <> · <b className="off">{fitText(c.fit)}</b></>}</small></span>
        <span className="a mono">{c.tx.currency !== baseCurrency() && <i>{c.tx.currency}</i>}{fmt(signed(c.tx))}</span>
      </div>
    );
  };
  const booking = (u: Unpaid) => {
    const i = k++;
    return (
      <div key={u.ref} className={`o tx2${i === at ? ' on' : ''}`} role="option" aria-selected={i === at} data-ref={u.ref} onMouseMove={() => pick(i)} onClick={() => choose(u)}>
        <span className="d mono">{formatDate(u.date)}</span>
        <span className="t"><span>{u.description}</span><small>{u.ref}{u.sameAmount && ` · ${t('receipts.whySameAmount')}`}</small></span>
        <span className="a mono">{u.currency !== baseCurrency() && <i>{u.currency}</i>}{fmt(u.amount)}</span>
      </div>
    );
  };
  const privateAt = best.length + more.length + unpaid.length;
  const picked = at >= 0 ? items[at] : undefined;
  const payment = picked && picked !== 'private' && 'tx' in picked ? picked : undefined;
  const enterDoes = at < 0 ? t('receipts.pickFirst')
    : payment && noCorrection(payment) ? t('receipts.noCorrection')
      : payment?.filed ? t('receipts.toCorrection')
      : second && second === picked ? t('receipts.confirmVerb') : t('receipts.linkVerbShort');

  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={onClose} />
      <div className="palette linkdlg" role="dialog" aria-label={t('receipts.linkPayment')} onKeyDown={onAccountKey}>
        <div className="ctx">
          <div><span className="lbl">{t('receipts.linkPayment')}</span><b>{v.vendor}</b> <span className="m">{v.desc}</span></div>
          <div className="mono">{v.date ? formatDate(v.date) : t('receipts.noDate')} · <b>{r.currency || baseCurrency()} {r.amount != null ? fmt(r.amount) : '—'}</b></div>
        </div>
        {paid.length > 0 && (
          <p className="warnline" data-testid="has-payment" style={{ margin: '8px 20px 0' }}>
            {second ? t('receipts.secondPaymentAsk', { what: txLine(second.tx) }) : t('receipts.hasPaymentAlready', { what: paid.map(txLine).join(', ') })}
          </p>
        )}
        {byEmployee ? <EmployeeForm v={v} nav={nav} onBack={() => setByEmployee(false)} onDone={onClose} />
          : privately ? <PrivateForm v={v} nav={nav} onBack={() => setPrivately(false)} onDone={onClose} /> : <>
        <input ref={search} autoFocus value={q} placeholder={t('receipts.linkSearch')} aria-label={t('receipts.linkSearch')} autoComplete="off" onChange={(e) => { setQ(e.target.value); setIdx(undefined); setSecond(undefined); }} onKeyDown={onKeyDown} />
        <div className="linkfilter">
          <ChipFilter fields={fields} rows={rows} chips={chips} onChips={(next) => { setChips(next); search.current?.focus(); }} />
          {accounts.length > 1 && (
            <div className="acctkeys" role="group" aria-label={t('chips.field.account')}>
              {accounts.slice(0, 9).map((a, i) => {
                const on = chips.some((c) => c.field === ACCOUNT && c.value === accountValue(a));
                return (
                  <button key={accountValue(a)} type="button" className={on ? 'on' : ''} aria-pressed={on} data-account={accountValue(a)} data-tip={t('receipts.accountKeyTip')}
                    onClick={() => { setChips(toggleAccount(chips, accounts, i + 1)!); search.current?.focus(); }}>
                    <span className="cap">⌥{i + 1}</span>{accountName(a)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {hidden > 0 && (
          <p className="hiddenbest" data-testid="best-hidden">
            {t('receipts.bestHidden', { n: hidden })}
            <button type="button" className="golink" onClick={() => { setChips([]); search.current?.focus(); }}>{t('chips.clearAll')}</button>
          </p>
        )}
        <div className="res" role="listbox">
          {best.length > 0 && <div className="gh">{t('receipts.bestFit')}</div>}
          {best.map(row)}
          {unpaid.length > 0 && <div className="gh">{t('receipts.bookingsWithoutPayment')}</div>}
          {unpaid.map(booking)}
          {more.length > 0 && <div className="gh">{q ? t('receipts.hits') : t('receipts.morePayments')}</div>}
          {more.map(row)}
          {!best.length && !more.length && <div className="none">{q ? t('receipts.noPaymentFits', { q }) : chips.length ? t('receipts.noPaymentInFilter') : t('receipts.noOpenPayment')}</div>}
          <div className="gh">{t('receipts.withoutBank')}</div>
          <div className={`o tx2${privateAt === at ? ' on' : ''}`} role="option" aria-selected={privateAt === at} data-ref="private" onMouseMove={() => pick(privateAt)} onClick={() => choose('private')}>
            <span className="d mono">{owner}</span>
            <span className="t"><span>{t('receipts.privatePaid')}</span><small>{t('receipts.privatePaidHint')}</small></span>
            <span className="a" />
          </div>
        </div>
        <div className="foot">
          <Kbd keys={['↑', '↓']} tip={t('receipts.pickTip')} /> {t('keys.select')}
          <Kbd keys={['↵']} tip={t('receipts.linkTip')} /> {enterDoes}
          <Kbd keys={[t('receipts.escKey')]} tip={t('receipts.closeTip')} /> {t('receipts.close')}
        </div>
        </>}
      </div>
    </>
  );
}
