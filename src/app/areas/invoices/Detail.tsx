/**
 * A document of Verkauf (the panel over a table, layout A): an invoice on its A4 sheet (a draft edited in place, a reminder
 * written on the sheet before it goes out) with its state, actions and margin; a contact
 * (contacts.tsx); a sent document as the PDF that went out.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { PRICES, isBooked, isItem, type Draft, type Invoice, type InvoiceLine, type Issued } from '../../../invoices/model.js';
import { eventRef } from '../../../books/refs.js';
import { lockedThrough } from '../../../books/lock-line.js';
import { TEXTS } from '../../../invoices/texts.js';
import { defaultTexts, draftDays, senderFor } from '../../../invoices/documents.js';
import { backToDraftRefusal, missingForIssue, openAmount, openFees, paidAmount, refundDue, reminderDraft, shortfallOf, skontoOffer, totals, warningsForIssue, type Missing } from '../../../invoices/rules.js';
import { prettyReference } from '../../../providers/qr-bill/reference.js';
import { closedByLoss } from '../../../invoices/lists.js';
import type { PaymentProposal } from '../../../invoices/payments.js';
import { at } from '../receipts/view.js';
import type { CompanyInfo } from '../../../books/company.js';
import type { RouteOf } from '../../shell/route.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { api, missingText, sources, type DraftChange, type InvoiceList } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import { baseCurrency, chargesVat } from '../../../engines/index.js';
import { DEFAULT_SHORTFALL_LIMIT } from '../../../invoices/model.js';
import { FourFigures, MoneyRows } from './Figures.js';
import { I } from '../receipts/icons.js';
import { Paper } from '../receipts/Paper.js';
import type { AreaProps } from '../index.js';
import { useInvoices } from './data.js';
import { byRouteId, contactOf, customerOf, issuedLater, linkablePayments, routeId, rowState, wasSent, type RowState } from './model.js';
import { CONVERSIONS, chainOf, doneShare } from '../../../invoices/chain.js';
import { groupOf, statusOfKind } from './table.js';
import { fixFor, insertLine, moveLine, parseNumber, repriced, sheetEdit, type Fix } from './edit.js';
import { setUi, ui, useUi, type Section } from './state.js';
import { answer, comment, confirmPayment, copyAsDraft, deleteDraft, firstLine, invoiceAt, issue, reopen, saveDraft, send, sendReminder, writeOff } from './actions.js';
import { ContactPanel } from './contacts.js';
import { ArticlePanel } from './articles.js';
import { addressOf, contactDays, goneRefs } from '../../../invoices/contacts.js';
import { contextOf, draftData, issuedData, reminderData } from './sheets.js';
import { Sheet } from './Sheet.js';
import { hrefOf } from '../../shell/history.js';
import { countryName } from './address.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { SentLine, SentList } from './Sent.js';
import { Menu, type MenuItem } from '../../shell/Menu.js';

type Props = AreaProps<RouteOf<'invoices'>>;

const LANGS = ['de', 'fr', 'it', 'en'] as const;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);

export function Detail(props: Props) {
  const load = useInvoices();
  const ws = useWorkspace();
  if (load.state !== 'ready' || !ws) return <div className="detail-empty"><div>{load.state === 'failed' ? t('invoices.unavailable') : ''}</div></div>;
  const d = load.data;
  const { route } = props;
  if (route.view === 'contacts') return <ContactPanel {...props} d={d} />;
  if (route.view === 'articles') return <ArticlePanel {...props} d={d} />;
  if (route.view === 'sent') return <SentDetail {...props} d={d} />;
  const inv = byRouteId(d.invoices, route.id);
  if (!inv) return <div className="detail-empty"><div>{route.id && route.id !== 'new' ? t('invoices.gone', { id: route.id }) : t('invoices.noneSelected')}</div></div>;
  return <InvoiceDetail key={inv.id} {...props} d={d} ws={ws} inv={inv} />;
}

function Sec({ k, label, val, children }: { k: Section; label: string; val: ReactNode; children: ReactNode }) {
  const s = useUi();
  const open = s.open[k];
  return (
    <div className={`sec${open ? ' open' : ''}`} data-sec={k}>
      <button type="button" className="sum" aria-expanded={open} onClick={() => setUi({ open: { ...s.open, [k]: !open } })}>
        {I.chev}<span className="lbl">{label}</span><span className="val">{val}</span>
      </button>
      <div className="in"><div><div className="pad">{children}</div></div></div>
    </div>
  );
}

interface DetailProps extends Props { d: InvoiceList; ws: CompanyInfo; inv: Invoice }

function InvoiceDetail(props: DetailProps) {
  const { d, ws, inv, nav, canEdit } = props;
  const s = useUi();
  const today = localToday();
  const state = rowState(inv, d.invoices, today);
  const customer = customerOf(d, inv);
  const t0 = totals(inv);
  const reminder = inv.status === 'issued' && s.reminder?.invoiceId === inv.id ? s.reminder : null;
  const editing = canEdit && !s.preview && (inv.status === 'draft' || !!reminder);

  const data = reminder && inv.status === 'issued' ? reminderData(d, inv, reminder, today, editing)
    : inv.status === 'draft' ? draftData(d, ws, inv, editing) : issuedData(d, inv);

  function edit(key: string, value: string, final: boolean): boolean | void {
    if (!final) return;
    if (reminder && inv.status === 'issued') {
      if (key === 'intro' || key === 'closing') setUi({ reminder: { ...reminder, [key]: value } });
      return;
    }
    if (inv.status !== 'draft') return;
    const change = draftChange(props, inv, key, value);
    if (change === false) return false;
    if (change) void saveDraft(nav, inv, change);
  }

  function action(a: string, k: number, to?: number): string | void {
    if (inv.status !== 'draft') return;
    if (a === 'rmline') void saveDraft(nav, inv, { lines: inv.lines.filter((_, i) => i !== k) });
    if ((a === 'move' || a === 'drop') && to !== undefined) {
      const moved = moveLine(inv.lines, k, to, a === 'drop' ? 'drop' : 'step');
      if (moved) void saveDraft(nav, inv, { lines: moved.lines });
      return moved ? `mv:${moved.at}` : undefined;
    }
    // «＋ Artikel»: the picker puts the Artikel position after the position the person is in.
    if (a === 'addarticle') { setUi({ dialog: { kind: 'articlePick', draft: inv.id, after: k } }); return; }
    const added = newPosition(a, inv, contactOf(d, inv));
    if (added) {
      // After the position the person is in (k), else at the end; an untouched first item gives way.
      const { lines, at } = insertLine(inv.lines, added, k, t('invoices.newLine'));
      void saveDraft(nav, inv, { lines });
      return added.kind === 'pagebreak' ? undefined : added.kind === 'discount' ? `l:${at}:discount` : `l:${at}:text`;
    }
  }

  return (
    <div className="detail-in" data-for={inv.id}>
      <div className="head">
        <h2 className="who">{customer?.name || t('invoices.noCustomer')}<small>{inv.kind === 'credit-note' && inv.status === 'issued' ? `${t('invoices.creditNo', { number: inv.number })} ${inv.subject ?? ''}` : inv.subject ?? ''}</small></h2>
        {/* A Lieferschein names quantities, never an amount (spec 4.4.1). */}
        {inv.kind !== 'delivery-note' && <div className="amount"><small>{inv.currency}</small>{fmt(t0.gross)}</div>}
      </div>
      <div className="facts">
        <span>{inv.status === 'issued' ? (inv.kind === 'credit-note' ? t('invoices.creditNo', { number: inv.number }) : inv.kind === 'invoice' ? t('invoices.no', { number: inv.number }) : `${t(`invoices.docKind.${inv.kind}`)} ${inv.number}`) : inv.number ? t('invoices.draftKeeps', { number: inv.number }) : t('invoices.draftNoNumber')}</span>
        <span data-tip={t('invoices.dateTip')}>{formatDate(inv.date)}</span>
        {inv.status === 'issued' && inv.kind === 'invoice' && <span data-tip={t('invoices.dueTip')}>{t('invoices.due', { date: formatDate(inv.dueDate) })}</span>}
        {inv.status === 'issued' && inv.kind === 'invoice' && <span data-tip={t('invoices.referenceTip')}>{prettyReference(inv.reference)}</span>}
        {/* A firm not in the register charges no VAT: its invoice's head has no VAT line at all (#398). */}
        {inv.kind !== 'delivery-note' && (chargesVat() || t0.vat) ? <span data-testid="invoice-head-vat">{t0.vat || inv.lines.some((l) => isItem(l) && l.vatRate > 0) ? t('invoices.vatAmount', { amount: fmt(t0.vat) }) : t('invoices.vatZero')}</span> : null}
      </div>
      {/* The money first (spec 4.8); slice D's sent fact sits beside the figures in this row. */}
      {/* The facts of an issued document first (spec 4.8): its money, and whether and how it went out. */}
      {inv.status === 'issued' && !reminder && (
        <div className="ivtop">
          {inv.kind === 'invoice' && !inv.cancelled && <FourFigures inv={inv} invoices={d.invoices} />}
          <SentLine sent={d.sent} inv={inv} onSend={canEdit ? () => setUi({ dialog: { kind: 'send' } }) : undefined} />
        </div>
      )}
      {inv.status === 'issued' && !isBooked(inv) ? <ChainStatus {...props} inv={inv} /> : <Status {...props} state={state} reminder={!!reminder} />}
      {inv.status === 'issued' && !isBooked(inv) ? <ChainActions {...props} inv={inv} /> : <Actions {...props} state={state} reminderLevel={reminder ? reminderDraft(inv, d.invoices, today).level : undefined} />}
      <div className="body">
        <div className="desk">
          <Sheet data={data} editing={editing} onEdit={edit} onAction={action} focus={editing ? s.focus : undefined} onFocused={() => setUi({ focus: undefined })} />
        </div>
        <aside className="margin" aria-label={t('invoices.details')}>
          {inv.status === 'draft' ? <DraftSec {...props} inv={inv} /> : <Sec k="look" label={t('invoices.sec.look')} val={`${t(`invoices.lang.${inv.language}`)} · ${inv.layout.font}`}><p className="m">{t('invoices.lookFrozen')}</p></Sec>}
          {reminder && inv.status === 'issued' && <ReminderSec {...props} inv={inv} />}
          <ChainSec {...props} />
          <CustomerSec {...props} />
          {inv.status === 'issued' && isBooked(inv) && (
            <Sec k="money" label={t('invoices.sec.money')} val={String(inv.payments.length + (inv.writeOffs?.length ?? 0) || '–')}>
              <MoneyRows inv={inv} books={props.books} nav={nav} period={props.period} canEdit={canEdit} />
              {canEdit && <OtherPayment {...props} inv={inv} state={state} />}
            </Sec>
          )}
          {inv.status === 'issued' && <SentSec {...props} inv={inv} />}
          <Comments {...props} />
          <Log {...props} />
        </aside>
      </div>
    </div>
  );
}

