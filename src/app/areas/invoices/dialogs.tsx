/**
 * The dialogs of Rechnungen: whom a new invoice is for, the customer form (any country), and
 * cancelling or crediting an issued invoice. A dialog is an action, not a place (docs/urls.md).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { localToday } from '../../../accounting/periods.js';
import type { Customer, CustomerFields, Invoice, Issued } from '../../../invoices/model.js';
import { openAmount, paidAmount, totals } from '../../../invoices/rules.js';
import type { RouteOf } from '../../shell/route.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import { I } from '../receipts/icons.js';
import type { AreaProps } from '../index.js';
import { invoicesNow, useInvoices } from './data.js';
import { byRouteId, customerChange } from './model.js';
import { setUi, useUi } from './state.js';
import { cancel, creditNote, newDraftFor, saveCustomer, saveDraft } from './actions.js';
import { COUNTRIES, addressRule, countryName, countryOf, languageFor, numberFirst, vatRule } from './address.js';

type Props = AreaProps<RouteOf<'invoices'>>;

export function Dialogs(props: Props) {
  const s = useUi();
  const load = useInvoices();
  if (!s.dialog || load.state !== 'ready' || !props.canEdit) return null;
  const d = load.data;
  const inv = byRouteId(d.invoices, props.route.view === 'list' ? props.route.id : undefined);
  switch (s.dialog.kind) {
    case 'new': return <NewInvoice {...props} customers={d.customers} />;
    case 'customer': return <CustomerDialog {...props} customer={d.customers.find((c) => c.id === (s.dialog as { id?: string }).id)} />;
    case 'cancel': return inv?.status === 'issued' ? <CancelDialog {...props} inv={inv} /> : null;
    case 'credit': return inv?.status === 'issued' ? <CreditDialog {...props} inv={inv} invoices={d.invoices} /> : null;
    default: return null;
  }
}

const close = () => setUi({ dialog: null });

function Frame({ label, title, children, foot, className = '' }: { label: string; title: ReactNode; children: ReactNode; foot?: ReactNode; className?: string }) {
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 45%, transparent)' }} onClick={close} />
      <div className={`palette idlg ${className}`} role="dialog" aria-label={label} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
        <div className="ihd"><span className="lbl">{label}</span><b>{title}</b></div>
        {children}
        {foot && <div className="ift">{foot}</div>}
      </div>
    </>
  );
}

function NewInvoice({ customers, nav }: Props & { customers: Customer[] }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const list = useMemo(() => [...customers].sort((a, b) => a.name.localeCompare(b.name)).filter((c) => !q || `${c.name} ${c.address.town}`.toLowerCase().includes(q.toLowerCase())), [customers, q]);
  const pick = (k: number) => {
    const c = list[k];
    if (!c) { setUi({ dialog: { kind: 'customer', then: 'invoice' } }); return; }
    close();
    void newDraftFor(nav, c);
  };
  return (
    <Frame label={t('invoices.new')} title={t('invoices.forWhom')}>
      <input className="isearch" autoFocus placeholder={t('invoices.searchCustomer')} aria-label={t('invoices.searchCustomer')} value={q}
        onChange={(e) => { setQ(e.target.value); setAt(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, Math.min(list.length, i + (e.key === 'ArrowDown' ? 1 : -1)))); }
          if (e.key === 'Enter') { e.preventDefault(); pick(at); }
        }} />
      <div className="iopts" role="listbox">
        {list.map((c, k) => (
          <button key={c.id} type="button" role="option" aria-selected={k === at} className={`opt${k === at ? ' on' : ''}`} onClick={() => pick(k)}>
            <span>{c.name}</span><span className="d">{c.address.town}{c.address.country !== 'CH' ? `, ${c.address.country}` : ''} · {t(`invoices.lang.${c.language}`)}</span>
          </button>
        ))}
        <button type="button" role="option" aria-selected={at === list.length} className={`opt alt${at === list.length ? ' on' : ''}`} onClick={() => pick(list.length)}>
          <span>＋ {t('invoices.newCustomer')}</span><span className="d">{t('invoices.newCustomerHint')}</span>
        </button>
      </div>
    </Frame>
  );
}

type Form = { name: string; attn: string; street: string; number: string; line2: string; postcode: string; town: string; state: string; countryText: string; language: CustomerFields['language']; email: string; vatId: string; terms: string };

function formOf(c: Customer | undefined): Form {
  const a = c?.address;
  return {
    name: c?.name ?? '', attn: c?.attn ?? '', street: a?.street ?? '', number: a?.number ?? '', line2: a?.line2 ?? '', postcode: a?.postcode ?? '', town: a?.town ?? '', state: a?.state ?? '',
    countryText: countryName(a?.country ?? 'CH', language()), language: c?.language ?? 'de', email: c?.email ?? '', vatId: c?.vatId ?? '', terms: String(c?.paymentTermsDays ?? 30),
  };
}

type Errors = Partial<Record<keyof Form, string>>;

function errorsOf(f: Form): Errors {
  const e: Errors = {};
  const country = countryOf(f.countryText);
  if (!country) e.countryText = t('customer.err.country');
  const rule = addressRule(country ?? 'CH');
  for (const k of ['name', 'street', 'town'] as const) if (!f[k].trim()) e[k] = t('customer.err.missing');
  if (!f.postcode.trim() && !rule.pattern.test('')) e.postcode = t('customer.err.missing');
  else if (f.postcode.trim() && !rule.pattern.test(f.postcode.trim())) e.postcode = rule.example ? t('customer.err.example', { example: rule.example }) : t('customer.err.tooLong');
  if (rule.state && !f.state.trim()) e.state = t('customer.err.missing');
  if (f.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) e.email = t('customer.err.email');
  const v = vatRule(country ?? 'CH');
  if (f.vatId.trim() && v.pattern && !v.pattern.test(f.vatId.trim())) e.vatId = t('customer.err.example', { example: v.example });
  if (`${f.street} ${f.number}`.length > 70 || f.town.length > 35) e.street = e.street ?? t('customer.err.qrLength');
  if (!/^\d{1,3}$/.test(f.terms.trim())) e.terms = t('customer.err.terms');
  return e;
}

function fieldsOf(f: Form): CustomerFields {
  const country = countryOf(f.countryText)!;
  const opt = (k: 'attn' | 'email' | 'vatId') => (f[k].trim() ? { [k]: f[k].trim() } : {});
  const address = {
    street: f.street.trim(), ...(f.number.trim() ? { number: f.number.trim() } : {}), ...(f.line2.trim() ? { line2: f.line2.trim() } : {}),
    postcode: f.postcode.trim().toUpperCase(), town: f.town.trim(), ...(f.state.trim() ? { state: f.state.trim().toUpperCase() } : {}), country,
  };
  return { name: f.name.trim(), ...opt('attn'), address, language: f.language, ...opt('email'), ...opt('vatId'), paymentTermsDays: Number(f.terms.trim()) };
}

/** One form for a new and a known customer: the country decides the address fields, the postcode the language (until chosen). */
function CustomerDialog({ customer, nav }: Props & { customer?: Customer }) {
  const s = useUi();
  const then = s.dialog?.kind === 'customer' ? s.dialog.then : undefined;
  const [f, setF] = useState<Form>(() => formOf(customer));
  const [tried, setTried] = useState(false);
  const langChosen = useRef(!!customer);
  const country = countryOf(f.countryText);
  const rule = addressRule(country ?? 'CH');
  const errors = tried ? errorsOf(f) : {};
  const set = (k: keyof Form, v: string) => setF((was) => {
    const next = { ...was, [k]: v };
    if (!langChosen.current && (k === 'countryText' || k === 'postcode')) { const cc = countryOf(next.countryText); if (cc) next.language = languageFor(cc, next.postcode.trim()); }
    return next;
  });
  const field = (k: keyof Form, label: string, ph: string, cls: string, mono = false) => (
    <label key={k} className={`cf ${cls}${errors[k] ? ' err' : ''}`}>
      <span>{label}{errors[k] && <em>{errors[k]}</em>}</span>
      <input className={mono ? 'mono' : undefined} value={f[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} autoFocus={k === 'name'} />
    </label>
  );

  async function save(next: 'close' | 'invoice') {
    setTried(true);
    if (Object.keys(errorsOf(f)).length) return;
    const before = customer;
    const saved = await saveCustomer(nav, customer?.id, fieldsOf(f));
    if (!saved) return;
    close();
    if (before) {
      const { id: _i, createdAt: _c, origin: _o, deleted: _d, ...was } = before;
      nav.toast(t('customer.saved', { name: saved.name }), () => { void saveCustomer(nav, before.id, was); });
      return;
    }
    if (then && typeof then === 'object') {
      const draft = invoicesNow()?.invoices.find((i) => i.id === then.draft);
      if (draft?.status === 'draft') void saveDraft(nav, draft, customerChange(draft, saved));
      return;
    }
    if (then === 'invoice' || next === 'invoice') { void newDraftFor(nav, saved); return; }
    nav.go({ route: { area: 'invoices', view: 'customers', id: saved.id }, query: {} });
    nav.toast(t('customer.created', { name: saved.name }));
  }

  const v = vatRule(country ?? 'CH');
  const street = [field('street', t('customer.street'), t('customer.streetPh'), 's3'), field('number', t('customer.number'), '12', 's1')];
  const town = rule.townFirst
    ? [field('town', t('customer.town'), '', rule.state ? 's2' : 's3'), ...(rule.state ? [field('state', t(`customer.${rule.state}`), rule.stateExample ?? '', 's1')] : []), field('postcode', t(`customer.pc.${rule.postcode}`), rule.example, 's1', true)]
    : [field('postcode', t(`customer.pc.${rule.postcode}`), rule.example, 's1', true), field('town', t('customer.town'), '', 's3')];
  return (
    <Frame
      className="cdlg"
      label={customer ? t('customer.edit') : t('invoices.newCustomer')}
      title={f.name || t('customer.namePlaceholder')}
      foot={<>
        {!customer && !then && <button type="button" className="btn ghost" onClick={() => void save('invoice')}>{t('customer.createAndInvoice')}</button>}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <button type="button" className="btn primary" data-act="save-customer" onClick={() => void save('close')}>{customer ? t('common.save') : t('customer.create')}</button>
      </>}
    >
      <form className="ibody cform" onSubmit={(e) => { e.preventDefault(); void save('close'); }} noValidate>
        {field('name', t('customer.name'), t('customer.namePh'), 'w2')}
        {field('attn', t('customer.attn'), t('customer.optional'), 'w2')}
        <label className={`cf s2${errors.countryText ? ' err' : ''}`}>
          <span>{t('customer.country')}{errors.countryText && <em>{errors.countryText}</em>}</span>
          <span className="ccin">
            <input list="cc-list" value={f.countryText} placeholder={countryName('CH', language())} autoComplete="off" onChange={(e) => set('countryText', e.target.value)} />
            <span className="mono cc">{country ? `→ ${country}` : ''}</span>
          </span>
          <datalist id="cc-list">{COUNTRIES.map((k) => <option key={k} value={countryName(k, language())} />)}</datalist>
        </label>
        <div className="cf s2"><span>{t('customer.language')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('customer.language')}>
            {(['de', 'fr', 'it', 'en'] as const).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={f.language === l} className={f.language === l ? 'on' : ''} onClick={() => { langChosen.current = true; setF({ ...f, language: l }); }}>{l.toUpperCase()}</button>
            ))}
          </span>
        </div>
        {numberFirst(country ?? 'CH') ? [street[1], street[0]] : street}
        {field('line2', t('customer.line2'), t('customer.line2Ph'), 'w2')}
        {town}
        {field('email', t('customer.email'), t('customer.emailPh'), 'w2')}
        {field('vatId', t(`customer.vat.${v.kind}`), v.example || t('customer.optional'), 's3', true)}
        <label className={`cf s1${errors.terms ? ' err' : ''}`}><span>{t('customer.terms')}{errors.terms && <em>{errors.terms}</em>}</span>
          <span className="iin"><input className="mono" value={f.terms} onChange={(e) => set('terms', e.target.value)} style={{ width: 56 }} /> {t('customer.days')}</span>
        </label>
        <button type="submit" hidden />
      </form>
    </Frame>
  );
}

