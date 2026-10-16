/**
 * Firma › Quellen (ADR 0014): every source with its verdict (ready, waiting
 * to be switched on with what its reach adds, or invalid with file and line), its feeds, its reach
 * whether each channel's secret is set, and the senders a mailbox could skip (one click). A person
 * connects a mailbox here (r5h-27): its address, server and login, its password into the secret
 * store, and a check that logs in and lists what the source would read.
 */
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { language, t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { reachLines } from '../../../platform/sources/reach.js';
import type { MailCheck, SourcesView } from '../../../platform/sources/model.js';
import type { Nav } from '../index.js';

/** A long list folded to its first lines; the rest opens on a click. */
function Lines({ lines, first = 6 }: { lines: string[]; first?: number }) {
  return (
    <div className="srclines">
      {lines.slice(0, first).map((l) => <div key={l}>{l}</div>)}
      {lines.length > first ? <details><summary>{t('sources.more', { n: lines.length - first })}</summary>{lines.slice(first).map((l) => <div key={l}>{l}</div>)}</details> : null}
    </div>
  );
}

/** A source's folder in the workspace, as a path (no word to translate). */
const folderOf = (id: string) => ['sources', id].join('/');

/** «Postfach verbinden»: address, IMAP server, login (the address unless it differs) and the app password. */
function AddMailbox({ view, done, cancel }: { view: SourcesView; done(id: string): void; cancel(): void }) {
  const [f, setF] = useState({ address: '', host: '', account: '', password: '' });
  const [err, setErr] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.addMailSource({ address: f.address, host: f.host, ...(f.account.trim() ? { account: f.account } : {}), ...(f.password ? { password: f.password } : {}) });
      done(r.id);
    } catch (x) { setErr(errorText(x)); }
  }
  const field = (k: 'address' | 'host' | 'account', placeholder: string) => (
    <label className="wide">{t(`sources.field.${k}`)}<input name={k} value={f[k]} placeholder={placeholder} autoComplete="off" onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  return (
    <form className="form inline srcadd" data-testid="add-mailbox" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
      {field('address', t('sources.field.addressExample'))}
      {field('host', t('sources.field.hostExample'))}
      {field('account', f.address || t('sources.field.accountSame'))}
      {view.secretsInApp && (
        <label className="wide">{t('sources.field.password')}<input name="password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
      )}
      <p className="fhint wide">{view.secretsInApp ? t('sources.passwordHintApp') : t('sources.passwordHint', { where: view.secretsWhere })}</p>
      <div className="acts">
        <button type="submit" className="btn primary">{t('sources.addMailbox')}</button>
        <button type="button" className="btn ghost" onClick={cancel}>{t('common.cancel')}</button>
      </div>
      <div className="err wide" role="alert">{err}</div>
    </form>
  );
}

/** The password of one mailbox: set or replaced in place; never shown. */
function PasswordField({ id, present, done }: { id: string; present: boolean; done(): void }) {
  const [open, setOpen] = useState(!present);
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  if (!open) return <button type="button" className="linkbtn" onClick={() => setOpen(true)}>{t('sources.passwordChange')}</button>;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!value) return;
    try { await api.saveSourcePassword(id, value); setValue(''); setOpen(false); done(); } catch (x) { setErr(errorText(x)); }
  }
  return (
    <form className="srcpw" onSubmit={save}>
      <input type="password" name={`password-${id}`} aria-label={t('sources.field.password')} autoComplete="new-password" value={value} placeholder={t('sources.field.password')} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="btn" disabled={!value}>{t('sources.passwordSave')}</button>
      {err && <span className="warnline">{err}</span>}
    </form>
  );
}