/** The position an «＋» button of the sheet adds, its label in the document's language; undefined for another action. */
function newPosition(a: string, inv: Draft, contact?: Parameters<typeof firstLine>[1]): InvoiceLine | undefined {
  const L = TEXTS[inv.language];
  switch (a) {
    case 'addline': { const items = inv.lines.filter(isItem); return firstLine(items.length > 0 && items.every((l) => l.vatRate === 0), contact); }
    case 'addtext': return { kind: 'text', text: '', style: 'title' };
    case 'addgroup': return { kind: 'group', text: '' };
    case 'addsubtotal': return { kind: 'subtotal', text: L.subtotal };
    case 'adddiscount': return { kind: 'discount', text: L.discount, percent: 0 };
    case 'addpagebreak': return { kind: 'pagebreak' };
    default: return undefined;
  }
}

/** An edit on the draft's sheet, saved; false: refused, the field goes back. */
function draftChange({ d, ws, nav }: DetailProps, inv: Draft, key: string, value: string): DraftChange | false | undefined {
  const terms = draftDays(contextOf(ws), inv, customerOf(d, inv, ws.invoicing));
  const r = sheetEdit(inv, key, value, { contacts: d.contacts, defaultTexts: defaultTexts(contextOf(ws), inv.kind, inv.language, terms, inv.printAs), units: ws.invoicing?.units });
  if (!r) return undefined;
  if ('change' in r) return r.change;
  if ('newCustomer' in r) { setUi({ dialog: { kind: 'contact', then: { draft: inv.id } } }); return false; }
  if (r.refused === 'date') nav.toast(t('invoices.errDate'));
  if (r.refused === 'number') nav.toast(t('invoices.errNumber'));
  return false;
}

