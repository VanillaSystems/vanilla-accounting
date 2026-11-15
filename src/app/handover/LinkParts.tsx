/**
 * The parts of «Teilen» that go through the share service (docs/specs/e2e-and-fiduciary.md B3.1,
 * B3.3): this computer's sender confirming her address once, the share sent (the service sends the
 * invitation), the shares as facts with «Aktualisieren», «Nochmals senden», «Zurückziehen», and a
 * link someone else sent, opened here. Every fact is a time or a state, never a reminder.
 */
import { useEffect, useRef, useState } from 'react';
import { language, t } from '../i18n/index.js';
import { ApiError, errorText, request } from '../lib/api.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import { sizeText } from './store.js';
import { mailto, refreshShares, runJob, running, type Job, type Registered, type SenderView, type ShareRecord, type Shared } from './link.js';
import { reloadHandover } from './store.js';
import type { LinkPreview } from '../../share/sharing.js';
import { askLines, askOther, oneLine } from './ask-text.js';
import { SHARE_LIMITS } from '../../share/limits.js';
import { AsyncButton } from '../shell/AsyncButton.js';

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
          <div className="acts"><AsyncButton type="button" className="btn" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onClick={() => register()} data-testid="share-sender-confirm">{t('share.sender.confirm')}</AsyncButton></div>
        </>
      ) : refused ? (
        <>
          <div className="err" role="alert">{t(`share.sender.refused.${refused}` as 'share.sender.refused.otherAddress', { email: address })}</div>
          <div className="acts">
            {refused === 'notAuthenticated' ? <button type="button" className="btn" onClick={onFile}>{t('share.way.file')}</button> : null}
            <AsyncButton type="button" className="btn ghost" onClick={() => (refused === 'codeExpired' ? register() : other())}>{t(refused === 'codeExpired' ? 'share.sender.again' : 'share.sender.other')}</AsyncButton>
          </div>
        </>
      ) : reg && !reg.confirmed && !reg.mailed ? (
        <>
          <div className="wm">{t('share.sender.sendIt', { email: address })}</div>
          <div className="shmail"><span>{t('share.sender.to')}</span><b className="mono">{reg.confirmation?.to}</b><span>{t('share.sender.subject')}</span><b className="mono">{reg.confirmation?.subject}</b></div>
          {reg.mailError ? <div className="err">{t('share.sender.mailFailed', { why: reg.mailError })}</div> : null}
          <div className="acts">
            <a className="btn" href={mailto(reg.confirmation!.to, reg.confirmation!.subject, reg.confirmation!.text)} data-testid="share-sender-mailto">{t('share.mailProgram')}</a>
            <AsyncButton type="button" className="linkbtn" onClick={() => other()}>{t('share.sender.other')}</AsyncButton>
          </div>
          <div className="wm">{t('share.sender.waiting')}</div>
        </>
      ) : (
        <>
          <div className="wm">{reg?.mailed ? t('share.sender.mailed', { email: address }) : t('share.sender.waitingFor', { email: address })}</div>
          <div className="acts"><AsyncButton type="button" className="linkbtn" onClick={() => other()}>{t('share.sender.other')}</AsyncButton></div>
        </>
      )}
      {error ? <div className="err" role="alert">{error}</div> : null}
    </div>
  );
}

/**
 * What was sent (the owner's decision of 2026-11-15): the service sends the invitation itself, so the
 * screen says it is on its way, and to which address. «Nochmals senden», «Link kopieren» as a second
 * way, «Aktualisieren» and «Zurückziehen» sit on the share's card (ShareActions). When the service
 * did not send it (its limit of the day, say), the reason in words and «Link kopieren» first.
 */
