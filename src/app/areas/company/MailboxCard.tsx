/**
 * A mailbox the AI sidebar drafted (src/server/workspace-edits.ts mailbox), as a card under its
 * answer: the address and server, the password field that writes the secret store straight from
 * here (never the message, the transcript or the model), «Verbindung prüfen» and «Einschalten»,
 * the same controls and the same routes as Firma › Quellen.
 */
import { useEffect, useState } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import type { SourcesView } from '../../../platform/sources/model.js';
import type { MailHost } from '../../../platform/sources/mail-host.js';
import { Check, PasswordField } from './SourcesSection.js';
import './company.css';

export function MailboxCard({ id, address, host, onSources }: { id: string; address: string; host?: string; onSources(): void }) {
  const [view, setView] = useState<SourcesView>();
  const [where, setWhere] = useState<MailHost>();
  const [error, setError] = useState('');
  const reload = () => { api.sources().then(setView, (e: unknown) => setError(errorText(e))); };
  useEffect(reload, [id]);
  useEffect(() => { api.mailHost(address).then(setWhere, () => setWhere(undefined)); }, [address]);
  const row = view?.rows.find((r) => r.verdict.kind !== 'invalid' && r.verdict.decl.id === id);
  if (!view || !row || row.verdict.kind === 'invalid') return error ? <p className="warnline">{error}</p> : null;
  const { verdict } = row;
  const stored = row.secrets.some((s) => s.channel === 'mail' && s.present);
  const needs = where?.provider && where.needs && t(where.needs === 'app-password' ? 'inflow.way.imapAppPassword' : 'inflow.way.imapOn', { provider: where.provider });
  const approve = () => { setError(''); api.approveSource(verdict.decl.id, verdict.decl.version).then(reload, (e: unknown) => setError(errorText(e))); };
  return (
    <div className="ruledraft mailboxcard" data-testid="mailbox-card" data-state={verdict.kind}>
      <span className="rk">{t('assistant.mailbox.advanced')}</span>
      <b>{address}</b>
      <span className="m">{t('assistant.mailbox.server', { host: host ?? verdict.decl.reach.mail?.host ?? '' })}{' · '}{t(`sources.verdict.${verdict.kind}`)}</span>
      {needs ? <span className="m">{needs}</span> : null}
      {view.secretsInApp ? (
        <span>
          <span className="m">{t(stored ? 'assistant.mailbox.passwordStored' : 'assistant.mailbox.password')} </span>
          <PasswordField key={String(stored)} id={id} present={stored} done={reload} />
        </span>
      ) : <span className="m">{t('sources.passwordHint', { where: view.secretsWhere })}</span>}
      {stored ? <Check id={id} /> : null}
      {verdict.kind === 'pending' ? (
        <span className="ruleacts">
          <button type="button" className="btn primary" data-testid="mailbox-approve" disabled={!stored} onClick={approve}>{t('sources.approve')}</button>
          <span className="m">{t(stored ? 'sources.approveWhy' : 'assistant.mailbox.passwordFirst')}</span>
        </span>
      ) : <span className="okline">{t('assistant.mailbox.on')}</span>}
      <button type="button" className="linkbtn" onClick={onSources}>{t('assistant.mailbox.byHand', { place: `${t('area.company')} › ${t('company.sources')}` })}</button>
      {error ? <span className="warnline">{error}</span> : null}
    </div>
  );
}