function Status({ d, ws, inv, state, reminder, nav, canEdit, books }: DetailProps & { state: RowState; reminder: boolean }) {
  const today = localToday();
  const [proposals, setProposals] = useState<PaymentProposal[]>([]);
  // An open invoice may be paid, a credit note may be paid back: what the bank shows that could be it.
  const awaits = inv.status === 'issued' && (state === 'open' || state === 'overdue' || (state === 'credit' && refundDue(inv, d.invoices) > 0));
  useEffect(() => {
    setProposals([]);
    if (!awaits || !canEdit) return;
    let live = true;
    api.paymentProposals().then((p) => { if (live) setProposals(p.filter((x) => x.invoiceId === inv.id)); }, () => undefined);
    return () => { live = false; };
  }, [inv.id, awaits, canEdit]);

  if (inv.status === 'draft') {
    const later = issuedLater(d.invoices, inv);
    return (
      <div className="status">
        <span className="notice">{inv.number ? t('invoices.draftNumberedStatus', { number: inv.number }) : t(inv.kind === 'credit-note' ? 'invoices.creditDraftStatus' : 'invoices.draftStatus')}</span>
        {later && <div className="notice warn" role="note">{I.dot}<span>{t('invoices.dateBeforeLast', { number: later.number, date: formatDate(later.date) })}</span></div>}
      </div>
    );
  }
  if (reminder) {
    const r = reminderDraft(inv, d.invoices, today);
    return (
      <div className="status">
        <span className="notice">{t('invoices.reminderStatus', { level: r.level, date: formatDate(r.dueDate) })}</span>
        {!wasSent(d.sent, inv) && (
          <div className="notice warn" role="note">
            {I.dot}<span>{t('invoices.remindUnsent')}</span>
            {canEdit && <button type="button" className="btn ghost" onClick={() => setUi({ reminder: null, preview: false, dialog: { kind: 'send' } })}>{t('invoices.sendFirst')}</button>}
          </div>
        )}
      </div>
    );
  }
  let line: ReactNode = null;
  if (state === 'cancelled' && inv.cancelled) line = <span className="notice">{t('invoices.cancelledStatus', { date: formatDate(inv.cancelled.date) })}{inv.cancelled.reason ? ` · ${inv.cancelled.reason}` : ''}</span>;
  else if (state === 'credit') {
    const target = d.invoices.find((i) => i.id === inv.creditFor);
    line = (
      <span className="notice">
        {t('invoices.creditFor')}{' '}
        {target && <button type="button" className="golink" onClick={() => nav.go(invoiceAt(target))}>{t('invoices.invoiceNo', { number: routeId(target) })}</button>}
        {inv.payments.length ? ` · ${t('invoices.refundedOn', { date: formatDate(inv.payments.at(-1)!.date), amount: `${inv.currency} ${fmt(paidAmount(inv))}` })}`
          : inv.settlement ? ` · ${t(`invoices.settlement.${inv.settlement}`)}` : ''}
      </span>
    );
  } else if (state === 'paid') {
    const last = inv.payments.at(-1);
    // A reminder fee not paid with the invoice stays named: open until it comes or is waived (r8c-15).
    const fee = openFees(inv);
    const loss = inv.status === 'issued' && closedByLoss(inv) ? inv.writeOffs!.filter((w) => w.reason === 'loss') : [];
    line = loss.length ? <span className="linked">{I.check}{t('invoices.writtenOffOn', { date: formatDate(loss.at(-1)!.date), what: (inv.writeOffs ?? []).map((w) => `${t(`invoices.reason.${w.reason}`)} ${inv.currency} ${fmt(w.amount)}`).join(', ') })}</span> : <span className="linked">{I.check}{last ? t('invoices.paidOn', { date: formatDate(last.date), amount: `${inv.currency} ${fmt(paidAmount(inv))}` })
      : inv.writeOffs?.length && !d.invoices.some((c) => c.status === 'issued' && c.kind === 'credit-note' && c.creditFor === inv.id && !c.cancelled) ? t('invoices.settledByWriteOff', { what: inv.writeOffs.map((w) => `${t(`invoices.reason.${w.reason}`)} ${inv.currency} ${fmt(w.amount)}`).join(', ') })
      : t('invoices.settledByCredit')}{fee > 0 ? ` · ${t('invoices.feeOpen', { amount: `${inv.currency} ${fmt(fee)}` })}` : ''}</span>;
  } else {
    const due = inv.dueDate;
    const r = inv.reminders.at(-1);
    const paid = paidAmount(inv);
    const sk = !inv.payments.length ? skontoOffer(inv) : undefined;
    const parts = [
      state === 'overdue' ? t('invoices.overdueSince', { n: days(due, today) }) : t('invoices.openDue', { when: due === today ? t('invoices.today') : t('invoices.inDays', { n: days(today, due) }) }),
      ...(sk && sk.until >= today ? [t('invoices.skontoUntil', { date: formatDate(sk.until), amount: `${inv.currency} ${fmt(sk.pays)}` })] : []),
      ...(r ? [t('invoices.lastReminder', { level: r.level, date: formatDate(r.date) })] : []),
      ...(paid ? [t('invoices.partlyPaid', { paid: fmt(paid), open: fmt(openAmount(inv, d.invoices)) })] : []),
      ...(openFees(inv) > 0 ? [t('invoices.feeOpen', { amount: `${inv.currency} ${fmt(openFees(inv))}` })] : []),
    ];
    line = <span className={`notice${state === 'overdue' ? ' warn' : ''}`}>{state === 'overdue' && I.dot}{parts.join(' · ')}</span>;
  }
  // A rest of at most the shortfall limit after a payment: proposed as Spesen, one click, never by code (spec 4.4.6).
  const short = inv.kind === 'invoice' ? shortfallOf(inv, d.invoices, ws.invoicing?.shortfallLimit ?? DEFAULT_SHORTFALL_LIMIT, baseCurrency()) : undefined;
  return (
    <div className="status">
      {line}
      {short !== undefined && (
        <div className="notice ivpay ivshort" data-testid="shortfall">
          <span>{t('invoices.shortfall', { amount: `${inv.currency} ${fmt(short)}`, limit: `${inv.currency} ${fmt(ws.invoicing?.shortfallLimit ?? DEFAULT_SHORTFALL_LIMIT)}` })}</span>
          {canEdit && <AsyncButton type="button" className="quiet2" data-act="shortfall-fee" onClick={() => writeOff(nav, inv, { reason: 'fee', amount: short })}>{t('invoices.shortfallBook')}</AsyncButton>}
        </div>
      )}
      {proposals.map((p) => (
        <div key={p.transactionRef} className="notice ivpay">
          <span>{t(p.direction === 'DBIT' ? 'invoices.refundProposal' : 'invoices.proposal', { date: formatDate(p.date), amount: `${p.currency} ${fmt(p.amount)}`, payer: p.payer })}{p.booked && <> {t('invoices.proposalBooked')}</>}</span>
          {canEdit && <span className="acts">
            {p.direction === 'CRDT' && p.amount !== openAmount(inv, d.invoices) && <button type="button" className="btn ghost" data-act="allocate" onClick={() => setUi({ dialog: { kind: 'allocate', transactionRef: p.transactionRef, customerId: inv.customerId } })}>{t('invoices.allocate')}</button>}
            <AsyncButton type="button" className="btn ghost" onClick={() => confirmPayment(nav, inv, p.transactionRef)}>{t(p.booked ? 'invoices.linkPayment' : 'invoices.confirmPayment')}</AsyncButton>
          </span>}
        </div>
      ))}
    </div>
  );
}

