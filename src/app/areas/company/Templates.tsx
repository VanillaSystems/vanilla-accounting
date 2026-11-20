/**
 * Firma › Rechnungslayout › Vorlagen (docs/specs/invoicing.md 4.4.11): the firm's named Vorlagen as a
 * list, one picked to edit with the layout editor beside it; per Vorlage its name, the kinds it is
 * the default of, a letterhead PDF printed under every sheet, a fixed attachment (the firm's terms)
 * that goes with every document of its kinds, and its texts per kind and language with placeholders.
 * Saved in belege.workspace.yaml (invoicing.templates, invoicing.templateFor); an issued document
 * keeps what it was issued with.
 */
import { useState } from 'react';
import { DOCUMENT_KINDS, TEMPLATE_TEXTS, type DocumentKind, type InvoiceLanguage, type InvoiceTemplate, type TemplateTextKey } from '../../../invoices/model.js';
import type { CompanyInfo } from '../../../books/company.js';
import type { InvoicingPatch } from '../../../workspace/manifest-write.js';
import { api, errorText } from '../../lib/api.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { PLACEHOLDERS } from '../../../invoices/templates.js';

/** A Vorlage's id from its name: letters and digits, unique in the list. */
export function templateId(name: string, list: readonly InvoiceTemplate[]): string {
  const base = name.normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 24) || 'vorlage';
  let id = base;
  for (let n = 2; list.some((x) => x.id === id); n++) id = `${base}-${n}`;
  return id;
}

async function save(nav: Nav, change: InvoicingPatch, done?: string): Promise<boolean> {
  try {
    await api.patchWorkspace({ invoicing: change });
    reloadWorkspace();
    if (done) nav.toast(done);
    return true;
  } catch (e) { nav.toast(errorText(e)); return false; }
}

/** The list of Vorlagen: one chip each, the picked one edited; «＋ Neue Vorlage» copies the picked one's layout. */
export function TemplateBar({ ws, nav, canEdit, picked, onPick }: { ws: CompanyInfo; nav: Nav; canEdit: boolean; picked: InvoiceTemplate; onPick(id: string): void }) {
  const list = ws.invoicing?.templates ?? [];
  const [name, setName] = useState<string | null>(null);
  async function add() {
    const n = name?.trim();
    if (!n) return;
    const id = templateId(n, list);
    if (await save(nav, { templates: { add: { id, name: n, from: picked.id } } }, t('templates.added', { name: n }))) { setName(null); onPick(id); }
  }
  return (
    <div className="lkf lktpl" data-testid="templates">
      <div className="lkr lkstack"><span>{t('templates.title')}</span><span className="m">{t('templates.hint')}</span></div>
      <div className="tplchips" role="radiogroup" aria-label={t('templates.title')}>
        {list.map((x) => (
          <button key={x.id} type="button" role="radio" data-template={x.id} aria-checked={x.id === picked.id} className={`tplchip${x.id === picked.id ? ' on' : ''}`} onClick={() => onPick(x.id)}>
            {x.name}
            <small className="m">{kindsOf(ws, x).map((k) => t(`invoices.docKind.${k}`)).join(', ')}</small>
          </button>
        ))}
        {canEdit && (name === null
          ? <button type="button" className="tplchip add" data-act="template-add" onClick={() => setName('')}>＋ {t('templates.add')}</button>
          : (
            <span className="tpladd">
              <input autoFocus value={name} aria-label={t('templates.name')} placeholder={t('templates.nameEx')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); if (e.key === 'Escape') setName(null); }} />
              <AsyncButton type="button" className="btn" disabled={!name.trim()} onClick={add}>{t('templates.addOk')}</AsyncButton>
              <button type="button" className="quiet2" onClick={() => setName(null)}>{t('common.cancel')}</button>
            </span>
          ))}
      </div>
      <TemplateFacts ws={ws} nav={nav} canEdit={canEdit} tpl={picked} onRemoved={() => onPick(list.find((x) => x.id !== picked.id)?.id ?? '')} />
    </div>
  );
}

