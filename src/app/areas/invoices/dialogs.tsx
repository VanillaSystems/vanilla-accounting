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
import { api, errorText, type SendMail } from '../../lib/api.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { mailText, type MailDocument } from '../../../invoices/documents.js';
import type { Statement } from '../../../invoices/statement.js';
import { TEXTS as STATEMENT_TEXTS } from '../../../invoices/texts.js';
import type { MailStatus } from '../../../types/api-error.js';
import { cancel, cancelDocument, creditNote, newDraftFor, savePdf, send, sendInstalment, sendReminder, sendStatement } from './actions.js';
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
  // A Kontoauszug is looked at where nothing may be changed too; only sending it writes the sent log.
  if (s.dialog.kind === 'statement') { const c = d.contacts.find((x) => x.id === (s.dialog as { contactId: string }).contactId); return c ? <StatementDialog {...props} contact={c} /> : null; }
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
function useMail(inv: Issued, doc: MailDocument): MailState {
  const ws = useWorkspace();
  const status = useMailStatus();
  const load = useInvoices();
  const contact = load.state === 'ready' ? load.data.contacts.find((c) => c.id === inv.customerId) : undefined;
  const text = mailText(ws?.invoicing, inv, doc, ws?.company.name ?? '');
  return { ready: !!status?.configured && status.password !== 'missing', status, defaults: { to: inv.customer.email ?? '', ...text }, proposals: proposalsOf(contact), own: ws?.outgoingMail?.fromAddress };
}

interface MailState { ready: boolean; status?: MailStatus; defaults: SendMail; proposals: Array<{ name: string; email: string }>; own?: string }

function useMailStatus(): MailStatus | undefined {
  const [status, setStatus] = useState<MailStatus>();
  useEffect(() => { api.mailStatus().then(setStatus, () => setStatus(undefined)); }, []);
  return status;
}

/** The addresses a contact offers (spec 4.4.11): its e-mails and its contact persons', each once. */
export function proposalsOf(c: Contact | undefined): Array<{ name: string; email: string }> {
  if (!c) return [];
  const all = [...c.emails.map((email) => ({ name: c.name, email })), ...c.persons.flatMap((p) => (p.email ? [{ name: p.name, email: p.email }] : []))];
  return all.filter((x, i) => all.findIndex((y) => y.email.toLowerCase() === x.email.toLowerCase()) === i);
}

const listed = (field: string | undefined) => (field ?? '').split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const addTo = (field: string | undefined, email: string) => [...(field ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean), email].join(', ');

/**
 * Recipients (several, separated by commas), copies, a copy to the firm's own address, subject and
 * text of the e-mail, editable, the contact's addresses offered; or why the app cannot send e-mail yet.
 */