/** «Andere Zahlung zuordnen» in the margin: any other incoming payment of the invoice's currency (a prepayment before its date included, r9c-3), linked or allocated. */
function OtherPayment({ d, inv, nav, books, state }: DetailProps & { inv: Issued; state: RowState }) {
  const [pick, setPick] = useState('');
  if (inv.kind !== 'invoice' || (state !== 'open' && state !== 'overdue')) return null;
  const others = linkablePayments(books, d.invoices, inv);
  if (!others.length) return null;
  return (
    <div className="ivother" data-testid="link-other-payment">
      <label><span className="m">{t('invoices.linkOther')}</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">…</option>
          {others.map((x) => <option key={x.ref} value={x.ref}>{formatDate(x.date)} · {x.currency} {fmt(x.amount)} · {x.counterparty || x.description}</option>)}
        </select>
      </label>
      <span className="acts">
        <AsyncButton type="button" className="quiet2" disabled={!pick} onClick={() => confirmPayment(nav, inv, pick).then((ok) => { if (ok) setPick(''); })}>{t('invoices.linkPayment')}</AsyncButton>
        <button type="button" className="quiet2" data-act="allocate-other" disabled={!pick} onClick={() => setUi({ dialog: { kind: 'allocate', transactionRef: pick, customerId: inv.customerId } })}>{t('invoices.allocate')}</button>
      </span>
    </div>
  );
}

/** What the draft still lacks before it can be issued, each with the way to fix it. */
function MissingList({ d, inv, nav, missing, warn }: DetailProps & { inv: Draft; missing: Missing[]; warn?: () => Promise<unknown> }) {
  const fix = (f: Fix) => {
    if ('company' in f) nav.go({ route: { area: 'company', section: f.company }, query: {} });
    else if ('customer' in f) {
      if (f.customer === 'edit') setUi({ dialog: { kind: 'contact', id: inv.customerId } });
      // A person or address gone: the margin's «Kontakt» opens, where another is picked.
      else if (f.customer === 'pick') { setUi({ open: { ...ui().open, customer: true } }); document.querySelector('[data-sec="customer"]')?.scrollIntoView({ block: 'nearest' }); }
      else setUi({ focus: 'customer', preview: false });
    }
    else if ('field' in f) setUi({ focus: f.field, preview: false });
    else return saveDraft(nav, inv, { lines: [...inv.lines, firstLine(false)] });
  };
  return (
    <div className="notice warn ivmissing" id="ivmissing" role="note">
      {I.dot}
      <span>{t(warn ? 'invoices.warnHead' : 'invoices.missingHead')}{' '}
        {missing.map((m, i) => {
          const f = fixFor(m);
          return (
            <span key={`${m.field}${m.line ?? ''}`}>
              {i > 0 && ', '}
              {f ? <AsyncButton type="button" className="golink" onClick={() => fix(f)}>{missingText(m)}</AsyncButton> : missingText(m)}
            </span>
          );
        })}
        {warn && <>{'. '}{t('invoices.warnRule')}</>}
      </span>
      {warn && <AsyncButton type="button" className="btn ghost" data-act="issue-anyway" onClick={warn}>{t('invoices.issueAnyway')}</AsyncButton>}
    </div>
  );
}

