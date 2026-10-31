/**
 * Firma › Quellen (ADR 0014): every source with its verdict (ready, waiting
 * to be switched on with what its reach adds, or invalid with file and line), its feeds, its reach
 * whether each channel's secret is set, and the senders a mailbox could skip (one click). A person
 * connects a mailbox here (r5h-27): its address, server and login, its password into the secret
 * store, and a check that logs in and lists what the source would read. On a Mac an account of the
 * Mail app can be connected too: its accounts are listed on that click only, one click connects one.
 */
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { language, t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { reachLines } from '../../../platform/sources/reach.js';
import type { MailCheck, Reach, SourcePreview, SourcesView } from '../../../platform/sources/model.js';
import type { Nav } from '../index.js';
import { clearMailDraft, peekMailDraft, type MailDraft } from './mail-draft.js';

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
function AddMailbox({ view, start, done, cancel }: { view: SourcesView; start?: MailDraft; done(id: string, updated: boolean): void; cancel(): void }) {
  const [f, setF] = useState({ address: start?.address ?? '', host: start?.host ?? '', account: '', password: '' });
  const [err, setErr] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.addMailSource({ address: f.address, host: f.host, ...(f.account.trim() ? { account: f.account } : {}), ...(f.password ? { password: f.password } : {}) });
      done(r.id, !!r.updated);
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
export function PasswordField({ id, present, done, channel = 'mail' }: { id: string; present: boolean; done(): void; channel?: 'mail' | 'api' }) {
  const [open, setOpen] = useState(!present);
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  if (!open) return <button type="button" className="linkbtn" onClick={() => setOpen(true)}>{t('sources.passwordChange')}</button>;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!value) return;
    try { await api.saveSourcePassword(id, value, channel); setValue(''); setOpen(false); done(); } catch (x) { setErr(errorText(x)); }
  }
  return (
    <form className="srcpw" onSubmit={save}>
      <input type="password" name={`${channel === 'api' ? 'token' : 'password'}-${id}`} aria-label={t(channel === 'api' ? 'sources.field.token' : 'sources.field.password')} autoComplete="new-password" value={value} placeholder={t(channel === 'api' ? 'sources.field.token' : 'sources.field.password')} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="btn" disabled={!value}>{t(channel === 'api' ? 'sources.tokenSave' : 'sources.passwordSave')}</button>
      {err && <span className="warnline">{err}</span>}
    </form>
  );
}

