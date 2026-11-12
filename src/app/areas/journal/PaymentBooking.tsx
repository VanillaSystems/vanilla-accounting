/**
 * A payment without a booking, booked by hand right where it shows (Kontoauszüge, the task «Bewegung
 * von Hand buchen», a receipt's payment): Soll, Haben, VAT code (a code, or a rate as typed), amount
 * and text per line, on the payment's date. It opens with what code knows (bookingDraft): the bank
 * side, and the other side proposed from a company rule, the business's last booking, the linked
 * receipt or the firm's default accounts, each proposal named with its source (#344). The lines must
 * add up to the payment, and ↵ books them through the API as a person's entries: nothing before.
 * Below it, the faster way for payments of the same kind: a rule started from this one (RuleWay).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Index, JournalEntry } from '../../../types/index.js';
import { formDraft, inputTaxWithoutReceipt, restOf, unattachedFor, type BookingDraft, type BookingLine, type DraftLine, type DraftSource, type Unattached as UnattachedBooking } from '../../../accounting/manual-booking.js';
import type { HandStart } from '../../../saving/hand-rule.js';
import { api } from '../../lib/api.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { firmCodes, formTakes, lookupVatCode, parseRate, vatCodeOf } from '../../../accounting/vat-codes.js';
import { withoutInputTax } from '../../../engines/index.js';
import { codeLabel, codeText } from '../codes/names.js';
import { isVatAmountCode } from '../../../accounting/validate.js';
import { getAccountMap } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { AccountField, unknownAccountText } from './AccountField.js';
import { VatCodeField } from '../codes/VatCodeField.js';
import { attachEntries, bookPayment } from './actions.js';
import { useInvoices } from '../invoices/data.js';
import { Go } from '../vat/links.js';
import { at } from '../receipts/view.js';
import { TagFields, tagsOfForm } from './TagFields.js';
import type { Dimension } from '../../../books/tags.js';

const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) && s.trim() ? n : null; };
const FIELDS = ['accountDebit', 'accountCredit', 'vatCode', 'amount', 'description'] as const;
type Row = { key: number; init: DraftLine };

type Props = {
  books: Index; nav: Nav; payment: string; narrow?: boolean;
  /** False where the way to a rule is offered beside the form already. */
  canRule?: boolean;
  /** The form, for a «Gebucht» elsewhere that should bring the person here. */
  onForm?(el: HTMLFormElement | null): void;
  onBooked?(entries: JournalEntry[]): void;
};

/** Waits for the workspace's bank accounts: the first lines put the bank on its side. */
export function PaymentBooking(props: Props) {
  const ws = useWorkspace();
  const inv = useInvoices();
  const invoices = inv.state === 'ready' ? inv.data.invoices : inv.state === 'loading' ? 'loading' : undefined;
  // The form's rows are set once from the draft, so it waits for the invoices too (formDraft, r9c-4).
  // What the server knows of the payment: the company rule that decides it, and how many payments a rule started from it would hold for.
  const [start, setStart] = useState<HandStart | null>();
  useEffect(() => {
    let live = true;
    setStart(undefined);
    api.handStart(props.payment).then((r) => { if (live) setStart(r.start); }, () => { if (live) setStart(null); });
    return () => { live = false; };
  }, [props.payment, props.books]);
  const rule = start?.rule;
  const draft = useMemo(() => ws && formDraft(props.books, props.payment, ws.bankAccounts, invoices, { defaults: ws.defaults, rule }), [ws, props.books, props.payment, invoices, rule]);
  const typed = useMemo(() => (ws ? unattachedFor(props.books, props.payment, ws.bankAccounts) : []), [ws, props.books, props.payment]);
  if (!ws || !draft) return null;
  const defaults = ws.defaults ? [...new Set([ws.defaults.sales, ...ws.defaults.all.sales.map((x) => x.account), ...ws.defaults.all.purchase.map((x) => x.account)])] : [];
  return (
    <>
      {typed.length ? <Unattached {...props} typed={typed} /> : null}
      <BookingForm {...props} accounts={ws.bankAccounts} draft={draft} dimensions={ws.dimensions ?? []} defaults={defaults} />
      {props.canRule !== false && start ? <RuleWay nav={props.nav} payment={props.payment} start={start} /> : null}
    </>
  );
}

/**
 * The faster way than one form per payment (#344): a rule for payments of this kind, started from
 * this one in Firma › Regeln (src/saving/hand-rule.ts), where its card shows every payment it
 * would book before anything is kept. It says how many unbooked payments are of the kind.
 */
