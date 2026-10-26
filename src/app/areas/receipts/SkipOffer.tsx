/**
 * «Immer so?» under a person's «kein Beleg» on a file a mailbox brought (#186): the sender, skipped
 * from now on in that mailbox's settings in the workspace. The click first shows the card: what the
 * mailbox brought from the sender, and which of those the books hold as receipts. «Behalten» keeps
 * it (POST /api/sources/:id/skip); nothing that came already changes.
 */
import { useEffect, useState } from 'react';
import { api, errorText } from '../../lib/api.js';
import { language, t } from '../../i18n/index.js';
import type { ReceiptSkipOffer } from '../../../platform/sources/model.js';
import { textIn } from '../../../workflows/model.js';
import type { Nav } from '../index.js';

export function SkipOffer({ receipt, nav }: { receipt: string; nav: Nav }) {
  const [offer, setOffer] = useState<ReceiptSkipOffer | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setOffer(null);
    setOpen(false);
    api.receiptSkipOffer(receipt).then((x) => { if (live) setOffer(x.offer); }, () => {});
    return () => { live = false; };
  }, [receipt]);
  if (!offer) return null;
  const keep = () => {
    setBusy(true);
    api.skipSender(offer.source, offer.sender, offer.version).then(() => {
      nav.toast(t('receipts.skip.done', { sender: offer.sender }));
      setOffer(null);
    }, (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  if (!open) {
    return (
      <div className="skipask" data-testid="skip-offer">
        <span>{t('receipts.skip.ask', { sender: offer.sender })}</span>
        <button type="button" className="btn" data-testid="skip-offer-show" onClick={() => setOpen(true)}>{t('receipts.skip.show')}</button>
      </div>
    );
  }
  const files = offer.receipts.map((r) => r.filename).join(', ');
  return (
    <div className="skipcard" data-testid="skip-card">
      <b>{t('receipts.skip.title', { source: textIn(offer.label, language()), sender: offer.sender })}</b>
      <span>{t('receipts.skip.delivered', { n: offer.delivered })}</span>
      {offer.receipts.length
        ? <span className="warnline" data-testid="skip-taken">{t('receipts.skip.taken', { n: offer.receipts.length, files })}</span>
        : <span className="m">{t('receipts.skip.noneTaken')}</span>}
      <span className="m">{t('receipts.skip.stays')}</span>
      {error ? <span className="warnline">{error}</span> : null}
      <span className="skipacts">
        <button type="button" className="btn primary" disabled={busy} data-testid="skip-keep" onClick={keep}>{t('receipts.skip.keep')}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
      </span>
    </div>
  );
}
