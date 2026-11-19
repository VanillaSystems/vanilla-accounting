/**
 * Firma › Rechnungslayout › Zahlungskonditionen (spec 4.4.6): the firm's named payment terms (days,
 * an optional Skonto in percent within fewer days, the text the paper prints), one of them the
 * default a new invoice takes. The list is a dated history (spec 4.12): a change holds from its «gilt ab»
 * (today unless she names a day), the table shows the list of that day, and a day before issued
 * Rechnungen whose printed terms now read otherwise shows the card first. An issued invoice keeps the
 * terms it printed.
 */
import { allTerms, invoicingOnDay } from '../../../invoices/dated-values.js';
import { localToday } from '../../../accounting/periods.js';
import { DatedTrail, useDatedChange } from '../invoices/DatedValue.js';
import { useState } from 'react';
import type { PaymentTerms } from '../../../invoices/model.js';
import type { CompanyInfo } from '../../../books/company.js';
import { api, errorText } from '../../lib/api.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';

const num = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));

/** A new term's id: its name as a slug, made unique among every term the history names. */
function newId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'terms';
  let id = base;
  for (let k = 2; taken.includes(id); k++) id = `${base}-${k}`;
  return id;
}

export function PaymentTermsSection({ ws, nav, canEdit }: { ws: CompanyInfo; nav: Nav; canEdit: boolean }) {
  const today = localToday();
  const [from, setFrom] = useState(today);
  const terms = invoicingOnDay(ws.invoicing, from)?.paymentTerms ?? [];
  const def = ws.invoicing?.defaultTerms ?? terms[0]?.id;
  const empty = { name: '', days: '30', percent: '', skDays: '', text: '' };
  const [draft, setDraft] = useState(empty);
  const change = useDatedChange(nav);
  /** The list from `from` on; the default (not dated: which terms a new document takes) beside it. */
  async function save(next: PaymentTerms[], defaultTerms: string | null, done: string): Promise<boolean> {
    try {
      if (defaultTerms !== (ws.invoicing?.defaultTerms ?? null) && next.some((x) => x.id === defaultTerms)) await api.patchWorkspace({ invoicing: { defaultTerms } });
      if (next === terms) { reloadWorkspace(); nav.toast(done); return true; }
      return await change.send({ path: 'invoicing/paymentTerms', value: next, validFrom: from });
    } catch (e) { nav.toast(errorText(e)); return false; }
  }
  const days = num(draft.days), percent = num(draft.percent), skDays = num(draft.skDays);
  const ok = !!draft.name.trim() && Number.isInteger(days) && (percent === undefined) === (skDays === undefined);
  async function add() {
    if (!ok) return;
    const term = { id: newId(draft.name.trim(), allTerms(ws.invoicing).map((x) => x.id)), name: draft.name.trim(), days: days!, ...(percent !== undefined ? { skonto: { percent, days: skDays! } } : {}), ...(draft.text.trim() ? { text: draft.text.trim() } : {}) };
    if (await save([...terms, term], def ?? null, t('invoiceLayout.termsAdded', { name: term.name }))) setDraft(empty);
  }
  return (
    <div className="lkf lkunits" data-testid="payment-terms">
      <div className="lkr"><span>{t('invoiceLayout.termsTitle')}</span><span className="m">{t('invoiceLayout.termsHint')}</span></div>
      <label className="lkr"><span>{t('dated.validFrom')}</span>
        <input type="date" data-testid="terms-valid-from" value={from} disabled={!canEdit} onChange={(e) => setFrom(e.target.value || today)} />
      </label>
      <DatedTrail history={ws.invoicing?.paymentTerms} today={today} show={(list) => list.map((x) => x.name).join(', ')} />
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
      {change.node}
    </div>
  );
}