/** The kinds a Vorlage is the default of: those `templateFor` names, the first Vorlage the rest. */
export function kindsOf(ws: CompanyInfo, tpl: InvoiceTemplate): DocumentKind[] {
  const list = ws.invoicing?.templates ?? [];
  const map = ws.invoicing?.templateFor ?? {};
  return DOCUMENT_KINDS.filter((k) => (map[k] ?? list[0]?.id) === tpl.id);
}

function TemplateFacts({ ws, nav, canEdit, tpl, onRemoved }: { ws: CompanyInfo; nav: Nav; canEdit: boolean; tpl: InvoiceTemplate; onRemoved(): void }) {
  const list = ws.invoicing?.templates ?? [];
  const first = list[0]?.id === tpl.id;
  const kinds = kindsOf(ws, tpl);
  async function upload(file: File, then: (a: { name: string; file: string }) => InvoicingPatch, done: string) {
    if (file.type !== 'application/pdf') { nav.toast(t('templates.pdfOnly', { name: file.name })); return; }
    try {
      const a = await api.uploadInvoiceFile(file, file.name);
      await save(nav, then(a), done);
    } catch (e) { nav.toast(errorText(e)); }
  }
  const pdfInput = (label: string, onFile: (f: File) => void) => canEdit && (
    <label className="quiet2">{label}<input type="file" accept="application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} /></label>
  );
  return (
    <>
      <label className="lkr"><span>{t('templates.name')}</span>
        <input key={tpl.id} name="templateName" defaultValue={tpl.name} disabled={!canEdit} onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== tpl.name) void save(nav, { templates: { rename: { id: tpl.id, name: n } } }, t('templates.renamed', { name: n })); }} />
      </label>
      <div className="lkr top"><span>{t('templates.defaultFor')}</span>
        <span className="lkel">
          {DOCUMENT_KINDS.map((k) => (
            <label key={k}><input type="checkbox" data-kind={k} checked={kinds.includes(k)} disabled={!canEdit || (first && kinds.includes(k))}
              onChange={(e) => void save(nav, { templateFor: { [k]: e.target.checked ? tpl.id : null } }, e.target.checked ? t('templates.defaultSet', { name: tpl.name, kind: t(`invoices.docKind.${k}`) }) : undefined)} /> {t(`invoices.docKind.${k}`)}</label>
          ))}
          {first && <span className="sub">{t('templates.firstTakesRest')}</span>}
        </span>
      </div>
      <div className="lkr"><span>{t('templates.letterhead')}</span>
        <span className="lklogo">
          {tpl.letterhead ? <a className="golink" href={api.invoiceFileUrl(tpl.letterhead)} target="_blank" rel="noreferrer" data-testid="letterhead">{tpl.letterhead.split('/').pop()?.slice(13)}</a> : <span className="m">{t('templates.noLetterhead')}</span>}
          {pdfInput(t('templates.upload'), (f) => void upload(f, (a) => ({ templates: { letterhead: { id: tpl.id, file: a.file } } }), t('templates.letterheadSet', { name: f.name })))}
          {canEdit && tpl.letterhead && <AsyncButton type="button" className="quiet2" onClick={() => save(nav, { templates: { letterhead: { id: tpl.id, file: null } } })}>{t('templates.remove')}</AsyncButton>}
        </span>
      </div>
      {tpl.letterhead && <div className="lkr"><span /><span className="m">{t('templates.letterheadHint')}</span></div>}
      <div className="lkr"><span>{t('templates.attachment')}</span>
        <span className="lklogo">
          {tpl.attachment ? <a className="golink" href={api.invoiceFileUrl(tpl.attachment.file)} target="_blank" rel="noreferrer" data-testid="fixed-attachment">{tpl.attachment.name}</a> : <span className="m">{t('templates.noAttachment')}</span>}
          {pdfInput(t('templates.upload'), (f) => void upload(f, (a) => ({ templates: { attachment: { id: tpl.id, value: { name: a.name, file: a.file, kinds: tpl.attachment?.kinds ?? ['invoice'] } } } }), t('templates.attachmentSet', { name: f.name })))}
          {canEdit && tpl.attachment && <AsyncButton type="button" className="quiet2" onClick={() => save(nav, { templates: { attachment: { id: tpl.id, value: null } } })}>{t('templates.remove')}</AsyncButton>}
        </span>
      </div>
      {tpl.attachment && (
        <div className="lkr top"><span>{t('templates.attachmentWith')}</span>
          <span className="lkel">
            {DOCUMENT_KINDS.map((k) => {
              const on = !tpl.attachment!.kinds || tpl.attachment!.kinds.includes(k);
              const next = (checked: boolean) => DOCUMENT_KINDS.filter((x) => (x === k ? checked : !tpl.attachment!.kinds || tpl.attachment!.kinds.includes(x)));
              return <label key={k}><input type="checkbox" data-attach-kind={k} checked={on} disabled={!canEdit} onChange={(e) => { const ks = next(e.target.checked); if (ks.length) void save(nav, { templates: { attachment: { id: tpl.id, value: { ...tpl.attachment!, kinds: ks } } } }); }} /> {t(`invoices.docKind.${k}`)}</label>;
            })}
          </span>
        </div>
      )}
      {canEdit && list.length > 1 && (
        <p className="lkfoot"><AsyncButton type="button" className="quiet2" data-act="template-remove" onClick={async () => { if (await save(nav, { templates: { remove: tpl.id } }, t('templates.removed', { name: tpl.name }))) onRemoved(); }}>{t('templates.removeTemplate', { name: tpl.name })}</AsyncButton></p>
      )}
    </>
  );
}

