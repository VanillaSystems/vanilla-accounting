/**
 * «Ins Wissen übernehmen?» under a booking a person corrected that no rule made (issue #40): a quiet
 * line with two ways. «Vorschlag der KI» asks the model for a rule or a note sentence, which code
 * checks (src/saving/learn-rule.ts): a rule is shown on its card (RuleDraft) to keep or discard, a
 * sentence waits for «In die Notizen». «Selbst schreiben» opens the form of Firma › Regeln started
 * from this payment. Nothing is kept without the person's click; nothing asks twice.
 */
import { useEffect, useState } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import type { LearnOffer as Offer, LearnProposal } from '../../../saving/learn-rule.js';
import type { Nav } from '../index.js';
import { onBooksChanged } from '../../assistant/store.js';
import { RuleDraft } from './RulesSection.js';

type NoteState = 'open' | 'kept' | 'discarded';

export function LearnOffer({ payment, nav }: { payment: string; nav: Nav }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [proposal, setProposal] = useState<LearnProposal>();
  const [note, setNote] = useState<NoteState>('open');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = () => { api.learnOffer(payment).then((x) => { if (live) setOffer(x.offer); }, () => { if (live) setOffer(null); }); };
    load();
    const off = onBooksChanged(load);
    return () => { live = false; off(); };
  }, [payment]);
  const toRules = () => nav.go({ route: { area: 'company', section: 'rules' }, query: {} });
  if (proposal?.kind === 'rule') return <RuleDraft path={proposal.path} nav={nav} onRules={toRules} title={t('rules.correction.title')} />;
  if (!offer) return null;
  const who = offer.partner.kind === 'business' ? offer.partner.name : t('rules.share.payer', { payer: offer.partner.name });
  const propose = () => {
    setBusy(true);
    setError(undefined);
    api.proposeLearned(offer.ref).then(setProposal, (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  const keepNote = async (p: Extract<LearnProposal, { kind: 'note' }>) => {
    setBusy(true);
    setError(undefined);
    try {
      const page = await api.partner(p.partner);
      const text = page.note?.text.trim() ? `${page.note.text.trimEnd()}\n\n${p.sentence}\n` : `${p.sentence}\n`;
      await api.saveNote({ kind: 'save', ref: { kind: 'partner', id: p.partner }, text, basis: page.note?.basis ?? 'none' });
      setNote('kept');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const self = <button type="button" className="linkbtn" data-act="learn-self" onClick={() => nav.go({ route: { area: 'company', section: 'rules' }, query: { payment: offer.ref } })}>{t('rules.learn.self')}</button>;
  return (
    <div className="ruledraft" data-learn={offer.ref}>
      <span>{offer.same > 1 ? t('rules.learn.ask', { who, same: String(offer.same), of: String(offer.of) }) : t('rules.learn.askOne', { who })}</span>
      {proposal?.kind === 'none' ? <span className="m" data-testid="learn-none">{t(`rules.learn.none.${proposal.why}`, { who })}</span> : null}
      {proposal?.kind === 'note' ? (
        note === 'open' ? (
          <>
            <span data-testid="learn-note">{t('rules.learn.note', { who, sentence: proposal.sentence })}</span>
            <span className="ruleacts">
              <button type="button" className="btn primary" disabled={busy} data-act="learn-keep-note" onClick={() => void keepNote(proposal)}>{t('rules.learn.keepNote')}</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setNote('discarded')}>{t('rules.draft.discard')}</button>
            </span>
          </>
        ) : <span className="m">{note === 'kept' ? t('rules.learn.noteKept', { who }) : t('rules.draft.discarded')}</span>
      ) : null}
      {error ? <span className="warnline">{error}</span> : null}
      {proposal ? <span className="ruleacts">{self}</span> : (
        <span className="ruleacts">
          <button type="button" className="btn" disabled={busy} data-act="learn-ai" onClick={propose}>{busy ? t('rules.learn.thinking') : t('rules.learn.ai')}</button>
          {self}
        </span>
      )}
    </div>
  );
}