function MailFields({ mail, value, onChange, nav }: { mail: MailState; value: SendMail; onChange(m: SendMail): void; nav: Props['nav'] }) {
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
      <label className="lkr"><span>{t('invoices.mailTo')}</span><input name="to" type="text" inputMode="email" value={value.to} placeholder={t('customer.emailPh')} onChange={(e) => onChange({ ...value, to: e.target.value })} /></label>
      <label className="lkr"><span>{t('invoices.mailCc')}</span><input name="cc" type="text" inputMode="email" value={value.cc ?? ''} placeholder={t('invoices.mailCcPh')} onChange={(e) => onChange({ ...value, cc: e.target.value })} /></label>
      {(() => {
        const taken = new Set([...listed(value.to), ...listed(value.cc)]);
        const free = mail.proposals.filter((p) => !taken.has(p.email.toLowerCase()));
        return free.length > 0 && (
          <div className="lkr"><span /><span className="rcpts" data-testid="mail-proposals">
            {free.map((p) => (
              <span key={p.email}>
                <button type="button" data-propose={p.email} data-tip={t('invoices.mailAddTo')} onClick={() => onChange({ ...value, to: addTo(value.to, p.email) })}>{p.name} · {p.email}</button>
                <button type="button" data-propose-cc={p.email} aria-label={t('invoices.mailAddCcOf', { email: p.email })} onClick={() => onChange({ ...value, cc: addTo(value.cc, p.email) })}>{t('invoices.mailCcShort')}</button>
              </span>
            ))}
          </span></div>
        );
      })()}
      {mail.own && <label className="lkr"><span /><span className="lkchk"><input type="checkbox" name="copy" checked={!!value.copy} onChange={(e) => onChange({ ...value, copy: e.target.checked })} /> {t('invoices.mailCopy', { address: mail.own })}</span></label>}
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
  const [m, setM] = useState<SendMail>();
  const [busy, setBusy] = useState(false);
  const value = m ?? mail.defaults;
  const go = async (email?: SendMail) => {
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
        <p className="m ivhint">{t('invoices.mailAttached', { file: reminder ? t('invoices.reminderFile', { title: reminder.title }) : instalment ? t('sales.instalment.file') : [`${inv.number}.pdf`, ...(inv.attachments ?? []).map((a) => a.name)].join(', ') })}</p>
        {!reminder && !instalment && !!inv.attachments?.length && <p className="m ivhint" data-testid="send-attachments">{t('invoices.mailAttachmentsDownload')}</p>}
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
  const [m, setM] = useState<SendMail>();
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

/**
 * Der Kontoauszug of a contact (spec 4.4.5, P3.7): a period (this year up to today by default), per
 * currency the balance before, each Rechnung, Gutschrift, payment, write-off and Storno with the
 * balance after it, and the items open at its end, which are what Offene Posten lists for the
 * contact. «PDF ansehen» opens it; it goes by e-mail or is saved, and the sent log keeps it.
 */
function StatementDialog({ contact, nav, canEdit }: Props & { contact: Contact }) {
  const ws = useWorkspace();
  const today = localToday();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [s, setS] = useState<Statement>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const status = useMailStatus();
  const ready = !!status?.configured && status.password !== 'missing';
  const L = STATEMENT_TEXTS[contact.language].statement;
  const fill = (x: string) => x.replaceAll('{company}', ws?.company.name ?? '');
  const defaults: SendMail = { to: contact.emails[0] ?? '', subject: fill(L.mailSubject), body: fill(L.mailBody) };
  const [m, setM] = useState<SendMail>();
  const mail: MailState = { ready, status, defaults, proposals: proposalsOf(contact), own: ws?.outgoingMail?.fromAddress };
  useEffect(() => {
    let live = true;
    if (!from || !to || to < from) { setS(undefined); return; }
    api.contactStatement(contact.id, from, to).then((x) => { if (live) { setS(x); setErr(undefined); } }, (e) => { if (live) setErr(errorText(e)); });
    return () => { live = false; };
  }, [contact.id, from, to]);
  const go = async (email?: SendMail) => { setBusy(true); const ok = await sendStatement(nav, contact.id, { from, to }, email); setBusy(false); if (ok) close(); };
  const value = m ?? defaults;
  const foot = (
    <>
      <button type="button" className="btn ghost" onClick={close}>{t('common.close')}</button>
      <a className="btn ghost" href={api.statementPdfUrl(contact.id, from, to)} target="_blank" rel="noreferrer" data-act="statement-pdf">{t('statement.viewPdf')}</a>
      {canEdit && <AsyncButton type="button" className={`btn ${ready ? 'ghost' : 'primary'}`} data-act="statement-download" disabled={busy || !s} onClick={() => go()}>{t('invoices.downloadInstead')}</AsyncButton>}
      {canEdit && ready && <AsyncButton type="button" className="btn primary" data-act="statement-mail" disabled={busy || !s || !value.to.trim()} onClick={() => go(value)}>{busy ? t('invoices.mailing') : t('invoices.mailSend')}</AsyncButton>}
    </>
  );
  return (
    <Frame label={t('statement.title', { name: contact.name })} title={contact.name} foot={foot} className="isend">
      <div className="ibody lkf" data-testid="statement">
        <div className="lkr"><span>{t('statement.period')}</span>
          <span className="iin"><input type="date" aria-label={t('statement.from')} value={from} onChange={(e) => setFrom(e.target.value)} /> – <input type="date" aria-label={t('statement.to')} value={to} onChange={(e) => setTo(e.target.value)} /></span>
        </div>
        {err && <p className="warnline" role="alert">{err}</p>}
        {s && !s.sections.length && <p className="m">{t('statement.empty')}</p>}
        {s?.sections.map((sec) => (
          <div key={sec.currency} className="stmtwrap" data-currency={sec.currency}>
            <table className="stmt">
              <thead><tr><th>{t('statement.date')}</th><th>{t('statement.doc')}</th><th>{t('statement.text')}</th><th className="r">{t('statement.debit')}</th><th className="r">{t('statement.credit')}</th><th className="r">{t('statement.balance', { currency: sec.currency })}</th></tr></thead>
              <tbody>
                <tr className="sum"><td colSpan={5}>{t('statement.opening', { date: formatDate(s.from) })}</td><td className="r">{fmt(sec.opening)}</td></tr>
                {sec.rows.map((r, k) => (
                  <tr key={k} data-row={r.kind}>
                    <td>{formatDate(r.date)}</td><td className="mono">{r.number}</td><td>{t(`statement.row.${r.kind}`, { of: r.of ?? '' })}{r.reason ? ` · ${t(`invoices.reason.${r.reason}`)}` : ''}{r.beyond ? <span className="m"> · {t('statement.beyond', { amount: fmt(r.beyond) })}</span> : null}</td>
                    <td className="r">{r.debit ? fmt(r.debit) : ''}</td><td className="r">{r.credit ? fmt(r.credit) : ''}</td><td className="r">{fmt(r.balance)}</td>
                  </tr>
                ))}
                <tr className="sum" data-testid="statement-closing"><td colSpan={5}>{t('statement.closing', { date: formatDate(s.to) })}</td><td className="r">{sec.currency} {fmt(sec.closing)}</td></tr>
              </tbody>
            </table>
            <p className="m ivhint">{t('statement.openNote', { n: sec.open.length, date: formatDate(s.to) })}</p>
          </div>
        ))}
        {canEdit && <MailFields mail={mail} value={value} onChange={setM} nav={nav} />}
      </div>
    </Frame>
  );
}
