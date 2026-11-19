/**
 * The dialogs of Rechnungen: whom a new invoice is for, the contact form and the contact import (contacts.tsx),
 * sending an invoice or a reminder (by e-mail or as a download), and cancelling or crediting an
 * issued invoice. A dialog is an action, not a place (docs/urls.md).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { isBooked, issuedPdfUrl, type Contact, type DocumentKind, type Invoice, type Issued } from '../../../invoices/model.js';
import { Paper } from '../receipts/Paper.js';
import { instalmentDue, openAmount, paidAmount, totals, creditable } from '../../../invoices/rules.js';
import type { RouteOf } from '../../shell/route.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import { I } from '../receipts/icons.js';
import type { AreaProps } from '../index.js';
import { invoicesNow, useInvoices } from './data.js';
import { byRouteId, townOf } from './model.js';
import { setUi, useUi } from './state.js';
import { DunningDialog } from './dunning.js';
import { api } from '../../lib/api.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { mailText, type MailDocument } from '../../../invoices/documents.js';
import type { MailMessage } from '../../../invoices/mail.js';
import type { MailStatus } from '../../../types/api-error.js';
import { cancel, cancelDocument, creditNote, newDraftFor, savePdf, send, sendInstalment, sendReminder } from './actions.js';
import { PlanDialog } from './plan.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import { ContactDialog, ImportDialog } from './contacts.js';
import { ArticleDialog, ArticleImportDialog, ArticlePicker } from './articles.js';
import { BulkDialogs } from './bulk.js';
import { ConvertDialog, WarnDialog } from './convert.js';
import { Frame, close } from './frame.js';
import { AllocateDialog, HandPaymentDialog, WriteOffDialog } from './money-dialogs.js';
import { AccountsDialog, BackToDraftDialog } from './revise-dialogs.js';

type Props = AreaProps<RouteOf<'invoices'>>;

export function Dialogs(props: Props) {
  const s = useUi();
  const load = useInvoices();
  if (!s.dialog || load.state !== 'ready') return null;
  const d = load.data;
  // Saving PDFs writes nothing: it works where nothing may be changed too.
  if (s.dialog.kind === 'bulk-pdf') return <BulkDialogs d={d} nav={props.nav} ids={s.dialog.ids} kind="bulk-pdf" />;
  if (!props.canEdit) return null;
  if (s.dialog.kind === 'bulk-send') return <BulkDialogs d={d} nav={props.nav} ids={s.dialog.ids} kind="bulk-send" />;
  if (s.dialog.kind === 'dunning') return <DunningDialog d={d} nav={props.nav} {...(s.dialog.ids ? { ids: s.dialog.ids } : {})} />;
  const inv = byRouteId(d.invoices, props.route.view === 'contacts' || props.route.view === 'sent' ? undefined : props.route.id);
  switch (s.dialog.kind) {
    case 'new': return <NewInvoice {...props} contacts={d.contacts.filter((c) => !c.archived)} doc={s.dialog.doc ?? 'invoice'} />;
    case 'convert': return inv?.status === 'issued' ? <ConvertDialog {...props} inv={inv} to={s.dialog.to} invoices={d.invoices} /> : null;
    case 'warn': return <WarnDialog title={s.dialog.title} text={s.dialog.text} anyway={s.dialog.anyway} run={s.dialog.run} />;
    case 'contact': return <ContactDialog {...props} contact={d.contacts.find((c) => c.id === (s.dialog as { id?: string }).id)} />;
    case 'contactImport': return <ImportDialog {...props} />;
    case 'article': return <ArticleDialog {...props} />;
    case 'articleImport': return <ArticleImportDialog {...props} />;
    case 'articlePick': { const draft = d.invoices.find((i) => i.id === (s.dialog as { draft: string }).draft); return draft?.status === 'draft' ? <ArticlePicker {...props} d={d} draft={draft} after={s.dialog.after} /> : null; }
    case 'cancel': return inv?.status === 'issued' ? (isBooked(inv) ? <CancelDialog {...props} inv={inv} /> : <CancelPlainDialog {...props} inv={inv} />) : null;
    case 'credit': return inv?.status === 'issued' ? <CreditDialog {...props} inv={inv} invoices={d.invoices} /> : null;
    case 'download': return inv?.status === 'issued' ? <DownloadDialog {...props} inv={inv} /> : null;
    case 'send': return inv?.status === 'issued' ? <SendDialog {...props} inv={inv} reminder={s.dialog.reminder} issued={s.dialog.issued} instalment={s.dialog.instalment} /> : null;
    case 'plan': return inv ? <PlanDialog {...props} inv={inv} invoices={d.invoices} /> : null;
    case 'handPayment': return inv?.status === 'issued' ? <HandPaymentDialog {...props} inv={inv} invoices={d.invoices} /> : null;
    case 'writeOff': return inv?.status === 'issued' ? <WriteOffDialog {...props} inv={inv} invoices={d.invoices} reason={s.dialog.reason} amount={s.dialog.amount} /> : null;
    case 'allocate': return <AllocateDialog {...props} transactionRef={s.dialog.transactionRef} customerId={s.dialog.customerId} />;
    case 'backToDraft': return inv?.status === 'issued' ? <BackToDraftDialog {...props} inv={inv} /> : null;
    case 'accounts': return inv?.status === 'issued' ? <AccountsDialog {...props} inv={inv} /> : null;
    default: return null;
  }
}

/** The «＋» of Lieferscheine: a Lieferschein comes only from an Auftrag (decision 21), so it says so and leads there. */
function DeliveryFromOrder({ nav }: Props) {
  return (
    <Frame label={t('sales.newTitle.delivery-note')} title={t('sales.deliveryFromOrder')} foot={<>
      <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
      <button type="button" className="btn primary" autoFocus data-act="to-orders" onClick={() => { close(); nav.go({ route: { area: 'invoices', view: 'orders' }, query: {} }); }}>{t('sales.toOrders')}</button>
    </>}>
      <div className="ibody"><p className="m">{t('sales.deliveryFromOrderText')}</p></div>
    </Frame>
  );
}

