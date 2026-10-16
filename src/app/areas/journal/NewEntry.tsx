/**
 * A new entry by hand (the add button and N), or a correction of a filed one: date, Soll, Haben,
 * amount in CHF, VAT code and text, booked in the open period. A correction names the filed
 * quarter it corrects, so the Korrekturabrechnung (0535) declares it.
 */
import { useEffect, useRef, useState } from 'react';
import { localToday, parsePeriod, parseSwissDate } from '../../../accounting/periods.js';
import { formTakes, lookupVatCode } from '../../../accounting/vat-codes.js';
import type { RouteOf } from '../../shell/route.js';
import { getAccountMap } from '../../lib/accounts.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { at } from '../receipts/view.js';
import { bookPayment, createEntry, createWithReversal } from './actions.js';
import { isAccrual, newYearAfter, reversalOf, reversedAsRule } from '../../../accounting/reversal.js';
import { PaymentField } from './PaymentField.js';
import { bookingDraft } from '../../../accounting/manual-booking.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import type { JournalEntryInput } from '../../lib/api.js';
import { AccountField } from './AccountField.js';
import { VatCodeList } from './Detail.js';
import { listed, setUi, useUi } from './state.js';
import { accountCorrectionCode, banksMoved, claimCode, correctionKinds, type CorrectionKind } from '../../../accounting/correction.js';
import { correct, isBankAccount, isPrivateAccount, journalFor, receiptRateOf } from './commands.js';
import { baseCurrency, chart, vat, withoutInputTax } from '../../../engines/index.js';
import { correctionName } from '../../lib/vat-words.js';

type Props = AreaProps<RouteOf<'journal'>>;

const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) && s.trim() ? n : null; };

