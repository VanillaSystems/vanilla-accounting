/**
 * Firma › Rechnungslayout › Zahlungskonditionen (spec 4.4.6): the firm's named payment terms (days,
 * an optional Skonto in percent within fewer days, the text the paper prints), one of them the
 * default a new invoice takes. Saved as the whole list in belege.workspace.yaml (invoicing.paymentTerms);
 * an issued invoice keeps the terms it printed, so a term may change or go any time.
 */
import { useState } from 'react';
import type { PaymentTerms } from '../../../invoices/model.js';
import type { CompanyInfo } from '../../../books/company.js';
import { api, errorText } from '../../lib/api.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';

const num = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));

export function PaymentTermsSection({ ws, nav, canEdit }: { ws: CompanyInfo; nav: Nav; canEdit: boolean }) {
  const terms = ws.invoicing?.paymentTerms ?? [];
  const def = ws.invoicing?.defaultTerms ?? terms[0]?.id;
  const empty = { name: '', days: '30', percent: '', skDays: '', text: '' };
  const [draft, setDraft] = useState(empty);
  async function save(next: PaymentTerms[], defaultTerms: string | null, done: string): Promise<boolean> {
    try {
      await api.patchWorkspace({ invoicing: { paymentTerms: next, defaultTerms } });
      reloadWorkspace();
      nav.toast(done);
      return true;
    } catch (e) { nav.toast(errorText(e)); return false; }
  }
  const days = num(draft.days), percent = num(draft.percent), skDays = num(draft.skDays);
  const ok = !!draft.name.trim() && Number.isInteger(days) && (percent === undefined) === (skDays === undefined);
  async function add() {
    if (!ok) return;
    const term = { id: '', name: draft.name.trim(), days: days!, ...(percent !== undefined ? { skonto: { percent, days: skDays! } } : {}), ...(draft.text.trim() ? { text: draft.text.trim() } : {}) };
    if (await save([...terms, term], def ?? null, t('invoiceLayout.termsAdded', { name: term.name }))) setDraft(empty);
  }
  return (
    <div className="lkf lkunits" data-testid="payment-terms">
      <div className="lkr"><span>{t('invoiceLayout.termsTitle')}</span><span className="m">{t('invoiceLayout.termsHint')}</span></div>
      <table className="lkut">
        <thead><tr><th>{t('invoiceLayout.termsDefault')}</th><th>{t('invoiceLayout.termsName')}</th><th>{t('invoiceLayout.termsDays')}</th><th>{t('invoiceLayout.termsSkonto')}</th><th /></tr></thead>
        <tbody>
          {terms.map((x) => (
            <tr key={x.id} data-terms={x.id}>
              <td><input type="radio" name="defaultTerms" checked={x.id === def} disabled={!canEdit} aria-label={t('invoiceLayout.termsMakeDefault', { name: x.name })} onChange={() => void save(terms, x.id, t('invoiceLayout.termsDefaultSet', { name: x.name }))} /></td>
              <td>{x.name}{x.text && x.text !== x.name ? <small className="m"> · {x.text}</small> : null}</td>
              <td className="mono">{x.days}</td>
              <td className="mono">{x.skonto ? t('invoiceLayout.termsSkontoOf', { percent: x.skonto.percent, days: x.skonto.days }) : '–'}</td>
              <td>{canEdit && terms.length > 1 && (
                <AsyncButton type="button" className="quiet2" aria-label={t('invoiceLayout.termsRemove', { name: x.name })}
                  onClick={() => { const rest = terms.filter((y) => y.id !== x.id); return save(rest, x.id === def ? rest[0].id : def ?? null, t('invoiceLayout.termsRemoved', { name: x.name })); }}>×</AsyncButton>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && (
        <div className="lkuadd lkterms">
          <input value={draft.name} aria-label={t('invoiceLayout.termsName')} placeholder={t('invoiceLayout.termsNameEx')} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="mono" inputMode="numeric" value={draft.days} aria-label={t('invoiceLayout.termsDays')} onChange={(e) => setDraft({ ...draft, days: e.target.value })} />
          <input className="mono" inputMode="decimal" value={draft.percent} aria-label={t('invoiceLayout.termsPercent')} placeholder={t('invoiceLayout.termsPercent')} onChange={(e) => setDraft({ ...draft, percent: e.target.value })} />
          <input className="mono" inputMode="numeric" value={draft.skDays} aria-label={t('invoiceLayout.termsSkDays')} placeholder={t('invoiceLayout.termsSkDays')} onChange={(e) => setDraft({ ...draft, skDays: e.target.value })} />
          <input value={draft.text} aria-label={t('invoiceLayout.termsText')} placeholder={t('invoiceLayout.termsText')} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <AsyncButton type="button" className="btn" disabled={!ok} onClick={add}>{t('invoiceLayout.termsAdd')}</AsyncButton>
        </div>
      )}
    </div>
  );
}
