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
import { followedVat, formDraft, withoutProposal, inputTaxWithoutReceipt, restOf, unattachedFor, type BookingDraft, type BookingLine, type DraftLine, type DraftNote, type DraftSource, type Unattached as UnattachedBooking } from '../../../accounting/manual-booking.js';
import type { HandStart } from '../../../saving/hand-rule.js';
import { api } from '../../lib/api.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { firmCodes, formTakes, lookupVatCode, parseRate, vatCodeOf } from '../../../accounting/vat-codes.js';
import { chart, withoutInputTax } from '../../../engines/index.js';
import { domesticSale, saleVatCode } from '../../../accounting/sales-without-vat.js';
import { ForeignTaxForm } from '../../questions/Questions.js';
import { errorText } from '../../lib/api.js';
import { answerSaleOnForm } from '../../questions/store.js';
import { codeLabel, codeText } from '../codes/names.js';
import { isVatAmountCode } from '../../../accounting/validate.js';
import { getAccountMap, getAccounts, hintsOf } from '../../lib/accounts.js';
import { ranksByWords } from '../../lib/account-filter.js';
import { offersInBooks } from '../../../intake/near-pairs.js';
import { nearWhy } from '../receipts/FindPair.js';
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
import { RuleWay } from './RuleWay.js';
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

/** How long the form waits for what the server knows of the payment before it opens without a proposal. */
const START_TIMEOUT_MS = 10_000;

/**
 * Waits for the workspace's bank accounts and for what the server knows of the payment (the rule
 * that decides it, what it is, its business's account): the form opens once with the final
 * proposal, never with a first guess that a late answer replaces under her (#344).
 */
export function PaymentBooking(props: Props) {
  const ws = useWorkspace();
  const inv = useInvoices();
  const invoices = inv.state === 'ready' ? inv.data.invoices : inv.state === 'loading' ? 'loading' : undefined;
  // The form's rows are set once from the draft, so it waits for the invoices too (formDraft, r9c-4).
  // What the server knows of the payment, and the books it answered for: a later answer is taken without emptying the form first.
  const [known, setKnown] = useState<{ start: HandStart | null; books: Index; failed?: true }>();
  // A receipt she said is not the invoice this payment pays (#382): the form proposes without it.
  const [notOwn, setNotOwn] = useState<string>();
  useEffect(() => {
    let live = true;
    const books = props.books;
    // A failed or slow answer opens the form without any proposal (withoutProposal): a guess without it would book an owner's deposit as revenue.
    const late = new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), START_TIMEOUT_MS));
    Promise.race([api.handStart(props.payment), late]).then((r) => { if (live) setKnown({ start: r.start, books }); }, () => { if (live) setKnown({ start: null, books, failed: true }); });
    return () => { live = false; };
  }, [props.payment, props.books]);
  const start = known?.start ?? undefined;
  const draft = useMemo(() => (ws && known ? (known.failed ? (d?: BookingDraft) => d && withoutProposal(d) : (d?: BookingDraft) => d)(formDraft(props.books, props.payment, ws.bankAccounts, invoices, {
    defaults: ws.defaults, rule: start?.rule, nature: start?.nature, account: start?.account, ...(start?.wages && { wages: start.wages }),
    invoiceRevenue: ws.invoicing?.revenueAccount, chart: getAccounts().map((a) => a.number), ownUid: ws.company.uid, firmName: ws.company.name,
    ...(notOwn && { notOwnInvoice: notOwn }),
    ranks: (words) => ranksByWords(getAccounts().filter((a) => chart().typeOf(a.number) === 'expense'), words, hintsOf),
    ...nearOf(props.books, props.payment, ws.company),
  })) : undefined), [ws, known, start, props.books, props.payment, invoices, notOwn]);
  // The form as it stands: the way to a rule starts with what it holds (#383).
  const formEl = useRef<HTMLFormElement | null>(null);
  const typed = useMemo(() => (ws ? unattachedFor(props.books, props.payment, ws.bankAccounts) : []), [ws, props.books, props.payment]);
  if (!ws || !draft) return null;
  const defaults = ws.defaults ? [...new Set([ws.defaults.sales, ...ws.defaults.all.sales.map((x) => x.account), ...ws.defaults.all.purchase.map((x) => x.account)])] : [];
  return (
    <>
      {typed.length ? <Unattached {...props} typed={typed} /> : null}
      <BookingForm {...props} onForm={(el) => { formEl.current = el; props.onForm?.(el); }} accounts={ws.bankAccounts} draft={draft} dimensions={ws.dimensions ?? []} defaults={defaults} pending={known!.books !== props.books} onNotOwn={setNotOwn} />
      {props.canRule !== false && start ? <RuleWay nav={props.nav} payment={props.payment} start={start} form={() => formEl.current} lines={draft.lines} other={draft.bank && (draft.bank.side === 'accountDebit' ? 'accountCredit' : 'accountDebit')} /> : null}
    </>
  );
}

