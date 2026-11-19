/**
 * Kontakte (docs/specs/invoicing.md 4.4.5, 4.8): the firms and persons the firm sells to as one
 * table (layout A), a contact opened as the panel over it (its fields, persons, addresses, defaults,
 * documents and open items, its business file), the form for a new and a known contact, and the
 * import of contacts from a CSV with a column mapping.
 */
import { useEffect, useRef, useState } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { INVOICE_CURRENCIES, type Contact, type ContactAddress, type ContactPerson, type InvoiceCurrency, type InvoiceLanguage } from '../../../invoices/model.js';
import { billingAddress, contactDays, documentsOf } from '../../../invoices/contacts.js';
import { IMPORT_FIELDS, type ImportField, type ImportMapping, type ImportRow } from '../../../invoices/contact-import.js';
import { TableImport, type ImportKind } from './import-dialog.js';
import { openAmount, totals } from '../../../invoices/rules.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { hrefOf } from '../../shell/history.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { api, errorText, type ContactDetail as Detail, type ContactInput, type InvoiceList } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { language, t } from '../../i18n/index.js';
import { baseCurrency } from '../../../engines/index.js';
import type { AreaProps } from '../index.js';
import { CONTACT_TABS, contactRows, customerChange, rowState, type ContactTab } from './model.js';
import { listed, setUi, useUi } from './state.js';
import { invoiceAt, newDraftFor, removeContact, restoreContact, saveContact, saveDraft } from './actions.js';
import { invoicesNow, reloadInvoices } from './data.js';
import { COUNTRIES, addressRule, countryName, countryOf, languageFor, numberFirst, vatRule } from './address.js';
import { AsyncButton, AsyncForm } from '../../shell/AsyncButton.js';
import { Frame, close } from './frame.js';
import { rowTab } from './Sent.js';
import { Search, Views } from './views.js';

type Props = AreaProps<RouteOf<'invoices'>>;

// ─── the table ──────────────────────────────────────────────────────────────────