export function SentView({ sent, onChanged }: { sent: Shared; onChanged(next: ShareRecord): void }) {
  const to = sent.record.to;
  return (
    <div className="what shsent" data-testid="share-sent">
      <div className="wt"><b>{ICONS.check} {sent.invited ? t('share.sent.title', { name: to.name, email: to.email ?? '' }) : t('share.sent.notSent', { email: to.email ?? '', why: errorText(new ApiError(sent.inviteError ?? { error: '' })) })}</b><span className="mono">{sizeText(sent.record.bytes)}</span></div>
      <div className="wm" data-testid="share-state">{stateText(sent.record)}</div>
      <div className="wm">{t('share.sent.until', { name: to.name, date: sent.record.expiresAt ? formatDate(sent.record.expiresAt.slice(0, 10)) : '' })}</div>
      <div className="wm">{t('share.sent.theySee', { name: to.name })}</div>
      <ShareActions s={sent.record} onChanged={onChanged} copyFirst={!sent.invited} />
      <div className="lock">{ICONS.lock}<span>{t('share.sent.back', { name: to.name })}</span></div>
    </div>
  );
}

/** The share's state in plain words: not opened yet, opened on …, updated on …, withdrawn. */
function stateText(s: ShareRecord): string {
  if (s.revokedAt) return t('share.card.revoked', { at: atText(s.revokedAt) });
  const parts = [s.firstOpenedAt ? t('share.card.opened', { at: atText(s.opens.at(-1) ?? s.firstOpenedAt), n: s.opens.length }) : t('share.card.notOpened')];
  if (s.updatedAt) parts.push(t('share.card.updated', { at: atText(s.updatedAt) }));
  return parts.join(' · ');
}

/**
 * What a running share offers: «Aktualisieren» (the whole books again into the same link, with
 * «<Name> Bescheid geben»), «Nochmals senden», «Link kopieren», «Zurückziehen» (asked once).
 */
function ShareActions({ s, onChanged, copyFirst = false }: { s: ShareRecord; onChanged(next: ShareRecord): void; copyFirst?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [notify, setNotify] = useState(true);
  const [note, setNote] = useState('');
  const [job, setJob] = useState<Job<unknown> | null>(null);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const live = running(s) && s.state !== 'revoked' && s.state !== 'expired' && s.state !== 'gone';
  if (!live) return null;
  const copy = async () => {
    try { const { link } = await request<{ link: string }>('GET', `/api/share/${s.id}/link`); await navigator.clipboard?.writeText(link); setCopied(true); } catch (e) { setError(errorText(e)); }
  };
  const again = async () => {
    setError(''); setSaid('');
    try { onChanged(await request<ShareRecord>('POST', `/api/share/${s.id}/invite`)); setSaid(t('share.againDone', { email: s.to.email ?? s.to.name })); } catch (e) { setError(errorText(e)); }
  };
  const update = async () => {
    setError(''); setSaid('');
    try {
      const next = await runJob<ShareRecord>(`/api/share/${s.id}/update`, { notify, ...(note.trim() ? { message: note.trim() } : {}), language: language() }, setJob as (j: Job<ShareRecord>) => void);
      onChanged(next);
      setUpdating(false); setNote('');
      // The update is done either way; a note that did not go out is said, «Nochmals senden» sends it.
      if (notify && next.notifyError) setError(t('share.update.notifyFailed', { name: s.to.name, why: next.notifyError }));
      else setSaid(t(next.notifiedAt && notify ? 'share.update.doneNotified' : 'share.update.done', { name: s.to.name }));
    } catch (e) { setError(errorText(e)); } finally { setJob(null); }
  };
  const revoke = async () => {
    try { onChanged(await request<ShareRecord>('DELETE', `/api/share/${s.id}`)); setConfirm(false); } catch (e) { setError(errorText(e)); }
  };
  return (
    <>
      {updating ? (
        <div className="what shupd" data-testid="share-update">
          <div className="wt"><b>{t('share.update.title', { name: s.to.name })}</b></div>
          <div className="wm">{t('share.update.note', { name: s.to.name, days: SHARE_LIMITS.days })}</div>
          <label>{t('share.message')}<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></label>
          <label className="chk"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} data-testid="share-update-notify" /> {t('share.update.notify', { name: s.to.name })}</label>
          <div className="acts">
            <button type="button" className="btn ghost" disabled={!!job} onClick={() => setUpdating(false)}>{t('common.cancel')}</button>
            <AsyncButton type="button" className="btn primary" disabled={!!job} onClick={() => update()} data-testid="share-update-go">{job ? t('share.update.busy') : t('share.update.go')}</AsyncButton>
          </div>
          <JobProgress job={job} />
        </div>
      ) : confirm ? (
        <div className="acts">
          <span className="wm">{t('share.card.revokeNote', { name: s.to.name })}</span>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
          <AsyncButton type="button" className="btn" onClick={() => revoke()} data-testid="share-revoke-yes">{t('share.card.revoke')}</AsyncButton>
        </div>
      ) : (
        <div className="acts">
          {copyFirst ? <AsyncButton type="button" className="btn primary" onClick={() => copy()} data-testid="share-copy">{copied ? t('share.copied') : t('share.copyLink')}</AsyncButton> : null}
          <button type="button" className="linkbtn" onClick={() => setUpdating(true)} data-testid="share-update-open">{t('share.update.open')}</button>
          {s.to.email ? <AsyncButton type="button" className="linkbtn" onClick={() => again()} data-testid="share-again">{t('share.again')}</AsyncButton> : null}
          {copyFirst ? null : <AsyncButton type="button" className="linkbtn" onClick={() => copy()} data-testid="share-copy">{copied ? t('share.copied') : t('share.copyLink')}</AsyncButton>}
          <button type="button" className="linkbtn" onClick={() => setConfirm(true)} data-testid="share-revoke">{t('share.card.revoke')}</button>
        </div>
      )}
      {said ? <div className="wm" role="status">{said}</div> : null}
      {error ? <div className="err" role="alert">{error}</div> : null}
    </>
  );
}