/** «Verbindung prüfen» and its answer: what the source would read, or why it could not look. */
function Check({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<MailCheck>();
  const [err, setErr] = useState('');
  async function run() {
    setBusy(true); setErr('');
    try { setRes(await api.checkSource(id)); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <div className="srccheck" data-testid={`check-${id}`}>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void run()}>{busy ? t('sources.checking') : t('sources.check')}</button>
      {err && <p className="warnline">{err}</p>}
      {res && !res.ok && <p className="warnline">{t(`sources.checkFail.${res.reason}`)}{res.detail ? ` (${res.detail})` : ''}</p>}
      {res?.ok && (
        <>
          <p className="okline">{t('sources.checkOk', { days: res.days, total: res.total, read: res.read })}</p>
          {res.mails.length > 0 && (
            <ul className="srcmails">
              {res.mails.map((m, i) => (
                <li key={i} className={m.read ? '' : 'skip'}><span className="mono">{m.date}</span> <span>{m.from}</span> <span className="m">{m.subject}</span> <span className="m">{m.read ? t('sources.mailRead') : t('sources.mailSkipped')}</span></li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function SourcesSection({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
  const [view, setView] = useState<SourcesView>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const reload = () => { api.sources().then(setView, (e) => setError(errorText(e))); };
  useEffect(reload, []);
  if (error) return <p className="warnline">{error}</p>;
  if (!view) return <p className="m">{t('changes.loading')}</p>;
  const rows = view.rows;
  const add = canEdit && (adding
    ? <AddMailbox view={view} cancel={() => setAdding(false)} done={(id) => { setAdding(false); nav.toast(t('sources.added', { id })); reload(); }} />
    : <div className="fedit"><button type="button" className="btn" data-testid="connect-mailbox" onClick={() => setAdding(true)}>{t('sources.addMailbox')}</button></div>);
  const notHere = !view.runsHere && <p className="notice warn" data-testid="sources-not-here">{t('sources.notInApp')}</p>;
  if (!rows.length) return <>{notHere}<p className="m">{t('sources.none')}</p>{add}</>;
  return (
    <div className="srcs">
      {notHere}
      {rows.map(({ verdict, secrets, skipOffers }) => {
        const id = verdict.kind === 'invalid' ? verdict.id : verdict.decl.id;
        const label = verdict.kind === 'invalid' ? id : verdict.decl.label[language()] ?? verdict.decl.label.en;
        return (
          <section key={id} className="srcsec">
            <div className="srchead">
              <b>{label}</b> <span className="mono m">{folderOf(id)}</span>
              <span className={`wfpill ${verdict.kind === 'ready' ? 'st-done' : verdict.kind === 'pending' ? 'warn' : 'st-stuck'}`}>{t(`sources.verdict.${verdict.kind}` as 'sources.verdict.ready')}</span>
            </div>
            {verdict.kind === 'invalid' ? (
              <ul className="srcproblems">{verdict.problems.map((p, i) => <li key={i}><span className="mono">{p.file}{p.line ? `:${p.line}` : ''}</span> {p.message}</li>)}</ul>
            ) : (
              <>
                {verdict.kind === 'pending' ? (
                  <div className="srcon">
                    {verdict.reachDiff.added.length ? <div className="m">{t('sources.newReachTitle')}<Lines lines={verdict.reachDiff.added.map((l) => `${l.channel} · ${l.what}`)} /></div> : null}
                    <button type="button" className="btn primary" onClick={() => api.approveSource(verdict.decl.id, verdict.decl.version).then(reload, (e) => setError(errorText(e)))}>{t('sources.approve')}</button>
                    <span className="m">{t('sources.approveWhy')}</span>
                  </div>
                ) : null}
                {(skipOffers ?? []).map((o) => (
                  <div key={o.sender} className="srcon">
                    <span>{t('sources.skipOffer', { n: o.n, sender: o.sender })}</span>
                    <button type="button" className="btn" onClick={() => api.skipSender(verdict.decl.id, o.sender, verdict.decl.version).then(reload, (e) => setError(errorText(e)))}>{t('sources.skipSender')}</button>
                  </div>
                ))}
                <dl className="kv">
                  <dt>{t('sources.feeds')}</dt>
                  <dd>{verdict.decl.feeds.map((f) => `${f.id} · ${f.output.kind === 'records' ? f.output.record : t(`sources.output.${f.output.kind}` as 'sources.output.document')} · ${t(`sources.every.${f.every}` as 'sources.every.daily')}`).join('; ')}</dd>
                  <dt>{t('sources.reach')}</dt>
                  <dd className="mono"><Lines lines={reachLines(verdict.decl.reach).map((l) => `${l.channel} · ${l.what}`)} /></dd>
                  <dt>{t('sources.code')}</dt>
                  <dd className="mono">{`${verdict.decl.code.kind === 'app' ? `app:${verdict.decl.code.id}` : verdict.decl.code.entry} · ${verdict.decl.version}`}</dd>
                  {secrets.map((s) => (
                    <Fragment key={s.channel}>
                      <dt>{t('sources.secret', { channel: s.channel })}</dt>
                      <dd>
                        {s.present ? t('sources.secretSet') : <span className="warnline">{t('sources.secretMissing')}</span>}{' '}
                        {canEdit && s.channel === 'mail' && view.secretsInApp && verdict.decl.origin === 'company' && <PasswordField key={String(s.present)} id={verdict.decl.id} present={s.present} done={reload} />}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
                {verdict.decl.reach.mail && <Check id={verdict.decl.id} />}
              </>
            )}
          </section>
        );
      })}
      {add}
    </div>
  );
}