/** The Vorlage's texts for one kind in the page's language; an empty field takes the firm's or the app's text again. */
export function TemplateTexts({ nav, canEdit, tpl, lang }: { nav: Nav; canEdit: boolean; tpl: InvoiceTemplate; lang: InvoiceLanguage }) {
  const [kind, setKind] = useState<DocumentKind>('invoice');
  const own = tpl.texts?.[kind]?.[lang] ?? {};
  const set = (key: TemplateTextKey, value: string) => {
    if (value === (own[key] ?? '')) return;
    void save(nav, { template: tpl.id, templateTexts: { [kind]: { [lang]: { [key]: value.trim() ? value : null } } } }, t('templates.textSaved'));
  };
  return (
    <div className="lkf lkmail" key={`${tpl.id}-${kind}-${lang}`} data-testid="template-texts">
      <div className="lkr lkstack"><span>{t('templates.texts', { name: tpl.name })}</span><span className="m">{t('templates.textsHint', { list: PLACEHOLDERS.filter((p) => p !== 'days').map((p) => `{${p}}`).join(' ') })}</span></div>
      <label className="lkr"><span>{t('templates.kind')}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>{DOCUMENT_KINDS.map((k) => <option key={k} value={k}>{t(`invoices.docKind.${k}`)}</option>)}</select>
      </label>
      {TEMPLATE_TEXTS.map((key) => {
        const long = key === 'intro' || key === 'closing' || key === 'mailBody';
        const props = { name: `tpl-${key}`, defaultValue: own[key] ?? '', placeholder: t('templates.fallback'), disabled: !canEdit, onBlur: (e: { target: { value: string } }) => set(key, e.target.value) };
        return <label key={key} className={`lkr${long ? ' top' : ''}`}><span>{t(`templates.text.${key}`)}</span>{long ? <textarea rows={key === 'mailBody' ? 5 : 3} {...props} /> : <input {...props} />}</label>;
      })}
    </div>
  );
}