function RuleWay({ nav, payment, start }: { nav: Nav; payment: string; start: HandStart }) {
  if (start.rule) return null;
  const n = start.similar ?? 1;
  const what = start.match.kind === 'text' ? start.match.text : start.name;
  return (
    <p className="pbr" data-testid="task-make-rule" data-similar={n}>
      <span>{n > 1 ? t('journal.byHand.ruleMany', { n, what }) : t('journal.byHand.ruleOne')}</span>{' '}
      <Go to={{ route: { area: 'company', section: 'rules' }, query: { payment } }} nav={nav} className="btn ghost">{n > 1 ? t('journal.byHand.ruleManyGo', { n }) : t('journal.byHand.ruleOneGo')}</Go>
      {start.wider ? (
        <span data-testid="task-make-rule-wider" data-similar={start.wider.similar}>
          <Go to={{ route: { area: 'company', section: 'rules' }, query: { payment, by: 'text' } }} nav={nav} className="golink">{t('journal.byHand.ruleWider', { n: start.wider.similar, text: start.wider.text })}</Go>
        </span>
      ) : null}
    </p>
  );
}

/** A line's proposals in a few words, each with where it comes from: the account («Standardkonto für Verkäufe»), the tax code («aus dem Beleg»). */
function sourceText(s: DraftSource, init: DraftLine, bankSide: 'accountDebit' | 'accountCredit' | undefined): string {
  const account = bankSide === 'accountDebit' ? init.accountCredit : init.accountDebit;
  const name = getAccountMap()[account];
  const a = s.account;
  const from = !a ? '' : a.from === 'rule' ? t('journal.byHand.from.rule', { rule: a.rule })
    : a.from === 'precedent' ? t('journal.byHand.from.precedent', { date: formatDate(a.date) })
      : t(`journal.byHand.from.${a.from}`);
  const v = s.vat;
  const vatFrom = !v ? '' : v.from === 'sale' ? t(`journal.byHand.from.sale.${v.choice === 'saleAbroad' ? 'abroad' : 'domestic'}`) : t(`journal.byHand.from.vat.${v.from}`);
  return [
    a && t('journal.byHand.proposedAccount', { account: name ? `${account} ${name}` : account, from }),
    v && init.vat && t('journal.byHand.proposedVat', { code: lookupVatCode(init.vat) ? codeLabel(init.vat) : `${init.vat} %`, from: vatFrom }),
  ].filter(Boolean).join(' · ');
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
          <span>{u.entries.map((e) => `${e.accountDebit || '–'} / ${e.accountCredit || '–'}${e.vatCode ? ` ${codeLabel(e.vatCode)}` : ''} · ${fmt(e.amount)}`).join(' + ')}</span>
          <span className="m">{u.entries.map((e) => e.description).filter(Boolean).join(' · ')}</span>
          <button type="button" className="btn" onClick={() => void attach(u.ref)}>{t('journal.unattached.attach', { ref: u.ref })}</button>
        </div>
      ))}
    </div>
  );
}