/** One share as facts: to whom, when sent, its state in words, until when, returns; and what it offers. */
function ShareRow({ s, onChanged }: { s: ShareRecord; onChanged(next: ShareRecord): void }) {
  const back = s.returns.filter((r) => r.received).length;
  // A return larger than the app fetches by itself waits at the service until she fetches it.
  const waiting = s.returns.filter((r) => !r.received && !r.error && r.state === 'ready' && r.bytes > SHARE_LIMITS.returnFetchedAlone);
  const [fetching, setFetching] = useState('');
  const [fetchError, setFetchError] = useState('');
  const fetchOne = async (id: string) => {
    setFetching(id); setFetchError('');
    try { onChanged(await request<ShareRecord>('POST', `/api/share/${s.id}/returns/${id}/fetch`)); await reloadHandover(); } catch (e) { setFetchError(errorText(e)); } finally { setFetching(''); }
  };
  return (
    <div className="shcard" data-testid="share-card">
      <div className="wt"><b>{t('share.card.to', { name: s.to.name })}</b><span className="mono">{sizeText(s.bytes)}</span></div>
      <div className="wm">
        {t('share.card.sent', { at: atText(s.at) })}
        {' · '}{stateText(s)}
        {!s.revokedAt && s.expiresAt ? ` · ${t(Date.parse(s.expiresAt) > Date.now() ? 'share.card.until' : 'share.card.ended', { at: atText(s.expiresAt) })}` : ''}
        {back ? ` · ${t('share.card.returns', { n: back })}` : ''}
        {s.error ? ` · ${t('share.card.unchecked')}` : ''}
      </div>
      {s.returns.some((r) => r.error) ? <div className="err">{t('share.card.returnFailed', { why: s.returns.find((r) => r.error)!.error! })}</div> : null}
      {waiting.map((r) => (
        <div key={r.id} className="acts" data-testid="share-return-waiting">
          <span className="wm">{t('share.card.returnWaiting', { size: sizeText(r.bytes), at: atText(r.at), limit: sizeText(SHARE_LIMITS.returnFetchedAlone) })}</span>
          <AsyncButton type="button" className="linkbtn" disabled={!!fetching} onClick={() => fetchOne(r.id)} data-testid="share-return-fetch">{fetching === r.id ? t('share.card.returnFetching') : t('share.card.returnFetch')}</AsyncButton>
        </div>
      ))}
      {fetchError ? <div className="err" role="alert">{fetchError}</div> : null}
      <ShareActions s={s} onChanged={onChanged} />
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
      <div className="gh"><span>{t('share.card.title')}</span><AsyncButton type="button" className="linkbtn" disabled={busy} onClick={() => ask()}>{t('share.card.ask')}</AsyncButton></div>
      {shares.slice(0, LIMIT).map((s) => <ShareRow key={s.id} s={s} onChanged={(next) => onShares(shares.map((x) => (x.id === next.id ? next : x)))} />)}
      {shares.length > LIMIT ? <div className="wm">{t('share.card.more', { n: shares.length - LIMIT, limit: LIMIT })}</div> : null}
      {error ? <div className="err" role="alert">{error}</div> : null}
    </div>
  );
}

