/**
 * Firma › Rechnungslayout › Nummern (docs/specs/invoicing.md 4.4.4): the number format of each kind,
 * with the next number it would give. A change applies from the next number; issued numbers never
 * change. Kinds with the same format count together (today's series of invoices and credit notes).
 */
import { useState } from 'react';
import { DOCUMENT_KINDS, type DocumentKind, type Invoice } from '../../../invoices/model.js';
import { DEFAULT_NUMBERING, nextNumberFor, type FormatRefusal, type NumberFormat, type Numbering } from '../../../invoices/numbering.js';
import type { CompanyInfo } from '../../../books/company.js';
import { localToday } from '../../../accounting/periods.js';
import { api, errorText, numberFormatText } from '../../lib/api.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';

/** `fits`: why a kind's format cannot be taken, the payment references of the jurisdiction included. */
export function NumberingSection({ ws, nav, canEdit, docs, fits }: { ws: CompanyInfo; nav: Nav; canEdit: boolean; docs: readonly Invoice[]; fits(kind: DocumentKind, nf: NumberFormat): FormatRefusal | undefined }) {
  const saved: Numbering = ws.invoicing?.numbering ?? DEFAULT_NUMBERING;
  const [edit, setEdit] = useState<Partial<Record<DocumentKind, NumberFormat>>>({});
  const now: Numbering = { ...saved, ...edit };
  const today = localToday();
  const changed = (Object.keys(edit) as DocumentKind[]).filter((k) => edit[k]!.format !== saved[k].format || edit[k]!.restartYearly !== saved[k].restartYearly);
  async function save() {
    try {
      await api.patchWorkspace({ invoicing: { numbering: Object.fromEntries(changed.map((k) => [k, now[k]])) } });
      reloadWorkspace();
      setEdit({});
      nav.toast(t('invoiceLayout.numbersSaved'));
    } catch (e) { nav.toast(errorText(e)); }
  }
  return (
    <div className="lkf lknumbers" data-testid="numbering">
      <div className="lkr"><span>{t('invoiceLayout.numbersTitle')}</span><span className="m">{t('invoiceLayout.numbersHint')}</span></div>
      <div className="lknumrows">
        {DOCUMENT_KINDS.map((k) => {
          const bad = fits(k, now[k]);
          const shared = DOCUMENT_KINDS.filter((o) => o !== k && now[o].format === now[k].format);
          return (
            <div key={k} className="lknum" data-kind={k}>
              <span className="lknk">{t(`invoices.docKind.${k}`)}</span>
              <input className="mono" aria-label={t('invoiceLayout.numbersFormatOf', { kind: t(`invoices.docKind.${k}`) })} value={now[k].format} disabled={!canEdit} aria-invalid={!!bad}
                onChange={(e) => setEdit({ ...edit, [k]: { ...now[k], format: e.target.value } })} />
              <label className="lknr"><input type="checkbox" checked={now[k].restartYearly} disabled={!canEdit} onChange={(e) => setEdit({ ...edit, [k]: { ...now[k], restartYearly: e.target.checked } })} /> {t('invoiceLayout.numbersRestart')}</label>
              <span className="lknext" data-testid={`next-${k}`}>
                {bad ? <span className="warn">{numberFormatText(bad, k, now[k].format)}</span>
                  : <>{t('invoiceLayout.numbersNext')} <b className="mono">{nextNumberFor(docs, k, today, now)}</b>{shared.length > 0 && <> · {t('invoiceLayout.numbersShared', { kinds: shared.map((o) => t(`invoices.docKind.${o}`)).join(', ') })}</>}</>}
              </span>
            </div>
          );
        })}
      </div>
      <p className="m ivhint">{t('invoiceLayout.numbersTokens', { year: '{JJJJ}', counter: '{NNNNN}' })}</p>
      {canEdit && changed.length > 0 && (
        <div className="lkuadd">
          <AsyncButton type="button" className="btn primary" data-act="numbers-save" onClick={save}>{t('invoiceLayout.numbersSave')}</AsyncButton>
          <button type="button" className="quiet2" onClick={() => setEdit({})}>{t('common.cancel')}</button>
        </div>
      )}
    </div>
  );
}