/** The closest receipt that may be this payment's but is not linked (#397): its name, the one Swiss rate it shows, what differs. */
function nearOf(books: Index, ref: string, company: { uid?: string; name?: string; owner?: string }): { near?: { name: string; rate?: number; why: string } } {
  const [o] = offersInBooks(books, { payment: ref }, { uid: company.uid, name: company.name, owner: company.owner }).filter((x) => !x.filed);
  const r = o && books.receipts.find((x) => x.id === o.receipt);
  if (!o || !r) return {};
  const rates = r.hasSwissVat ? [...new Set((r.vatSummary ?? []).filter((g) => g.ratePercent > 0).map((g) => g.ratePercent))] : [];
  return { near: { name: r.title?.vendor ?? r.description ?? r.filename, ...(rates.length === 1 && { rate: rates[0] }), why: nearWhy(o, 'payment', books.transactions.find((x) => x.ref === ref), r) } };
}

/**
 * A line's proposals in a few words, each with where it comes from: the account («Standardkonto für
 * Verkäufe»), the tax code («aus dem Beleg»). Only what still stands as proposed: an account she
 * changed is hers, and so is a code she typed; a code that followed her account is said as it is now.
 */
function sourceText(s: DraftSource, account: string | undefined, vat: string | undefined): string {
  const name = account ? getAccountMap()[account] : undefined;
  const a = account ? s.account : undefined;
  const from = !a ? '' : a.from === 'rule' ? t('journal.byHand.from.rule', { rule: a.rule })
    : a.from === 'precedent' ? (a.yours && a.name ? t('journal.byHand.from.precedentYours', { name: a.name, date: formatDate(a.date) }) : t('journal.byHand.from.precedent', { date: formatDate(a.date) }))
      : a.from === 'refund' ? t('journal.byHand.from.refund', { date: formatDate(a.date) })
        : a.from === 'invoice' || a.from === 'receivable' ? t(`journal.byHand.from.${a.from}`, { number: a.number })
          : a.from === 'clearing' ? t('journal.byHand.from.clearing', { provider: a.provider })
            : t(`journal.byHand.from.${a.from}`);
  const v = vat ? s.vat : undefined;
  const vatFrom = !v ? '' : v.from === 'sale' ? t(`journal.byHand.from.sale.${v.choice === 'saleAbroad' ? 'abroad' : 'domestic'}`) : t(`journal.byHand.from.vat.${v.from}`);
  return [
    a && t('journal.byHand.proposedAccount', { account: name ? `${account} ${name}` : account!, from }),
    v && t('journal.byHand.proposedVat', { code: lookupVatCode(vat!) ? codeLabel(vat!) : `${vat} %`, from: vatFrom }),
  ].filter(Boolean).join(' · ');
}

