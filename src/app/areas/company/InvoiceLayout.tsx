/**
 * Firma › Rechnungslayout: the font, colour, logo, envelope window and elements every draft is
 * laid out with, and the texts above and below the table per language, written on a sample
 * sheet. Saved in belege.workspace.yaml's invoicing block; an issued invoice keeps the layout it
 * was issued with.
 */
import { banksOf } from '../../../workspace/money-accounts.js';
import { Fragment, useMemo, useState } from 'react';
import { DEFAULT_UNITS, INVOICE_CURRENCIES, INVOICE_FONTS, LAYOUT_ELEMENTS, PRICES, isItem, type Invoice, type Prices, type UnitDef, type Draft, type InvoiceCurrency, type InvoiceLanguage, type InvoiceLayout, type LayoutElement, type OWN_TEXTS } from '../../../invoices/model.js';
import { draftSheet } from '../../../invoices/documents.js';
import { builtInTexts } from '../../../invoices/texts.js';
import type { CompanyInfo } from '../../../books/company.js';
import type { InvoicingPatch } from '../../../workspace/manifest-write.js';
import { ApiError, api, errorText } from '../../lib/api.js';
import { qrIbanTakes } from '../../../providers/qr-bill/reference.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import { localToday } from '../../../accounting/periods.js';
import { getAccountMap } from '../../lib/accounts.js';
import { usePersistedFlag } from '../../shell/prefs.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { useInvoices } from '../invoices/data.js';
import { bookOf } from '../invoices/model.js';
import { contextOf, screenOf } from '../invoices/sheets.js';
import { Sheet } from '../invoices/Sheet.js';
import '../invoices/invoices.css';
import { chargesVat, invoiceRates } from '../../../engines/index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { PaymentTermsSection } from './PaymentTerms.js';

const LANGS: InvoiceLanguage[] = ['de', 'fr', 'it', 'en'];
const ACCENTS: Array<[string, 'black' | 'blue' | 'green' | 'bordeaux' | 'ochre']> = [['#141a26', 'black'], ['#1d4ed8', 'blue'], ['#0f766e', 'green'], ['#9f1239', 'bordeaux'], ['#b45309', 'ochre']];
const DAYS = '{days}';
type OwnText = (typeof OWN_TEXTS)[number];

