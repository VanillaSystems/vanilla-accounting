/**
 * A payment whose receipt's VAT could not be read (issue #57): the app guesses no rate and asks.
 * «Neu fotografieren» opens the receipt; «So buchen wie meistens» sets the rate this business's
 * receipts showed most often as the person's VAT facts of the receipt; «Ohne Vorsteuer buchen» sets
 * no Swiss VAT. Either answer books the payment (the receipt's facts changed). Under the rate answer,
 * «Immer so?» drafts the company's rule for the business, which waits in Änderungen.
 */
import { useEffect, useState } from 'react';
import { t } from '../../i18n/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { api, errorText } from '../../lib/api.js';
import { isUnreadable, type WaitingPayment } from '../../../accounting/receipt-due.js';
import type { UnreadOffer } from '../../../saving/unread-rule.js';
import type { VatFacts } from '../../../types/index.js';
import { payText, signed } from '../bank/model.js';
import { at } from '../receipts/view.js';
import type { Nav } from '../index.js';

/** The receipt's facts as the person answered: its whole amount at `rate`, or no Swiss VAT. */
export function answeredFacts(gross: number, rate: number | undefined): VatFacts {
  if (!rate) return { hasSwissVat: false, vatSummary: [] };
  return { hasSwissVat: true, vatSummary: [{ ratePercent: rate, gross, vat: Math.round(((gross * rate) / (100 + rate)) * 100) / 100 }] };
}

export function UnreadTask({ item, nav, canEdit, onRate }: { item: WaitingPayment; nav: Nav; canEdit: boolean; onRate(offer: UnreadOffer, rate: number): void }) {
  const { tx, receipts } = item;
  const [offer, setOffer] = useState<UnreadOffer | null>(null);
  useEffect(() => {
    let live = true;
    api.unreadOffer(tx.ref).then((x) => { if (live) setOffer(x.offer); }, () => {});
    return () => { live = false; };
  }, [tx.ref]);
  const unread = receipts.filter(isUnreadable);
  const first = unread[0];
  const answer = async (rate: number | undefined) => {
    try {
      for (const r of unread) await api.patchReceipt(r.id, { vat: answeredFacts(r.amount ?? Math.abs(tx.amount), rate) });
      if (rate && offer) onRate(offer, rate);
      nav.refresh();
    } catch (e) { nav.toast(errorText(e)); }
  };
  const name = offer?.business.name ?? payText(tx).name;
  return (
    <div className="wftask" data-testid="receipt-unread">
      <b>{t('receiptUnread.title', { name, amount: `${tx.currency} ${fmt(signed(tx))}` })}</b>
      <span className="m">{formatDate(tx.date)}{first ? ` · ${first.filename}` : ''}</span>
      <p>{t('receiptUnread.lead')}</p>
      <span className="wfactions">
        {first ? <button type="button" className="btn ghost" data-testid="receipt-unread-photo" onClick={() => nav.go(at({ area: 'receipts', id: first.id }, first.date ?? tx.date))}>{t('receiptUnread.photo')}</button> : null}
        {canEdit && offer?.usual ? <button type="button" className="btn" data-testid="receipt-unread-usual" onClick={() => void answer(offer.usual)}>{t('receiptUnread.usual', { rate: String(offer.usual) })}</button> : null}
        {canEdit ? <button type="button" className="btn" data-testid="receipt-unread-none" onClick={() => void answer(undefined)}>{t('receiptDue.withoutInputTax')}</button> : null}
      </span>
    </div>
  );
}

/** «Immer so?» under the rate answer: the company's rule for the business, drafted on the click; it then waits in Änderungen. */
export function UnreadRuleOffer({ offer, rate, nav }: { offer: UnreadOffer; rate: number; nav: Nav }) {
  const [path, setPath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const draft = () => {
    setBusy(true);
    api.draftUnread(offer.ref, rate).then((r) => setPath(r.path), (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="ruledraft" data-testid="unread-rule-offer">
      <span>{path ? t('receiptUnread.drafted', { name: offer.business.name, rate: String(rate) }) : t('receiptUnread.always', { name: offer.business.name, rate: String(rate) })}</span>
      {error ? <span className="warnline">{error}</span> : null}
      <span className="ruleacts">
        {path
          ? <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'changes' }, query: {} })}>{t('receiptUnread.toChanges')}</button>
          : <button type="button" className="btn" disabled={busy} data-testid="unread-rule-draft" onClick={draft}>{t('receiptUnread.draft')}</button>}
      </span>
    </div>
  );
}