function CancelDialog({ inv, nav }: Props & { inv: Issued }) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(localToday());
  const [notify, setNotify] = useState(true);
  const gross = totals(inv.lines).gross;
  const title = `${inv.customer.name} · ${inv.currency} ${fmt(gross)}`;
  const label = t('invoices.cancelTitle', { number: inv.number });
  if (inv.payments.length) {
    return (
      <Frame label={label} title={title} foot={<><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button><button type="button" className="btn primary" autoFocus onClick={() => setUi({ dialog: { kind: 'credit' } })}>{t('invoices.creditInstead')}</button></>}>
        <div className="ibody"><p>{t('invoices.paidNoCancel', { date: formatDate(inv.payments.at(-1)!.date) })}</p></div>
      </Frame>
    );
  }
  const run = async () => { if (await cancel(nav, inv, { date, reason, notify })) close(); };
  return (
    <Frame label={label} title={title} foot={<><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button><button type="button" className="btn primary danger" data-act="cancel-ok" onClick={() => void run()}>{t('invoices.cancelOk')}</button></>}>
      <div className="ibody lkf">
        <label className="lkr"><span>{t('invoices.reason')}</span><input autoFocus value={reason} placeholder={t('invoices.cancelReasonPh')} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} /></label>
        <label className="lkr"><span>{t('invoices.date')}</span><span className="iin"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></span></label>
        <label className="lkr"><span /><span className="iin"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> {t('invoices.cancelNotify')}</span></label>
        <p className="m ivhint">{t('invoices.cancelHint', { number: inv.number })}</p>
      </div>
    </Frame>
  );
}