export function InvoiceLayoutSection({ ws, nav, canEdit }: { ws: CompanyInfo; nav: Nav; canEdit: boolean }) {
  const settings = ws.invoicing;
  const [lang, setLang] = useState<InvoiceLanguage>('de');
  const [guide, setGuide] = usePersistedFlag('invoices.windowGuide', true);
  const [local, setLocal] = useState<InvoiceLayout | undefined>(settings?.layout);
  const load = useInvoices();
  if (!settings || !local) return <InvoicingSetup ws={ws} nav={nav} canEdit={canEdit} onDone={(l) => setLocal(l)} />;
  const layout = local;

  async function patch(change: InvoicingPatch, next?: InvoiceLayout) {
    if (next) setLocal(next);
    try { await api.patchWorkspace({ invoicing: change }); reloadWorkspace(); } catch (e) { setLocal(settings!.layout); nav.toast(errorText(e)); }
  }
  const setLayout = <K extends keyof InvoiceLayout>(key: K, value: InvoiceLayout[K]) => patch({ layout: { [key]: value } }, { ...layout, [key]: value });
  const setShow = (k: LayoutElement, on: boolean) => void patch({ layout: { show: { [k]: on } } }, { ...layout, show: { ...layout.show, [k]: on } });

  async function upload(file: File) {
    if (file.size > 1.5e6) { nav.toast(t('invoiceLayout.logoTooBig')); return; }
    try {
      const info = await api.uploadLogo(file, file.type);
      setLocal(info.invoicing?.layout);
      reloadWorkspace();
      nav.toast(t('invoiceLayout.logoSet', { name: file.name }));
    } catch (e) { nav.toast(errorText(e)); }
  }

  const own = settings.texts[lang] ?? {};
  const texts = { ...builtInTexts(lang), ...own };
  const changed = Object.keys(own).length;
  function saveText(key: OwnText, value: string) {
    if (value === texts[key]) return;
    void patch({ texts: { [lang]: { [key]: value === builtInTexts(lang)[key] ? null : value } } });
  }
  function resetTexts() {
    const was = { ...own };
    const reset = patch({ texts: { [lang]: { salutation: null, intro: null, closing: null, mailSubject: null, mailBody: null } } });
    nav.toast(t('invoiceLayout.textsReset'), () => { void patch({ texts: { [lang]: was } }); });
    return reset;
  }

  const seg = <T extends string>(value: T, opts: Array<[T, string]>, onPick: (v: T) => void, label: string) => (
    <span className="seg2" role="radiogroup" aria-label={label}>
      {opts.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} disabled={!canEdit} onClick={() => onPick(v)}>{l}</button>)}
    </span>
  );

  return (
    <div className="lkpage">
      <div>
        <div className="lkf">
          <div className="lkr"><span>{t('invoiceLayout.language')}</span>{seg(lang, LANGS.map((l): [InvoiceLanguage, string] => [l, l.toUpperCase()]), setLang, t('invoiceLayout.language'))}</div>
          <label className="lkr"><span>{t('invoiceLayout.days')}</span>
            <input key={settings.paymentTermsDays} className="mono" name="paymentTermsDays" inputMode="numeric" defaultValue={String(settings.paymentTermsDays)} disabled={!canEdit}
              onBlur={(e) => { const days = Number(e.target.value); if (Number.isInteger(days) && days > 0 && days !== settings.paymentTermsDays) void patch({ paymentTermsDays: days }); }} />
          </label>
          <label className="lkr"><span>{t('invoiceLayout.font')}</span>
            <select value={layout.font} disabled={!canEdit} onChange={(e) => setLayout('font', e.target.value as InvoiceLayout['font'])}>{INVOICE_FONTS.map((f) => <option key={f}>{f}</option>)}</select>
          </label>
          <div className="lkr"><span>{t('invoiceLayout.accent')}</span>
            <span className="sw">
              {[...ACCENTS.map(([c, name]) => [c, t(`invoiceLayout.colour.${name}`)]), ...(ACCENTS.some(([c]) => c === layout.accent) ? [] : [[layout.accent, layout.accent]])].map(([c, name]) => (
                <AsyncButton key={c} type="button" className={`swc${layout.accent === c ? ' on' : ''}`} style={{ ['--c' as string]: c }} disabled={!canEdit} aria-label={name} aria-pressed={layout.accent === c} onClick={() => setLayout('accent', c)} />
              ))}
            </span>
          </div>
          <div className="lkr"><span>{t('invoiceLayout.logo')}</span>
            <span className="lklogo">
              {layout.logo ? <img src={api.logoUrl(layout.logo)} alt="" /> : <span className="m">{t('invoiceLayout.wordmark')}</span>}
              {canEdit && <label className="quiet2">{t('invoiceLayout.upload')}<input type="file" accept="image/png,image/svg+xml,image/jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label>}
              {canEdit && layout.logo && <AsyncButton type="button" className="quiet2" onClick={() => { const { logo: _, ...rest } = layout; return patch({ layout: { logo: null } }, rest); }}>{t('invoiceLayout.removeLogo')}</AsyncButton>}
            </span>
          </div>
          <div className="lkr"><span>{t('invoiceLayout.place')}</span>{seg(layout.logoPosition, [['left', t('invoiceLayout.left')], ['center', t('invoiceLayout.center')], ['right', t('invoiceLayout.right')]], (v) => setLayout('logoPosition', v), t('invoiceLayout.place'))}</div>
          <div className="lkr"><span>{t('invoiceLayout.size')}</span>{seg(layout.logoSize, [['s', 'S'], ['m', 'M'], ['l', 'L']], (v) => setLayout('logoSize', v), t('invoiceLayout.size'))}</div>
          {chargesVat() && <div className="lkr"><span>{t('invoiceLayout.prices')}</span>{seg(settings.prices.invoice, PRICES.map((p): [Prices, string] => [p, t(`invoices.prices.${p}`)]), (v) => void patch({ prices: { invoice: v === 'net' ? null : v } }), t('invoiceLayout.prices'))}</div>}
          <div className="lkr"><span>{t('invoiceLayout.envelope')}</span>{seg(layout.window, [['left', t('invoiceLayout.windowLeft')], ['right', t('invoiceLayout.windowRight')]], (v) => setLayout('window', v), t('invoiceLayout.envelope'))}</div>
          <div className="lkr top"><span>{t('invoiceLayout.elements')}</span>
            <span className="lkel">
              {LAYOUT_ELEMENTS.map((k) => (
                <label key={k}><input type="checkbox" checked={layout.show[k]} disabled={!canEdit} onChange={(e) => setShow(k, e.target.checked)} /> {t(`invoiceLayout.el.${k}`)}</label>
              ))}
              <label><input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} /> {t('invoiceLayout.windowGuide')} <span className="sub">{t('invoiceLayout.previewOnly')}</span></label>
            </span>
          </div>
        </div>
        <PayTo ws={ws} nav={nav} canEdit={canEdit} />
        <Units ws={ws} nav={nav} canEdit={canEdit} drafts={load.state === 'ready' ? load.data.invoices.filter((i) => i.status === 'draft') : []} />
        <PaymentTermsSection ws={ws} nav={nav} canEdit={canEdit} />
        <div className="lkf" key={`greet-${lang}`}>
          <label className="lkr"><span>{t('invoiceLayout.salutation')}</span><input name="salutation" defaultValue={texts.salutation} placeholder={t('invoiceLayout.salutationHint')} disabled={!canEdit} onBlur={(e) => saveText('salutation', e.target.value.trim())} /></label>
        </div>
        <div className="lkf lkmail" key={lang}>
          <div className="lkr"><span>{t('invoiceLayout.mail')}</span><span className="m">{t('invoiceLayout.mailHint', { document: '{document}', company: '{company}' })}</span></div>
          <label className="lkr"><span>{t('invoiceLayout.mailSubject')}</span><input name="mailSubject" defaultValue={texts.mailSubject} disabled={!canEdit} onBlur={(e) => saveText('mailSubject', e.target.value)} /></label>
          <label className="lkr top"><span>{t('invoiceLayout.mailBody')}</span><textarea name="mailBody" rows={6} defaultValue={texts.mailBody} disabled={!canEdit} onBlur={(e) => saveText('mailBody', e.target.value)} /></label>
        </div>
        <p className="m src-note">{t('invoiceLayout.note')}</p>
      </div>
      <div className="lkprevw">
        {load.state === 'ready' && <Preview ws={ws} layout={layout} lang={lang} texts={texts} guide={guide} canEdit={canEdit} onText={saveText} />}
        <p className="m ivhint">{t('invoiceLayout.daysHint', { days: DAYS })}{changed > 0 && <> · {t('invoiceLayout.nChanged', { n: changed })}{canEdit && <> · <AsyncButton type="button" className="quiet2" onClick={resetTexts}>{t('invoiceLayout.reset')}</AsyncButton></>}</>}</p>
      </div>
    </div>
  );
}

