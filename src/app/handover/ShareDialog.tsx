/**
 * «Teilen…» (docs/specs/e2e-and-fiduciary.md B3.1, prototype PR #530): to whom, a short message, and
 * what goes, named by the app with its size (the first hand-over to a person carries the books of
 * the open years, a later one only what is new). Two ways: the link through the share service
 * (B3.2, B3.3: end to end encrypted, the invitation from her own mailbox), offered when a service is
 * set up and this computer keeps the link's key; and the file («Als Datei speichern», B3.7), which
 * does every step without the service. «Öffnen…» takes a `.vanilla` file, and a link someone sent
 * opens here too.
 */
import { useEffect, useRef, useState } from 'react';
import './handover.css';
import { t } from '../i18n/index.js';
import { errorText, request } from '../lib/api.js';
import { postDownload } from '../areas/export/state.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import { openVanilla, reloadHandover, sizeText, type Opened } from './store.js';
import { runJob, shareSettings, type Job, type ShareSettings, type Shared } from './link.js';
import { JobProgress, OpenLink, SenderStep, SentView, SharesList } from './LinkParts.js';

interface Plan {
  kind: 'full' | 'update';
  base?: { n: number; at: string };
  files: number;
  held: number;
  omitted: number;
  omittedBytes: number;
  bytes: number;
  newFiles: number;
  closedYears: string[];
  questions: number;
  /** The books' version now: the hand-over writes the next one. */
  version?: { n: number };
}

/** The ways a hand-over goes: the link through the share service, the file by hand. */
type Way = 'link' | 'file';

const PEOPLE = 'handover.people';
interface Known { name: string; email?: string }
const knownPeople = (): Known[] => { try { return JSON.parse(localStorage.getItem(PEOPLE) ?? '[]') as Known[]; } catch { return []; } };
const keepPerson = (p: Known) => { try { localStorage.setItem(PEOPLE, JSON.stringify([p, ...knownPeople().filter((x) => x.name !== p.name)].slice(0, 8))); } catch { /* per viewer only */ } };

const LINK = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>;

