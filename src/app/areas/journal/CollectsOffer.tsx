/**
 * «Zieht Lohnabzüge ein» on a payment out (docs/specs/payroll.md §22 decision 110): where the payee or the payment's text
 * names a deduction the year's payslips withheld and no business collects yet (a pension fund's «Pensionskasse»), one click
 * writes `collects:` into the company's file of that business (src/payroll/collects-way.ts), so the hand form proposes the
 * employees' share on the deductions account and a payment booked whole is named under «Arbeitnehmeranteil abziehen».
 * «Rückgängig» puts the file back. Nothing is written to the books.
 */
import { useEffect, useState } from 'react';
import { api, errorText } from '../../lib/api.js';
import { isKey, t } from '../../i18n/index.js';
import { setup } from '../../../engines/index.js';
import type { Nav } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';

type Offer = NonNullable<Awaited<ReturnType<typeof api.collectsOffer>>['offer']>;

/** A deduction kind in the person's words: the app's name for it, else the first word the payslips name it by. */
export function collectsKindLabel(kind: string): string {
  const key = `journal.byHand.collects.kind.${kind}`;
  return isKey(key) ? t(key as 'journal.byHand.collects.kind.pension') : setup().wages?.withholds?.[kind]?.[0] ?? kind;
}

export function CollectsOffer({ payment, nav }: { payment: string; nav: Pick<Nav, 'toast' | 'refresh'> }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [kept, setKept] = useState<{ name: string; path: string; kinds: string[]; undo: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.collectsOffer(payment).then((r) => { if (live) setOffer(r.offer); }, () => { if (live) setOffer(null); });
    return () => { live = false; };
  }, [payment]);
  const keep = async (kinds: string[]) => {
    try {
      const r = await api.keepCollects(payment, kinds);
      setKept({ name: r.name, path: r.path, kinds: r.kinds, undo: r.undo });
      nav.toast(t('journal.byHand.collects.kept', { name: r.name, kinds: r.kinds.map(collectsKindLabel).join(', '), path: r.path }));
    } catch (e) { nav.toast(errorText(e)); }
    nav.refresh();
  };
  const undo = async () => {
    if (!kept) return;
    try { await api.undoCollects(kept.undo); setKept(null); nav.toast(t('journal.byHand.collects.undone', { name: kept.name })); } catch (e) { nav.toast(errorText(e)); }
    nav.refresh();
  };
  if (kept) {
    return (
      <p className="collectsway m" data-testid="collects-kept">
        {t('journal.byHand.collects.keptNote', { name: kept.name, kinds: kept.kinds.map(collectsKindLabel).join(', '), path: kept.path })}{' '}
        <AsyncButton type="button" className="golink" data-testid="collects-undo" onClick={undo}>{t('journal.byHand.collects.undo')}</AsyncButton>
      </p>
    );
  }
  if (!offer) return null;
  return (
    <div className="collectsway" data-testid="collects-offer" data-business={offer.business}>
      <span>{t('journal.byHand.collects.ask', { name: offer.name })}</span>
      {offer.kinds.map((k) => (
        <AsyncButton key={k} type="button" className="btn" data-kind={k} onClick={() => keep([k])}>{t('journal.byHand.collects.yes', { kind: collectsKindLabel(k) })}</AsyncButton>
      ))}
      <small className="m">{t(offer.created ? 'journal.byHand.collects.whereNew' : 'journal.byHand.collects.where', { path: offer.path })}</small>
    </div>
  );
}