function Actions(props: DetailProps & { state: RowState; reminderLevel?: number }) {
  const { d, ws, inv, state, reminderLevel, nav, canEdit } = props;
  const s = useUi();
  const dl = inv.status === 'issued'
    ? <a className="dl inline" href={sources.invoicePdf(inv.number)} download={`${inv.number}.pdf`} data-tip={t('invoices.downloadTip')}>{I.dl}<span>{t('invoices.downloadInstead')}</span></a>
    : null;
  if (!canEdit) return <div className="ivacts">{dl}</div>;
  // A Rechnung or Gutschrift that never went out: its download may be the sending (spec 4.8), so it asks whether to record it.
  const asks = inv.status === 'issued' && (inv.kind === 'invoice' || inv.kind === 'credit-note') && !inv.cancelled && !wasSent(d.sent, inv);
  const download = asks
    ? <button type="button" className="dl inline" data-act="download-pdf" data-tip={t('invoices.downloadAskTip')} onClick={() => setUi({ dialog: { kind: 'download' } })}>{I.dl}<span>{t('invoices.downloadInstead')}</span></button>
    : dl;
  const preview = <button type="button" className="btn ghost" data-act="preview" aria-pressed={s.preview} onClick={() => setUi({ preview: !s.preview })}>{s.preview ? t('invoices.edit') : t('invoices.preview')}</button>;
  if (inv.status === 'draft') {
    const missing = missingForIssue(inv, { customer: customerOf(d, inv, ws.invoicing), sender: senderFor(contextOf(ws), inv.currency), invoices: d.invoices });
    const warnings = missing.length ? [] : [...goneRefs(contactOf(d, inv), inv), ...warningsForIssue(inv)];
    const tryIssue = () => {
      if (missing.length || warnings.length) {
        // Issuing would be refused or warned of: the person is taken to the first thing to fix.
        document.querySelector<HTMLButtonElement>('.ivmissing button')?.focus();
        nav.toast(missing.length ? t('invoices.missing', { list: missing.map(missingText).join(', ') }) : t('invoices.warnEmpty', { list: warnings.map(missingText).join(', ') }));
        return;
      }
      return issue(nav, inv, props.period);
    };
    return (
      <div className="ivacts">
        {preview}
        <AsyncButton type="button" className="btn primary" data-act="issue" aria-describedby={missing.length ? 'ivmissing' : undefined} onClick={tryIssue}>{t(inv.kind === 'credit-note' ? 'invoices.issueCredit' : 'invoices.issue')}</AsyncButton>
        {/* A draft back from issue keeps its number: it is issued again and cancelled, never deleted (the series stays without a gap). */}
        {!inv.number && <AsyncButton type="button" className="btn ghost danger" data-act="delete" onClick={() => deleteDraft(nav, inv)}>{t('common.delete')}</AsyncButton>}
        {missing.length > 0 && <MissingList {...props} inv={inv} missing={missing} />}
        {warnings.length > 0 && <MissingList {...props} inv={inv} missing={warnings} warn={() => issue(nav, inv, props.period, true)} />}
      </div>
    );
  }
  if (reminderLevel !== undefined && s.reminder) {
    const r = s.reminder;
    return (
      <div className="ivacts">
        {preview}
        <button type="button" className="btn primary" data-act="remsend" onClick={() => setUi({ dialog: { kind: 'send', reminder: { level: reminderLevel, ...(r.fee ? { fee: r.fee } : {}), ...(r.intro !== undefined ? { intro: r.intro } : {}), ...(r.closing !== undefined ? { closing: r.closing } : {}) } } })}>
          {t('invoices.sendReminder', { level: reminderLevel })}
        </button>
        <button type="button" className="btn ghost" onClick={() => setUi({ reminder: null, preview: false })}>{t('common.cancel')}</button>
      </div>
    );
  }
  const sentOnce = d.sent.some((x) => x.invoiceId === inv.id && (x.kind === 'invoice' || x.kind === 'credit-note'));
  const open = state === 'open' || state === 'overdue';
  const unpaid = inv.kind === 'invoice' && open;
  const next = open ? reminderDraft(inv, d.invoices, localToday()).level : 0;
  // One row of the main actions of the state; the rest in «Weitere» (owner's review of slice C).
  const main: ReactNode[] = [];
  if (unpaid) main.push(<button key="hand" type="button" className={`btn ${state === 'overdue' ? 'ghost' : 'primary'}`} data-act="hand-payment" onClick={() => setUi({ dialog: { kind: 'handPayment' } })}>{t('invoices.handPayment')}</button>);
  if (state === 'overdue') main.push(<button key="remind" type="button" className="btn primary" data-act="remind" onClick={() => setUi({ reminder: { invoiceId: inv.id }, preview: false })}>{t('invoices.remind', { level: next })}</button>);
  if (open || state === 'credit') main.push(<button key="send" type="button" className={`btn ${sentOnce || unpaid ? 'ghost' : 'primary'}`} data-act="send" data-tip={t('invoices.sendTip')} onClick={() => setUi({ dialog: { kind: 'send' } })}>{sentOnce ? t('invoices.resend') : t('invoices.send')}</button>);
  const more: MenuItem[] = [
    ...(unpaid ? [{ act: 'write-off', label: t('invoices.writeOff'), run: () => setUi({ dialog: { kind: 'writeOff' } }) }] : []),
    ...(unpaid ? [{ act: 'allocate', label: t('invoices.allocate'), run: () => setUi({ dialog: { kind: 'allocate', transactionRef: '', customerId: inv.customerId } }) }] : []),
    ...(open || state === 'paid' ? [{ act: 'credit', label: t('invoices.credit'), run: () => setUi({ dialog: { kind: 'credit' } }) }] : []),
    ...(open || state === 'paid' ? [{ act: 'cancel', label: t('invoices.cancel'), run: () => setUi({ dialog: { kind: 'cancel' } }) }] : []),
    ...(state !== 'credit' ? [{ act: 'copy', label: t('invoices.copy'), run: () => { void copyAsDraft(nav, inv); } }] : []),
    // Spec 4.4.2: only while never sent, nothing settled, and its booking (the agreed basis) in an open period; once sent, Gutschrift and Storno are the ways on.
    // Refused only because it went out (a recorded download included), it is still offered: its dialog says why (decision 97).
    ...(mayGoBack(props, inv) ? [{ act: 'back-to-draft', label: t('invoices.backToDraft'), run: () => setUi({ dialog: { kind: 'backToDraft' } }) }] : []),
    ...(inv.kind === 'invoice' && !inv.cancelled ? [{ act: 'accounts', label: t('invoices.accounts'), run: () => setUi({ dialog: { kind: 'accounts' } }) }] : []),
  ];
  return (
    <div className="ivacts">
      {main}
      {more.length > 0 && <MoreMenu items={more} />}
      {download}
    </div>
  );
}

/** «Zurück zum Entwurf» is offered: the rules allow it, and its booking of the issue (the agreed basis) lies after the locked line. */
function mayGoBack({ d, books }: DetailProps, inv: Issued): boolean {
  const refused = backToDraftRefusal(inv, d.invoices, d.sent);
  if (refused && (refused !== 'sent' || backToDraftRefusal(inv, d.invoices, []))) return false;
  const line = lockedThrough(books.config);
  const ref = eventRef(inv, 'issue');
  return !line || !books.journalEntries?.some((e) => e.transactionRef === ref && e.date <= line);
}

/** The status line of an Angebot, Auftrag or Lieferschein: its status from facts and what it waits for. */
function ChainStatus({ d, inv }: DetailProps & { inv: Issued }) {
  const today = localToday();
  const status = statusOfKind(inv, d.invoices, today);
  const word = t(`sales.status.${groupOf(inv.kind)}.${status}` as 'sales.status.invoice.open');
  const parts = [word];
  if (inv.cancelled) parts.push(formatDate(inv.cancelled.date) + (inv.cancelled.reason ? ` · ${inv.cancelled.reason}` : ''));
  if (inv.kind === 'quote') {
    if (inv.accepted) parts.push(t('sales.acceptedOn', { date: formatDate(inv.accepted.date), by: inv.accepted.by }));
    else if (inv.declined) parts.push(t('sales.declinedOn', { date: formatDate(inv.declined.date), by: inv.declined.by }));
    if (inv.validUntil && status !== 'accepted') parts.push(t(inv.validUntil < today ? 'sales.expiredOn' : 'sales.validUntil', { date: formatDate(inv.validUntil) }));
  }
  if (inv.kind === 'sales-order' && !inv.cancelled) parts.push(t('sales.orderDone', { delivered: Math.round(doneShare(inv, d.invoices, 'delivered') * 100), invoiced: Math.round(doneShare(inv, d.invoices, 'invoiced') * 100) }));
  return <div className="status"><span className={`notice${status === 'expired' || status === 'declined' ? ' warn' : ''}`} data-testid="chain-status">{parts.join(' · ')}</span></div>;
}

