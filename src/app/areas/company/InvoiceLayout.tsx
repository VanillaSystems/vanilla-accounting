/**
 * Firma › Rechnungslayout: the font, colour, logo, envelope window and elements every draft is
 * laid out with, and the texts above and below the table per language, written on a sample
 * sheet. Saved in belege.workspace.yaml's invoicing block; an issued invoice keeps the layout it
 * was issued with.
 */
import { useMemo, useState } from 'react';
import { INVOICE_FONTS, LAYOUT_ELEMENTS, type Draft, type InvoiceLanguage, type InvoiceLayout, type LayoutElement, type OWN_TEXTS } from '../../../invoices/model.js';
import { draftSheet } from '../../../invoices/documents.js';
import { builtInTexts } from '../../../invoices/texts.js';
import type { CompanyInfo } from '../../../books/company.js';
import type { InvoicingPatch } from '../../../workspace/manifest-write.js';
import { api, errorText } from '../../lib/api.js';
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
  const setLayout = <K extends keyof InvoiceLayout>(key: K, value: InvoiceLayout[K]) => void patch({ layout: { [key]: value } }, { ...layout, [key]: value });
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
    void patch({ texts: { [lang]: { salutation: null, intro: null, closing: null, mailSubject: null, mailBody: null } } });
    nav.toast(t('invoiceLayout.textsReset'), () => { void patch({ texts: { [lang]: was } }); });
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
                <button key={c} type="button" className={`swc${layout.accent === c ? ' on' : ''}`} style={{ ['--c' as string]: c }} disabled={!canEdit}
                  title={name} aria-label={name} aria-pressed={layout.accent === c} onClick={() => setLayout('accent', c)} />
              ))}
            </span>
          </div>
          <div className="lkr"><span>{t('invoiceLayout.logo')}</span>
            <span className="lklogo">
              {layout.logo ? <img src={api.logoUrl(layout.logo)} alt="" /> : <span className="m">{t('invoiceLayout.wordmark')}</span>}
              {canEdit && <label className="quiet2">{t('invoiceLayout.upload')}<input type="file" accept="image/png,image/svg+xml,image/jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label>}
              {canEdit && layout.logo && <button type="button" className="quiet2" onClick={() => { const { logo: _, ...rest } = layout; void patch({ layout: { logo: null } }, rest); }}>{t('invoiceLayout.removeLogo')}</button>}
            </span>
          </div>
          <div className="lkr"><span>{t('invoiceLayout.place')}</span>{seg(layout.logoPosition, [['left', t('invoiceLayout.left')], ['center', t('invoiceLayout.center')], ['right', t('invoiceLayout.right')]], (v) => setLayout('logoPosition', v), t('invoiceLayout.place'))}</div>
          <div className="lkr"><span>{t('invoiceLayout.size')}</span>{seg(layout.logoSize, [['s', 'S'], ['m', 'M'], ['l', 'L']], (v) => setLayout('logoSize', v), t('invoiceLayout.size'))}</div>
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
        <p className="m ivhint">{t('invoiceLayout.daysHint', { days: DAYS })}{changed > 0 && <> · {t('invoiceLayout.nChanged', { n: changed })}{canEdit && <> · <button type="button" className="quiet2" onClick={resetTexts}>{t('invoiceLayout.reset')}</button></>}</>}</p>
      </div>
    </div>
  );
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
      customerId: customer?.id ?? '', date: localToday(), currency: 'CHF', language: lang,
      lines: latest?.lines.length ? latest.lines : [{ text: t('invoiceLayout.sampleLine'), quantity: 4, unit: 'h', price: 120, vatRate: 8.1 }],
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
  const banks = ws.bankAccounts.filter((a) => a.bank !== 'manual');
  const names = getAccountMap();
  const revenue = Object.keys(names).filter((n) => n.startsWith('3')).sort();
  const [account, setAccount] = useState((banks.find((a) => a.currency === 'CHF') ?? banks[0])?.account ?? '');
  const [revenueAccount, setRevenue] = useState(revenue.find((n) => n === '3400') ?? revenue[0] ?? '');
  const [days, setDays] = useState('30');
  const [iban, setIban] = useState('');
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
      <button type="button" className="btn primary" disabled={!canEdit || busy || !account || !revenueAccount || !days || (!banks.find((a) => a.account === account)?.iban && !iban.trim())} onClick={() => void setup()}>{t('invoiceLayout.setup')}</button>
    </div>
  );
}