function NewInvoice(props: Props & { contacts: Contact[]; doc: DocumentKind }) {
  return props.doc === 'delivery-note' ? <DeliveryFromOrder {...props} /> : <PickCustomer {...props} />;
}

function PickCustomer({ contacts, nav, doc }: Props & { contacts: Contact[]; doc: DocumentKind }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const list = useMemo(() => [...contacts].sort((a, b) => a.name.localeCompare(b.name)).filter((c) => !q || `${c.name} ${c.number ?? ''} ${townOf(c)} ${c.persons.map((p) => p.name).join(' ')}`.toLowerCase().includes(q.toLowerCase())), [contacts, q]);
  const pick = (k: number) => {
    const c = list[k];
    if (!c) { setUi({ dialog: { kind: 'contact', then: doc === 'invoice' ? 'invoice' : { kind: doc }, ...(q.trim() && { name: q.trim() }) } }); return; }
    close();
    void newDraftFor(nav, c, doc);
  };
  return (
    <Frame label={t(`sales.newTitle.${doc}` as 'sales.newTitle.invoice')} title={t('invoices.forWhom')}>
      <input className="isearch" autoFocus placeholder={t('invoices.searchCustomer')} aria-label={t('invoices.searchCustomer')} value={q}
        onChange={(e) => { setQ(e.target.value); setAt(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, Math.min(list.length, i + (e.key === 'ArrowDown' ? 1 : -1)))); }
          if (e.key === 'Enter') { e.preventDefault(); pick(at); }
        }} />
      <div className="iopts" role="listbox">
        {list.map((c, k) => (
          <button data-busy-exempt="the dialog closes at once; the new draft opens when made" key={c.id} type="button" role="option" aria-selected={k === at} className={`opt${k === at ? ' on' : ''}`} onClick={() => pick(k)}>
            <span>{c.name}</span><span className="d">{[c.number, townOf(c), t(`invoices.lang.${c.language}`)].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        <button data-busy-exempt="the dialog closes at once; the new draft opens when made" type="button" role="option" aria-selected={at === list.length} className={`opt alt${at === list.length ? ' on' : ''}`} onClick={() => pick(list.length)}>
          <span>＋ {t('invoices.newCustomer')}</span><span className="d">{t('invoices.newCustomerHint')}</span>
        </button>
      </div>
    </Frame>
  );
}

/** The company's mailbox, as far as a send needs to know: can it send, and what does the e-mail say by default. */
function useMail(inv: Issued, doc: MailDocument): { ready: boolean; status?: MailStatus; defaults: MailMessage } {
  const ws = useWorkspace();
  const [status, setStatus] = useState<MailStatus>();
  useEffect(() => { api.mailStatus().then(setStatus, () => setStatus(undefined)); }, []);
  const text = mailText(ws?.invoicing, inv, doc, ws?.company.name ?? '');
  return { ready: !!status?.configured && status.password !== 'missing', status, defaults: { to: inv.customer.email ?? '', ...text } };
}

/** Recipient, subject and text of the e-mail, editable; or why the app cannot send e-mail yet. */
function MailFields({ mail, value, onChange, nav }: { mail: ReturnType<typeof useMail>; value: MailMessage; onChange(m: MailMessage): void; nav: Props['nav'] }) {
  if (!mail.status) return null;
  if (!mail.ready) {
    return (
      <p className="m ivhint">
        {mail.status.configured ? t('mail.passwordMissing', { where: mail.status.where }) : t('invoices.mailNotSetUp')}{' '}
        <button type="button" className="quiet2" onClick={() => { close(); nav.go({ route: { area: 'company', section: 'mail' }, query: {} }); }}>{t('invoices.toMail')}</button>
      </p>
    );
  }
  return (
    <>
      <label className="lkr"><span>{t('invoices.mailTo')}</span><input name="to" type="email" value={value.to} placeholder={t('customer.emailPh')} onChange={(e) => onChange({ ...value, to: e.target.value })} /></label>
      <label className="lkr"><span>{t('invoices.mailSubject')}</span><input name="subject" value={value.subject} onChange={(e) => onChange({ ...value, subject: e.target.value })} /></label>
      <label className="lkr top"><span>{t('invoices.mailBody')}</span><textarea name="body" rows={6} value={value.body} onChange={(e) => onChange({ ...value, body: e.target.value })} /></label>
    </>
  );
}

/**
 * Senden: the issued invoice with its stored PDF in view, or a reminder, by e-mail with the PDF attached, or saved as
 * a download. Right after «Ausstellen» (`issued`) it says so and «Später» closes it.
 */
function SendDialog({ inv, nav, reminder, issued, instalment }: Props & { inv: Issued; reminder?: { level: number; title: string }; issued?: true; instalment?: true }) {
  const mail = useMail(inv, reminder ? { kind: 'reminder', level: reminder.level, title: reminder.title } : instalment ? { kind: 'instalment' } : { kind: 'invoice' });
  const [m, setM] = useState<MailMessage>();
  const [busy, setBusy] = useState(false);
  const value = m ?? mail.defaults;
  const go = async (email?: MailMessage) => {
    setBusy(true);
    const ok = reminder ? await sendReminder(nav, inv, email) : instalment ? await sendInstalment(nav, inv, email) : await send(nav, inv, email);
    setBusy(false);
    if (!ok) return;
    close();
    if (reminder) setUi({ preview: false });
  };
  const credit = inv.kind === 'credit-note';
  // An Angebot, Auftrag or Lieferschein names its own kind.
  const other = inv.kind !== 'invoice' && !credit ? t(`invoices.docKind.${inv.kind}`) : undefined;
  const label = reminder ? t('invoices.sendReminder', { title: reminder.title })
    : instalment ? t('sales.instalment.title', { number: inv.number })
    : other ? t(issued ? 'invoices.docIssued' : 'invoices.sendTitleDoc', { kind: other, number: inv.number })
    : issued ? t(credit ? 'invoices.creditIssued' : 'invoices.issued', { number: inv.number })
    : t(credit ? 'invoices.sendTitleCredit' : 'invoices.sendTitle', { number: inv.number });
  const foot = (
    <>
      <button type="button" className="btn ghost" data-act="later" onClick={close}>{t(issued ? 'invoices.later' : 'common.cancel')}</button>
      <AsyncButton type="button" className={`btn ${mail.ready ? 'ghost' : 'primary'}`} data-act="download" disabled={busy} onClick={() => go()}>{t('invoices.downloadInstead')}</AsyncButton>
      {mail.ready && <AsyncButton type="button" className="btn primary" data-act="mail" disabled={busy || !value.to.trim()} onClick={() => go(value)}>{busy ? t('invoices.mailing') : t('invoices.mailSend')}</AsyncButton>}
    </>
  );
  return (
    <Frame label={label} title={`${inv.customer.name} · ${inv.currency} ${fmt(instalment ? instalmentDue(inv, invoicesNow()?.invoices ?? [], localToday())?.amount ?? 0 : totals(inv).gross)}`} foot={foot} className={`isend${reminder || instalment ? '' : ' withpdf'}`}>
      <div className="ibody lkf">
        {!reminder && !instalment && <div className="isendpdf paper real"><Paper src={issuedPdfUrl(inv.number)} maxWidth={560} whole /></div>}
        {instalment && <p className="m ivhint" data-testid="instalment-hint">{t('sales.instalment.hint', { amount: `${inv.currency} ${fmt(instalmentDue(inv, invoicesNow()?.invoices ?? [], localToday())?.amount ?? 0)}` })}</p>}
        {issued && <p className="m ivhint">{t('invoices.issuedNext')}</p>}
        <MailFields mail={mail} value={value} onChange={setM} nav={nav} />
        <p className="m ivhint">{t('invoices.mailAttached', { file: reminder ? t('invoices.reminderFile', { title: reminder.title }) : instalment ? t('sales.instalment.file') : `${inv.number}.pdf` })}</p>
      </div>
    </Frame>
  );
}

/**
 * «PDF herunterladen» of a Rechnung or Gutschrift the sent log never saw (spec 4.8, decision 97): a
 * document sent outside the app is downloaded first, and the download is its entry. So it asks once
 * per download: «Ja, festhalten» saves the PDF and records the download as its sending (channel
 * Download, with the checksum), «Nur ansehen» saves it and records nothing.
 */
function DownloadDialog({ inv, nav }: Props & { inv: Issued }) {
  const credit = inv.kind === 'credit-note';
  const view = async () => { if (await savePdf(nav, inv)) close(); };
  return (
    <Frame label={t('invoices.downloadAskTitle', { number: inv.number })} title={`${inv.customer.name} · ${inv.currency} ${fmt(totals(inv).gross)}`}
      foot={<>
        <AsyncButton type="button" className="btn ghost" data-act="view-only" onClick={view}>{t('invoices.downloadViewOnly')}</AsyncButton>
        <AsyncButton type="button" className="btn primary" autoFocus data-act="record-download" onClick={async () => { if (await send(nav, inv)) close(); }}>{t('invoices.downloadRecord')}</AsyncButton>
      </>}>
      <div className="ibody" data-testid="download-ask">
        <p>{t(credit ? 'invoices.downloadAskCredit' : 'invoices.downloadAsk', { number: inv.number })}</p>
        <p className="m ivhint">{t('invoices.downloadAskHint')}</p>
      </div>
    </Frame>
  );
}

function CancelDialog({ inv, nav }: Props & { inv: Issued }) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(localToday());
  const [notify, setNotify] = useState(true);
  const mail = useMail(inv, { kind: 'cancellation' });
  const [m, setM] = useState<MailMessage>();
  const gross = totals(inv).gross;
  const title = `${inv.customer.name} · ${inv.currency} ${fmt(gross)}`;
  const label = t('invoices.cancelTitle', { number: inv.number });
  // A paid invoice: a warning naming its payments (spec 4.11); «Gutschrift statt Storno», or «Trotzdem stornieren», which releases them.
  const paid = inv.payments.length > 0;
  const run = async () => { if (await cancel(nav, inv, { date, reason, notify, ...(paid ? { confirm: 'paid' as const } : {}) }, notify && mail.ready ? m ?? mail.defaults : undefined)) close(); };
  return (
    <Frame label={label} title={title} foot={<>
      <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
      {paid && <button type="button" className="btn primary" autoFocus data-act="credit-instead" onClick={() => setUi({ dialog: { kind: 'credit' } })}>{t('invoices.creditInstead')}</button>}
      <AsyncButton type="button" className={`btn ${paid ? 'ghost' : 'primary'} danger`} data-act="cancel-ok" onClick={() => run()}>{t(paid ? 'invoices.cancelAnyway' : 'invoices.cancelOk')}</AsyncButton>
    </>}>
      <div className="ibody lkf">
        {paid && (
          <div className="notice warn" role="note" data-testid="cancel-paid">
            <span>{t('invoices.paidCancelWarn', { number: inv.number, payments: inv.payments.map((p) => `${formatDate(p.date)} ${inv.currency} ${fmt(p.amount)}`).join(', ') })}</span>
          </div>
        )}
        <label className="lkr"><span>{t('invoices.reason')}</span><input autoFocus={!paid} value={reason} placeholder={t('invoices.cancelReasonPh')} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} /></label>
        <label className="lkr"><span>{t('invoices.date')}</span><span className="iin"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></span></label>
        <label className="lkr"><span /><span className="iin"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> {t('invoices.cancelNotify')}</span></label>
        {notify && <MailFields mail={mail} value={m ?? mail.defaults} onChange={setM} nav={nav} />}
        <p className="m ivhint">{t('invoices.cancelHint', { number: inv.number })}</p>
      </div>
    </Frame>
  );
}