/** A fact under the lines, in plain words (DraftNote). */
function noteText(n: DraftNote): string {
  switch (n.kind) {
    case 'payout': return t(`journal.byHand.note.payout.${n.why}${(n.why === 'clearing' || n.why === 'since') && n.sales === false ? 'NoSales' : ''}` as 'journal.byHand.note.payout.gap', { provider: n.provider, account: n.account ?? '', since: n.since ? formatDate(n.since) : '' });
    case 'authority': return t('journal.byHand.note.authority', { name: n.name });
    case 'saleVat': return t(`journal.byHand.note.saleVat.${n.why}`);
    case 'ask': return t('journal.byHand.note.ask', { question: n.question });
    case 'taxPoint': return t('journal.byHand.note.taxPoint', { date: formatDate(n.date) });
    case 'invoicePaid': return t('journal.byHand.note.invoicePaid', { number: n.number, amount: fmt(n.surplus) });
    case 'prepayment': return t('journal.byHand.note.prepayment', { number: n.number });
    case 'bankChargesMissing': return t('journal.byHand.note.bankChargesMissing', { account: n.account, name: n.name });
    case 'ownInvoiceSurplus': return t('journal.byHand.note.ownInvoiceSurplus', { number: n.number, amount: fmt(n.surplus) });
    case 'wageDeductions': return t('journal.byHand.note.wageDeductions', { account: n.account });
    case 'nearReceipt': return !n.vat ? t('journal.byHand.note.nearReceiptPlain', { name: n.name, why: n.why }) : n.rate !== undefined ? t('journal.byHand.note.nearReceipt', { name: n.name, why: n.why, rate: String(n.rate) }) : t('journal.byHand.note.nearReceiptNoRate', { name: n.name, why: n.why });
    case 'noProposal': return t(n.linked ? 'journal.byHand.note.noProposal.receipt' : 'journal.byHand.note.noProposal.none', { name: n.name });
    case 'discount': return t(n.vat === 'paid' ? 'journal.byHand.note.discount' : n.vat === 'rates' ? 'journal.byHand.note.discountRates' : 'journal.byHand.note.discountNoVat', { percent: String(n.percent), amount: fmt(n.amount) });
    case 'ownerOutlays': return t(n.judged ? 'journal.byHand.note.ownerOutlaysJudged' : 'journal.byHand.note.ownerOutlays', { amount: fmt(n.open) });
    case 'ownerForeign': return t('journal.byHand.note.ownerForeign', { currency: n.currency });
    case 'ownerWaits': return t(n.open > 0 ? 'journal.byHand.note.ownerWaitsShort' : 'journal.byHand.note.ownerWaits', { owner: n.owner, account: n.account, amount: fmt(n.open) });
    default: return t(`journal.byHand.note.${n.kind}`);
  }
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

/** The answers of the sale question the form takes (#382): as on the question card (src/app/questions/Questions.tsx). */
const SALE_ANSWERS = ['saleDomestic', 'saleAbroad', 'saleAbroadForeignTax', 'notSale'] as const;
type SaleAnswer = (typeof SALE_ANSWERS)[number];

/** An answer's words, as the question card says them: the domestic sale names its rate, or the firm's net rate. */
function saleAnswerText(a: SaleAnswer): string {
  if (a !== 'saleDomestic') return t(`questions.choice.${a}`);
  const d = domesticSale();
  return d?.net ? t('questions.choice.saleDomesticNet', { code: d.code, rate: String(d.rate) }) : t('questions.choice.saleDomestic', { rate: String(d?.rate ?? '') });
}

/** Whether the firm's form takes the code an answer books (none for «kein Umsatz»). */
const answerable = (a: SaleAnswer): boolean => a === 'notSale' || !!saleVatCode(a === 'saleDomestic' ? 'saleDomestic' : 'saleAbroad');

function BookingForm({ books, nav, payment, narrow, onForm, onBooked, accounts, draft, dimensions, defaults, pending, onNotOwn }: Props & { accounts: readonly LedgerBankAccount[]; draft: BookingDraft; dimensions: readonly Dimension[]; defaults: readonly string[]; pending?: boolean; onNotOwn?(receipt: string): void }) {
  const [rows, setRows] = useState<Row[]>(() => draft.lines.map((init, key) => ({ key, init })));
  const [, redraw] = useState(0);
  // The lines follow the draft (the payment's own prefill, a receipt linked meanwhile) until the person typed or picked anything (r9k-7, #344).
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setRows(draft.lines.map((init, key) => ({ key, init }))); }, [draft]);
  // The rows she has seen: ↵ books only lines that stood on the screen for a render (a late proposal is never booked unseen).
  const seen = useRef<Row[]>();
  useEffect(() => { seen.current = rows; }, [rows]);
  // The lines whose VAT field she typed in or picked from, with the code the field showed then: their code is hers and follows no account.
  const [ownVat, setOwnVat] = useState<ReadonlyMap<number, string>>(new Map());
  const [err, setErr] = useState('');
  // The answer «abroad with a foreign VAT» opens the question card's form for the foreign tax (#382).
  const [foreign, setForeign] = useState(false);
  const form = useRef<HTMLFormElement | null>(null);
  const busy = useRef(false);
  const chose = () => { touched.current = true; redraw((n) => n + 1); };

  /** The lines as typed now; `vat` the code a typed rate stands for, null where it is neither code nor rate. */
  function typed(): Array<{ line: BookingLine; vat: ReturnType<typeof vatCodeOf>; raw: Record<typeof FIELDS[number], string> }> {
    const f = form.current ? new FormData(form.current) : undefined;
    return rows.map(({ key, init }) => {
      const get = (k: typeof FIELDS[number]) => String(f?.get(`${k}-${key}`) ?? (k === 'amount' ? fmt(init.amount) : k === 'vatCode' ? init.vat : init[k])).trim();
      const raw = Object.fromEntries(FIELDS.map((k) => [k, get(k)])) as Record<typeof FIELDS[number], string>;
      // A code she did not set follows the accounts in the fields (followedVat): the field shows it from the next render on.
      if (!ownVat.has(key)) raw.vatCode = followedVat(init, raw.accountDebit, raw.accountCredit);
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
    touched.current = true;
    setRows([...rows, { key, init }]);
    setTimeout(() => form.current?.querySelector<HTMLInputElement>(`[name="${side === 'accountDebit' ? 'accountCredit' : 'accountDebit'}-${key}"]`)?.focus());
  }

  /** What keeps the lines from being booked, in words; `sale`: the sale question's answer sets the code, so the code field is not checked. */
  function problemOf(sale = false): string {
    const known = getAccountMap();
    return now.map(({ raw, vat: typedVat }, i): string => {
      const vat = sale ? { code: '' } : typedVat;
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
  }

  /** The receipts booking links: her own invoices the proposal is read off, never across periods on the agreed basis (they are linked alone there). */
  const links = draft.ownInvoice && draft.ownInvoice.from !== 'taxPoint' ? draft.ownInvoice.links : [];

  async function book() {
    if (busy.current || pending || seen.current !== rows) return;
    const problem = problemOf();
    if (problem) { setErr(problem); return; }
    setErr('');
    busy.current = true;
    const entries = await bookPayment(nav, payment, now.map((x) => x.line), deducts ? proofText() : undefined, links);
    busy.current = false;
    if (entries) onBooked?.(entries);
  }

  /**
   * Her answer to the sale question on the form (#382): the lines as they stand are booked as hers,
   * and the answer sets their code as the question card's does (src/server/questions.ts
   * answerSaleOnForm), so both book the same, and the answered card offers «Immer so?».
   */
  async function answerSale(choice: 'saleDomestic' | 'saleAbroad' | 'notSale', foreignTax?: { rate: number; amount: number; account: string }) {
    if (busy.current || pending || seen.current !== rows) return;
    const problem = problemOf(true);
    if (problem) { setErr(problem); return; }
    setErr('');
    busy.current = true;
    try {
      await answerSaleOnForm(payment, { choice, ...(foreignTax && { foreignTax }), lines: now.map((x) => x.line), links });
      nav.toast(t('questions.answeredToast'));
      nav.refresh();
      onBooked?.([]);
    } catch (e) { setErr(errorText(e)); } finally { busy.current = false; }
  }

  async function linkOnly() {
    for (const id of draft.ownInvoice?.links ?? []) await api.addMapping({ receiptId: id, transactionRef: payment });
    nav.refresh();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.defaultPrevented && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void book(); }
  }

  const setForm = (el: HTMLFormElement | null) => { form.current = el; onForm?.(el); };
  const inv = draft.invoice;
  const invoiceSaid = draft.notes.some((n) => n.kind === 'prepayment' || n.kind === 'invoicePaid');
  // Nothing is open on the invoice: a confirmation would refuse the payment, so the link only shows the invoice.
  const paidAlready = draft.notes.some((n) => n.kind === 'invoicePaid') && !rows.some((r) => r.init.source);
  // «Die App nimmt einen Verkauf an» holds while the proposed revenue account stands; once she chose another, it is hers.
  const otherSide = draft.bank && (draft.bank.side === 'accountDebit' ? 'accountCredit' : 'accountDebit');
  const saleStands = !!otherSide && now.some((x, i) => x.raw[otherSide] === rows[i].init[otherSide]);
  // The sale question (#382): asked where no code is proposed for a sale whose VAT the app cannot tell.
  const asksSale = saleStands && draft.notes.some((n) => n.kind === 'saleVat');
  const own = draft.ownInvoice;

  return (
    <form ref={setForm} className={`form pbook${narrow ? ' narrow' : ''}`} autoComplete="off" aria-label={t('journal.byHand.title')} data-testid="payment-booking"
      onKeyDown={onKeyDown} onInput={chose} onSubmit={(e) => { e.preventDefault(); void book(); }}>
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
      {inv ? (
        <p className="pbw" data-testid="pays-invoice" data-number={inv.number} data-settles={inv.settles}>
          {/* A prepayment or a payment of an invoice paid already: the note under the lines says what it is. */}
          {invoiceSaid ? null : <>{t(inv.settles ? 'journal.byHand.invoice.settles' : 'journal.byHand.invoice.revenue', { number: inv.number })}{' '}</>}
          <Go to={at({ area: 'invoices', view: 'list', id: inv.number }, draft.date)} nav={nav}>{t(paidAlready ? 'journal.byHand.showInvoice' : 'journal.byHand.invoice.confirm', { number: inv.number })}</Go>
        </p>
      ) : null}
      {own ? (
        <p className="pbw" data-testid="own-invoice" data-receipt={own.id} data-from={own.from}>
          {/* What is true: the proposal is read off her invoice, comes from elsewhere, or is not made across periods (agreed basis, #360). */}
          {t(`journal.byHand.ownInvoice.${own.earlier ? 'earlier' : own.from}`, { number: own.number, file: own.file, date: own.earlier ? formatDate(own.earlier) : '' })}{' '}
          {own.from === 'taxPoint' && own.links.length ? <button type="button" className="btn" data-act="link-own-invoice" onClick={() => void linkOnly()}>{t('journal.byHand.linkOnly')}</button> : null}
          {own.links.length ? <button type="button" className="golink" data-act="not-own-invoice" onClick={() => onNotOwn?.(own.id)}>{t('journal.byHand.notOwnInvoice')}</button> : null}
        </p>
      ) : null}
      {rows.map(({ key, init }, i) => {
        const x = now[i];
        const vat = x?.vat;
        const zero = noReceipt ? inputTaxWithoutReceipt(vat?.code) : undefined;
        // The side opposite the bank is where the person chooses: money in lists revenue first, money out expenses, the firm's default accounts on top.
        const other = draft.bank && (draft.bank.side === 'accountDebit' ? 'accountCredit' : 'accountDebit');
        const prefer = draft.bank ? (draft.bank.side === 'accountDebit' ? 'revenue' as const : 'expense' as const) : undefined;
        const side = (k: 'accountDebit' | 'accountCredit') => (k === other ? { prefer, defaults, ...(draft.words && { suggest: draft.words }) } : {});
        // What still stands as proposed: the account while it is the proposal's, the code while she has not set one.
        const otherNow = other && x ? x.raw[other] : undefined;
        const accountStands = !!other && otherNow === init[other];
        const followed = ownVat.get(key) ?? x?.raw.vatCode ?? init.vat;
        const vatStands = !ownVat.has(key) && !!followed && !!init.source?.vat;
        const proposed = init.source ? sourceText(init.source, accountStands ? init[other!] : undefined, vatStands ? followed : undefined) : '';
        return (
          <div key={`${key}-${init.accountDebit}-${init.accountCredit}-${init.vat}`} className="pbl">
            <AccountField name={`accountDebit-${key}`} label={t('journal.field.accountDebit')} defaultValue={init.accountDebit} onPick={chose} {...side('accountDebit')} />
            <AccountField name={`accountCredit-${key}`} label={t('journal.field.accountCredit')} defaultValue={init.accountCredit} onPick={chose} {...side('accountCredit')} />
            {firmCodes().length ? (
              <VatCodeField
                // While the code is not hers it follows the accounts: the field is set anew with the followed code (and keeps it once she types).
                key={`vat-${followed}`}
                className="pbv"
                name={`vatCode-${key}`}
                label={t('journal.byHand.vatLabel')}
                defaultValue={followed}
                placeholder={t('journal.vatPlaceholder')}
                onPick={chose}
                onValue={() => { if (!ownVat.has(key)) setOwnVat(new Map([...ownVat, [key, followed]])); touched.current = true; }}
                accounts={{ debit: x?.raw.accountDebit ?? init.accountDebit, credit: x?.raw.accountCredit ?? init.accountCredit }}
                hint={vat?.code ? `${vat.fromRate !== undefined ? `${t('journal.byHand.vatIs', { code: vat.code })} · ` : ''}${codeText(vat.code)}` : vat === null || asksSale ? '' : t('journal.byHand.noVat')}
              />
            ) : <span className="pbv" />}
            {/* The amount before the lines under the fields: after them, the grid put it into the last, narrow column (#382). */}
            <label className="pba">{t('journal.amountIn', { currency: draft.currency })}<input className="mono" name={`amount-${key}`} defaultValue={fmt(init.amount)} style={{ textAlign: 'right' }} /></label>
            {proposed ? <p className="pbs" data-testid="proposal">{t('journal.byHand.proposal', { what: proposed })}</p> : null}
            {zero ? <p className="pbw" data-testid="vat-no-receipt">{t('journal.byHand.noReceiptVat', { code: codeLabel(vat!.code), zero: codeLabel(zero) })}</p> : null}
            <label className="pbt">{t('journal.field.description')}<input name={`description-${key}`} defaultValue={init.description} /></label>
            {dimensions.length ? <div className="pbg"><TagFields dimensions={dimensions} entries={books.journalEntries ?? []} tags={init.tags} suffix={`-${key}`} onPick={chose} /></div> : null}
            {rows.length > 1 ? <button type="button" className="rm" aria-label={t('journal.byHand.removeLine')} onClick={() => { touched.current = true; setRows(rows.filter((r) => r.key !== key)); }}>×</button> : null}
          </div>
        );
      })}
      {draft.notes.filter((n) => !(n.kind === 'sale' || n.kind === 'saleVat' || n.kind === 'refund' || n.kind === 'owner') || saleStands).map((n) => <p key={n.kind} className="pbn" data-testid={`note-${n.kind}`}>{noteText(n)}</p>)}
      {asksSale ? (
        <div className="pbq" data-testid="sale-question">
          <span>{t('journal.byHand.saleAsk')}</span>
          {SALE_ANSWERS.filter(answerable).map((a) => (
            <button key={a} type="button" className="btn" aria-expanded={a === 'saleAbroadForeignTax' ? foreign : undefined} data-choice={a}
              onClick={() => (a === 'saleAbroadForeignTax' ? setForeign(!foreign) : void answerSale(a))}>{saleAnswerText(a)}</button>
          ))}
          <p className="m">{t('journal.byHand.saleAskDoes')}</p>
          {foreign ? <ForeignTaxForm payment={payment} books={books} onCancel={() => setForeign(false)} onAnswer={(a) => void answerSale('saleAbroad', a.foreignTax)} /> : null}
        </div>
      ) : null}
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
        <button type="submit" className="btn primary">{t(links.length ? 'journal.byHand.submitLink' : 'journal.byHand.submit')} <span className="k">↵</span></button>
      </div>
      <div className="err" role="alert">{err}</div>
    </form>
  );
}