/**
 * «Einen Link bekommen?»: a link pasted here opens like a link in the invitation, as a copy for
 * «Durchsicht». First the app says whose books, from whom and through which service; the link
 * opens on «Öffnen», with what the person confirmed there.
 */
export function OpenLink({ onOpened }: { onOpened(o: { kind: 'full' | 'update'; firm: string; version: number; conflicts: number; dropped: number }): void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [job, setJob] = useState<Job<unknown> | null>(null);
  const [error, setError] = useState('');
  const look = async () => {
    setError(''); setPreview(null);
    try { setPreview(await request<LinkPreview>('POST', '/api/share/preview', { link: text.trim() })); } catch (e) { setError(errorText(e)); }
  };
  const ask = preview ? askLines((k, v) => t(k, v as never), preview) : null;
  // A copy of this firm here from someone else: the package says so after the download, and the person decides (shareCopyOther).
  const [other, setOther] = useState<{ firm: string; was: string; now: string; trust: boolean } | null>(null);
  const open = async (copy?: 'new' | 'replace') => {
    setError('');
    const trust = other?.trust ?? !!preview?.foreign;
    try {
      onOpened(await runJob<Parameters<typeof onOpened>[0]>('/api/share/open', { link: text.trim(), trust, ...(copy ? { copy } : {}) }, setJob as (j: Job<unknown>) => void));
      setOther(null);
    } catch (e) {
      setJob(null);
      const body = e instanceof ApiError ? e.body : undefined;
      if (!copy && body && 'code' in body && body.code === 'shareCopyOther') { setOther({ ...body.params, trust }); setPreview(null); return; }
      setError(errorText(e));
    }
  };
  return (
    <div className="shopen">
      <label>{t('share.openLink')}<input value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder={t('share.openLinkHint')} data-testid="share-open-link" /></label>
      <AsyncButton type="button" className="btn" disabled={!text.trim() || !!job} onClick={() => look()} data-testid="share-open-go">{t('share.openGo')}</AsyncButton>
      {preview && ask ? (
        <div className="what shask" data-testid="share-open-ask">
          <div className="wt"><b>{t('share.ask.title')}</b></div>
          <div className="wm">{ask.what}</div>
          {ask.warnings.map((w) => <div key={w} className="err">{w}</div>)}
          <div className="acts">
            <button type="button" className="btn ghost" onClick={() => setPreview(null)}>{t('common.cancel')}</button>
            <AsyncButton type="button" className="btn" disabled={!!job} onClick={() => open()} data-testid="share-open-yes">{t('share.ask.open')}</AsyncButton>
          </div>
        </div>
      ) : null}
      {other ? (
        <div className="what shask" data-testid="share-open-other">
          <div className="wt"><b>{t('share.ask.title')}</b></div>
          <div className="err">{askOther((k, v) => t(k, v as never), other)}</div>
          <div className="wm">{t('share.ask.otherChoice', { was: oneLine(other.was), now: oneLine(other.now) })}</div>
          <div className="acts">
            <button type="button" className="btn ghost" disabled={!!job} onClick={() => setOther(null)}>{t('common.cancel')}</button>
            <AsyncButton type="button" className="btn" disabled={!!job} onClick={() => open('replace')} data-testid="share-open-replace">{t('share.ask.replace')}</AsyncButton>
            <AsyncButton type="button" className="btn primary" disabled={!!job} onClick={() => open('new')} data-testid="share-open-new">{t('share.ask.asNew')}</AsyncButton>
          </div>
        </div>
      ) : null}
      {job ? <JobProgress job={job} /> : null}
      {error ? <div className="err" role="alert">{error}</div> : null}
    </div>
  );
}