/** The actions of an issued Angebot, Auftrag or Lieferschein: its conversions, send, the customer's answer, back to draft, Storno, copy. */
function ChainActions({ d, inv, nav, canEdit }: DetailProps & { inv: Issued }) {
  const dl = <a className="dl inline" href={sources.invoicePdf(inv.number)} download={`${inv.number}.pdf`} data-tip={t('invoices.downloadTip')}>{I.dl}<span>{t('invoices.downloadInstead')}</span></a>;
  if (!canEdit) return <div className="ivacts">{dl}</div>;
  const sentOnce = wasSent(d.sent, inv);
  const main: ReactNode[] = [];
  if (!inv.cancelled) {
    for (const to of CONVERSIONS[inv.kind] ?? []) main.push(<button key={to} type="button" className={`btn ${main.length ? 'ghost' : 'primary'}`} data-act={`convert-${to}`} onClick={() => setUi({ dialog: { kind: 'convert', to } })}>{t(`sales.convert.${to}` as 'sales.convert.invoice')}</button>);
    main.push(<button key="send" type="button" className={`btn ${sentOnce || main.length ? 'ghost' : 'primary'}`} data-act="send" onClick={() => setUi({ dialog: { kind: 'send' } })}>{sentOnce ? t('invoices.resend') : t('invoices.send')}</button>);
  }
  const made = d.invoices.some((x) => !x.deleted && x.from?.id === inv.id);
  const more: MenuItem[] = [
    ...(inv.kind === 'quote' && !inv.accepted ? [{ act: 'accept', label: t('sales.accept'), run: () => { void answer(nav, inv, 'accepted'); } }] : []),
    ...(inv.kind === 'quote' && !inv.declined && !made ? [{ act: 'decline', label: t('sales.decline'), run: () => { void answer(nav, inv, 'declined'); } }] : []),
    ...(inv.kind === 'quote' && (inv.accepted || inv.declined) ? [{ act: 'unanswer', label: t('sales.unanswer'), run: () => { void answer(nav, inv, null); } }] : []),
    ...((inv.kind === 'quote' || inv.kind === 'sales-order') && !inv.cancelled && !made ? [{ act: 'reopen', label: t('sales.reopen'), run: () => { void reopen(nav, inv); } }] : []),
    ...(inv.kind !== 'quote' && !inv.cancelled ? [{ act: 'cancel', label: t('invoices.cancel'), run: () => setUi({ dialog: { kind: 'cancel' } }) }] : []),
    ...(inv.kind !== 'delivery-note' ? [{ act: 'copy', label: t('invoices.copy'), run: () => { void copyAsDraft(nav, inv); } }] : []),
  ];
  return (
    <div className="ivacts">
      {main}
      <MoreMenu items={more} />
      {dl}
    </div>
  );
}

/** The Belegkette in the margin (spec 4.4.1): every document of the chain, each a link, the one shown bold; the same seen from each. */
function ChainSec({ d, inv, nav, period }: DetailProps) {
  const steps = chainOf(inv, d.invoices);
  if (steps.length < 2 && inv.kind !== 'quote' && inv.kind !== 'sales-order') return null;
  const today = localToday();
  return (
    <Sec k="chain" label={t('sales.sec.chain')} val={String(steps.length)}>
      <ol className="ivchain" data-testid="chain">
        {steps.map((s) => {
          const loc = invoiceAt(s.doc, period);
          const name = `${t(`invoices.docKind.${s.doc.kind}`)} ${s.doc.status === 'issued' ? s.doc.number : t('invoices.draft')}`;
          const st = t(`sales.status.${groupOf(s.doc.kind)}.${statusOfKind(s.doc, d.invoices, today)}` as 'sales.status.invoice.open');
          return (
            <li key={s.doc.id} style={{ paddingInlineStart: `${s.depth * 14}px` }} className={s.current ? 'on' : ''} data-kind={s.doc.kind}>
              {s.current ? <b aria-current="page">{name}</b>
                : <a className="golink" href={hrefOf(loc)} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.go(loc); }}>{name}</a>}
              <span className="m"> · {st}</span>
            </li>
          );
        })}
      </ol>
    </Sec>
  );
}

/** «Weitere ▾»: the actions of the state beside the main row. */
function MoreMenu({ items }: { items: MenuItem[] }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  return (
    <>
      <button type="button" className="btn ghost" data-act="more" aria-haspopup="menu" aria-expanded={!!at} onClick={(e) => setAt(e.currentTarget.getBoundingClientRect())}>{t('invoices.more')} ▾</button>
      {at && <Menu anchor={at} items={items} onClose={() => setAt(null)} />}
    </>
  );
}