export function ShareDialog({ company, toast, onClose, onOpened }: { company?: string; toast(msg: string, undo?: () => void): void; onClose(): void; onOpened(o: Opened): void }) {
  const last = knownPeople()[0];
  const [name, setName] = useState(last?.name ?? '');
  const [email, setEmail] = useState(last?.email ?? '');
  const [message, setMessage] = useState('');
  const [full, setFull] = useState(false);
  const [archive, setArchive] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<ShareSettings | null>(null);
  const [way, setWay] = useState<Way>('file');
  const [sender, setSender] = useState<string | null>(null);
  const [mailIt, setMailIt] = useState(true);
  const [job, setJob] = useState<Job<Shared> | null>(null);
  const [sent, setSent] = useState<Shared | null>(null);
  const [service, setService] = useState('');
  const pick = useRef<HTMLInputElement>(null);

  // The link is offered where a service is set up and this computer keeps its keys; else the file alone.
  useEffect(() => {
    shareSettings().then((s) => { setSettings(s); setService(s.service.url ?? ''); if (s.service.url && s.keeps) setWay('link'); }, () => undefined);
  }, []);
  const linkable = !!settings?.service.url && !!settings.keeps;

  useEffect(() => {
    if (!name.trim()) { setPlan(null); return; }
    const q = new URLSearchParams({ name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}), ...(full ? { full: '1' } : {}), ...(archive.length ? { archive: archive.join(',') } : {}) });
    const timer = setTimeout(() => { request<Plan>('GET', `/api/handover/plan?${q}`).then((p) => { setPlan(p); setError(''); }, (e) => setError(errorText(e))); }, 250);
    return () => clearTimeout(timer);
  }, [name, email, full, archive]);

  const to = () => ({ name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) });
  const options = () => ({ ...(full ? { full: true } : {}), ...(archive.length ? { archive: archive.join(',') } : {}) });

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const file = await postDownload('/api/handover/share', { to: to(), message, ...options() }, 'buchhaltung.vanilla');
      keepPerson(to());
      const v = await reloadHandover();
      toast(t('share.saved', { file, n: v?.version?.n ?? 0, name: to().name }));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const done = await runJob<Shared>('/api/share/link', { to: to(), message, ...options(), mail: mailIt && !!settings?.mailFrom && !!email.trim() }, setJob);
      keepPerson(to());
      setSent(done);
      await reloadHandover();
      setSettings((s) => (s ? { ...s, shares: [done.record, ...s.shares] } : s));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false); setJob(null);
    }
  }

  async function saveService() {
    try { const r = await request<{ service: ShareSettings['service'] }>('PUT', '/api/share/service', { url: service.trim() || null }); setSettings((s) => (s ? { ...s, service: r.service } : s)); setError(''); } catch (e) { setError(errorText(e)); }
  }

  async function open(file: File) {
    setBusy(true);
    try { onOpened(await openVanilla(file)); onClose(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const who = name.trim() || t('share.recipient');
  const needsSender = way === 'link' && linkable && !sender;
  const ways: Way[] = linkable ? ['link', 'file'] : ['file'];
  return (
    <>
      <div className="scrim shscrim" onClick={onClose} />
      <div className="palette shdlg" role="dialog" aria-label={t('share.title')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <div className="xhd">
          <div><span className="lbl">{t('share.title')}</span><b>{company}</b></div>
          <button type="button" className="x" aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>
        <div className="shbody form">
          {sent ? <SentView sent={sent} to={sent.record.to} /> : (
            <>
              {settings?.shares.length ? <SharesList shares={settings.shares} onShares={(shares) => setSettings({ ...settings, shares })} /> : null}
              <div className="two2">
                <label>{t('share.to')}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('share.toName')} list="share-people" data-testid="share-name" /></label>
                <label>{t(way === 'link' ? 'share.emailTo' : 'share.email')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('share.emailHint')} data-testid="share-email" /></label>
                <datalist id="share-people">{knownPeople().map((p) => <option key={p.name} value={p.name} />)}</datalist>
              </div>
              <label>{t('share.message')}<textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} /></label>
              <div className="what" data-testid="share-what">
                {plan ? (
                  <>
                    <div className="wt">
                      <b>{plan.kind === 'update' && plan.base ? t('share.update', { date: formatDate(plan.base.at.slice(0, 10)) }) : t('share.full')}</b>
                      <span className="mono">{sizeText(plan.bytes)}</span>
                    </div>
                    <div className="wm">
                      {plan.kind === 'update' && plan.base
                        ? t('share.updateNote', { name: who, v: plan.base.n, n: plan.newFiles })
                        : t('share.fullNote', { n: plan.newFiles })}
                      {plan.omitted ? ` ${t('share.closedStay', { years: plan.closedYears.filter((y) => !archive.includes(y)).join(', '), n: plan.omitted, size: sizeText(plan.omittedBytes) })}` : ''}
                      {plan.questions ? ` ${t('share.questions', { n: plan.questions })}` : ''}
                    </div>
                  </>
                ) : <div className="wm">{t('share.whoFirst')}</div>}
              </div>
              <button type="button" className="linkbtn shmore" aria-expanded={more} onClick={() => setMore(!more)}>{t('share.more')} {more ? '▴' : '▾'}</button>
              {more && (
                <div className="shopts">
                  <label className="chk"><input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> {t('share.fullAgain')}</label>
                  {(plan?.closedYears ?? []).map((y) => (
                    <label key={y} className="chk"><input type="checkbox" checked={archive.includes(y)} onChange={(e) => setArchive(e.target.checked ? [...archive, y] : archive.filter((x) => x !== y))} /> {t('share.archive', { year: y })}</label>
                  ))}
                  {settings && settings.service.source !== 'env' ? (
                    <div className="shsvc">
                      <label>{t('share.service')}<input value={service} onChange={(e) => setService(e.target.value)} placeholder={t('share.serviceHint')} data-testid="share-service" /></label>
                      <button type="button" className="btn ghost" onClick={() => void saveService()}>{t('share.serviceSave')}</button>
                    </div>
                  ) : null}
                  <OpenLink onOpened={(o) => { onOpened(o); onClose(); }} />
                </div>
              )}
              <div className="ways" role="radiogroup" aria-label={t('share.how')}>
                {ways.map((w) => (
                  <div key={w} role="radio" tabIndex={0} aria-checked={way === w} className={`way${way === w ? ' on' : ''}`} onClick={() => setWay(w)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') setWay(w); }} data-testid={`share-way-${w}`}>
                    {w === 'link' ? LINK : ICONS.download}
                    <span>
                      <b>{t(`share.way.${w}`)}</b>
                      <small>{w === 'link' ? t('share.way.linkNote', { name: who }) : t('share.way.fileNote', { name: who })}</small>
                    </span>
                  </div>
                ))}
                {settings && !linkable ? <div className="wm">{t(settings.service.url ? 'share.way.noKeys' : 'share.way.noService')}</div> : null}
              </div>
              {needsSender ? <SenderStep kept={settings?.sender} mailFrom={settings?.mailFrom} onConfirmed={setSender} onFile={() => setWay('file')} /> : null}
              {way === 'link' && linkable && sender ? (
                <>
                  {settings?.mailFrom && email.trim() ? (
                    <label className="chk shchk"><input type="checkbox" checked={mailIt} onChange={(e) => setMailIt(e.target.checked)} data-testid="share-mail" /> {t('share.mailFrom', { from: settings.mailFrom, to: email.trim() })}</label>
                  ) : <div className="wm">{t('share.mailYourself', { from: sender })}</div>}
                  <div className="lock">{ICONS.lock}<span>{t('share.e2e', { hours: 5, days: 10 })}</span></div>
                </>
              ) : null}
              <JobProgress job={job} />
            </>
          )}
          {error ? <div className="err" role="alert">{error}</div> : null}
        </div>
        <div className="xft">
          {sent ? (
            <>
              <span className="m">{t('version.short', { n: sent.record.version })}</span>
              <button type="button" className="btn primary" onClick={onClose} data-testid="share-done">{t('share.done')}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => pick.current?.click()}>{t('share.open')}</button>
              <input ref={pick} type="file" accept=".vanilla" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void open(f); }} />
              <span className="m">{plan ? t('share.version', { n: (plan.version?.n ?? 0) + 1 }) : ''}</span>
              <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
              {way === 'link' && linkable
                ? <button type="button" className="btn primary" disabled={!name.trim() || !plan || busy || !sender} onClick={() => void send()} data-testid="share-send">{busy ? t('share.sending') : t('share.send')}</button>
                : <button type="button" className="btn primary" disabled={!name.trim() || !plan || busy} onClick={() => void save()} data-testid="share-save">{busy ? t('share.busy') : t('share.saveFile')}</button>}
            </>
          )}
        </div>
      </div>
    </>
  );
}
