/**
 * The right side of Rechnungen: an invoice on its A4 sheet (a draft edited in place, a reminder
 * written on the sheet before it goes out) with its state, actions and margin; a customer with
 * their invoices; a sent document as the PDF that went out.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { issuedPdfUrl, sentPdfUrl, type Draft, type Invoice, type Issued } from '../../../invoices/model.js';
import { defaultTexts, senderFor } from '../../../invoices/documents.js';
import { missingForIssue, openAmount, openFees, paidAmount, refundDue, reminderDraft, totals, type Missing } from '../../../invoices/rules.js';
import { prettyReference } from '../../../providers/qr-bill/reference.js';
import type { PaymentProposal } from '../../../invoices/payments.js';
import { at } from '../receipts/view.js';
import type { CompanyInfo } from '../../../books/company.js';
import type { RouteOf } from '../../shell/route.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { api, missingText, type DraftChange, type InvoiceList } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import { I } from '../receipts/icons.js';
import { Paper } from '../receipts/Paper.js';
import type { AreaProps } from '../index.js';
import { useInvoices } from './data.js';
import { byRouteId, customerOf, issuedLater, linkablePayments, routeId, rowState, wasSent, type RowState } from './model.js';
import { fixFor, parseNumber, sheetEdit, type Fix } from './edit.js';
import { setUi, useUi, type Section } from './state.js';
import { comment, confirmPayment, copyAsDraft, deleteDraft, firstLine, invoiceAt, issue, releasePayment, saveDraft, send, sendReminder } from './actions.js';
import { contextOf, draftData, issuedData, reminderData } from './sheets.js';
import { Sheet } from './Sheet.js';
import { hrefOf } from '../../shell/history.js';
import { countryName } from './address.js';

type Props = AreaProps<RouteOf<'invoices'>>;

const LANGS = ['de', 'fr', 'it', 'en'] as const;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);

export function Detail(props: Props) {
  const load = useInvoices();
  const ws = useWorkspace();
  if (load.state !== 'ready' || !ws) return <div className="detail-empty"><div>{load.state === 'failed' ? t('invoices.unavailable') : ''}</div></div>;
  const d = load.data;
  const { route } = props;
  if (route.view === 'customers') return <CustomerDetail {...props} d={d} />;
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
  const t0 = totals(inv.lines);
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

  function action(a: string, k: number): string | void {
    if (inv.status !== 'draft') return;
    if (a === 'rmline') void saveDraft(nav, inv, { lines: inv.lines.filter((_, i) => i !== k) });
    if (a === 'addline') {
      const zero = inv.lines.length > 0 && inv.lines.every((l) => l.vatRate === 0);
      void saveDraft(nav, inv, { lines: [...inv.lines, firstLine(zero)] });
      return `l:${inv.lines.length}:text`;
    }
  }

  return (
    <div className="detail-in" data-for={inv.id}>
      <div className="head">
        <h2 className="who">{customer?.name || t('invoices.noCustomer')}<small>{inv.kind === 'credit-note' && inv.status === 'issued' ? `${t('invoices.creditNo', { number: inv.number })} ${inv.subject ?? ''}` : inv.subject ?? ''}</small></h2>
        <div className="amount"><small>{inv.currency}</small>{fmt(t0.gross)}</div>
      </div>
      <div className="facts">
        <span>{inv.status === 'issued' ? (inv.kind === 'credit-note' ? t('invoices.creditNo', { number: inv.number }) : t('invoices.no', { number: inv.number })) : t('invoices.draftNoNumber')}</span>
        <span data-tip={t('invoices.dateTip')}>{formatDate(inv.date)}</span>
        {inv.status === 'issued' && inv.kind === 'invoice' && <span data-tip={t('invoices.dueTip')}>{t('invoices.due', { date: formatDate(inv.dueDate) })}</span>}
        {inv.status === 'issued' && inv.kind === 'invoice' && <span data-tip={t('invoices.referenceTip')}>{prettyReference(inv.reference)}</span>}
        <span>{t0.vat || inv.lines.some((l) => l.vatRate > 0) ? t('invoices.vatAmount', { amount: fmt(t0.vat) }) : t('invoices.vatZero')}</span>
      </div>
      <Status {...props} state={state} reminder={!!reminder} />
      <Actions {...props} state={state} reminderLevel={reminder ? reminderDraft(inv, d.invoices, today).level : undefined} />
      <div className="body">
        <div className="desk">
          <Sheet data={data} editing={editing} onEdit={edit} onAction={action} focus={editing ? s.focus : undefined} onFocused={() => setUi({ focus: undefined })} />
        </div>
        <aside className="margin" aria-label={t('invoices.details')}>
          {inv.status === 'draft' ? <DraftSec {...props} inv={inv} /> : <Sec k="look" label={t('invoices.sec.look')} val={`${t(`invoices.lang.${inv.language}`)} · ${inv.layout.font}`}><p className="m">{t('invoices.lookFrozen')}</p></Sec>}
          {reminder && inv.status === 'issued' && <ReminderSec {...props} inv={inv} />}
          <CustomerSec {...props} />
          {inv.status === 'issued' && <SentSec {...props} inv={inv} />}
          <Comments {...props} />
          <Log {...props} />
        </aside>
      </div>
    </div>
  );
}

/** An edit on the draft's sheet, saved; false: refused, the field goes back. */
function draftChange({ d, ws, nav }: DetailProps, inv: Draft, key: string, value: string): DraftChange | false | undefined {
  const terms = d.customers.find((x) => x.id === inv.customerId)?.paymentTermsDays ?? ws.invoicing?.paymentTermsDays ?? 30;
  const r = sheetEdit(inv, key, value, { customers: d.customers, defaultTexts: defaultTexts(contextOf(ws), inv.kind, inv.language, terms) });
  if (!r) return undefined;
  if ('change' in r) return r.change;
  if ('newCustomer' in r) { setUi({ dialog: { kind: 'customer', then: { draft: inv.id } } }); return false; }
  if (r.refused === 'date') nav.toast(t('invoices.errDate'));
  if (r.refused === 'number') nav.toast(t('invoices.errNumber'));
  return false;
}