/** «Verbindung prüfen» and its answer: what the source would read, or why it could not look. */
export function Check({ id, auto = false }: { id: string; auto?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<MailCheck>();
  const [err, setErr] = useState('');
  async function run() {
    setBusy(true); setErr('');
    try { setRes(await api.checkSource(id)); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  useEffect(() => { if (auto) void run(); }, [auto]);
  return (
    <div className="srccheck" data-testid={`check-${id}`}>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void run()}>{busy ? t('sources.checking') : t('sources.check')}</button>
      {err && <p className="warnline">{err}</p>}
      {res && !res.ok && <p className="warnline">{res.reason === 'mail-app' ? t(`sources.macMail.problem.${res.problem}`) : t(`sources.checkFail.${res.reason}`)}{res.detail ? ` (${res.detail})` : ''}</p>}
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

const list = (xs: Array<{ text: string }>) => xs.map((x) => x.text).join(', ');

/** What a source may reach, one plain sentence per place: what the person approves. */
export function plainReach(r: Reach): string[] {
  const out: string[] = [];
  const senders = (m: NonNullable<Reach['mail'] | Reach['macMail']>) => [
    m.from.some((f) => f.text === '*') ? t('sources.plain.fromAll') : t('sources.plain.from', { list: list(m.from) }),
    ...(m.skip.length ? [t('sources.plain.skip', { list: list(m.skip) })] : []),
  ];
  if (r.mail) out.push(t('sources.plain.mail', { account: r.mail.account, host: r.mail.host, folders: r.mail.folders.join(', ') }), ...senders(r.mail));
  if (r.macMail) out.push(t('sources.plain.macMail', { account: r.macMail.account, folders: r.macMail.folders.join(', ') }), ...senders(r.macMail));
  if (r.web) {
    if (r.web.signIn.length) out.push(t('sources.plain.signIn', { list: list(r.web.signIn) }));
    if (r.web.open.length) out.push(t('sources.plain.open', { list: list(r.web.open) }));
    if (r.web.download.length) out.push(t('sources.plain.download', { list: list(r.web.download) }));
  }
  if (r.api) out.push(t('sources.plain.api', { host: r.api.base.replace(/^https:\/\//, '').replace(/\/$/, ''), list: r.api.allow.map((a) => a.path.text).join(', ') }));
  return out;
}

/** «Prüfen»: the source's code run dry, and what it would bring or why it could not look. */
export function Preview({ id, signIn }: { id: string; signIn?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SourcePreview>();
  const [err, setErr] = useState('');
  async function run() {
    setBusy(true); setErr('');
    try { setRes(await api.previewSource(id)); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  const fail = (r: Exclude<SourcePreview, { ok: true }>): string => {
    switch (r.reason) {
      case 'missing-secret': return t(`sources.preview.fail.missing-secret.${r.channel}`);
      case 'mail-app': return [t(`sources.macMail.problem.${r.problem}`), r.accounts?.length ? t('sources.preview.accounts', { list: r.accounts.join(', ') }) : ''].filter(Boolean).join(' ');
      case 'login-needed': return t('sources.preview.fail.login-needed');
      case 'changed': return t('sources.preview.fail.changed', { detail: r.detail });
      case 'over-reach': return t('sources.preview.fail.over-reach', { detail: r.detail });
      case 'not-here': return t('sources.preview.fail.not-here');
      case 'no-browser': return t('sources.preview.fail.no-browser');
    }
  };
  return (
    <div className="srccheck" data-testid={`preview-${id}`}>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void run()}>{busy ? t('sources.checking') : t('sources.preview')}</button>
      {err ? <p className="warnline">{err}</p> : null}
      {res && !res.ok ? (
        <p className="warnline">
          {fail(res)}{' '}
          {res.reason === 'login-needed' && signIn ? <button type="button" className="linkbtn" onClick={signIn}>{t('sources.signIn')}</button> : null}
        </p>
      ) : null}
      {res?.ok ? (
        res.seen.length ? (
          <>
            <p className="okline">{t('sources.preview.ok')}</p>
            <ul className="srcmails">
              {res.seen.map((s, i) => (
                <li key={i} className={s.as === 'new' ? '' : 'skip'}>
                  {s.date ? <span className="mono">{s.date.slice(0, 10)}</span> : null} <span>{s.name}</span> {s.from ? <span className="m">{s.from}</span> : null} <span className="m">{t(`sources.preview.as.${s.as}`)}</span>
                </li>
              ))}
            </ul>
            {res.more ? <p className="m">{t('sources.preview.more')}</p> : null}
          </>
        ) : <p className="okline">{t('sources.preview.none')}</p>
      ) : null}
    </div>
  );
}

export function SourcesSection({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
  const [view, setView] = useState<SourcesView>();
  const [error, setError] = useState<string>();
  const [draft] = useState(peekMailDraft);
  const [adding, setAdding] = useState<false | 'mailbox'>(draft ? 'mailbox' : false);
  /** The source just connected from the Mail app: its check runs at once, so the person sees what it would read before switching it on. */
  useEffect(clearMailDraft, []);
  const reload = () => { api.sources().then(setView, (e) => setError(errorText(e))); };
  useEffect(reload, []);
  if (error) return <p className="warnline">{error}</p>;
  if (!view) return <p className="m">{t('changes.loading')}</p>;
  const rows = view.rows;
  const add = canEdit && (adding === 'mailbox'
    ? <AddMailbox view={view} start={draft} cancel={() => setAdding(false)} done={(id, updated) => { setAdding(false); nav.toast(t(updated ? 'sources.updated' : 'sources.added', { id })); reload(); }} />
    : (
        <div className="fedit">
          <button type="button" className="btn" data-testid="connect-mailbox" onClick={() => setAdding('mailbox')}>{t('sources.addMailbox')}</button>
        </div>
      ));
  // The Mac app runs the Mail app's sources itself; the notice is for the others (a server's mailbox, a company's own code).
  const notHere = !view.runsHere && (!rows.length || rows.some((r) => r.verdict.kind === 'invalid' || !r.verdict.decl.reach.macMail)) && <p className="notice warn" data-testid="sources-not-here">{t('sources.notInApp')}</p>;
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
                        {canEdit && view.secretsInApp && verdict.decl.origin === 'company' && <PasswordField key={String(s.present)} id={verdict.decl.id} channel={s.channel} present={s.present} done={reload} />}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
                {(verdict.decl.reach.mail || verdict.decl.reach.macMail) && verdict.decl.code.kind === 'app'
                  ? <Check id={verdict.decl.id} />
                  : <Preview id={verdict.decl.id} {...(verdict.decl.reach.web && canEdit ? { signIn: () => { api.signInSource(verdict.decl.id).then(() => nav.toast(t('sources.signInOpened')), (e) => setError(errorText(e))); } } : {})} />}
              </>
            )}
          </section>
        );
      })}
      {add}
    </div>
  );
}