export function ContactTable(props: Props & { d: InvoiceList }) {
  const { route, query, nav, d, canEdit } = props;
  const [tab, setTab] = useState<ContactTab>('all');
  const rows = contactRows(d, query.q, tab);
  listed.ids = rows.map((r) => r.contact.id);
  const count = (x: ContactTab) => contactRows(d, undefined, x).length;
  const open = (id: string) => nav.select({ area: 'invoices', view: 'contacts', id });
  return (
    <div className="page ivtable" data-view="contacts">
      <ListHead {...props} noPeriod>
        <div className="counts">
          <span>{t('contacts.n', { n: count('all') })}</span>
          <Views on="contacts" props={props} />
          <Search props={props} />
        </div>
      </ListHead>
      <div className="ivtabs" role="tablist" aria-label={t('contacts.tabs')}>
        {CONTACT_TABS.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} className={`${tab === x ? 'on' : ''}${x === 'archived' ? ' apart' : ''}`} data-tab={x}
            onClick={() => setTab(x)}>
            {t(`contacts.tab.${x}`)} <span className="n mono">{count(x)}</span>
          </button>
        ))}
      </div>
      {canEdit && (
        <div className="ivfacts">
          <span>{t('contacts.facts', { n: rows.length })}</span>
          <button type="button" className="quiet2" data-act="import-contacts" onClick={() => setUi({ dialog: { kind: 'contactImport' } })}>{t('contacts.import')}</button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="empty"><h2>{t(tab === 'archived' ? 'contacts.noneArchived' : 'contacts.none')}</h2><p>{t(tab === 'archived' ? 'contacts.noneArchivedText' : 'contacts.noneText')}</p></div>
      ) : (
        <div className="ivscroll">
          <table className="ivt ctab" aria-label={t('invoices.view.contacts')}>
            <thead>
              <tr>
                <th className="c-number">{t('contacts.col.number')}</th><th>{t('contacts.col.name')}</th><th>{t('contacts.col.town')}</th>
                <th className="num">{t('contacts.col.open', { currency: baseCurrency() })}</th><th className="num">{t('contacts.col.documents')}</th><th>{t('contacts.col.tags')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const c = r.contact;
                const sel = c.id === route.id;
                return (
                  <tr key={c.id} className={`trow${sel ? ' sel' : ''}`} data-id={c.id} aria-selected={sel} tabIndex={rowTab(sel, i, rows.some((x) => x.contact.id === route.id))}
                    onClick={() => open(c.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(c.id); }}>
                    <td className="mono c-number">{c.number ?? ''}</td>
                    <td className="c-contact tt">{c.name}{c.type === 'firm' && c.persons.length > 0 && <small>{c.persons.map((p) => p.name).join(', ')}</small>}</td>
                    <td>{r.town}</td>
                    <td className="num mono">{r.open ? fmt(r.open) : ''}</td>
                    <td className="num mono">{r.documents || ''}</td>
                    <td className="ctags">{(c.tags ?? []).map((x) => <span key={x} className="ctag">{x}</span>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── the panel ──────────────────────────────────────────────────────────────────

const addressText = (a: ContactAddress) =>
  [[a.street, a.number].filter(Boolean).join(' '), a.line2, `${a.country !== 'CH' ? `${a.country}-` : ''}${a.postcode} ${a.town}${a.state ? ` ${a.state}` : ''}`].filter(Boolean).join(', ');

function termsText(c: Contact, ws: ReturnType<typeof useWorkspace>): string {
  const named = ws?.invoicing?.paymentTerms.find((x) => x.id === c.paymentTerms);
  if (named) return named.name;
  const days = contactDays(c, ws?.invoicing);
  return c.paymentDays !== undefined ? t('invoices.nDays', { n: days }) : t('contacts.termsFirm', { n: days });
}

export function ContactPanel({ d, route, nav, canEdit }: Props & { d: InvoiceList }) {
  const ws = useWorkspace();
  const c = d.contacts.find((x) => x.id === route.id);
  const [detail, setDetail] = useState<Detail>();
  useEffect(() => {
    if (!c) return;
    let live = true;
    api.contact(c.id).then((x) => { if (live) setDetail(x); }, () => { if (live) setDetail(undefined); });
    return () => { live = false; };
  }, [c?.id, c?.business]);
  if (!c) return <div className="detail-empty"><div>{route.id ? t('contacts.gone') : t('invoices.noneSelected')}</div></div>;
  const docs = documentsOf(d, c.id).sort((x, y) => y.date.localeCompare(x.date));
  const today = localToday();
  const open = docs.filter((i) => i.status === 'issued' && i.kind === 'invoice' && !i.cancelled && openAmount(i, d.invoices) > 0);
  const a = billingAddress(c);
  const partner = detail?.business?.known ? detail.business.id : undefined;
  const go = (to: Parameters<typeof hrefOf>[0]) => (e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav.go(to); };
  return (
    <div className="detail-in cpanel" data-for={c.id}>
      <div className="head">
        <h2 className="who">{c.name}<small>{[c.number, t(`contacts.type.${c.type}`), a ? addressText(a) : t('contacts.noAddress')].filter(Boolean).join(' · ')}</small></h2>
      </div>
      <div className="facts">
        <span>{c.emails[0] ?? t('invoices.noEmail')}</span>
        {c.phone && <span>{c.phone}</span>}
        <span>{c.vatId || t('invoices.noVatId')}</span>
        <span>{t(`invoices.lang.${c.language}`)}</span>
        <span>{termsText(c, ws)}</span>
      </div>
      {c.archived && <p className="cnote" data-testid="contact-archived">{t('contacts.archivedNote')}</p>}
      {canEdit && (
        <div className="ivacts">
          {!c.archived && <AsyncButton type="button" className="btn primary" data-act="new-invoice" onClick={() => newDraftFor(nav, c)}>{t('invoices.new')}</AsyncButton>}
          {open.length > 0 && <button type="button" className="btn ghost" data-act="allocate-contact" data-tip={t('contacts.allocateTip')} onClick={() => setUi({ dialog: { kind: 'allocate', transactionRef: '', customerId: c.id } })}>{t('contacts.allocate')}</button>}
          <button type="button" className="btn ghost" data-act="edit-contact" onClick={() => setUi({ dialog: { kind: 'contact', id: c.id } })}>{t('contacts.edit')}</button>
          {c.archived
            ? <AsyncButton type="button" className="btn ghost" data-act="restore-contact" onClick={() => restoreContact(nav, c)}>{t('contacts.restore')}</AsyncButton>
            : <AsyncButton type="button" className="btn ghost danger" data-act="remove-contact" data-tip={t(docs.length ? 'contacts.archiveTip' : 'contacts.deleteTip')} onClick={() => removeContact(nav, c)}>{t(docs.length ? 'contacts.archive' : 'common.delete')}</AsyncButton>}
        </div>
      )}
      <div className="csecs">
        <section className="csec">
          <h3>{t('contacts.sec.addresses')}</h3>
          {c.addresses.length ? c.addresses.map((x) => (
            <div key={x.id} className="caddr" data-testid="contact-address">
              <span>{x.label && <b>{x.label} · </b>}{x.attn && <>{x.attn}, </>}{addressText(x)}</span>
              <span className="m">{[x.id === a?.id && t('contacts.billing'), x.delivery && t('contacts.delivery')].filter(Boolean).join(' · ')}</span>
            </div>
          )) : <p className="m">{t('contacts.noAddress')}</p>}
        </section>
        {c.type === 'firm' && (
          <section className="csec">
            <h3>{t('contacts.sec.persons')}</h3>
            {c.persons.length ? c.persons.map((p) => (
              <div key={p.id} className="caddr" data-testid="contact-person">
                <span>{p.name}{p.role && <span className="m"> · {p.role}</span>}</span>
                <span className="m">{[p.email, p.phone].filter(Boolean).join(' · ')}</span>
              </div>
            )) : <p className="m">{t('contacts.noPersons')}</p>}
          </section>
        )}
        <section className="csec">
          <h3>{t('contacts.sec.defaults')}</h3>
          <dl className="kv">
            <dt>{t('invoices.f.terms')}</dt><dd>{termsText(c, ws)}</dd>
            <dt>{t('invoices.currency')}</dt><dd>{c.currency ?? t('contacts.firmDefault')}</dd>
            <dt>{t('contacts.revenueAccount')}</dt><dd className={c.revenueAccount ? 'mono' : undefined}>{c.revenueAccount ?? t('contacts.firmDefault')}</dd>
            <dt>{t('contacts.discount')}</dt><dd>{c.discount ? `${c.discount} %` : '–'}</dd>
            <dt>{t('contacts.reminders')}</dt><dd>{t(c.noReminders ? 'contacts.noReminders' : 'contacts.withReminders')}</dd>
          </dl>
          {(c.tags?.length || c.notes) && <p className="m">{(c.tags ?? []).map((x) => <span key={x} className="ctag">{x}</span>)} {c.notes}</p>}
        </section>
        <section className="csec" data-testid="contact-business">
          <h3>{t('contacts.sec.business')}</h3>
          {detail?.business ? (
            <p>
              {partner ? <a className="linkbtn" data-act="partner-page" href={hrefOf({ route: { area: 'partners', id: partner }, query: {} })} onClick={go({ route: { area: 'partners', id: partner }, query: {} })}>{detail.business.name}</a> : detail.business.name}
              {!detail.business.known && <span className="m"> · {t('contacts.businessGone')}</span>}
              {canEdit && <> · <AsyncButton type="button" className="quiet2" data-act="unlink-business" onClick={() => saveContact(nav, c.id, { business: null })}>{t('contacts.unlink')}</AsyncButton></>}
            </p>
          ) : detail?.proposal ? (
            <p data-testid="business-proposal">
              {t('contacts.proposal', { name: detail.proposal.name, by: t(`contacts.by.${detail.proposal.by}` as 'contacts.by.uid') })}
              {canEdit && <> · <AsyncButton type="button" className="quiet2" data-act="keep-business" onClick={() => saveContact(nav, c.id, { business: detail.proposal!.id })}>{t('contacts.keep')}</AsyncButton></>}
            </p>
          ) : <p className="m">{t('contacts.noBusiness')}</p>}
          {canEdit && !detail?.business && (detail?.businesses.length ?? 0) > 0 && (
            <label className="cpick"><span className="m">{t('contacts.pickBusiness')}</span>
              <select value="" onChange={(e) => { if (e.target.value) void saveContact(nav, c.id, { business: e.target.value }); }}>
                <option value="">–</option>
                {detail!.businesses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
          )}
          {!partner && <p className="lkfoot"><a className="linkbtn" href={hrefOf({ route: { area: 'partners', id: c.id }, query: {} })} onClick={go({ route: { area: 'partners', id: c.id }, query: {} })}>{t('partners.openPage')}</a></p>}
        </section>
        <section className="csec">
          <h3>{t('contacts.sec.open')}</h3>
          <div className="ftab cinv">
            {open.length ? open.map((i) => (
              <button key={i.id} type="button" className="fr" onClick={() => nav.go(invoiceAt(i))}>
                <span className="mono">{i.status === 'issued' ? i.number : ''}</span>
                <span>{i.status === 'issued' ? t('invoices.due', { date: formatDate(i.dueDate) }) : ''}</span>
                <span className="m">{t(`invoices.state.${rowState(i, d.invoices, today)}`)}</span>
                <span className="r mono">{i.currency} {fmt(openAmount(i, d.invoices))}</span>
              </button>
            )) : <p className="m">{t('contacts.nothingOpen')}</p>}
          </div>
        </section>
        <section className="csec">
          <h3>{t('contacts.sec.documents')}</h3>
          <div className="ftab cinv">
            {docs.length ? docs.map((i) => (
              <button key={i.id} type="button" className="fr" onClick={() => nav.go(invoiceAt(i))}>
                <span className="mono">{i.status === 'issued' ? i.number : t('invoices.draft')}</span>
                <span data-tip={i.subject || undefined}>{i.subject ?? ''}</span>
                <span className="m">{t(`invoices.state.${rowState(i, d.invoices, today)}`)}</span>
                <span className="r mono">{i.currency} {fmt(totals(i).gross)}</span>
              </button>
            )) : <p className="m">{t('invoices.noInvoicesYet')}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

// ─── the form ───────────────────────────────────────────────────────────────────

type AddrForm = { id?: string; label: string; attn: string; street: string; number: string; line2: string; postcode: string; town: string; state: string; countryText: string; billing: boolean; delivery: boolean };
type PersonForm = { id?: string; name: string; role: string; email: string; phone: string };
type Form = {
  type: Contact['type']; name: string; salutation: string; firstName: string; lastName: string; number: string; language: InvoiceLanguage;
  emails: string; phone: string; vatId: string; terms: string; ownDays: string; currency: '' | InvoiceCurrency; revenueAccount: string; discount: string;
  noReminders: boolean; tags: string; notes: string; addresses: AddrForm[]; persons: PersonForm[];
};

const emptyAddress = (billing: boolean): AddrForm => ({ label: '', attn: '', street: '', number: '', line2: '', postcode: '', town: '', state: '', countryText: countryName('CH', language()), billing, delivery: false });
const addrForm = (a: ContactAddress, billing: boolean): AddrForm => ({
  id: a.id, label: a.label ?? '', attn: a.attn ?? '', street: a.street ?? '', number: a.number ?? '', line2: a.line2 ?? '', postcode: a.postcode, town: a.town, state: a.state ?? '',
  countryText: countryName(a.country, language()), billing, delivery: !!a.delivery,
});
const personForm = (p: ContactPerson): PersonForm => ({ id: p.id, name: p.name, role: p.role ?? '', email: p.email ?? '', phone: p.phone ?? '' });

function formOf(c: Contact | undefined, typedName: string | undefined, firmTerms: readonly string[]): Form {
  const own = c?.paymentDays !== undefined ? String(c.paymentDays) : undefined;
  const billing = c ? billingAddress(c)?.id : undefined;
  return {
    type: c?.type ?? 'firm', name: c?.type === 'person' ? '' : c?.name ?? typedName ?? '', salutation: c?.salutation ?? '', firstName: c?.firstName ?? '', lastName: c?.lastName ?? '',
    number: c?.number ?? '', language: c?.language ?? 'de', emails: (c?.emails ?? []).join(', '), phone: c?.phone ?? '', vatId: c?.vatId ?? '',
    terms: own !== undefined ? 'own' : c?.paymentTerms && firmTerms.includes(c.paymentTerms) ? c.paymentTerms : '', ownDays: own ?? '', currency: c?.currency ?? '', revenueAccount: c?.revenueAccount ?? '', discount: c?.discount ? String(c.discount) : '',
    noReminders: !!c?.noReminders, tags: (c?.tags ?? []).join(', '), notes: c?.notes ?? '',
    addresses: c ? c.addresses.map((a) => addrForm(a, a.id === billing)) : [emptyAddress(true)],
    persons: (c?.persons ?? []).map(personForm),
  };
}

type Errors = Record<string, string>;
const blank = (a: AddrForm) => ![a.label, a.attn, a.street, a.number, a.line2, a.postcode, a.town, a.state].some((x) => x.trim());

function errorsOf(f: Form): Errors {
  const e: Errors = {};
  if (f.type === 'firm' && !f.name.trim()) e.name = t('customer.err.missing');
  if (f.type === 'person' && !f.firstName.trim() && !f.lastName.trim()) e.lastName = t('customer.err.missing');
  const mails = f.emails.split(/[;,\s]+/).filter(Boolean);
  if (mails.some((m) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m))) e.emails = t('customer.err.email');
  f.addresses.forEach((a, i) => {
    if (blank(a)) return;
    const country = countryOf(a.countryText);
    if (!country) e[`a.${i}.countryText`] = t('customer.err.country');
    const rule = addressRule(country ?? 'CH');
    for (const k of ['street', 'town'] as const) if (!a[k].trim()) e[`a.${i}.${k}`] = t('customer.err.missing');
    if (!a.postcode.trim() && !rule.pattern.test('')) e[`a.${i}.postcode`] = t('customer.err.missing');
    else if (a.postcode.trim() && !rule.pattern.test(a.postcode.trim())) e[`a.${i}.postcode`] = rule.example ? t('customer.err.example', { example: rule.example }) : t('customer.err.tooLong');
    if (rule.state && !a.state.trim()) e[`a.${i}.state`] = t('customer.err.missing');
    if (`${a.street} ${a.number}`.length > 70 || a.town.length > 35) e[`a.${i}.street`] = e[`a.${i}.street`] ?? t('customer.err.qrLength');
  });
  f.persons.forEach((p, i) => {
    if (!p.name.trim()) e[`p.${i}.name`] = t('customer.err.missing');
    if (p.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email.trim())) e[`p.${i}.email`] = t('customer.err.email');
  });
  const country = countryOf(f.addresses.find((a) => !blank(a))?.countryText ?? '') ?? 'CH';
  const v = vatRule(country);
  if (f.vatId.trim() && v.pattern && !v.pattern.test(f.vatId.trim())) e.vatId = t('customer.err.example', { example: v.example });
  if (f.terms === 'own' && !/^\d{1,3}$/.test(f.ownDays.trim())) e.ownDays = t('customer.err.terms');
  if (f.revenueAccount.trim() && !/^\d{4}$/.test(f.revenueAccount.trim())) e.revenueAccount = t('contacts.err.account');
  const disc = Number(f.discount.replace(',', '.'));
  if (f.discount.trim() && !(disc >= 0 && disc <= 100)) e.discount = t('contacts.err.discount');
  return e;
}

/** The request of the form: every field, an empty optional one as null (it clears what the contact had). */
function inputOf(f: Form): ContactInput {
  const opt = (v: string) => (v.trim() ? v.trim() : null);
  const addresses = f.addresses.filter((a) => !blank(a)).map((a) => ({
    ...(a.id ? { id: a.id } : {}), ...(a.label.trim() ? { label: a.label.trim() } : {}), ...(a.attn.trim() ? { attn: a.attn.trim() } : {}),
    street: a.street.trim(), ...(a.number.trim() ? { number: a.number.trim() } : {}), ...(a.line2.trim() ? { line2: a.line2.trim() } : {}),
    postcode: a.postcode.trim().toUpperCase(), town: a.town.trim(), ...(a.state.trim() ? { state: a.state.trim().toUpperCase() } : {}), country: countryOf(a.countryText)!,
    ...(a.billing ? { billing: true } : {}), ...(a.delivery ? { delivery: true } : {}),
  }));
  const persons = f.type === 'firm' ? f.persons.map((p) => ({ ...(p.id ? { id: p.id } : {}), name: p.name.trim(), ...(p.role.trim() ? { role: p.role.trim() } : {}), ...(p.email.trim() ? { email: p.email.trim() } : {}), ...(p.phone.trim() ? { phone: p.phone.trim() } : {}) })) : [];
  const tags = f.tags.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    type: f.type,
    ...(f.type === 'firm' ? { name: f.name.trim() } : { salutation: opt(f.salutation), firstName: opt(f.firstName), lastName: opt(f.lastName) }),
    number: opt(f.number), language: f.language, emails: f.emails.split(/[;,\s]+/).filter(Boolean), phone: opt(f.phone), vatId: opt(f.vatId),
    ...(f.terms === 'own' ? { paymentDays: Number(f.ownDays.trim()) } : f.terms ? { paymentTerms: f.terms } : { paymentTerms: null, paymentDays: null }),
    currency: f.currency || null, revenueAccount: opt(f.revenueAccount), discount: f.discount.trim() ? Number(f.discount.replace(',', '.')) : null,
    noReminders: f.noReminders ? true : null, tags: tags.length ? tags : null, notes: opt(f.notes), addresses, persons,
  } as ContactInput;
}

/** One form for a new and a known contact: firm or person, its addresses (the country decides their fields), contact persons and defaults. */
export function ContactDialog({ contact, nav }: Props & { contact?: Contact }) {
  const s = useUi();
  const ws = useWorkspace();
  const dlg = s.dialog?.kind === 'contact' ? s.dialog : undefined;
  const then = dlg?.then;
  const firmTerms = (ws?.invoicing?.paymentTerms ?? []).map((x) => x.id);
  // N › a name nobody has yet › ↵: the name typed is the new contact's (r8c-17).
  const [f, setF] = useState<Form>(() => formOf(contact, dlg?.name, firmTerms));
  const [tried, setTried] = useState(false);
  const langChosen = useRef(!!contact);
  const errors = tried ? errorsOf(f) : {};
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((was) => ({ ...was, [k]: v }));
  const setAddr = (i: number, k: keyof AddrForm, v: string | boolean) => setF((was) => {
    const addresses = was.addresses.map((a, j) => (j === i ? { ...a, [k]: v } : k === 'billing' && v === true ? { ...a, billing: false } : a));
    const next = { ...was, addresses };
    const first = addresses[0];
    if (!langChosen.current && i === 0 && (k === 'countryText' || k === 'postcode')) { const cc = countryOf(first.countryText); if (cc) next.language = languageFor(cc, first.postcode.trim()); }
    return next;
  });
  const setPerson = (i: number, k: keyof PersonForm, v: string) => setF((was) => ({ ...was, persons: was.persons.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));
  const input = (key: string, value: string, onChange: (v: string) => void, label: string, ph: string, cls: string, mono = false, autoFocus = false) => (
    <label key={key} className={`cf ${cls}${errors[key] ? ' err' : ''}`}>
      <span>{label}{errors[key] && <em>{errors[key]}</em>}</span>
      <input className={mono ? 'mono' : undefined} value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} data-field={key} />
    </label>
  );
  const field = (k: 'name' | 'salutation' | 'firstName' | 'lastName' | 'number' | 'emails' | 'phone' | 'vatId' | 'ownDays' | 'revenueAccount' | 'discount' | 'tags' | 'notes', label: string, ph: string, cls: string, mono = false, autoFocus = false) =>
    input(k, f[k], (v) => set(k, v), label, ph, cls, mono, autoFocus);

  async function save(next: 'close' | 'invoice') {
    setTried(true);
    if (Object.keys(errorsOf(f)).length) return;
    const saved = await saveContact(nav, contact?.id, inputOf(f));
    if (!saved) return;
    close();
    if (contact) {
      const before = contact;
      nav.toast(t('contacts.saved', { name: saved.name }), () => { void saveContact(nav, before.id, inputOf(formOf(before, undefined, firmTerms))); });
      return;
    }
    if (then && typeof then === 'object' && 'kind' in then) { void newDraftFor(nav, saved, then.kind); return; }
    if (then && typeof then === 'object') {
      const draft = invoicesNow()?.invoices.find((i) => i.id === then.draft);
      if (draft?.status === 'draft') void saveDraft(nav, draft, customerChange(draft, saved));
      return;
    }
    if (then === 'invoice' || next === 'invoice') { void newDraftFor(nav, saved); return; }
    nav.go({ route: { area: 'invoices', view: 'contacts', id: saved.id }, query: {} });
    nav.toast(t('contacts.created', { name: saved.name }));
  }

  const firstCountry = countryOf(f.addresses[0]?.countryText ?? '') ?? 'CH';
  const v = vatRule(firstCountry);
  const title = f.type === 'firm' ? f.name : [f.firstName, f.lastName].filter(Boolean).join(' ');
  return (
    <Frame
      className="cdlg contact"
      label={contact ? t('contacts.edit') : t('contacts.new')}
      title={title || t('contacts.namePlaceholder')}
      foot={<>
        {!contact && !then && <AsyncButton type="button" className="btn ghost" onClick={() => save('invoice')}>{t('customer.createAndInvoice')}</AsyncButton>}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <AsyncButton type="button" className="btn primary" data-act="save-contact" onClick={() => save('close')}>{contact ? t('common.save') : t('contacts.create')}</AsyncButton>
      </>}
    >
      <AsyncForm className="ibody cform" onSubmit={(e) => { e.preventDefault(); return save('close'); }} noValidate>
        <div className="cf s2"><span>{t('contacts.type')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('contacts.type')}>
            {(['firm', 'person'] as const).map((x) => <button key={x} type="button" role="radio" data-type={x} aria-checked={f.type === x} className={f.type === x ? 'on' : ''} onClick={() => set('type', x)}>{t(`contacts.type.${x}`)}</button>)}
          </span>
        </div>
        {field('number', t('contacts.number'), t('contacts.numberPh'), 's2', true)}
        {f.type === 'firm' ? field('name', t('contacts.firmName'), t('customer.namePh'), 'w2', false, true) : <>
          {field('salutation', t('contacts.salutation'), t('contacts.salutationPh'), 's1')}
          {field('firstName', t('contacts.firstName'), '', 's1', false, true)}
          {field('lastName', t('contacts.lastName'), '', 's2')}
        </>}
        <div className="cf s2"><span>{t('customer.language')}</span>
          <span className="seg2" role="radiogroup" aria-label={t('customer.language')}>
            {(['de', 'fr', 'it', 'en'] as const).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={f.language === l} className={f.language === l ? 'on' : ''} onClick={() => { langChosen.current = true; set('language', l); }}>{l.toUpperCase()}</button>
            ))}
          </span>
        </div>
        {field('phone', t('contacts.phone'), '', 's2')}
        {field('emails', t('contacts.emails'), t('customer.emailPh'), 'w2')}
        {field('vatId', t(`customer.vat.${v.kind}`), v.example || t('customer.optional'), 'w2', true)}

        <h4 className="cfh">{t('contacts.sec.addresses')}</h4>
        {f.addresses.map((a, i) => {
          const country = countryOf(a.countryText);
          const rule = addressRule(country ?? 'CH');
          const af = (k: 'label' | 'attn' | 'street' | 'number' | 'line2' | 'postcode' | 'town' | 'state', label: string, ph: string, cls: string, mono = false) =>
            input(`a.${i}.${k}`, a[k], (x) => setAddr(i, k, x), label, ph, cls, mono);
          const street = [af('street', t('customer.street'), t('customer.streetPh'), 's3'), af('number', t('customer.number'), '12', 's1')];
          const town = rule.townFirst
            ? [af('town', t('customer.town'), '', rule.state ? 's2' : 's3'), ...(rule.state ? [af('state', t(`customer.${rule.state}`), rule.stateExample ?? '', 's1')] : []), af('postcode', t(`customer.pc.${rule.postcode}`), rule.example, 's1', true)]
            : [af('postcode', t(`customer.pc.${rule.postcode}`), rule.example, 's1', true), af('town', t('customer.town'), '', 's3')];
          return (
            <fieldset key={a.id ?? `new-${i}`} className="cgroup" data-testid="address-form">
              {af('label', t('contacts.addressLabel'), t('contacts.addressLabelPh'), 's2')}
              {af('attn', t('customer.attn'), t('customer.optional'), 's2')}
              <label className={`cf s2${errors[`a.${i}.countryText`] ? ' err' : ''}`}>
                <span>{t('customer.country')}{errors[`a.${i}.countryText`] && <em>{errors[`a.${i}.countryText`]}</em>}</span>
                <span className="ccin">
                  <input list="cc-list" value={a.countryText} placeholder={countryName('CH', language())} autoComplete="off" onChange={(e) => setAddr(i, 'countryText', e.target.value)} />
                  <span className="mono cc">{country ? `→ ${country}` : ''}</span>
                </span>
              </label>
              <div className="cf s2 cflags">
                <label><input type="radio" name="billing" checked={a.billing} onChange={() => setAddr(i, 'billing', true)} /> {t('contacts.billing')}</label>
                <label><input type="checkbox" checked={a.delivery} onChange={(e) => setAddr(i, 'delivery', e.target.checked)} /> {t('contacts.delivery')}</label>
                <button type="button" className="quiet2" data-act="remove-address" onClick={() => setF((was) => ({ ...was, addresses: was.addresses.filter((_, j) => j !== i) }))}>{t('contacts.remove')}</button>
              </div>
              {numberFirst(country ?? 'CH') ? [street[1], street[0]] : street}
              {af('line2', t('customer.line2'), t('customer.line2Ph'), 'w2')}
              {town}
            </fieldset>
          );
        })}
        <datalist id="cc-list">{COUNTRIES.map((k) => <option key={k} value={countryName(k, language())} />)}</datalist>
        <p className="cf"><button type="button" className="quiet2" data-act="add-address" onClick={() => setF((was) => ({ ...was, addresses: [...was.addresses, emptyAddress(was.addresses.length === 0)] }))}>＋ {t('contacts.addAddress')}</button></p>

        {f.type === 'firm' && <>
          <h4 className="cfh">{t('contacts.sec.persons')}</h4>
          {f.persons.map((p, i) => (
            <fieldset key={p.id ?? `new-${i}`} className="cgroup" data-testid="person-form">
              {input(`p.${i}.name`, p.name, (x) => setPerson(i, 'name', x), t('contacts.personName'), '', 's2')}
              {input(`p.${i}.role`, p.role, (x) => setPerson(i, 'role', x), t('contacts.role'), t('contacts.rolePh'), 's2')}
              {input(`p.${i}.email`, p.email, (x) => setPerson(i, 'email', x), t('contacts.personEmail'), '', 's2')}
              {input(`p.${i}.phone`, p.phone, (x) => setPerson(i, 'phone', x), t('contacts.phone'), '', 's1')}
              <div className="cf s1 cflags"><button type="button" className="quiet2" data-act="remove-person" onClick={() => setF((was) => ({ ...was, persons: was.persons.filter((_, j) => j !== i) }))}>{t('contacts.remove')}</button></div>
            </fieldset>
          ))}
          <p className="cf"><button type="button" className="quiet2" data-act="add-person" onClick={() => setF((was) => ({ ...was, persons: [...was.persons, { name: '', role: '', email: '', phone: '' }] }))}>＋ {t('contacts.addPerson')}</button></p>
        </>}

        <h4 className="cfh">{t('contacts.sec.defaults')}</h4>
        <label className="cf s2"><span>{t('customer.terms')}</span>
          <select value={f.terms} data-field="terms" onChange={(e) => set('terms', e.target.value)}>
            <option value="">{t('contacts.termsFirm', { n: contactDays(undefined, ws?.invoicing) })}</option>
            {(ws?.invoicing?.paymentTerms ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            <option value="own">{t('contacts.termsOwn')}</option>
          </select>
        </label>
        {f.terms === 'own' ? field('ownDays', t('customer.days'), '30', 's1', true) : <span className="cf s1" />}
        <label className="cf s1"><span>{t('invoices.currency')}</span>
          <select value={f.currency} onChange={(e) => set('currency', e.target.value as Form['currency'])}>
            <option value="">{t('contacts.firmDefault')}</option>{INVOICE_CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        {field('revenueAccount', t('contacts.revenueAccount'), ws?.invoicing?.revenueAccount ?? '3200', 's2', true)}
        {field('discount', t('contacts.discountPct'), '0', 's1', true)}
        <label className="cf s1 cflags"><span /><label><input type="checkbox" checked={f.noReminders} onChange={(e) => set('noReminders', e.target.checked)} /> {t('contacts.noReminders')}</label></label>
        {field('tags', t('contacts.tags'), t('contacts.tagsPh'), 'w2')}
        {field('notes', t('contacts.notes'), '', 'w2')}
        <AsyncButton type="submit" hidden />
      </AsyncForm>
    </Frame>
  );
}

// ─── the import ─────────────────────────────────────────────────────────────────

/** «Importieren»: a CSV, its columns mapped (code proposes the mapping), the rows as they would come in, then the import. */
export function ImportDialog({ nav }: Props) {
  const kind: ImportKind<ImportRow> = {
    label: t('contacts.import'), title: t('contacts.importTitle'), text: t('contacts.importText'),
    fields: IMPORT_FIELDS, fieldLabel: (k) => t(`contacts.field.${k as ImportField}`),
    preview: (csv, map) => api.previewContactImport(csv, map as ImportMapping | undefined),
    run: (csv, map, choices) => api.importContacts(csv, map as ImportMapping, choices),
    done: (n, skipped) => t('contacts.imported', { n, skipped }),
    count: (n, of) => t('contacts.importCount', { n, of }),
    runLabel: (n) => t('contacts.importRun', { n }),
    columns: [[t('contacts.col.name'), (r) => r.contact?.name ?? '–'], [t('contacts.col.town'), (r) => (r.contact ? (billingAddress(r.contact)?.town ?? '') : '')]],
    notes: (r) => <>
      {r.problems.map((p) => t(`contacts.problem.${p}`)).join(' · ')}
      {r.same && <span data-testid="import-same">{r.problems.length ? ' · ' : ''}{t(`contacts.same.${r.same.by}`, { name: r.same.name, where: 'line' in r.same ? t('contacts.sameRow', { line: r.same.line }) : t('contacts.sameContact') })}</span>}
    </>,
    blocked: (r) => !r.contact || r.problems.some((p) => p === 'name' || p === 'uid'),
    hasSame: (r) => !!r.same,
    newWord: t('contacts.choice.new'),
  };
  return <TableImport kind={kind} nav={nav} />;
}
