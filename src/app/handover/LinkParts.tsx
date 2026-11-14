/**
 * The parts of «Teilen» that go through the share service (docs/specs/e2e-and-fiduciary.md B3.1,
 * B3.3): this computer's sender confirming her address once, the share sent (its link, the
 * invitation from her mailbox or her mail program), the shares as facts with «Zurückziehen», and a
 * link someone else sent, opened here. Every fact is a time or a state, never a reminder.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { errorText, request } from '../lib/api.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import { sizeText } from './store.js';
import { mailto, refreshShares, runJob, running, type Job, type Registered, type SenderView, type ShareRecord, type Shared } from './link.js';

/** «15.11. 19:04»: a moment as a person reads it, in this computer's time. */
export function atText(iso: string): string {
  const d = new Date(iso);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${formatDate(day)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The progress of a job: what it does and how far, in bytes. */
export function JobProgress({ job }: { job: Job<unknown> | null }) {
  if (!job) return null;
  const phase = job.phase === 'download' || job.phase === 'decrypt' ? 'download' : job.phase === 'upload' || job.phase === 'encrypt' ? 'upload' : 'pack';
  return (
    <div className="shprog" role="status" data-testid="share-progress">
      <span>{t(`share.progress.${phase}`)}{job.total ? ` · ${sizeText(job.done)} / ${sizeText(job.total)}` : ''}</span>
      <progress max={job.total || 1} value={job.total ? job.done : 0} />
    </div>
  );
}

const REASONS = new Set(['otherAddress', 'ambiguousFrom', 'notAuthenticated', 'codeExpired']);

/**
 * Before the first share by link: the address the invitations come from, confirmed once by one
 * e-mail from that address. The app sends it when the books' mailbox sends from there; otherwise
 * she sends it from her mail program, prepared with the exact subject. The page asks the service
 * while it waits, and says a refusal in words (a provider that fails the check: the file instead).
 */
export function SenderStep({ kept, mailFrom, onConfirmed, onFile }: { kept?: string; mailFrom?: string; onConfirmed(email: string): void; onFile(): void }) {
  const [email, setEmail] = useState(kept ?? mailFrom ?? '');
  const [reg, setReg] = useState<Registered | null>(null);
  const [state, setState] = useState<SenderView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const waiting = !!kept || !!reg;
  const stopped = useRef(false);
  useEffect(() => { stopped.current = false; return () => { stopped.current = true; }; }, []);

  // While an address waits for its e-mail: the service is asked every few seconds, ten minutes at most.
  useEffect(() => {
    if (!waiting) return;
    let left = 200;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => request<SenderView>('GET', '/api/share/sender').then((s) => {
      if (stopped.current) return;
      setState(s);
      if (s.confirmed && s.email) { onConfirmed(s.email); return; }
      if (s.refusedReason || --left <= 0) return;
      timer = setTimeout(ask, 3000);
    }, (e) => setError(errorText(e)));
    void ask();
    return () => clearTimeout(timer);
  }, [waiting, reg]); // eslint-disable-line react-hooks/exhaustive-deps

  async function register() {
    setBusy(true); setError('');
    try { setReg(await request<Registered>('POST', '/api/share/sender', { email: email.trim() })); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function other() {
    await request('DELETE', '/api/share/sender').catch(() => undefined);
    setReg(null); setState(null); setEmail(mailFrom ?? '');
  }

  const address = reg?.email ?? state?.email ?? kept ?? email;
  const refused = state?.refusedReason && REASONS.has(state.refusedReason) ? state.refusedReason : undefined;
  return (
    <div className="what shsender" data-testid="share-sender">
      <div className="wt"><b>{t('share.sender.title')}</b></div>
      {!waiting ? (
        <>
          <div className="wm">{t('share.sender.why')}</div>
          <label>{t('share.sender.email')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('share.emailHint')} data-testid="share-sender-email" /></label>
          <div className="acts"><button type="button" className="btn" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onClick={() => void register()} data-testid="share-sender-confirm">{t('share.sender.confirm')}</button></div>
        </>
      ) : refused ? (
        <>
          <div className="err" role="alert">{t(`share.sender.refused.${refused}` as 'share.sender.refused.otherAddress', { email: address })}</div>
          <div className="acts">
            {refused === 'notAuthenticated' ? <button type="button" className="btn" onClick={onFile}>{t('share.way.file')}</button> : null}
            <button type="button" className="btn ghost" onClick={() => void (refused === 'codeExpired' ? register() : other())}>{t(refused === 'codeExpired' ? 'share.sender.again' : 'share.sender.other')}</button>
          </div>
        </>
      ) : reg && !reg.confirmed && !reg.mailed ? (
        <>
          <div className="wm">{t('share.sender.sendIt', { email: address })}</div>
          <div className="shmail"><span>{t('share.sender.to')}</span><b className="mono">{reg.confirmation?.to}</b><span>{t('share.sender.subject')}</span><b className="mono">{reg.confirmation?.subject}</b></div>
          {reg.mailError ? <div className="err">{t('share.sender.mailFailed', { why: reg.mailError })}</div> : null}
          <div className="acts">
            <a className="btn" href={mailto(reg.confirmation!.to, reg.confirmation!.subject, reg.confirmation!.text)} data-testid="share-sender-mailto">{t('share.mailProgram')}</a>
            <button type="button" className="linkbtn" onClick={() => void other()}>{t('share.sender.other')}</button>
          </div>
          <div className="wm">{t('share.sender.waiting')}</div>
        </>
      ) : (
        <>
          <div className="wm">{reg?.mailed ? t('share.sender.mailed', { email: address }) : t('share.sender.waitingFor', { email: address })}</div>
          <div className="acts"><button type="button" className="linkbtn" onClick={() => void other()}>{t('share.sender.other')}</button></div>
        </>
      )}
      {error ? <div className="err" role="alert">{error}</div> : null}
    </div>
  );
}

/** What was sent: the version, the link, and the invitation, sent from her mailbox or ready for her mail program. */
export function SentView({ sent, to }: { sent: Shared; to: { name: string; email?: string } }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(sent.link).then(() => setCopied(true), () => undefined);
  return (
    <div className="what shsent" data-testid="share-sent">
      <div className="wt"><b>{ICONS.check} {t('share.sent.title', { n: sent.record.version, name: to.name })}</b><span className="mono">{sizeText(sent.record.bytes)}</span></div>
      <div className="wm">{t('share.sent.until', { date: sent.record.expiresAt ? atText(sent.record.expiresAt) : '', hours: 5 })}</div>
      {sent.mailed ? <div className="wm">{t('share.sent.mailed', { to: to.email ?? to.name })}</div> : (
        <>
          {sent.mailError ? <div className="err">{t('share.sender.mailFailed', { why: sent.mailError })}</div> : null}
          <div className="wm">{t('share.sent.yourself', { name: to.name })}</div>
          <input readOnly value={sent.link} onFocus={(e) => e.target.select()} data-testid="share-link" />
          <div className="acts">
            <button type="button" className="btn" onClick={copy}>{copied ? t('share.copied') : t('share.copyLink')}</button>
            <a className="btn" href={mailto(to.email ?? '', sent.invitation.subject, sent.invitation.text)}>{t('share.mailProgram')}</a>
          </div>
        </>
      )}
      <div className="lock">{ICONS.lock}<span>{t('share.sent.back', { name: to.name })}</span></div>
    </div>
  );
}

/** One share as facts: to whom, which version, when sent, opened or not, until when, returns; «Link kopieren», «Zurückziehen». */
function ShareRow({ s, onChanged }: { s: ShareRecord; onChanged(next: ShareRecord): void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const live = running(s) && s.state !== 'revoked' && s.state !== 'expired' && s.state !== 'spent';
  const copy = async () => {
    try { const { link } = await request<{ link: string }>('GET', `/api/share/${s.id}/link`); await navigator.clipboard?.writeText(link); setCopied(true); } catch (e) { setError(errorText(e)); }
  };
  const revoke = async () => {
    try { onChanged(await request<ShareRecord>('DELETE', `/api/share/${s.id}`)); setConfirm(false); } catch (e) { setError(errorText(e)); }
  };
  const back = s.returns.filter((r) => r.received).length;
  return (
    <div className="shcard" data-testid="share-card">
      <div className="wt"><b>{t('share.card.to', { name: s.to.name, n: s.version })}</b><span className="mono">{sizeText(s.bytes)}</span></div>
      <div className="wm">
        {t('share.card.sent', { at: atText(s.at) })}
        {' · '}{s.revokedAt ? t('share.card.revoked', { at: atText(s.revokedAt) }) : s.firstOpenedAt ? t('share.card.opened', { at: atText(s.firstOpenedAt), n: s.opens.length }) : t('share.card.notOpened')}
        {!s.revokedAt && s.expiresAt ? ` · ${t(Date.parse(s.expiresAt) > Date.now() ? 'share.card.until' : 'share.card.ended', { at: atText(s.expiresAt) })}` : ''}
        {back ? ` · ${t('share.card.returns', { n: back })}` : ''}
        {s.error ? ` · ${t('share.card.unchecked')}` : ''}
      </div>
      {s.returns.some((r) => r.error) ? <div className="err">{t('share.card.returnFailed', { why: s.returns.find((r) => r.error)!.error! })}</div> : null}
      {live ? (
        confirm ? (
          <div className="acts">
            <span className="wm">{t('share.card.revokeNote', { name: s.to.name })}</span>
            <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
            <button type="button" className="btn" onClick={() => void revoke()} data-testid="share-revoke-yes">{t('share.card.revoke')}</button>
          </div>
        ) : (
          <div className="acts">
            <button type="button" className="linkbtn" onClick={() => void copy()}>{copied ? t('share.copied') : t('share.copyLink')}</button>
            <button type="button" className="linkbtn" onClick={() => setConfirm(true)} data-testid="share-revoke">{t('share.card.revoke')}</button>
          </div>
        )
      ) : null}
      {error ? <div className="err" role="alert">{error}</div> : null}
    </div>
  );
}

/** The shares of these books, newest first, with «Neu abfragen». At most `LIMIT` are listed, and the rest is named. */
export function SharesList({ shares, onShares }: { shares: ShareRecord[]; onShares(next: ShareRecord[]): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const LIMIT = 5;
  if (!shares.length) return null;
  const ask = async () => {
    setBusy(true); setError('');
    try { onShares((await refreshShares()).shares); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="shlist" data-testid="share-list">
      <div className="gh"><span>{t('share.card.title')}</span><button type="button" className="linkbtn" disabled={busy} onClick={() => void ask()}>{t('share.card.ask')}</button></div>
      {shares.slice(0, LIMIT).map((s) => <ShareRow key={s.id} s={s} onChanged={(next) => onShares(shares.map((x) => (x.id === next.id ? next : x)))} />)}
      {shares.length > LIMIT ? <div className="wm">{t('share.card.more', { n: shares.length - LIMIT, limit: LIMIT })}</div> : null}
      {error ? <div className="err" role="alert">{error}</div> : null}
    </div>
  );
}

/** «Einen Link bekommen?»: a link pasted here opens like a link in the invitation, as a copy for «Durchsicht». */
export function OpenLink({ onOpened }: { onOpened(o: { kind: 'full' | 'update'; firm: string; version: number; conflicts: number; dropped: number }): void }) {
  const [text, setText] = useState('');
  const [job, setJob] = useState<Job<unknown> | null>(null);
  const [error, setError] = useState('');
  const open = async () => {
    setError('');
    try { onOpened(await runJob<Parameters<typeof onOpened>[0]>('/api/share/open', { link: text.trim() }, setJob as (j: Job<unknown>) => void)); } catch (e) { setError(errorText(e)); setJob(null); }
  };
  return (
    <div className="shopen">
      <label>{t('share.openLink')}<input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('share.openLinkHint')} data-testid="share-open-link" /></label>
      <button type="button" className="btn" disabled={!text.trim() || !!job} onClick={() => void open()} data-testid="share-open-go">{t('share.openGo')}</button>
      {job ? <JobProgress job={job} /> : null}
      {error ? <div className="err" role="alert">{error}</div> : null}
    </div>
  );
}
