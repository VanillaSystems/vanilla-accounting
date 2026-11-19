/**
 * A new entry by hand (the add button and N), or a correction of a filed one: date, Soll, Haben,
 * amount in CHF, VAT code and text, booked in the open period. A correction names the filed
 * quarter it corrects, so the Korrekturabrechnung (0535) declares it.
 *
 * «+ Zeile» makes it a Sammelbuchung (#567): one account on one side against several lines on the
 * other, each line booked as a pair with the shared account under one ref. The last line holds the
 * rest of the total until it is typed in; ↵ books only once the lines add up to the total. ⇄ swaps
 * the sides, and a date typed short («6.12.») is the form's year.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { localToday, parsePeriod, parseSwissDate } from '../../../accounting/periods.js';
import { firmCodes, formTakes, lookupVatCode } from '../../../accounting/vat-codes.js';
import type { RouteOf } from '../../shell/route.js';
import { getAccountMap } from '../../lib/accounts.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { at } from '../receipts/view.js';
import { bookPayment, createEntries, createEntry, createWithReversal } from './actions.js';
import { isAccrual, newYearAfter, reversalOf, reversedAsRule } from '../../../accounting/reversal.js';
import { PaymentField } from './PaymentField.js';
import { bookingDraft, type BookingLine } from '../../../accounting/manual-booking.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import type { JournalEntryInput } from '../../lib/api.js';
import { AccountField, unknownAccountText } from './AccountField.js';
import { VatCodeField } from '../codes/VatCodeField.js';
import { codeLabel } from '../codes/names.js';
import { listed, setUi, useUi, type Side, type Split, type SplitLine } from './state.js';
import { accountCorrectionCode, banksMoved, claimCode, correctionKinds, isNetRateSale, type CorrectionKind } from '../../../accounting/correction.js';
import { collectiveOf, correct, isBankAccount, isPrivateAccount, journalFor, receiptRateOf } from './commands.js';
import { baseCurrency, chargesVat, chart, vat, withoutInputTax } from '../../../engines/index.js';
import { correctionName } from '../../lib/vat-words.js';
import { chfAmount } from '../../../accounting/ledger.js';
import { toRappen, fromRappen } from '../../../accounting/rappen.js';
import type { JournalEntry } from '../../../types/index.js';
import { TagFields, tagsOfForm } from './TagFields.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';

type Props = AreaProps<RouteOf<'journal'>>;

const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) && s.trim() ? n : null; };
const otherSide = (s: Side): Side => (s === 'accountDebit' ? 'accountCredit' : 'accountDebit');
/** A sum in Rappen, so 216.20 + 300.00 is 516.20 and not 516.2000000001. */
const sum = (xs: readonly number[]) => fromRappen(xs.reduce((a, x) => a + toRappen(x), 0));