function Status({ d, ws, inv, state, reminder, nav, canEdit, books }: DetailProps & { state: RowState; reminder: boolean }) {
  const today = localToday();
  const [proposals, setProposals] = useState<PaymentProposal[]>([]);
  const [pick, setPick] = useState('');
  // An open invoice may be paid, a credit note may be paid back: what the bank shows that could be it.
  const awaits = inv.status === 'issued' && (state === 'open' || state === 'overdue' || (state === 'credit' && refundDue(inv, d.invoices) > 0));
  useEffect(() => {
    setProposals([]);
    if (!awaits) return;
    let live = true;
    api.paymentProposals().then((p) => { if (live) setProposals(p.filter((x) => x.invoiceId === inv.id)); }, () => undefined);
    return () => { live = false; };
  }, [inv.id, awaits]);

  if (inv.status === 'draft') {
    const later = issuedLater(d.invoices, inv);
    return (
      <div className="status">
        <span className="notice">{t(inv.kind === 'credit-note' ? 'invoices.creditDraftStatus' : 'invoices.draftStatus')}</span>
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
  const sent = d.sent.filter((x) => x.invoiceId === inv.id).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const firstSent = sent.find((x) => x.kind === 'invoice' || x.kind === 'credit-note');
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
    line = <span className="linked">{I.check}{last ? t('invoices.paidOn', { date: formatDate(last.date), amount: `${inv.currency} ${fmt(paidAmount(inv))}` }) : t('invoices.settledByCredit')}{fee > 0 ? ` · ${t('invoices.feeOpen', { amount: `${inv.currency} ${fmt(fee)}` })}` : ''}</span>;
  } else {
    const due = inv.dueDate;
    const r = inv.reminders.at(-1);
    const paid = paidAmount(inv);
    const parts = [
      state === 'overdue' ? t('invoices.overdueSince', { n: days(due, today) }) : t('invoices.openDue', { when: due === today ? t('invoices.today') : t('invoices.inDays', { n: days(today, due) }) }),
      ...(r ? [t('invoices.lastReminder', { level: r.level, date: formatDate(r.date) })] : []),
      ...(paid ? [t('invoices.partlyPaid', { paid: fmt(paid), open: fmt(openAmount(inv, d.invoices)) })] : []),
      ...(openFees(inv) > 0 ? [t('invoices.feeOpen', { amount: `${inv.currency} ${fmt(openFees(inv))}` })] : []),
      firstSent ? t('invoices.sentOn', { date: formatDate(firstSent.sentAt.slice(0, 10)) }) : t('invoices.notSent'),
    ];
    line = <span className={`notice${state === 'overdue' ? ' warn' : ''}`}>{state === 'overdue' && I.dot}{parts.join(' · ')}</span>;
  }
  return (
    <div className="status">
      {line}
      {canEdit && !inv.cancelled && inv.payments.map((p) => (
        <div key={p.transactionRef} className="notice ivpay" data-testid="linked-payment">
          <span>{t(inv.kind === 'credit-note' ? 'invoices.linkedRefund' : 'invoices.linkedPayment', { date: formatDate(p.date), amount: `${inv.currency} ${fmt(p.amount)}` })}</span>
          <button type="button" className="golink" onClick={() => nav.go(at({ area: 'bank', payment: p.transactionRef }, p.date))}>{p.transactionRef}</button>
          <button type="button" className="btn ghost" data-tip={t('invoices.releasePaymentTip')} onClick={() => void releasePayment(nav, inv, p.transactionRef)}>{t('invoices.releasePayment')}</button>
        </div>
      ))}
      {proposals.map((p) => (
        <div key={p.transactionRef} className="notice ivpay">
          <span>{t(p.direction === 'DBIT' ? 'invoices.refundProposal' : 'invoices.proposal', { date: formatDate(p.date), amount: `${p.currency} ${fmt(p.amount)}`, payer: p.payer })}{p.booked && <> {t('invoices.proposalBooked')}</>}</span>
          {canEdit && <button type="button" className="btn ghost" onClick={() => void confirmPayment(nav, inv, p.transactionRef)}>{t(p.booked ? 'invoices.linkPayment' : 'invoices.confirmPayment')}</button>}
        </div>
      ))}
      {canEdit && awaits && inv.kind === 'invoice' && (() => {
        // Any other incoming payment of the invoice's currency, a prepayment before its date included (r9c-3).
        const others = linkablePayments(books, d.invoices, inv).filter((x) => !proposals.some((p) => p.transactionRef === x.ref));
        return others.length ? (
          <div className="notice ivpay" data-testid="link-other-payment">
            <label>{t('invoices.linkOther')}{' '}
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">…</option>
                {others.map((x) => <option key={x.ref} value={x.ref}>{formatDate(x.date)} · {x.currency} {fmt(x.amount)} · {x.counterparty || x.description}</option>)}
              </select>
            </label>
            <button type="button" className="btn ghost" disabled={!pick} onClick={() => void confirmPayment(nav, inv, pick).then((ok) => { if (ok) setPick(''); })}>{t('invoices.linkPayment')}</button>
          </div>
        ) : null;
      })()}
    </div>
  );
}

/** What the draft still lacks before it can be issued, each with the way to fix it. */
function MissingList({ d, inv, nav, missing }: DetailProps & { inv: Draft; missing: Missing[] }) {
  const fix = (f: Fix) => {
    if ('company' in f) nav.go({ route: { area: 'company', section: f.company }, query: {} });
    else if ('customer' in f) { if (f.customer === 'edit') setUi({ dialog: { kind: 'customer', id: inv.customerId } }); else setUi({ focus: 'customer', preview: false }); }
    else if ('field' in f) setUi({ focus: f.field, preview: false });
    else void saveDraft(nav, inv, { lines: [...inv.lines, firstLine(false)] });
  };
  return (
    <div className="notice warn ivmissing" id="ivmissing" role="note">
      {I.dot}
      <span>{t('invoices.missingHead')}{' '}
        {missing.map((m, i) => {
          const f = fixFor(m);
          return (
            <span key={`${m.field}${m.line ?? ''}`}>
              {i > 0 && ', '}
              {f ? <button type="button" className="golink" onClick={() => fix(f)}>{missingText(m)}</button> : missingText(m)}
            </span>
          );
        })}
      </span>
    </div>
  );
}

function Actions(props: DetailProps & { state: RowState; reminderLevel?: number }) {
  const { d, ws, inv, state, reminderLevel, nav, canEdit } = props;
  const s = useUi();
  const dl = inv.status === 'issued'
    ? <a className="dl inline" href={issuedPdfUrl(inv.number)} download={`${inv.number}.pdf`} data-tip={t('invoices.downloadTip')}>{I.dl}<span>{t('invoices.downloadInstead')}</span></a>
    : null;
  if (!canEdit) return <div className="ivacts">{dl}</div>;
  const preview = <button type="button" className="btn ghost" data-act="preview" aria-pressed={s.preview} onClick={() => setUi({ preview: !s.preview })}>{s.preview ? t('invoices.edit') : t('invoices.preview')}</button>;
  if (inv.status === 'draft') {
    const missing = missingForIssue(inv, { customer: d.customers.find((c) => c.id === inv.customerId), sender: senderFor(contextOf(ws), inv.currency), invoices: d.invoices });
    const tryIssue = () => {
      if (missing.length) {
        // Issuing would be refused: the person is taken to the first thing to fix.
        document.querySelector<HTMLButtonElement>('.ivmissing button')?.focus();
        nav.toast(t('invoices.missing', { list: missing.map(missingText).join(', ') }));
        return;
      }
      void issue(nav, inv, props.period);
    };
    return (
      <div className="ivacts">
        {preview}
        <button type="button" className="btn primary" data-act="issue" aria-describedby={missing.length ? 'ivmissing' : undefined} onClick={tryIssue}>{t(inv.kind === 'credit-note' ? 'invoices.issueCredit' : 'invoices.issue')}</button>
        <button type="button" className="btn ghost danger" data-act="delete" onClick={() => {
          const i = d.invoices.indexOf(inv);
          void deleteDraft(nav, inv, d.invoices[i + 1] ?? d.invoices[i - 1]);
        }}>{t('common.delete')}</button>
        {missing.length > 0 && <MissingList {...props} inv={inv} missing={missing} />}
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
  const sendBtn = <button type="button" className={`btn ${sentOnce || state === 'overdue' ? 'ghost' : 'primary'}`} data-act="send" data-tip={t('invoices.sendTip')} onClick={() => setUi({ dialog: { kind: 'send' } })}>{sentOnce ? t('invoices.resend') : t('invoices.send')}</button>;
  const copy = <button type="button" className="btn ghost" data-act="copy" data-tip={t('invoices.copyTip')} onClick={() => void copyAsDraft(nav, inv)}>{t('invoices.copy')}</button>;
  const credit = <button type="button" className="btn ghost" data-act="credit" onClick={() => setUi({ dialog: { kind: 'credit' } })}>{t('invoices.credit')}</button>;
  const cancel = <button type="button" className="btn ghost danger" data-act="cancel" onClick={() => setUi({ dialog: { kind: 'cancel' } })}>{t('invoices.cancel')}</button>;
  const next = state === 'open' || state === 'overdue' ? reminderDraft(inv, d.invoices, localToday()).level : 0;
  const remind = <button type="button" className={`btn ${state === 'overdue' ? 'primary' : 'ghost'}`} data-act="remind" onClick={() => setUi({ reminder: { invoiceId: inv.id }, preview: false })}>{t('invoices.remind', { level: next })}</button>;
  return (
    <div className="ivacts">
      {state === 'overdue' && remind}
      {(state === 'open' || state === 'overdue' || state === 'credit') && sendBtn}
      {state !== 'credit' && copy}
      {(state === 'open' || state === 'overdue' || state === 'paid') && credit}
      {(state === 'open' || state === 'overdue' || state === 'paid') && cancel}
      {dl}
    </div>
  );
}

function DraftSec({ d, ws, inv, nav, canEdit }: DetailProps & { inv: Draft }) {
  const terms = d.customers.find((c) => c.id === inv.customerId)?.paymentTermsDays ?? ws.invoicing?.paymentTermsDays ?? 30;
  const def = defaultTexts(contextOf(ws), inv.kind, inv.language, terms);
  const own = (inv.intro !== undefined && inv.intro !== def.intro) || (inv.closing !== undefined && inv.closing !== def.closing);
  return (
    <Sec k="draft" label={t(inv.kind === 'credit-note' ? 'invoices.sec.credit' : 'invoices.sec.draft')} val={`${t(`invoices.lang.${inv.language}`)} · ${inv.currency}`}>
      <div className="lkf">
        <div className="lkr"><span>{t('invoices.language')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('invoices.language')}>
            {LANGS.map((l) => <button key={l} type="button" role="radio" aria-checked={inv.language === l} className={inv.language === l ? 'on' : ''} disabled={!canEdit} onClick={() => void saveDraft(nav, inv, { language: l })}>{l.toUpperCase()}</button>)}
          </span>
        </div>
        <div className="lkr"><span>{t('invoices.currency')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('invoices.currency')}>
            {(['CHF', 'EUR'] as const).map((c) => <button key={c} type="button" role="radio" aria-checked={inv.currency === c} className={inv.currency === c ? 'on' : ''} disabled={!canEdit || !ws.invoicing?.payTo[c]} data-tip={ws.invoicing?.payTo[c] ? undefined : t('invoices.currencyNeedsPayTo', { currency: c })} onClick={() => void saveDraft(nav, inv, { currency: c })}>{c}</button>)}
          </span>
        </div>
      </div>
      {own && <p className="m ivhint">{t('invoices.ownTexts')} · <button type="button" className="quiet2" onClick={() => void saveDraft(nav, inv, { intro: null, closing: null })}>{t('invoices.resetTexts')}</button></p>}
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

function CustomerSec({ d, inv, canEdit }: DetailProps) {
  const c = customerOf(d, inv);
  if (!c) return null;
  const a = c.address;
  return (
    <Sec k="customer" label={t('invoices.sec.customer')} val={a.town}>
      <dl className="kv">
        <dt>{t('invoices.f.name')}</dt><dd>{c.name}</dd>
        <dt>{t('invoices.f.address')}</dt><dd>{[[a.street, a.number].filter(Boolean).join(' '), a.line2, `${a.postcode} ${a.town}${a.state ? ` ${a.state}` : ''}`, a.country !== 'CH' ? countryName(a.country, language()) : ''].filter(Boolean).join(', ')}</dd>
        <dt>{t('invoices.f.email')}</dt><dd>{c.email || '–'}</dd>
        <dt>{t('invoices.f.vatId')}</dt><dd>{c.vatId || '–'}</dd>
        <dt>{t('invoices.f.terms')}</dt><dd>{t('invoices.nDays', { n: c.paymentTermsDays })}</dd>
      </dl>
      {inv.status === 'issued' ? <p className="m ivhint">{t('invoices.customerFrozen')}</p>
        : canEdit && <button type="button" className="quiet2" onClick={() => setUi({ dialog: { kind: 'customer', id: inv.customerId } })}>{t('invoices.editCustomer')}</button>}
    </Sec>
  );
}

function SentSec({ d, inv, nav }: DetailProps & { inv: Issued }) {
  const docs = d.sent.filter((x) => x.invoiceId === inv.id).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  return (
    <Sec k="sent" label={t('invoices.sec.sent')} val={docs.length ? String(docs.length) : '–'}>
      {docs.length ? (
        <div className="ivsent">
          {docs.map((x) => (
            <button key={x.id} type="button" className="sdoc" onClick={() => nav.go({ route: { area: 'invoices', view: 'sent', id: x.id }, query: {} })}>
              <span className="mono">{formatDate(x.sentAt.slice(0, 10))}</span>
              <span>{x.title}<small>{x.to === 'download' ? t('invoices.toDownload') : x.to} · {new Date(x.sentAt).toTimeString().slice(0, 5)}</small></span>
              <span className="m">{t('invoices.view')}</span>
            </button>
          ))}
        </div>
      ) : <p className="m">{t('invoices.nothingSentYet')}</p>}
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
            <button type="button" className="quiet2" onClick={() => void add()}>{t('invoices.addComment')} <span className="m">⌘↵</span></button>
          </>
        )}
      </div>
    </Sec>
  );
}

function Log({ d, inv }: DetailProps) {
  const rows: Array<[string, string]> = [[inv.createdAt.slice(0, 10), t('invoices.log.created')]];
  if (inv.status === 'issued') {
    rows.push([inv.issuedAt.slice(0, 10), t('invoices.log.issued', { number: inv.number })]);
    for (const x of d.sent.filter((y) => y.invoiceId === inv.id)) rows.push([x.sentAt.slice(0, 10), t('invoices.log.sent', { title: x.title })]);
    const how = { reference: 'invoices.log.paidRef', number: 'invoices.log.paidNumber', confirmed: 'invoices.log.paidConfirmed' } as const;
    for (const p of inv.payments) rows.push([p.date, t(inv.kind === 'credit-note' ? 'invoices.log.refunded' : how[p.by], { amount: `${inv.currency} ${fmt(p.amount)}` })]);
    if (inv.cancelled) rows.push([inv.cancelled.date, t('invoices.log.cancelled')]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <Sec k="log" label={t('invoices.sec.log')} val={String(rows.length)}>
      <div className="ivlog">{rows.map(([date, text], i) => <div key={i}><span className="mono">{formatDate(date)}</span><span>{text}</span></div>)}</div>
    </Sec>
  );
}

function CustomerDetail({ d, route, nav, canEdit }: Props & { d: InvoiceList }) {
  const c = d.customers.find((x) => x.id === route.id);
  if (!c) return <div className="detail-empty"><div>{route.id ? t('invoices.customerGone') : t('invoices.noneSelected')}</div></div>;
  const a = c.address;
  const invs = d.invoices.filter((i) => i.customerId === c.id).sort((x, y) => y.date.localeCompare(x.date));
  const today = localToday();
  return (
    <div className="detail-in" data-for={c.id}>
      <div className="head"><h2 className="who">{c.name}<small>{[c.attn, [a.street, a.number].filter(Boolean).join(' '), `${a.country !== 'CH' ? `${a.country}-` : ''}${a.postcode} ${a.town}`].filter(Boolean).join(' · ')}</small></h2></div>
      <div className="facts">
        <span>{c.email || t('invoices.noEmail')}</span>
        <span>{c.vatId || t('invoices.noVatId')}</span>
        <span>{t('invoices.nDays', { n: c.paymentTermsDays })}</span>
        <span>{t(`invoices.lang.${c.language}`)}</span>
        <span><a className="linkbtn" data-act="partner-page" href={hrefOf({ route: { area: 'partners', id: c.id }, query: {} })} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.go({ route: { area: 'partners', id: c.id }, query: {} }); }}>{t('partners.openPage')}</a></span>
      </div>
      {canEdit && (
        <div className="ivacts">
          <button type="button" className="btn ghost" data-act="edit-customer" onClick={() => setUi({ dialog: { kind: 'customer', id: c.id } })}>{t('invoices.editCustomer')}</button>
          <button type="button" className="btn ghost" data-act="new-invoice" onClick={() => nav.go({ route: { area: 'invoices', view: 'list', id: 'new' }, query: { customer: c.id } })}>{t('invoices.new')}</button>
        </div>
      )}
      <div className="ftab cinv">
        {invs.length ? invs.map((i) => (
          <button key={i.id} type="button" className="fr" onClick={() => nav.go(invoiceAt(i))}>
            <span className="mono">{i.status === 'issued' ? i.number : t('invoices.draft')}</span>
            <span>{i.subject ?? ''}</span>
            <span className="m">{t(`invoices.state.${rowState(i, d.invoices, today)}`)}</span>
            <span className="r mono">{i.currency} {fmt(totals(i.lines).gross)}</span>
          </button>
        )) : <p className="m">{t('invoices.noInvoicesYet')}</p>}
      </div>
    </div>
  );
}

function SentDetail({ d, route, nav }: Props & { d: InvoiceList }) {
  const doc = d.sent.find((x) => x.id === route.id);
  if (!doc) return <div className="detail-empty"><div>{route.id ? t('invoices.docGone') : t('invoices.nothingSent')}</div></div>;
  const inv = d.invoices.find((i) => i.id === doc.invoiceId);
  const src = sentPdfUrl(doc.id);
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