/** A credit note: the whole invoice or a part, and what happens with money already paid. */
function CreditDialog({ inv, invoices, nav }: Props & { inv: Issued; invoices: Invoice[] }) {
  const gross = totals(inv.lines).gross;
  const paid = paidAmount(inv);
  const open = openAmount(inv, invoices);
  const [scope, setScope] = useState<'all' | 'part'>('all');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [settlement, setSettlement] = useState<'refund' | 'offset'>('refund');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const typed = Number(amount.replace(/[’'\s]/g, '').replace(',', '.'));
  const credit = scope === 'all' ? gross : Number.isFinite(typed) ? Math.round(typed * 100) / 100 : 0;
  const back = Math.max(0, Math.round((credit - open) * 100) / 100);
  const ok = credit > 0 && credit <= gross;
  const seg = <T extends string>(value: T, set: (v: T) => void, opts: Array<[T, string]>) => (
    <span className="seg2" role="radiogroup">
      {opts.map(([v, l], i) => <button key={v} ref={i === 0 ? first : undefined} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => set(v)}>{l}</button>)}
    </span>
  );
  const run = async () => {
    if (!ok) return;
    if (await creditNote(nav, inv, { reason, ...(scope === 'part' ? { amount: credit } : {}), ...(back > 0 ? { settlement } : {}) })) close();
  };
  return (
    <Frame className="icredit" label={t('invoices.creditTitle', { number: inv.number })} title={`${inv.customer.name} · ${inv.currency} ${fmt(gross)}`}
      foot={<><button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button><button type="button" className="btn primary" data-act="credit-ok" disabled={!ok} onClick={() => void run()}>{t('invoices.creditOk')}</button></>}>
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
        {credit > gross && <p className="warnline">{I.dot}{t('invoices.creditTooHigh')}</p>}
      </div>
    </Frame>
  );
}
