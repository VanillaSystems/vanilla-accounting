/**
 * Firma › Rechnungslayout: the font, colour, logo, envelope window and elements every draft is
 * laid out with, and the texts above and below the table per language, written on a sample
 * sheet. Saved in belege.workspace.yaml's invoicing block; an issued invoice keeps the layout it
 * was issued with.
 */
import { useMemo, useState } from 'react';
import { INVOICE_FONTS, LAYOUT_ELEMENTS, type Draft, type InvoiceLanguage, type InvoiceLayout, type LayoutElement } from '../../../invoices/model.js';
import { draftSheet } from '../../../invoices/documents.js';
import { TEXTS } from '../../../invoices/texts.js';
import type { CompanyInfo } from '../../../books/company.js';
import type { InvoicingPatch } from '../../../workspace/manifest-write.js';
import { api, errorText } from '../../lib/api.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import { localToday } from '../../../accounting/periods.js';
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
/** The app's own texts of a language, the payment term left as {days}. */
const builtIn = (lang: InvoiceLanguage) => ({ intro: TEXTS[lang].intro, closing: TEXTS[lang].closing(9999).replace('9999', DAYS) });

export function InvoiceLayoutSection({ ws, nav, canEdit }: { ws: CompanyInfo; nav: Nav; canEdit: boolean }) {
  const settings = ws.invoicing;
  const [lang, setLang] = useState<InvoiceLanguage>('de');
  const [guide, setGuide] = usePersistedFlag('invoices.windowGuide', true);
  const [local, setLocal] = useState<InvoiceLayout | undefined>(settings?.layout);
  const load = useInvoices();
  if (!settings || !local) return <p className="m">{t('invoiceLayout.noInvoicing')}</p>;
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
  const texts = { ...builtIn(lang), ...own };
  const changed = Object.keys(own).length;
  function saveText(key: 'intro' | 'closing', value: string) {
    if (value === texts[key]) return;
    void patch({ texts: { [lang]: { [key]: value === builtIn(lang)[key] ? null : value } } });
  }
  function resetTexts() {
    const was = { ...own };
    void patch({ texts: { [lang]: { intro: null, closing: null } } });
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
  ws: CompanyInfo; layout: InvoiceLayout; lang: InvoiceLanguage; texts: { intro: string; closing: string }; guide: boolean; canEdit: boolean; onText(key: 'intro' | 'closing', value: string): void;
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
  }, [d, ws, layout, lang, texts.intro, texts.closing, guide, canEdit]);
  if (!data) return null;
  return <Sheet data={data} editing={canEdit} className="lkprev" onEdit={(key, value, final) => { if (final && (key === 'intro' || key === 'closing')) onText(key, value); }} />;
}