/**
 * Firma › Rechnungslayout › Zahlungskonten: per currency, the bank account customers pay to, set
 * after the first setup too (r8c-1: an EUR invoice needs payTo.EUR). An account without an IBAN
 * takes it here, in the same change, as the setup does.
 */
function PayTo({ ws, nav, canEdit }: { ws: CompanyInfo; nav: Nav; canEdit: boolean }) {
  const banks = banksOf(ws.bankAccounts);
  const [pending, setPending] = useState<Partial<Record<InvoiceCurrency, string>>>({});
  const [ibans, setIbans] = useState<Partial<Record<InvoiceCurrency, string>>>({});
  async function set(currency: InvoiceCurrency, account: string, iban?: string) {
    const bank = banks.find((a) => a.account === account);
    try {
      await api.patchWorkspace({ ...(iban && bank ? { banks: [{ bank: bank.bank, currency, iban }] } : {}), invoicing: { payTo: { [currency]: account ? { account } : null } } });
      reloadWorkspace();
      setPending({ ...pending, [currency]: undefined });
      nav.toast(account ? t('invoiceLayout.payToSet', { currency, account: `${account} ${bank?.label ?? ''}`.trim() }) : t('invoiceLayout.payToCleared', { currency }));
    } catch (e) { nav.toast(errorText(e)); }
  }
  return (
    <div className="lkf" data-testid="pay-to">
      <div className="lkr lkstack"><span>{t('invoiceLayout.payToTitle')}</span><span className="m">{t('invoiceLayout.payToHint')}</span></div>
      {INVOICE_CURRENCIES.map((c) => {
        const own = banks.filter((a) => a.currency === c);
        const current = ws.invoicing?.payTo[c]?.account ?? '';
        const picked = pending[c] ?? current;
        const bank = own.find((a) => a.account === picked);
        const needsIban = !!bank && !bank.iban;
        return (
          <Fragment key={c}>
          <label className="lkr" data-currency={c}><span>{t('invoiceLayout.payToIn', { currency: c })}</span>
            {own.length === 0 ? <span className="m">{t('invoiceLayout.payToNoBank', { currency: c })}</span> : (
              <span className="lkpay">
                <select value={picked} disabled={!canEdit} onChange={(e) => {
                  const account = e.target.value;
                  if (!account || own.find((a) => a.account === account)?.iban) void set(c, account);
                  else setPending({ ...pending, [c]: account });
                }}>
                  <option value="">{t('invoiceLayout.payToNone')}</option>
                  {own.map((a) => <option key={a.account} value={a.account}>{a.account} {a.label}{a.iban ? ` · ${a.iban}` : ''}</option>)}
                </select>
                {needsIban && (
                  <>
                    <input className="mono wide" value={ibans[c] ?? ''} placeholder={t('invoiceLayout.ibanExample')} aria-label={t('invoiceLayout.iban')} disabled={!canEdit} onChange={(e) => setIbans({ ...ibans, [c]: e.target.value })} />
                    <AsyncButton type="button" className="btn" disabled={!canEdit || !ibans[c]?.trim()} onClick={() => set(c, picked, ibans[c]!.trim())}>{t('common.save')}</AsyncButton>
                  </>
                )}
              </span>
            )}
          </label>
          {current && <QrIban key={current} ws={ws} nav={nav} canEdit={canEdit} currency={c} account={current} />}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The QR-IBAN of a currency's account, optional: invoices paid to it carry a QR reference. Since
 * SIX IG v2.4 only CHF may use one (#506): saving it under another currency warns with the rule and
 * what follows, and «Trotzdem speichern» keeps it. One kept so, or written before the warning
 * existed, shows the same warning as a fact beside the field.
 */
function QrIban({ ws, nav, canEdit, currency, account }: { ws: CompanyInfo; nav: Nav; canEdit: boolean; currency: InvoiceCurrency; account: string }) {
  const stored = ws.invoicing?.payTo[currency]?.qrIban ?? '';
  const [value, setValue] = useState(stored);
  const [warned, setWarned] = useState(false);
  const changed = value.replace(/\s+/g, '').toUpperCase() !== stored;
  async function save(confirm: boolean) {
    try {
      await api.patchWorkspace({ invoicing: { payTo: { [currency]: { account, qrIban: value.trim() || null } }, ...(confirm ? { confirm: 'qrIbanNotChf' as const } : {}) } });
      setWarned(false);
      reloadWorkspace();
      nav.toast(value.trim() ? t('invoiceLayout.qrIbanSet', { currency }) : t('invoiceLayout.qrIbanCleared', { currency }));
    } catch (e) {
      if (e instanceof ApiError && e.body.code === 'qrIbanNotChf') setWarned(true);
      else nav.toast(errorText(e));
    }
  }
  const fact = !!stored && !qrIbanTakes(currency) && !changed;
  return (
    <>
      <label className="lkr lkqr" data-qr-iban={currency}>
        <span>{t('invoiceLayout.qrIban')}</span>
        <span className="lkpay">
          <input className="mono wide" value={value} placeholder={t('invoiceLayout.qrIbanPlaceholder')} aria-label={t('invoiceLayout.qrIbanIn', { currency })} disabled={!canEdit}
            onChange={(e) => { setValue(e.target.value); setWarned(false); }} />
          {changed && <AsyncButton type="button" className="btn" disabled={!canEdit} onClick={() => save(false)}>{t('common.save')}</AsyncButton>}
        </span>
      </label>
      {(warned || fact) && (
        <div className="lkr" data-qr-warning={currency}>
          <span />
          <span className="warnline qrwarn" role={warned ? 'alert' : undefined}>
            {t('invoiceLayout.qrIbanNotChf', { currency })}
            {warned && <AsyncButton type="button" className="btn" disabled={!canEdit} onClick={() => save(true)}>{t('invoiceLayout.saveAnyway')}</AsyncButton>}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Firma › Rechnungslayout › Einheiten: the units a position may be counted in, each with its word
 * in the four document languages. A unit is added with its four words (its id made from the German
 * one) and removed while no draft uses it; an issued document keeps the words it was issued with.
 */
function Units({ ws, nav, canEdit, drafts }: { ws: CompanyInfo; nav: Nav; canEdit: boolean; drafts: readonly Invoice[] }) {
  const units = ws.invoicing?.units ?? DEFAULT_UNITS;
  const empty = { de: '', fr: '', it: '', en: '' };
  const [words, setWords] = useState<Record<InvoiceLanguage, string>>(empty);
  const used = new Set(drafts.flatMap((i) => i.lines.flatMap((l) => (isItem(l) && l.unit ? [l.unit] : []))));
  async function save(next: UnitDef[], done: string) {
    try { await api.patchWorkspace({ invoicing: { units: next } }); reloadWorkspace(); nav.toast(done); return true; } catch (e) { nav.toast(errorText(e)); return false; }
  }
  const ready = LANGS.every((l) => words[l].trim());
  async function add() {
    const id = unitId(words.de, units);
    if (await save([...units, { id, ...Object.fromEntries(LANGS.map((l) => [l, words[l].trim()])) as Record<InvoiceLanguage, string> }], t('invoiceLayout.unitAdded', { unit: words.de.trim() }))) setWords(empty);
  }
  return (
    <div className="lkf lkunits" data-testid="units">
      <div className="lkr"><span>{t('invoiceLayout.unitsTitle')}</span><span className="m">{t('invoiceLayout.unitsHint')}</span></div>
      <table className="lkut">
        <thead><tr>{LANGS.map((l) => <th key={l}>{l.toUpperCase()}</th>)}<th /></tr></thead>
        <tbody>
          {units.map((u) => (
            <tr key={u.id} data-unit={u.id}>
              {LANGS.map((l) => <td key={l}>{u[l]}</td>)}
              <td>{canEdit && (
                <AsyncButton type="button" className="quiet2" disabled={used.has(u.id) || units.length === 1} data-tip={used.has(u.id) ? t('invoiceLayout.unitUsed') : undefined}
                  aria-label={t('invoiceLayout.unitRemove', { unit: u.de })} onClick={() => save(units.filter((x) => x.id !== u.id), t('invoiceLayout.unitRemoved', { unit: u.de }))}>×</AsyncButton>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && (
        <div className="lkuadd">
          {LANGS.map((l) => <input key={l} value={words[l]} aria-label={t('invoiceLayout.unitWord', { language: l.toUpperCase() })} placeholder={l === 'de' ? t('invoiceLayout.unitExample') : t('invoiceLayout.unitWord', { language: l.toUpperCase() })} onChange={(e) => setWords({ ...words, [l]: e.target.value })} />)}
          <AsyncButton type="button" className="btn" disabled={!ready} onClick={add}>{t('invoiceLayout.unitAdd')}</AsyncButton>
        </div>
      )}
    </div>
  );
}

/** A unit's id from its German word: letters and digits only (m² → m2), unique in the list. */
export function unitId(word: string, units: readonly UnitDef[]): string {
  const base = word.normalize('NFKD').replace(/²/g, '2').replace(/³/g, '3').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'unit';
  let id = base;
  for (let n = 2; units.some((u) => u.id === id); n++) id = `${base}${n}`;
  return id;
}

/** The newest invoice laid out as a draft with this layout (or a sample when there is none), its texts editable. */
function Preview({ ws, layout, lang, texts, guide, canEdit, onText }: {
  ws: CompanyInfo; layout: InvoiceLayout; lang: InvoiceLanguage; texts: { salutation: string; intro: string; closing: string }; guide: boolean; canEdit: boolean; onText(key: 'intro' | 'closing', value: string): void;
}) {
  const load = useInvoices();
  const d = load.state === 'ready' ? load.data : undefined;
  const data = useMemo(() => {
    if (!d) return undefined;
    const latest = [...d.invoices].filter((i) => i.kind === 'invoice' && i.lines.length).sort((a, b) => Number(b.status === 'issued') - Number(a.status === 'issued') || b.date.localeCompare(a.date))[0];
    const customer = latest ? d.customers.find((c) => c.id === latest.customerId) : undefined;
    const sample: Draft = {
      id: 'sample', createdAt: '', origin: 'manual', deleted: false, status: 'draft', comments: [], kind: 'invoice',
      customerId: customer?.id ?? '', date: localToday(), currency: 'CHF', language: lang, ...(latest?.prices ? { prices: latest.prices } : {}),
      lines: latest?.lines.length ? latest.lines : [{ text: t('invoiceLayout.sampleLine'), quantity: 4, unit: 'h', price: 120, vatRate: invoiceRates()[0] }],
      intro: texts.intro, closing: texts.closing,
    };
    const ctx = contextOf(ws);
    const sheet = draftSheet({ ...ctx, settings: { ...ctx.settings!, layout } }, bookOf(d), sample, customer, layout.logo ? api.logoUrl(layout.logo) : undefined);
    const fallback = customer ? {} : { customer: { ...sheet.customer, name: t('invoiceLayout.sampleCustomer'), address: { street: t('invoiceLayout.sampleStreet'), number: '1', postcode: '8000', town: t('invoiceLayout.sampleTown'), country: 'CH' } } };
    const windowGuide = guide ? t(layout.window === 'left' ? 'invoiceLayout.windowFrameLeft' : 'invoiceLayout.windowFrameRight') : undefined;
    return { ...sheet, ...fallback, screen: screenOf(d, canEdit ? 'texts' : undefined, undefined, windowGuide) };
  }, [d, ws, layout, lang, texts.intro, texts.closing, texts.salutation, guide, canEdit]);
  if (!data) return null;
  return <Sheet data={data} editing={canEdit} className="lkprev" onEdit={(key, value, final) => { if (final && (key === 'intro' || key === 'closing')) onText(key, value); }} />;
}

/**
 * Before the first invoice: the three things an invoice needs that the layout does not hold, with
 * the likely answers filled in (the CHF bank account, a revenue account). «Rechnungen einrichten»
 * writes the invoicing block; the layout editor takes over.
 */
function InvoicingSetup({ ws, nav, canEdit, onDone }: { ws: CompanyInfo; nav: Nav; canEdit: boolean; onDone(layout: InvoiceLayout | undefined): void }) {
  const banks = banksOf(ws.bankAccounts);
  const names = getAccountMap();
  const revenue = Object.keys(names).filter((n) => n.startsWith('3')).sort();
  const first = (banks.find((a) => a.currency === 'CHF') ?? banks[0])?.account ?? '';
  const [account, setAccountOnly] = useState(first);
  const [revenueAccount, setRevenue] = useState(revenue.find((n) => n === '3400') ?? revenue[0] ?? '');
  const [days, setDays] = useState('30');
  // The IBAN the account's statements show is offered; the field asks only for one the books do not know.
  const [iban, setIban] = useState(ws.statementIbans?.[first] ?? '');
  const setAccount = (a: string) => { setAccountOnly(a); setIban(ws.statementIbans?.[a] ?? ''); };
  const [busy, setBusy] = useState(false);
  if (!banks.length) return <p className="m">{t('invoiceLayout.needsBank')}</p>;
  async function setup() {
    setBusy(true);
    try {
      const bank = banks.find((a) => a.account === account)!;
      const info = await api.patchWorkspace({ ...(bank.iban ? {} : { banks: [{ bank: bank.bank, currency: bank.currency, iban: iban.trim() }] }), invoicing: { setup: { currency: bank.currency, account, revenueAccount, paymentTermsDays: Number(days) } } });
      reloadWorkspace();
      onDone(info.invoicing?.layout);
      nav.toast(t('invoiceLayout.setupDone'));
    } catch (e) { nav.toast(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="invsetup">
      <p className="lead">{t('invoiceLayout.setupLead')}</p>
      <label>{t('invoiceLayout.payTo')}
        <select value={account} onChange={(e) => setAccount(e.target.value)} disabled={!canEdit}>
          {banks.map((a) => <option key={a.account} value={a.account}>{a.label} · {a.currency}{a.iban ? ` · ${a.iban}` : ''}</option>)}
        </select>
      </label>
      {!banks.find((a) => a.account === account)?.iban ? <label>{t('invoiceLayout.iban')}<input className="mono wide" value={iban} placeholder={t('invoiceLayout.ibanExample')} onChange={(e) => setIban(e.target.value)} disabled={!canEdit} /></label> : null}
      <label>{t('invoiceLayout.revenue')}
        <select value={revenueAccount} onChange={(e) => setRevenue(e.target.value)} disabled={!canEdit}>
          {revenue.map((n) => <option key={n} value={n}>{n} {names[n]}</option>)}
        </select>
      </label>
      <label>{t('invoiceLayout.days')}<input className="mono" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} disabled={!canEdit} /></label>
      <AsyncButton type="button" className="btn primary" disabled={!canEdit || busy || !account || !revenueAccount || !days || (!banks.find((a) => a.account === account)?.iban && !iban.trim())} onClick={() => setup()}>{t('invoiceLayout.setup')}</AsyncButton>
    </div>
  );
}