function DraftSec({ d, ws, inv, nav, canEdit }: DetailProps & { inv: Draft }) {
  const customer = customerOf(d, inv, ws.invoicing);
  const terms = contactDays(contactOf(d, inv), ws.invoicing);
  const def = defaultTexts(contextOf(ws), inv.kind, inv.language, draftDays(contextOf(ws), inv, customer), inv.printAs);
  const own = (inv.intro !== undefined && inv.intro !== def.intro) || (inv.closing !== undefined && inv.closing !== def.closing);
  return (
    <Sec k="draft" label={inv.kind === 'credit-note' ? t('invoices.sec.credit') : inv.kind === 'invoice' ? t('invoices.sec.draft') : t(`invoices.docKind.${inv.kind}`)} val={`${t(`invoices.lang.${inv.language}`)} · ${inv.currency}`}>
      <div className="lkf">
        <div className="lkr"><span>{t('invoices.language')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('invoices.language')}>
            {LANGS.map((l) => <AsyncButton key={l} type="button" role="radio" aria-checked={inv.language === l} className={inv.language === l ? 'on' : ''} disabled={!canEdit} onClick={() => saveDraft(nav, inv, { language: l })}>{l.toUpperCase()}</AsyncButton>)}
          </span>
        </div>
        <div className="lkr"><span>{t('invoices.currency')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('invoices.currency')}>
            {(['CHF', 'EUR'] as const).map((c) => <AsyncButton key={c} type="button" role="radio" aria-checked={inv.currency === c} className={inv.currency === c ? 'on' : ''} disabled={!canEdit || !ws.invoicing?.payTo[c]} data-tip={ws.invoicing?.payTo[c] ? undefined : t('invoices.currencyNeedsPayTo', { currency: c })} onClick={() => saveDraft(nav, inv, { currency: c })}>{c}</AsyncButton>)}
          </span>
        </div>
        {inv.kind === 'invoice' && (ws.invoicing?.paymentTerms.length ?? 0) > 0 && (
          <label className="lkr"><span>{t('invoices.terms')}</span>
            <select data-testid="draft-terms" value={inv.termsId ?? ''} disabled={!canEdit} onChange={(e) => saveDraft(nav, inv, { termsId: e.target.value || null, dueDate: null })}>
              <option value="">{t('invoices.termsCustomer', { n: terms })}</option>
              {ws.invoicing!.paymentTerms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        )}
        {inv.kind === 'sales-order' && (
          <div className="lkr"><span>{t('sales.printAs')}</span>
            <span className="seg2" role="radiogroup" aria-label={t('sales.printAs')}>
              {(['confirmation', 'proforma'] as const).map((p) => <AsyncButton key={p} type="button" role="radio" data-print={p} aria-checked={(inv.printAs ?? 'confirmation') === p} className={(inv.printAs ?? 'confirmation') === p ? 'on' : ''} disabled={!canEdit} onClick={() => saveDraft(nav, inv, { printAs: p === 'confirmation' ? null : p, intro: null, closing: null })}>{t(`sales.printAs.${p}`)}</AsyncButton>)}
            </span>
          </div>
        )}
        {inv.kind !== 'credit-note' && (
          <label className="lkr"><span>{t('sales.ordered')}</span>
            <input data-testid="draft-ordered" defaultValue={inv.ordered ?? ''} placeholder={t('sales.orderedPh')} disabled={!canEdit} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (inv.ordered ?? '')) void saveDraft(nav, inv, { ordered: v || null }); }} />
          </label>
        )}
        {chargesVat() && inv.kind !== 'delivery-note' && (
          <div className="lkr"><span>{t('invoices.prices')}</span>
            <span className="seg2" role="radiogroup" aria-label={t('invoices.prices')}>
              {PRICES.map((p) => <AsyncButton key={p} type="button" role="radio" data-prices={p} aria-checked={(inv.prices ?? 'net') === p} className={(inv.prices ?? 'net') === p ? 'on' : ''} disabled={!canEdit} onClick={() => saveDraft(nav, inv, { prices: p, lines: repriced(inv.lines) })}>{t(`invoices.prices.${p}`)}</AsyncButton>)}
            </span>
          </div>
        )}
      </div>
      {/* A firm not registered issues invoices without VAT (#347): said as a fact, with its place. */}
      {!chargesVat() && <p className="m ivhint" data-testid="invoice-no-vat">{t('invoices.noVat')} · <button type="button" className="quiet2" onClick={() => nav.go({ route: { area: 'company', section: 'vat' }, query: {} })}>{t('invoices.toVat')}</button></p>}
      {own && <p className="m ivhint">{t('invoices.ownTexts')}{canEdit && <> · <AsyncButton type="button" className="quiet2" data-act="reset-texts" onClick={() => saveDraft(nav, inv, { intro: null, closing: null })}>{t('invoices.resetTexts')}</AsyncButton></>}</p>}
      <p className="lkfoot"><button type="button" className="quiet2" onClick={() => nav.go({ route: { area: 'company', section: 'invoice-layout' }, query: {} })}>{t('invoices.toLayout')}</button></p>
    </Sec>
  );
}

function ReminderSec({ d, inv }: DetailProps & { inv: Issued }) {
  const s = useUi();
  const r = s.reminder!;
  const drafted = reminderDraft(inv, d.invoices, localToday(), r.fee);
  return (
    <Sec k="draft" label={t('invoices.sec.reminder', { level: drafted.level })} val={t('invoices.dueShort', { date: formatDate(drafted.dueDate) })}>
      <div className="lkf">
        <label className="lkr"><span>{t('invoices.fee')}</span>
          <input className="mono" inputMode="decimal" defaultValue={r.fee ? fmt(r.fee) : ''} placeholder="0.00" aria-label={t('invoices.fee')}
            onBlur={(e) => { const n = parseNumber(e.target.value); setUi({ reminder: { ...r, ...(n && n > 0 ? { fee: n } : { fee: undefined }) } }); }} />
        </label>
      </div>
      <p className="m ivhint">{t('invoices.feeHint')}</p>
    </Sec>
  );
}

/**
 * The margin's Kontakt: whom the document goes to. A draft picks the contact on the sheet, then here
 * the contact person («z. Hd.», the mail's recipient) and the address (the billing address unless
 * another is picked); an issued document shows what it froze.
 */