function BookingForm({ books, nav, payment, narrow, onForm, onBooked, accounts, draft, dimensions, defaults }: Props & { accounts: readonly LedgerBankAccount[]; draft: BookingDraft; dimensions: readonly Dimension[]; defaults: readonly string[] }) {
  const [rows, setRows] = useState<Row[]>(() => draft.lines.map((init, key) => ({ key, init })));
  const [, redraw] = useState(0);
  // The lines follow the draft (the payment's own prefill, a receipt linked meanwhile) until the person typed (r9k-7).
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setRows(draft.lines.map((init, key) => ({ key, init }))); }, [draft]);
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
      const tags = f && tagsOfForm(f, dimensions, `-${key}`);
      return { raw, vat, line: { accountDebit: raw.accountDebit, accountCredit: raw.accountCredit, amount: parseAmount(raw.amount) ?? 0, ...(vat?.code && { vatCode: vat.code }), description: raw.description, ...(tags && { tags }) } };
    });
  }

  const now = typed();
  const noReceipt = !books.mappings.some((m) => m.transactionRef === payment);
  // An input-tax code no receipt backs: the person may name the other proof that shows the VAT (#134).
  const deducts = noReceipt && now.some((x) => inputTaxWithoutReceipt(x.vat?.code));
  const proofText = () => String((form.current ? new FormData(form.current).get('inputTaxProof') : '') ?? '').trim() || undefined;
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
      if (unknown) return unknownAccountText(unknown);
      if (!raw.accountDebit && !raw.accountCredit) return t('journal.errNoAccount');
      if (!vat) return parseRate(raw.vatCode) ? (withoutInputTax() ? t(`journal.errVatNotTaken.${withoutInputTax()!}`, { code: raw.vatCode }) : t('journal.errVatRate', { rate: raw.vatCode })) : t('journal.errVat', { code: raw.vatCode });
      if (vat.code && !formTakes(vat.code)) return t(`journal.errVatNotTaken.${withoutInputTax() ?? 'none'}`, { code: vat.code });
      if ((!raw.accountDebit || !raw.accountCredit) && !isVatAmountCode(vat.code)) return t('journal.byHand.errLegs', { n: i + 1 });
      if (!parseAmount(raw.amount)) return t('journal.errAmount');
      if (!raw.description) return t('journal.errText');
      return '';
    }).find(Boolean) ?? (rest ? t('journal.byHand.errRest', { currency: draft.currency, amount: fmt(rest) }) : '');
    if (problem) { setErr(problem); return; }
    setErr('');
    busy.current = true;
    const entries = await bookPayment(nav, payment, now.map((x) => x.line), deducts ? proofText() : undefined);
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
      onKeyDown={onKeyDown} onInput={() => { touched.current = true; redraw((n) => n + 1); }} onSubmit={(e) => { e.preventDefault(); void book(); }}>
      <div className="pbh">
        <b>{t('journal.byHand.title')}</b>
        <span className="m">{t('journal.byHand.lead', { date: formatDate(draft.date), currency: draft.currency })}</span>
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
        // The side opposite the bank is where the person chooses: money in lists revenue first, money out expenses, the firm's default accounts on top.
        const other = draft.bank && (draft.bank.side === 'accountDebit' ? 'accountCredit' : 'accountDebit');
        const prefer = draft.bank ? (draft.bank.side === 'accountDebit' ? 'revenue' as const : 'expense' as const) : undefined;
        const side = (k: 'accountDebit' | 'accountCredit') => (k === other ? { prefer, defaults } : {});
        // A proposal stands until the person types over it: the line under the fields says what is proposed, and from where.
        const proposed = init.source && now[i] && now[i].raw.accountDebit === init.accountDebit && now[i].raw.accountCredit === init.accountCredit && now[i].raw.vatCode === init.vat ? sourceText(init.source, init, draft.bank?.side) : '';
        return (
          <div key={`${key}-${init.accountDebit}-${init.accountCredit}-${init.vat}`} className="pbl">
            <AccountField name={`accountDebit-${key}`} label={t('journal.field.accountDebit')} defaultValue={init.accountDebit} onPick={() => redraw((n) => n + 1)} {...side('accountDebit')} />
            <AccountField name={`accountCredit-${key}`} label={t('journal.field.accountCredit')} defaultValue={init.accountCredit} onPick={() => redraw((n) => n + 1)} {...side('accountCredit')} />
            {firmCodes().length ? (
              <VatCodeField
                className="pbv"
                name={`vatCode-${key}`}
                label={t('journal.byHand.vatLabel')}
                defaultValue={init.vat}
                placeholder={t('journal.vatPlaceholder')}
                onPick={() => redraw((n) => n + 1)}
                accounts={{ debit: now[i]?.raw.accountDebit ?? init.accountDebit, credit: now[i]?.raw.accountCredit ?? init.accountCredit }}
                hint={vat?.code ? `${vat.fromRate !== undefined ? `${t('journal.byHand.vatIs', { code: vat.code })} · ` : ''}${codeText(vat.code)}` : vat === null ? '' : t('journal.byHand.noVat')}
              />
            ) : <span className="pbv" />}
            {proposed ? <p className="pbs" data-testid="proposal">{t('journal.byHand.proposal', { what: proposed })}</p> : null}
            {zero ? <p className="pbw" data-testid="vat-no-receipt">{t('journal.byHand.noReceiptVat', { code: codeLabel(vat!.code), zero: codeLabel(zero) })}</p> : null}
            <label className="pba">{t('journal.amountIn', { currency: draft.currency })}<input className="mono" name={`amount-${key}`} defaultValue={fmt(init.amount)} style={{ textAlign: 'right' }} /></label>
            <label className="pbt">{t('journal.field.description')}<input name={`description-${key}`} defaultValue={init.description} /></label>
            {dimensions.length ? <div className="pbg"><TagFields dimensions={dimensions} entries={books.journalEntries ?? []} suffix={`-${key}`} /></div> : null}
            {rows.length > 1 ? <button type="button" className="rm" aria-label={t('journal.byHand.removeLine')} onClick={() => setRows(rows.filter((r) => r.key !== key))}>×</button> : null}
          </div>
        );
      })}
      {deducts ? (
        <label className="pbp" data-testid="input-tax-proof">{t('journal.byHand.proofLabel')}
          <input name="inputTaxProof" placeholder={t('journal.byHand.proofPlaceholder')} />
          <span className="m">{t('journal.byHand.proofHint')}</span>
        </label>
      ) : null}
      <div className="pbf">
        <button type="button" className="addlink" data-tip={t('journal.byHand.addLineTip')} onClick={addLine}>+ {t('journal.byHand.addLine')}</button>
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
