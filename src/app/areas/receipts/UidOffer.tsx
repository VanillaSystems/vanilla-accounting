/**
 * The firm's own invoice while Firma › Firma has no UID (#452): the UID its letterhead shows,
 * offered to keep (src/intake/own-invoice.ts uidToKeep). The person decides; «Übernehmen» writes it
 * through Firma's own path, which checks it, and the toast takes it back.
 */
import { useState } from 'react';
import { api, errorText } from '../../lib/api.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import { uidToKeep } from '../../../intake/own-invoice.js';
import type { Nav } from '../index.js';
import type { Ledger, ReceiptView } from './model.js';

export function UidOffer({ v, l, nav }: { v: ReceiptView; l: Ledger; nav: Nav }) {
  const [busy, setBusy] = useState(false);
  const uid = uidToKeep(v.r, l.firm);
  if (!uid) return null;
  const keep = () => {
    setBusy(true);
    api.patchWorkspace({ company: { uid } }).then(() => {
      reloadWorkspace();
      nav.toast(t('receipts.uidOffer.kept', { uid }), () => { api.patchWorkspace({ company: { uid: '' } }).then(reloadWorkspace, (e) => nav.toast(errorText(e))); });
    }, (e) => nav.toast(errorText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="notice" data-testid="uid-offer">
      <span>{t('receipts.uidOffer.ask', { uid })}</span>
      <button type="button" className="btn" disabled={busy} onClick={keep}>{t('receipts.uidOffer.keep')}</button>
    </div>
  );
}