export function NewEntry(props: Props) {
  const { books, nav } = props;
  const s = useUi();
  const ws = useWorkspace();
  const form = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState('');
  const [round, setRound] = useState(0);
  const [, redraw] = useState(0);
  const [reverse, setReverse] = useState<boolean | undefined>(undefined);
  /** The person was told the entry moves a bank account without its payment, and books it anyway with a second ↵. */
  const [sure, setSure] = useState(false);
  const autoCode = useRef<string>();
  // A form started again (another kind of correction, a payment picked) is read once it is there.
  useEffect(() => redraw((n) => n + 1), [round]);
  if (s.overlay?.kind !== 'new') return null;
  const d = s.overlay.draft;
  const close = () => { setSure(false); setUi({ overlay: null }); };
  const filed = d.corrects && parsePeriod(d.corrects, localToday());
  const tx = d.transactionRef ? books.transactions.find((x) => x.ref === d.transactionRef) : undefined;
  const now = form.current ? typed() : d;
  // An accrual typed by hand may be reversed on the next 1.1. in the same step (treuhaender-27).
  const sides = { accountDebit: now.accountDebit ?? '', accountCredit: now.accountCredit ?? '' };
  const accrual = !tx && !d.corrects && isAccrual(sides) && !!now.date;
  const reverseIt = accrual && (reverse ?? reversedAsRule(sides));
  const corrected = s.overlay.correcting && journalFor(books).byId.get(s.overlay.correcting.entry)?.e;
  const as = s.overlay.correcting?.as;
  const moved = tx ? [] : banksMoved(sides, isBankAccount);
  const accounts = getAccountMap();
  // An account correction onto the owner's private account takes the input tax back with it (r4t-7).
  const privateTo = as === 'account' && corrected ? [sides.accountDebit, sides.accountCredit].find(isPrivateAccount) : undefined;
  const privateCode = privateTo && corrected ? accountCorrectionCode(corrected, privateTo, isPrivateAccount) : undefined;
  // A firm without input tax has none to take back or claim: its correction carries no such code, and the form says why.
  const noInputTax = withoutInputTax();
  // A VAT correction of a purchase without input tax whose receipt shows Swiss VAT claims it (r4c-37).
  const rate = corrected ? receiptRateOf(books, corrected, s.overlay.correcting?.from) : undefined;
  const claim = as === 'vat' && corrected && d.vatCode && d.vatCode === claimCode(corrected, d.accountDebit ?? '', rate) ? d.vatCode : undefined;
  const taxOf = (code: string | undefined) => (corrected && code ? fmt(Math.abs(vat().vatLine({ ...corrected, id: '', transactionRef: '', date: d.date ?? '', vatCode: code })?.tax ?? 0)) : '');

  /** The private code goes into the VAT field while the field is empty or holds the one put there before. */
  function followPrivate() {
    const field = form.current?.elements.namedItem('vatCode') as HTMLInputElement | null;
    if (!field || as !== 'account' || !corrected) return;
    const f = Object.fromEntries(new FormData(form.current!)) as Record<string, string>;
    const to = [f.accountDebit.trim(), f.accountCredit.trim()].find(isPrivateAccount);
    const code = to ? accountCorrectionCode(corrected, to, isPrivateAccount) : undefined;
    if (code && !field.value.trim()) { field.value = code; autoCode.current = code; }
    else if (!code && autoCode.current && field.value.trim() === autoCode.current) { field.value = ''; autoCode.current = undefined; }
  }

  /** Another kind of correction: the form starts again from the filed entry. */
  function correctAs(kind: CorrectionKind) {
    if (!corrected || kind === as) return;
    correct(books, corrected, kind, s.overlay?.kind === 'new' ? s.overlay.correcting?.from : undefined);
    setRound(round + 1);
    setErr('');
    setSure(false);
  }

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
    const amount = parseAmount(f.amount);
    const [dr, cr, vat, text] = [f.accountDebit.trim(), f.accountCredit.trim(), f.vatCode.trim(), f.description.trim()];
    const problem = !date && !tx ? t('journal.errDate')
      : !tx && closed && date! <= closed ? t('journal.errFiledDate', { date: formatDate(closed) })
      : [dr, cr].find((n) => n && !accounts[n]) ? t('journal.errAccount', { account: [dr, cr].find((n) => n && !accounts[n])! })
      : [dr, cr].find((n) => n && !chart().isPlaced(n)) ? t('error.accountOutsideStatements', { account: [dr, cr].find((n) => n && !chart().isPlaced(n))!, classes: chart().placedClasses })
      : !dr && !cr ? t('journal.errNoAccount')
      : vat && !lookupVatCode(vat) ? t('journal.errVat', { code: vat })
      : vat && !formTakes(vat) ? t(`journal.errVatNotTaken.${noInputTax ?? 'none'}`, { code: vat })
      : !amount ? t('journal.errAmount')
      : !text ? t('journal.errText')
      : '';
    if (problem) { setErr(problem); return; }
    if (!tx && banksMoved({ accountDebit: dr, accountCredit: cr }, isBankAccount).length && !sure) { setSure(true); setErr(t('journal.movesBankAgain')); return; }
    if (tx) {
      const entries = await bookPayment(nav, tx.ref, [{ accountDebit: dr, accountCredit: cr, amount: amount!, ...(vat && { vatCode: vat }), description: text }]);
      if (!entries?.length) return;
      close();
      listed.pending = entries[0].id;
      nav.go(at({ area: 'journal', id: entries[0].id }, entries[0].date, props.period));
      return;
    }
    close();
    const input: JournalEntryInput = { date: date!, accountDebit: dr, accountCredit: cr, amount: amount!, description: text, ...(vat && { vatCode: vat }), ...(d.corrects && { corrects: d.corrects }) };
    const entry = reverseIt
      ? await createWithReversal(nav, input, reversalOf(input, newYearAfter(date!), t('journal.accrualText', { text, year: date!.slice(0, 4) })))
      : await createEntry(nav, input);
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
          <div><span className="lbl">{filed ? t('journal.correctionTitle') : t('journal.addTitle')}</span>{filed ? t(noInputTax === 'none' ? 'journal.correctionHintUnregistered' : 'journal.correctionHint', { filed: periodName(filed), correction: correctionName() }) : t('journal.addHint')}</div>
          {corrected && as && (
            <div className="jcorr">
              <span className="seg" role="tablist" aria-label={t('journal.correctionLead')}>
                <span className="m">{t('journal.correctionLead')}</span>
                {correctionKinds(corrected).map((k) => (
                  <button key={k} type="button" role="tab" aria-selected={k === as} className={k === as ? 'on' : ''} data-correct={k} onClick={() => correctAs(k)}>{t(`journal.correctionAs.${k}`)}</button>
                ))}
              </span>
              <p className="m" data-testid="correction-how">{claim
                ? t('journal.correctionHow.claim', { rate: String(rate), code: claim, tax: taxOf(claim), was: corrected.vatCode ?? '' })
                : as === 'account' && noInputTax ? t(`journal.correctionHowNoInputTax.${noInputTax}`)
                  : t(`journal.correctionHow.${as}`, { account: as === 'vat' ? (d.accountDebit ?? '') : '', code: corrected.vatCode ?? '' })}</p>
            </div>
          )}
        </div>
        <form key={round} ref={form} className="form" autoComplete="off" onKeyDown={onKeyDown} onInput={() => { followPrivate(); redraw((n) => n + 1); setSure(false); if (err === t('journal.movesBankAgain')) setErr(''); }} onSubmit={(e) => { e.preventDefault(); book(); }}>
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
          {accrual && (
            <label className="jrev" data-testid="reverse-on-new-year">
              <input type="checkbox" checked={reverseIt} onChange={(e) => setReverse(e.target.checked)} />
              {t('journal.reverseNewYear', { date: formatDate(newYearAfter(now.date!)) })}
            </label>
          )}
          <VatCodeList />
          {privateCode && (
            <div className="notice" data-testid="correction-private">
              {t('journal.correctionPrivate', { account: `${privateTo} ${accounts[privateTo!] ?? ''}`.trim(), tax: taxOf(corrected!.vatCode), was: corrected!.vatCode ?? '', code: privateCode })}
            </div>
          )}
          {privateTo && noInputTax && (
            <div className="notice" data-testid="correction-no-input-tax">
              {t(`journal.correctionPrivateNoInputTax.${noInputTax}`, { account: `${privateTo} ${accounts[privateTo] ?? ''}`.trim() })}
            </div>
          )}
          {moved.length > 0 && (
            <div className="notice warn" data-testid="moves-bank">
              {t(filed ? 'journal.movesBankCorrection' : 'journal.movesBank', { account: `${moved[0]} ${accounts[moved[0]] ?? ''}`.trim(), amount: fmt(now.amount ?? 0) })}
            </div>
          )}
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
