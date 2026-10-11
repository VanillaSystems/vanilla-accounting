/**
 * Firma › E-Mail-Versand: the company's own mailbox that sends invoices, reminders and notices
 * (belege.workspace.yaml `outgoingMail`, ADR 0010). The password is not kept here: `npm start`
 * reads it from .env, the desktop app from the keychain; the section says whether it is there.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import type { CompanyInfo } from '../../../books/company.js';
import { MAIL_SECURITY, type MailSecurity, type OutgoingMail } from '../../../invoices/model.js';
import type { MailStatus } from '../../../types/api-error.js';
import type { Nav } from '../index.js';
import { I } from '../receipts/icons.js';

const FIELDS = ['host', 'port', 'user', 'fromName', 'fromAddress', 'replyTo'] as const;
type Field = (typeof FIELDS)[number];
type Form = Record<Field, string> & { security: MailSecurity };

const formOf = (m: OutgoingMail | undefined): Form => ({
  host: m?.host ?? '', port: String(m?.port ?? 587), security: m?.security ?? 'starttls', user: m?.user ?? '',
  fromName: m?.fromName ?? '', fromAddress: m?.fromAddress ?? '', replyTo: m?.replyTo ?? '',
});

export function MailSection({ ws, nav, canEdit }: { ws: CompanyInfo; nav: Nav; canEdit: boolean }) {
  const m = ws.outgoingMail;
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(() => formOf(m));
  const [status, setStatus] = useState<MailStatus>();
  const [checking, setChecking] = useState(false);
  useEffect(() => { api.mailStatus().then(setStatus, () => setStatus(undefined)); }, [m]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const change = {
      host: f.host, port: Number(f.port), security: f.security, user: f.user.trim() || null,
      fromName: f.fromName.trim() || null, fromAddress: f.fromAddress, replyTo: f.replyTo.trim() || null,
    };
    try {
      await api.patchWorkspace({ outgoingMail: change });
    } catch (err) {
      nav.toast(errorText(err));
      return;
    }
    reloadWorkspace();
    setEdit(false);
    nav.toast(t('mail.saved'), m ? () => { api.patchWorkspace({ outgoingMail: { ...m, user: m.user ?? null, fromName: m.fromName ?? null, replyTo: m.replyTo ?? null } }).then(reloadWorkspace, (err) => nav.toast(errorText(err))); } : undefined);
  }
  async function check() {
    setChecking(true);
    try {
      await api.verifyMail();
      nav.toast(t('mail.verified', { host: m!.host }));
    } catch (err) {
      nav.toast(errorText(err));
    } finally {
      setChecking(false);
    }
  }
  const begin = () => { setF(formOf(m)); setEdit(true); };
  const input = (k: Field, cls = '') => (
    <label className={cls}>{t(`mail.field.${k}`)}<input name={k} className={k === 'port' ? 'mono' : ''} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  const none = <span className="m">{t('company.notSet')}</span>;
  const password = !status ? '' : status.password === 'set' ? t('mail.passwordSet', { where: status.where }) : status.password === 'missing' ? t('mail.passwordMissing', { where: status.where }) : t('mail.passwordNone');

  return (
    <>
      {m ? (
        <dl className="kv2 wide">
          <dt>{t('mail.server')}</dt><dd><span className="mono">{m.host}:{m.port}</span> <span className="m">{t(`mail.security.${m.security}`)}</span></dd>
          <dt>{t('mail.field.user')}</dt><dd>{m.user ?? none}</dd>
          <dt>{t('mail.password')}</dt><dd className={status?.password === 'missing' ? 'warnline' : ''}>{password}</dd>
          <dt>{t('mail.sender')}</dt><dd>{m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}</dd>
          <dt>{t('mail.field.replyTo')}</dt><dd>{m.replyTo ?? <span className="m">{t('mail.replyToSender')}</span>}</dd>
        </dl>
      ) : <p className="m">{t('mail.none')}</p>}
      {edit ? (
        <form className="form inline" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(false); } }}>
          {input('host', 'wide')}{input('port')}
          <label>{t('mail.field.security')}
            <select name="security" value={f.security} onChange={(e) => setF({ ...f, security: e.target.value as MailSecurity })}>
              {MAIL_SECURITY.map((s) => <option key={s} value={s}>{t(`mail.security.${s}`)}</option>)}
            </select>
          </label>
          {input('user', 'wide')}{input('fromName')}{input('fromAddress')}{input('replyTo', 'wide')}
          <p className="fhint wide">{t('mail.passwordHint', { where: status?.where ?? 'VANILLA_SMTP_PASSWORD' })}</p>
          <div className="acts">
            <button type="submit" className="btn primary">{t('common.save')}</button>
            <button type="button" className="btn ghost" onClick={() => setEdit(false)}>{t('common.cancel')}</button>
          </div>
        </form>
      ) : canEdit && (
        <div className="fedit">
          <button type="button" className="btn" onClick={begin}>{I.edit}{m ? t('company.edit') : t('mail.setUp')}</button>
          {m && <button type="button" className="btn ghost" disabled={checking} onClick={() => void check()}>{checking ? t('mail.checking') : t('mail.check')}</button>}
        </div>
      )}
      <p className="m src-note">{t('mail.source')}</p>
    </>
  );
}