function CustomerSec({ d, ws, inv, nav, canEdit }: DetailProps) {
  const c = customerOf(d, inv, ws.invoicing);
  if (!c) return null;
  const a = c.address;
  const contact = inv.status === 'draft' ? contactOf(d, inv) : undefined;
  const addr = contact ? addressOf(contact, inv.addressId) : undefined;
  const gone = inv.status === 'draft' ? goneRefs(contact, inv) : [];
  return (
    <Sec k="customer" label={t('invoices.sec.customer')} val={a.town}>
      {gone.length > 0 && <p className="m ivhint warn" data-testid="draft-gone">{gone.map(missingText).join(' · ')}</p>}
      {contact && inv.status === 'draft' && (contact.persons.length > 0 || contact.addresses.length > 1) && (
        <div className="lkf">
          {contact.persons.length > 0 && (
            <label className="lkr"><span>{t('contacts.attn')}</span>
              <select data-testid="draft-person" value={inv.personId ?? ''} disabled={!canEdit} onChange={(e) => saveDraft(nav, inv, { personId: e.target.value || null })}>
                <option value="">{t('contacts.noPerson')}</option>
                {contact.persons.map((p) => <option key={p.id} value={p.id}>{p.role ? `${p.name} · ${p.role}` : p.name}</option>)}
              </select>
            </label>
          )}
          {contact.addresses.length > 1 && (
            <label className="lkr"><span>{t('contacts.address')}</span>
              <select data-testid="draft-address" value={addr?.id ?? ''} disabled={!canEdit} onChange={(e) => saveDraft(nav, inv, { addressId: e.target.value === contact.addresses.find((x) => x.billing)?.id || !e.target.value ? null : e.target.value })}>
                {contact.addresses.map((x) => <option key={x.id} value={x.id}>{[x.label, `${x.street ?? ''} ${x.number ?? ''}`.trim(), x.town].filter(Boolean).join(' · ')}{x.billing || (!contact.addresses.some((y) => y.billing) && x === contact.addresses[0]) ? ` (${t('contacts.billing')})` : x.delivery ? ` (${t('contacts.delivery')})` : ''}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      <dl className="kv">
        <dt>{t('invoices.f.name')}</dt><dd>{c.name}{c.attn && <><br />{c.attn}</>}</dd>
        <dt>{t('invoices.f.address')}</dt><dd>{[[a.street, a.number].filter(Boolean).join(' '), a.line2, `${a.postcode} ${a.town}${a.state ? ` ${a.state}` : ''}`, a.country !== 'CH' ? countryName(a.country, language()) : ''].filter(Boolean).join(', ')}</dd>
        <dt>{t('invoices.f.email')}</dt><dd>{c.email || '–'}</dd>
        <dt>{t('invoices.f.vatId')}</dt><dd>{c.vatId || '–'}</dd>
        <dt>{t('invoices.f.terms')}</dt><dd>{t('invoices.nDays', { n: c.paymentTermsDays })}</dd>
      </dl>
      {inv.status === 'issued' ? <p className="m ivhint">{t('invoices.customerFrozen')}</p>
        : canEdit && <button type="button" className="quiet2" onClick={() => setUi({ dialog: { kind: 'contact', id: inv.customerId } })}>{t('contacts.edit')}</button>}
    </Sec>
  );
}

function SentSec({ d, inv, nav }: DetailProps & { inv: Issued }) {
  const n = d.sent.filter((x) => x.invoiceId === inv.id && !x.deleted).length;
  return (
    <Sec k="sent" label={t('sales.sec.sent')} val={n ? String(n) : '–'}>
      <SentList sent={d.sent} inv={inv} nav={nav} />
    </Sec>
  );
}

function Comments({ inv, nav, canEdit }: DetailProps) {
  const [text, setText] = useState('');
  const add = async () => { if (text.trim() && (await comment(nav, inv, text))) setText(''); };
  return (
    <Sec k="comments" label={t('invoices.sec.comments')} val={inv.comments.length ? String(inv.comments.length) : ''}>
      <div className="ivnotes">
        {inv.comments.map((c) => (
          <div key={c.id} className="ivnote">
            <div className="nh"><b>{c.author}</b><span className="mono">{formatDate(c.createdAt.slice(0, 10))} {new Date(c.createdAt).toTimeString().slice(0, 5)}</span></div>
            <p>{c.text}</p>
          </div>
        ))}
        {canEdit && (
          <>
            <textarea rows={2} value={text} placeholder={t('invoices.commentPlaceholder')} aria-label={t('invoices.sec.comments')} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(); } }} />
            <AsyncButton type="button" className="quiet2" onClick={() => add()}>{t('invoices.addComment')} <span className="m">⌘↵</span></AsyncButton>
          </>
        )}
      </div>
    </Sec>
  );
}

function Log({ d, inv }: DetailProps) {
  const rows: Array<[string, ReactNode]> = [[inv.createdAt.slice(0, 10), t('invoices.log.created')]];
  // Each PDF it was issued with before it went back to draft stays, marked as replaced (spec 4.4.2).
  (inv.replaced ?? []).forEach((r, k) => {
    rows.push([r.issuedAt.slice(0, 10), t('invoices.log.issued', { number: inv.number ?? '' })]);
    rows.push([r.replacedAt.slice(0, 10), <>{t('invoices.log.replaced')} · <a className="golink" href={inv.number ? sources.replacedPdf({ id: inv.id, number: inv.number }, k + 1) : undefined} target="_blank" rel="noreferrer" data-act="replaced-pdf">{t('invoices.replacedPdf', { date: formatDate(r.issuedAt.slice(0, 10)) })}</a></>]);
  });
  if (inv.status === 'issued') {
    rows.push([inv.issuedAt.slice(0, 10), t('invoices.log.issued', { number: inv.number })]);
    for (const x of d.sent.filter((y) => y.invoiceId === inv.id)) rows.push([x.sentAt.slice(0, 10), t('invoices.log.sent', { title: x.title })]);
    const how = { reference: 'invoices.log.paidRef', number: 'invoices.log.paidNumber', confirmed: 'invoices.log.paidConfirmed' } as const;
    for (const p of inv.payments) rows.push([p.date, t(inv.kind === 'credit-note' ? 'invoices.log.refunded' : p.source === 'hand' ? 'invoices.log.paidHand' : how[p.by], { amount: `${inv.currency} ${fmt(p.amount)}` })]);
    for (const w of inv.writeOffs ?? []) rows.push([w.date, t('invoices.log.writtenOff', { reason: t(`invoices.reason.${w.reason}`), amount: `${inv.currency} ${fmt(w.amount)}` })]);
    if (inv.cancelled) rows.push([inv.cancelled.date, t('invoices.log.cancelled')]);
    for (const c of inv.accountChanges ?? []) rows.push([c.at.slice(0, 10), t('invoices.log.accounts', { list: c.lines.map((l) => t('invoices.accountsPos', { n: l.line + 1, from: l.from, to: l.to })).join(', ') })]);
    if (inv.accepted) rows.push([inv.accepted.date, t('sales.log.accepted', { by: inv.accepted.by })]);
    if (inv.declined) rows.push([inv.declined.date, t('sales.log.declined', { by: inv.declined.by })]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <Sec k="log" label={t('invoices.sec.log')} val={String(rows.length)}>
      <div className="ivlog">{rows.map(([date, text], i) => <div key={i}><span className="mono">{formatDate(date)}</span><span>{text}</span></div>)}</div>
    </Sec>
  );
}

function SentDetail({ d, route, nav }: Props & { d: InvoiceList }) {
  const doc = d.sent.find((x) => x.id === route.id);
  if (!doc) return <div className="detail-empty"><div>{route.id ? t('invoices.docGone') : t('invoices.nothingSent')}</div></div>;
  const inv = d.invoices.find((i) => i.id === doc.invoiceId);
  const src = sources.sentPdf(doc.id);
  return (
    <div className="detail-in" data-for={doc.id}>
      <div className="head"><h2 className="who">{doc.title}<small>{inv ? customerOf(d, inv)?.name : ''}</small></h2></div>
      <div className="facts">
        <span>{t(`invoices.docKind.${doc.kind}`)}</span>
        <span>{t('invoices.sentAt', { date: formatDate(doc.sentAt.slice(0, 10)), time: new Date(doc.sentAt).toTimeString().slice(0, 5) })}</span>
        <span>{doc.to === 'download' ? t('invoices.toDownload') : t('invoices.to', { to: doc.to })}</span>
        <span className="mono" data-tip={t('invoices.shaTip')}>{t('invoices.sha', { sha: doc.sha256.slice(0, 12) })}</span>
      </div>
      <div className="ivacts">
        {inv && <button type="button" className="btn ghost" onClick={() => nav.go(invoiceAt(inv))}>{t('invoices.toInvoice', { number: routeId(inv) })}</button>}
        <a className="dl inline" href={src} download={`${doc.title}.pdf`}>{I.dl}<span>{t('invoices.download')}</span></a>
      </div>
      <div className="body">
        <div className="desk"><div className="paper real sentpdf"><Paper key={src} src={src} maxWidth={900} whole /></div></div>
        <aside className="margin" />
      </div>
    </div>
  );
}
