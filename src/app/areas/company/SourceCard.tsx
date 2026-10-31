/**
 * A source the AI wrote with the person (src/platform/sources/draft.ts), as a card under its
 * answer: what it may reach in plain words, its code, the secret its channel needs (written to the
 * secret store from here, never through the chat), «Prüfen» (its code run dry: what it would
 * bring) and «Einschalten». Firma › Quellen shows the same source with the same controls.
 */
import { useEffect, useState } from 'react';
import { language, t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import type { SourcesView } from '../../../platform/sources/model.js';
import { PasswordField, Preview, plainReach } from './SourcesSection.js';
import './company.css';

export function SourceCard({ id, onSources }: { id: string; onSources(): void }) {
  const [view, setView] = useState<SourcesView>();
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);
  const reload = () => { api.sources().then(setView, (e: unknown) => setError(errorText(e))); };
  useEffect(reload, [id]);
  const row = view?.rows.find((r) => r.verdict.kind !== 'invalid' && r.verdict.decl.id === id);
  if (!view || !row || row.verdict.kind === 'invalid') return error ? <p className="warnline">{error}</p> : null;
  const { verdict } = row;
  const { decl } = verdict;
  const missing = row.secrets.filter((s) => !s.present);
  const approve = () => { setError(''); api.approveSource(decl.id, decl.version).then(reload, (e: unknown) => setError(errorText(e))); };
  const signIn = decl.reach.web ? () => { api.signInSource(decl.id).then(() => setOpened(true), (e: unknown) => setError(errorText(e))); } : undefined;
  return (
    <div className="ruledraft mailboxcard" data-testid="source-card" data-state={verdict.kind}>
      <span className="rk">{t('assistant.source.kind')}</span>
      <b>{decl.label[language()] ?? decl.label.en}</b>
      <ul className="srcplain">{plainReach(decl.reach).map((l) => <li key={l}>{l}</li>)}<li>{t('sources.plain.never')}</li></ul>
      <span className="m">{decl.code.kind === 'app' ? t('assistant.source.codeApp', { id: decl.code.id }) : t('assistant.source.codeOwn', { entry: decl.code.entry })}{' · '}{t(`sources.verdict.${verdict.kind}`)}</span>
      {row.secrets.map((s) => (view.secretsInApp ? (
        <span key={s.channel}>
          <span className="m">{t(s.channel === 'api' ? (s.present ? 'assistant.source.tokenStored' : 'assistant.source.token') : (s.present ? 'assistant.mailbox.passwordStored' : 'assistant.mailbox.password'))} </span>
          <PasswordField key={`${s.channel}${String(s.present)}`} id={id} channel={s.channel} present={s.present} done={reload} />
        </span>
      ) : <span key={s.channel} className="m">{t('sources.passwordHint', { where: view.secretsWhere })}</span>))}
      {signIn ? <button type="button" className="btn ghost" data-testid="source-sign-in" onClick={signIn}>{t('sources.signIn')}</button> : null}
      {opened ? <span className="m">{t('sources.signInOpened')}</span> : null}
      <Preview id={id} signIn={signIn} />
      {verdict.kind === 'pending' ? (
        <span className="ruleacts">
          <button type="button" className="btn primary" data-testid="source-approve" disabled={missing.length > 0} onClick={approve}>{t('sources.approve')}</button>
          <span className="m">{t('sources.approveWhy')}</span>
        </span>
      ) : <span className="okline">{t('assistant.mailbox.on')}</span>}
      <button type="button" className="linkbtn" onClick={onSources}>{t('assistant.mailbox.byHand', { place: `${t('area.company')} › ${t('company.sources')}` })}</button>
      {error ? <span className="warnline">{error}</span> : null}
    </div>
  );
}