/** Storno of an Auftrag or Lieferschein: date and reason; nothing is booked, no notice goes out. */
function CancelPlainDialog({ inv, nav }: Props & { inv: Issued }) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(localToday());
  const run = () => cancelDocument(nav, inv, { date, reason });
  return (
    <Frame label={t('sales.cancelTitle', { number: inv.number })} title={inv.customer.name} foot={<>
      <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
      <AsyncButton type="button" className="btn primary danger" data-act="cancel-ok" onClick={() => run()}>{t('invoices.cancel')}</AsyncButton>
    </>}>
      <div className="ibody lkf">
        <label className="lkr"><span>{t('invoices.reason')}</span><input autoFocus value={reason} placeholder={t('invoices.cancelReasonPh')} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} /></label>
        <label className="lkr"><span>{t('invoices.date')}</span><span className="iin"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></span></label>
        <p className="m ivhint">{t('sales.cancelPlainHint')}</p>
      </div>
    </Frame>
  );
}

/** A credit note: the whole invoice or a part, and what happens with money already paid. */
function CreditDialog({ inv, invoices, nav }: Props & { inv: Issued; invoices: Invoice[] }) {
  const gross = totals(inv).gross;
  const paid = paidAmount(inv);
  const open = openAmount(inv, invoices);
  // After an earlier credit note «alles» is what is left to credit, not the whole invoice again (r8c-14).
  const max = creditable(inv, invoices);
  const [scope, setScope] = useState<'all' | 'part'>('all');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [settlement, setSettlement] = useState<'refund' | 'offset'>('refund');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const typed = Number(amount.replace(/[’'\s]/g, '').replace(',', '.'));
  const credit = scope === 'all' ? max : Number.isFinite(typed) ? Math.round(typed * 100) / 100 : 0;
  const back = Math.max(0, Math.round((credit - open) * 100) / 100);
  const ok = credit > 0 && credit <= max;
  const seg = <T extends string>(value: T, set: (v: T) => void, opts: Array<[T, string]>) => (
    <span className="seg2" role="radiogroup">
      {opts.map(([v, l], i) => <button key={v} ref={i === 0 ? first : undefined} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => set(v)}>{l}</button>)}
    </span>
  );
  const run = async () => {
    if (!ok) return;
    if (await creditNote(nav, inv, { reason, ...(scope === 'part' || max < gross ? { amount: credit } : {}), ...(back > 0 ? { settlement } : {}) })) close();
  };
  return (
    <Frame className="icredit" label={t('invoices.creditTitle', { number: inv.number })} title={`${inv.customer.name} · ${inv.currency} ${fmt(gross)}`}
      foot={<><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button><AsyncButton type="button" className="btn primary" data-act="credit-ok" disabled={!ok} onClick={() => run()}>{t('invoices.creditOk')}</AsyncButton></>}>
      <div className="ibody lkf">
        <div className="lkr"><span>{t('invoices.scope')}</span>{seg(scope, setScope, [['all', t('invoices.scopeAll')], ['part', t('invoices.scopePart')]])}</div>
        {scope === 'part' && <label className="lkr"><span>{t('invoices.amount')}</span><span className="iin"><input className="mono" autoFocus value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} /> <span className="m">{t('invoices.inclVat', { currency: inv.currency })}</span></span></label>}
        <label className="lkr"><span>{t('invoices.reason')}</span><input value={reason} placeholder={t('invoices.creditReasonPh')} onChange={(e) => setReason(e.target.value)} /></label>
        {paid > 0 && <p className="m ivhint">{t('invoices.paidBefore', { amount: `${inv.currency} ${fmt(paid)}`, date: formatDate(inv.payments.at(-1)!.date) })}</p>}
        {back > 0 && <div className="lkr"><span>{t('invoices.settle')}</span>{seg(settlement, setSettlement, [['refund', t('invoices.refund')], ['offset', t('invoices.offset')]])}</div>}
        <div className="isum">
          <div><span>{t('invoices.invoiceNo', { number: inv.number })}</span><span className="mono">{fmt(gross)}</span></div>
          {gross - open > 0 && <div><span>{t('invoices.paidOrCredited')}</span><span className="mono">−{fmt(Math.round((gross - open) * 100) / 100)}</span></div>}
          <div><span>{t('invoices.creditLine')}</span><span className="mono">−{fmt(credit)}</span></div>
          <div className="tot"><span>{back > 0 ? (settlement === 'refund' ? t('invoices.refundTotal') : t('invoices.offsetTotal')) : t('invoices.stillOpen')}</span><span className="mono">{inv.currency} {fmt(back > 0 ? back : Math.round((open - credit) * 100) / 100)}</span></div>
        </div>
        {credit > max && <p className="warnline">{I.dot}{t('invoices.creditTooHigh', { max: `${inv.currency} ${fmt(max)}` })}</p>}
      </div>
    </Frame>
  );
}