export function NewEntry(props: Props) {
  const { books, nav } = props;
  const s = useUi();
  const ws = useWorkspace();
  const form = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState('');
  const [round, setRound] = useState(0);
  const [, redraw] = useState(0);
  const [reverse, setReverse] = useState<boolean | undefined>(undefined);
  /** The person was told the entry moves a bank account without its payment, or books a collective account, and books it anyway with a second ↵. */
  const [sure, setSure] = useState(false);
  /** The last line's amount was typed in this round: it no longer holds the rest. */
  const ownRest = useRef(false);
  const autoCode = useRef<string>();
  const dimensions = ws?.dimensions ?? [];
  // A form started again (another kind of correction, a payment picked, ⇄, a line more) is read once it is there.
  useEffect(() => { ownRest.current = false; redraw((n) => n + 1); }, [round]);
  // The rest goes into the last line while she has not typed there (not while it has the focus: her typing is hers).
  useLayoutEffect(() => {
    const sp = s.overlay?.kind === 'new' ? s.overlay.split : undefined;
    const el = sp && (form.current?.elements.namedItem(`line-amount-${sp.lines.length - 1}`) as HTMLInputElement | null);
    if (!el || !sp.lines.at(-1)?.auto || ownRest.current || document.activeElement === el) return;
    const rest = typed().split?.lines.at(-1)?.amount;
    el.value = rest ? fmt(rest) : '';
  });
  if (s.overlay?.kind !== 'new') return null;
  const d = s.overlay.draft;
  const split = s.overlay.split;
  const close = () => { setSure(false); setUi({ overlay: null }); };
  const filed = d.corrects && parsePeriod(d.corrects, localToday());
  const tx = d.transactionRef ? books.transactions.find((x) => x.ref === d.transactionRef) : undefined;
  const year = (d.date ?? localToday()).slice(0, 4);
  const now = form.current ? typed() : { draft: d, split };
  // An accrual typed by hand may be reversed on the next 1.1. in the same step (treuhaender-27).
  const sides = { accountDebit: now.draft.accountDebit ?? '', accountCredit: now.draft.accountCredit ?? '' };
  const pairs = now.split ? linesOf(now.split, sides) : [sides];
  const accrual = !tx && !d.corrects && !split && isAccrual(sides) && !!now.draft.date;
  const reverseIt = accrual && (reverse ?? reversedAsRule(sides));
  const corrected = s.overlay.correcting && journalFor(books).byId.get(s.overlay.correcting.entry)?.e;
  const as = s.overlay.correcting?.as;
  const from = s.overlay.correcting?.from;
  const moved = tx ? [] : [...new Set(pairs.flatMap((p) => banksMoved(p, isBankAccount)))];
  // Debitoren and Kreditoren hold the open invoices and bills: an entry without a payment booked onto one is warned of, never refused (#567).
  const collective = tx || filed ? undefined : pairs.flatMap((p) => [p.accountDebit, p.accountCredit]).find((a) => collectiveOf(a));
  const accounts = getAccountMap();
  // The account the correction moves the amount to: the side that is not the filed entry's own.
  const movedTo = (dr: string, cr: string) => (corrected ? [dr, cr].find((a) => a && a !== corrected.accountDebit && a !== corrected.accountCredit) : undefined);
  // An account correction onto the owner's private account takes the input tax back with it (r4t-7); a net-rate sale moved off revenue takes its turnover back (r9n-24).
  const to = as === 'account' ? movedTo(sides.accountDebit, sides.accountCredit) : undefined;
  const privateTo = to && isPrivateAccount(to) ? to : undefined;
  const followCode = to && corrected ? accountCorrectionCode(corrected, to, isPrivateAccount) : undefined;
  const saleCorrected = !!corrected && isNetRateSale(corrected.vatCode);
  // A firm without input tax has none to take back or claim: its correction carries no such code, and the form says why.
  const noInputTax = withoutInputTax();
  // A VAT correction of a purchase without input tax whose receipt shows Swiss VAT claims it (r4c-37).
  const rate = corrected ? receiptRateOf(books, corrected, s.overlay.correcting?.from) : undefined;
  const claim = as === 'vat' && corrected && d.vatCode && d.vatCode === claimCode(corrected, d.accountDebit ?? '', rate) ? d.vatCode : undefined;
  const fx = !tx && d.exchangeCurrency && d.exchangeRate ? { currency: d.exchangeCurrency, rate: d.exchangeRate } : undefined;
  const currency = tx?.currency ?? fx?.currency ?? baseCurrency();
  const taxOf = (code: string | undefined) => (corrected && code ? fmt(Math.abs(vat().vatLine({ ...corrected, id: '', transactionRef: '', date: d.date ?? '', vatCode: code })?.tax ?? 0)) : '');

  /** The lines of a Sammelbuchung as pairs: the shared account on its side, the line's on the other. */
  function linesOf(sp: Split, shared: { accountDebit: string; accountCredit: string }): Array<{ accountDebit: string; accountCredit: string }> {
    return sp.lines.map((l) => ({ [sp.side]: shared[sp.side], [otherSide(sp.side)]: l.account } as { accountDebit: string; accountCredit: string }));
  }

  /** What the lines leave of the total; null without a total (the lines' sum is the entry then). */
  function restOfLines(): number | null {
    const now = typed();
    if (!now.split || !now.draft.amount) return null;
    return fromRappen(toRappen(now.draft.amount) - toRappen(sum(now.split.lines.map((l) => l.amount ?? 0))));
  }

  /** The private code goes into the VAT field while the field is empty or holds the one put there before. */
  function followPrivate() {
    const field = form.current?.elements.namedItem('vatCode') as HTMLInputElement | null;
    if (!field || as !== 'account' || !corrected) return;
    const f = Object.fromEntries(new FormData(form.current!)) as Record<string, string>;
    const to = movedTo(f.accountDebit.trim(), f.accountCredit.trim());
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

  /** What the fields hold now, so a payment picked (or dropped), ⇄ or a line more keeps what was typed. */
  function typed(): { draft: Partial<JournalEntryInput>; split?: Split } {
    const fd = new FormData(form.current!);
    const f = Object.fromEntries(fd) as Record<string, string>;
    const field = (k: string) => String(f[k] ?? '').trim();
    const draft: Partial<JournalEntryInput> = { ...d, date: parseSwissDate(field('date'), year) ?? d.date, accountDebit: field('accountDebit'), accountCredit: field('accountCredit'), amount: parseAmount(field('amount')) ?? undefined, vatCode: field('vatCode'), description: f.description ?? '', tags: tagsOfForm(fd, dimensions) };
    if (!split) return { draft };
    const lines = split.lines.map((l, i): SplitLine => {
      const amount = parseAmount(field(`line-amount-${i}`));
      const rest = l.auto && !ownRest.current && i === split.lines.length - 1;
      return { account: field(`line-account-${i}`), ...(amount !== null && !rest && { amount }), vatCode: field(`line-vat-${i}`), description: f[`line-text-${i}`] ?? '', ...(rest && { auto: true as const }) };
    });
    // The line that holds the rest takes what the total leaves of the others, whatever its field shows yet.
    const last = lines.at(-1);
    if (last?.auto && draft.amount) {
      const left = fromRappen(toRappen(draft.amount) - toRappen(sum(lines.slice(0, -1).map((l) => l.amount ?? 0))));
      if (left > 0) last.amount = left;
    }
    return { draft, split: { side: split.side, lines } };
  }

  /** The form drawn again from what it holds, with `change` applied: ⇄, a line more or less. */
  function again(change: (now: { draft: Partial<JournalEntryInput>; split?: Split }) => { draft: Partial<JournalEntryInput>; split?: Split }, focus?: string) {
    const next = change(typed());
    setUi({ overlay: { kind: 'new', draft: next.draft, ...(next.split && { split: next.split }), ...(s.overlay?.kind === 'new' && s.overlay.correcting && { correcting: s.overlay.correcting }) } });
    setRound(round + 1);
    setErr('');
    setSure(false);
    if (focus) setTimeout(() => form.current?.querySelector<HTMLInputElement>(`[name="${focus}"]`)?.focus());
  }

  /** ⇄: Soll and Haben change places; in a Sammelbuchung the shared account goes to the other side. */
  const swap = () => again(({ draft, split }) => ({
    draft: split ? draft : { ...draft, accountDebit: draft.accountCredit, accountCredit: draft.accountDebit },
    ...(split && { split: { ...split, side: otherSide(split.side) } }),
  }));

  /**
   * «+ Zeile»: a single entry becomes a Sammelbuchung, its amount the total. The side kept is the one
   * typed alone, else the bank's, else Haben; the other side's account is the first line. A
   * Sammelbuchung gets a line more, which holds the rest.
   */
  function addLine() {
    let focus = '';
    again(({ draft, split }) => {
      if (split) {
        const lines: SplitLine[] = [...split.lines.map(({ auto: _a, ...l }) => l), { account: '', description: '', auto: true }];
        focus = `line-account-${lines.length - 1}`;
        return { draft, split: { ...split, lines } };
      }
      const dr = draft.accountDebit ?? '';
      const cr = draft.accountCredit ?? '';
      const side: Side = dr && !cr ? 'accountDebit' : cr && !dr ? 'accountCredit' : isBankAccount(dr) && !isBankAccount(cr) ? 'accountDebit' : 'accountCredit';
      const first: SplitLine = { account: draft[otherSide(side)] ?? '', ...(draft.amount && { amount: draft.amount }), vatCode: draft.vatCode ?? '', description: '' };
      focus = first.account ? 'line-account-1' : 'line-account-0';
      return { draft: { ...draft, [otherSide(side)]: '', vatCode: '' }, split: { side, lines: [first, { account: '', description: '', auto: true }] } };
    }, undefined);
    setTimeout(() => form.current?.querySelector<HTMLInputElement>(`[name="${focus}"]`)?.focus());
  }

  /** × on a line; the last one gone, the entry is a single one again with the line's account and code. */
  const removeLine = (i: number) => again(({ draft, split }) => {
    if (!split) return { draft };
    const lines = split.lines.filter((_, j) => j !== i);
    if (lines.length > 1) return { draft, split: { ...split, lines } };
    const [only] = lines;
    return { draft: { ...draft, [otherSide(split.side)]: only?.account ?? '', vatCode: only?.vatCode ?? '', amount: draft.amount ?? only?.amount } };
  });

  /** A pick from the payments: the entry books it, on its date, its amount and bank side filled where empty. */
  function pickPayment(ref: string | undefined) {
    const { draft: now, split: sp } = typed();
    const p = ref ? books.transactions.find((x) => x.ref === ref) : undefined;
    const draft = p && ws ? bookingDraft(books, p.ref, ws.bankAccounts) : undefined;
    const next: Partial<JournalEntryInput> = p
      ? { ...now, transactionRef: p.ref, date: p.date, amount: now.amount || draft?.lines[0]?.amount || p.amount, description: now.description || draft?.lines[0]?.description || p.description }
      : { ...now, transactionRef: undefined };
    if (draft?.bank && !next[draft.bank.side] && (!sp || sp.side === draft.bank.side)) next[draft.bank.side] = draft.bank.account;
    setUi({ overlay: { kind: 'new', draft: next, ...(sp && { split: sp }) } });
    setRound(round + 1);
    setErr('');
  }

  /** Why the fields cannot be booked, in words; '' when they can. */
  function problemOf(date: string | null, pairs: ReadonlyArray<{ accountDebit: string; accountCredit: string; vat: string; amount: number | null; text: string }>, total: number | null): string {
    const closed = books.config?.closedThrough;
    const known = getAccountMap();
    const all = pairs.flatMap((p) => [p.accountDebit, p.accountCredit]);
    const unknown = all.find((n) => n && !known[n]);
    const unplaced = all.find((n) => n && !chart().isPlaced(n));
    if (!date && !tx) return t('journal.errDate');
    if (!tx && closed && date! <= closed) return t(chargesVat() ? 'journal.errFiledDate' : 'journal.errClosedDate', { date: formatDate(closed) });
    if (unknown) return unknownAccountText(unknown);
    if (unplaced) return t('error.accountOutsideStatements', { account: unplaced, classes: chart().placedClasses });
    for (const [i, p] of pairs.entries()) {
      if (!p.accountDebit && !p.accountCredit) return t('journal.errNoAccount');
      if (split && (!p.accountDebit || !p.accountCredit)) return t('journal.byHand.errLegs', { n: i + 1 });
      if (p.vat && !lookupVatCode(p.vat)) return t('journal.errVat', { code: p.vat });
      if (p.vat && !formTakes(p.vat)) return t(`journal.errVatNotTaken.${noInputTax ?? 'none'}`, { code: p.vat });
      if (!p.amount) return t('journal.errAmount');
      if (!p.text) return t('journal.errText');
    }
    if (split && total) {
      const rest = fromRappen(toRappen(total) - toRappen(sum(pairs.map((p) => p.amount ?? 0))));
      if (rest) return t(rest > 0 ? 'journal.split.errRest' : 'journal.split.errOver', { currency, amount: fmt(Math.abs(rest)) });
    }
    return '';
  }

  async function book() {
    const fd = new FormData(form.current!);
    const f = Object.fromEntries(fd) as Record<string, string>;
    const date = parseSwissDate(f.date, year);
    const amount = parseAmount(f.amount);
    const [dr, cr, vat, text] = [f.accountDebit.trim(), f.accountCredit.trim(), (f.vatCode ?? '').trim(), f.description.trim()];
    const tags = tagsOfForm(fd, dimensions);
    const lines = typed().split?.lines;
    const pairs = split && lines
      ? lines.map((l) => ({ ...linesOf({ side: split.side, lines: [l] }, { accountDebit: dr, accountCredit: cr })[0], vat: l.vatCode ?? '', amount: l.amount ?? null, text: (l.description ?? '').trim() || text }))
      : [{ accountDebit: dr, accountCredit: cr, vat, amount, text }];
    const problem = problemOf(date, pairs, amount);
    if (problem) { setErr(problem); return; }
    const warned = moved.length > 0 || !!collective;
    if (warned && !sure) { setSure(true); setErr(t(moved.length ? 'journal.movesBankAgain' : 'journal.collectiveAgain')); return; }
    const booking: BookingLine[] = pairs.map((p) => ({ accountDebit: p.accountDebit, accountCredit: p.accountCredit, amount: p.amount!, ...(p.vat && { vatCode: p.vat }), description: p.text, ...(tags && { tags }) }));
    if (tx) {
      const entries = await bookPayment(nav, tx.ref, booking);
      if (!entries?.length) return;
      close();
      listed.pending = entries[0].id;
      nav.go(at({ area: 'journal', id: entries[0].id }, entries[0].date, props.period));
      return;
    }
    close();
    if (split) {
      const entries = await createEntries(nav, date!, booking);
      if (!entries?.length) return;
      listed.pending = entries[0].id;
      nav.go(at({ area: 'journal', id: entries[0].id }, entries[0].date, props.period));
      return;
    }
    const input: JournalEntryInput = {
      date: date!, accountDebit: dr, accountCredit: cr, amount: amount!, description: text, ...(vat && { vatCode: vat }), ...(d.corrects && { corrects: d.corrects }), ...(tags && { tags }),
      // A correction or reversal of a foreign-currency entry keeps its currency and rate: the amount typed is in that currency (r9c-1).
      ...(fx && { exchangeCurrency: fx.currency, exchangeRate: fx.rate }),
      ...(d.corrects && corrected && as && { correctsEntry: corrected.id, correction: as }),
      // Opened from a late receipt of the filed payment: the correction is its booking (r10h-6).
      ...(d.corrects && from && { receipt: from }),
    };
    const entry = reverseIt
      ? await createWithReversal(nav, input, { ...reversalOf(input, newYearAfter(date!), t('journal.accrualText', { text, year: date!.slice(0, 4) })), ...(tags && { tags }) })
      : await createEntry(nav, input);
    if (!entry) return;
    listed.pending = entry.id;
    nav.go(at({ area: 'journal', id: entry.id }, entry.date, props.period));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); book(); }
  }

  /** A short date («6.12.», «6.12.26») is shown whole once the field is left, so she sees the day it is. */
  function completeDate(e: React.FocusEvent<HTMLInputElement>) {
    const day = parseSwissDate(e.currentTarget.value, year);
    if (day) e.currentTarget.value = formatDate(day);
  }

  function onInput(e: React.FormEvent) {
    const name = (e.target as HTMLInputElement).name;
    if (split && name === `line-amount-${split.lines.length - 1}`) ownRest.current = true;
    followPrivate();
    redraw((n) => n + 1);
    setSure(false);
    if (err === t('journal.movesBankAgain') || err === t('journal.collectiveAgain')) setErr('');
  }

  const rest = split ? restOfLines() : null;
  const lineSum = split ? sum((now.split?.lines ?? []).map((l) => l.amount ?? 0)) : 0;
  const swapButton = <button type="button" className="jswap" data-act="swap-sides" aria-label={t('journal.swapSides')} data-tip={t('journal.swapSides')} onClick={swap}>⇄</button>;
  const sideLabel = (side: Side) => t(`journal.field.${side}`);

  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={close} />
      <div className={`palette jnew${split ? ' split' : ''}`} role="dialog" aria-label={filed ? t('journal.correctionTitle') : t('journal.addTitle')}>
        <div className="ctx">
          <div><span className="lbl">{filed ? t('journal.correctionTitle') : split ? t('journal.split.title') : t('journal.addTitle')}</span>{filed ? t(noInputTax === 'none' ? 'journal.correctionHintUnregistered' : 'journal.correctionHint', { filed: periodName(filed), correction: correctionName() }) : split ? t('journal.split.hint') : t('journal.addHint')}</div>
          {corrected && as && (
            <div className="jcorr">
              <span className="seg" role="tablist" aria-label={t('journal.correctionLead')}>
                <span className="m">{t('journal.correctionLead')}</span>
                {correctionKinds(corrected).map((k) => (
                  <button key={k} type="button" role="tab" aria-selected={k === as} className={k === as ? 'on' : ''} data-correct={k} onClick={() => correctAs(k)}>{t(`journal.correctionAs.${k}`)}</button>
                ))}
              </span>
              <p className="m" data-testid="correction-how">{claim
                ? t('journal.correctionHow.claim', { rate: String(rate), code: codeLabel(claim), tax: taxOf(claim), was: corrected.vatCode ? codeLabel(corrected.vatCode) : '' })
                : as === 'account' && saleCorrected ? t('journal.correctionHowNetRateSale', { code: corrected.vatCode ?? '', turned: `-${corrected.vatCode ?? ''}` })
                : as === 'account' && noInputTax ? t(`journal.correctionHowNoInputTax.${noInputTax}`)
                  : t(`journal.correctionHow.${as}`, { account: as === 'vat' ? (d.accountDebit ?? '') : '', code: corrected.vatCode ?? '', side: t(chart().typeOf(corrected.accountCredit) === 'revenue' ? 'journal.correctionSide.revenue' : 'journal.correctionSide.expense') })}</p>
            </div>
          )}
        </div>
        <AsyncForm key={round} ref={form} className="form" autoComplete="off" onKeyDown={onKeyDown} onInput={onInput} onSubmit={(e) => { e.preventDefault(); return book(); }}>
          {!filed && <PaymentField books={books} picked={tx} amount={d.amount} onPick={pickPayment} />}
          <div className="two">
            <label>{t('journal.field.date')}<input className="mono" name="date" defaultValue={formatDate(d.date ?? localToday())} readOnly={!!tx} data-tip={tx ? t('journal.payment.dateIs') : t('journal.dateShortTip')} autoFocus={!round} onBlur={completeDate} /></label>
            <label>{split ? t('journal.split.totalIn', { currency }) : t('journal.amountIn', { currency })}<input className="mono" name="amount" defaultValue={d.amount ? fmt(d.amount) : ''} style={{ textAlign: 'right' }} autoFocus={!!round && !split} placeholder={split ? t('journal.split.totalPlaceholder') : undefined} />
              {fx && now.draft.amount ? <span className="m" data-testid="fx-line">{t('journal.fxLine', { chf: fmt(chfAmount({ amount: now.draft.amount, exchangeCurrency: fx.currency, exchangeRate: fx.rate } as JournalEntry)), rate: String(fx.rate) })}</span> : null}
            </label>
          </div>
          {split ? (
            <>
              <div className="jsides one">
                <AccountField name={split.side} label={t('journal.split.shared', { side: sideLabel(split.side) })} defaultValue={d[split.side] ?? ''} />
                {swapButton}
                <input type="hidden" name={otherSide(split.side)} value="" />
                <label>{t('journal.split.text')}<input name="description" defaultValue={d.description ?? ''} /></label>
              </div>
              <div className="jlines" data-testid="split-lines">
                {split.lines.map((l, i) => (
                  <div key={i} className="jline" data-line={i}>
                    <AccountField name={`line-account-${i}`} label={sideLabel(otherSide(split.side))} defaultValue={l.account} />
                    <label>{t('journal.field.description')}<input name={`line-text-${i}`} defaultValue={l.description ?? ''} placeholder={now.draft.description || t('journal.split.textPlaceholder')} /></label>
                    {firmCodes().length ? <VatCodeField name={`line-vat-${i}`} label={t('journal.field.vatCode')} defaultValue={l.vatCode ?? ''} placeholder={t('journal.vatPlaceholder')} /> : <span />}
                    <label>{t('journal.amountIn', { currency })}<input className="mono" name={`line-amount-${i}`} defaultValue={l.amount !== undefined && !l.auto ? fmt(l.amount) : ''} style={{ textAlign: 'right' }} data-rest={l.auto && !ownRest.current ? '' : undefined} /></label>
                    <button type="button" className="rm" aria-label={t('journal.byHand.removeLine')} onClick={() => removeLine(i)}>×</button>
                  </div>
                ))}
              </div>
              <div className="jsplitf">
                <button type="button" className="addlink" data-act="add-line" data-tip={t('journal.split.addLineTip')} onClick={addLine}>+ {t('journal.byHand.addLine')}</button>
                <span className={rest ? 'wn' : 'ok'} data-testid="split-rest">
                  {rest === null ? t('journal.split.sum', { currency, amount: fmt(lineSum) })
                    : rest > 0 ? t('journal.byHand.rest', { currency, amount: fmt(rest) })
                      : rest < 0 ? t('journal.byHand.over', { currency, amount: fmt(-rest) })
                        : t('journal.split.adds', { currency, amount: fmt(lineSum) })}
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="jsides">
                <AccountField name="accountDebit" label={t('journal.field.accountDebit')} defaultValue={d.accountDebit ?? ''} />
                {swapButton}
                <AccountField name="accountCredit" label={t('journal.field.accountCredit')} defaultValue={d.accountCredit ?? ''} />
              </div>
              {firmCodes().length ? (
                <div className="two">
                  <VatCodeField name="vatCode" label={t('journal.field.vatCode')} defaultValue={d.vatCode ?? ''} placeholder={t('journal.vatPlaceholder')} />
                  {filed ? <span /> : <span className="jaddl"><button type="button" className="addlink" data-act="add-line" data-tip={t('journal.split.startTip')} onClick={addLine}>+ {t('journal.byHand.addLine')}</button></span>}
                </div>
              ) : filed ? null : <button type="button" className="addlink" data-act="add-line" data-tip={t('journal.split.startTip')} onClick={addLine}>+ {t('journal.byHand.addLine')}</button>}
            </>
          )}
          {split ? null : <label>{t('journal.field.description')}<input name="description" defaultValue={d.description ?? ''} /></label>}
          <TagFields dimensions={dimensions} entries={books.journalEntries ?? []} tags={d.tags} />
          {accrual && (
            <label className="jrev" data-testid="reverse-on-new-year">
              <input type="checkbox" checked={reverseIt} onChange={(e) => setReverse(e.target.checked)} />
              {t('journal.reverseNewYear', { date: formatDate(newYearAfter(now.draft.date!)) })}
            </label>
          )}
          {followCode && saleCorrected && (
            <div className="notice" data-testid="correction-no-sale">
              {t('journal.correctionNoSale', { account: `${to} ${accounts[to!] ?? ''}`.trim(), amount: fmt(corrected!.amount), tax: taxOf(corrected!.vatCode), code: followCode ? codeLabel(followCode) : '' })}
            </div>
          )}
          {followCode && !saleCorrected && (
            <div className="notice" data-testid="correction-private">
              {t('journal.correctionPrivate', { account: `${privateTo} ${accounts[privateTo!] ?? ''}`.trim(), tax: taxOf(corrected!.vatCode), was: corrected!.vatCode ? codeLabel(corrected!.vatCode) : '', code: followCode ? codeLabel(followCode) : '' })}
            </div>
          )}
          {privateTo && noInputTax && !saleCorrected && (
            <div className="notice" data-testid="correction-no-input-tax">
              {t(`journal.correctionPrivateNoInputTax.${noInputTax}`, { account: `${privateTo} ${accounts[privateTo] ?? ''}`.trim() })}
            </div>
          )}
          {moved.length > 0 && (
            <div className="notice warn" data-testid="moves-bank">
              {t(filed ? 'journal.movesBankCorrection' : 'journal.movesBank', { account: `${moved[0]} ${accounts[moved[0]] ?? ''}`.trim(), amount: fmt((split ? (now.draft.amount ?? lineSum) : now.draft.amount) ?? 0) })}
            </div>
          )}
          {collective && (
            <div className="notice warn" data-testid="collective-account">
              {t(`journal.collective.${collectiveOf(collective)!}`, { account: `${collective} ${accounts[collective] ?? ''}`.trim() })}
            </div>
          )}
          <div className="err" role="alert">{err}</div>
          <div className="dacts">
            <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')} <span className="k">{t('codes.escKey')}</span></button>
            <AsyncButton type="submit" className="btn primary">{sure ? t('journal.bookAnyway') : t('journal.book')} <span className="k">↵</span></AsyncButton>
          </div>
        </AsyncForm>
      </div>
    </>
  );
}
