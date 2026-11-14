/**
 * «Teilen…» (docs/specs/e2e-and-fiduciary.md B3.1, prototype PR #530): to whom, a short message, and
 * what goes, named by the app with its size (the first hand-over to a person carries the books of
 * the open years, a later one only what is new). The ways to send are a list: for now the file
 * («Als Datei speichern», B3.7); the link through the share service joins it there. «Öffnen…»
 * takes a `.vanilla` file: a return to review, or books handed over to this person.
 */
import { useEffect, useRef, useState } from 'react';
import './handover.css';
import { t } from '../i18n/index.js';
import { errorText, request } from '../lib/api.js';
import { postDownload } from '../areas/export/state.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import { openVanilla, reloadHandover, sizeText, type Opened } from './store.js';

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

/** The ways a hand-over goes: the file now; the link joins as a second entry (B3.1). */
type Way = 'file';
const WAYS: readonly Way[] = ['file'];

const PEOPLE = 'handover.people';
interface Known { name: string; email?: string }
const knownPeople = (): Known[] => { try { return JSON.parse(localStorage.getItem(PEOPLE) ?? '[]') as Known[]; } catch { return []; } };
const keepPerson = (p: Known) => { try { localStorage.setItem(PEOPLE, JSON.stringify([p, ...knownPeople().filter((x) => x.name !== p.name)].slice(0, 8))); } catch { /* per viewer only */ } };

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
  const [way] = useState<Way>('file');
  const pick = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!name.trim()) { setPlan(null); return; }
    const q = new URLSearchParams({ name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}), ...(full ? { full: '1' } : {}), ...(archive.length ? { archive: archive.join(',') } : {}) });
    const timer = setTimeout(() => { request<Plan>('GET', `/api/handover/plan?${q}`).then((p) => { setPlan(p); setError(''); }, (e) => setError(errorText(e))); }, 250);
    return () => clearTimeout(timer);
  }, [name, email, full, archive]);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const to = { name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) };
      const file = await postDownload('/api/handover/share', { to, message, ...(full ? { full: true } : {}), ...(archive.length ? { archive: archive.join(',') } : {}) }, 'buchhaltung.vanilla');
      keepPerson(to);
      const v = await reloadHandover();
      toast(t('share.saved', { file, n: v?.version?.n ?? 0, name: to.name }));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function open(file: File) {
    setBusy(true);
    try { onOpened(await openVanilla(file)); onClose(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const who = name.trim() || t('share.recipient');
  return (
    <>
      <div className="scrim shscrim" onClick={onClose} />
      <div className="palette shdlg" role="dialog" aria-label={t('share.title')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <div className="xhd">
          <div><span className="lbl">{t('share.title')}</span><b>{company}</b></div>
          <button type="button" className="x" aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>
        <div className="shbody form">
          <div className="two2">
            <label>{t('share.to')}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('share.toName')} list="share-people" data-testid="share-name" /></label>
            <label>{t('share.email')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('share.emailHint')} data-testid="share-email" /></label>
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
            </div>
          )}
          <div className="ways" role="radiogroup" aria-label={t('share.how')}>
            {WAYS.map((w) => (
              <div key={w} role="radio" aria-checked={way === w} className={`way${way === w ? ' on' : ''}`}>
                {ICONS.download}<span><b>{t('share.way.file')}</b><small>{t('share.way.fileNote', { name: who })}</small></span>
              </div>
            ))}
          </div>
          {error ? <div className="err" role="alert">{error}</div> : null}
        </div>
        <div className="xft">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => pick.current?.click()}>{t('share.open')}</button>
          <input ref={pick} type="file" accept=".vanilla" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void open(f); }} />
          <span className="m">{plan ? t('share.version', { n: (plan.version?.n ?? 0) + 1 }) : ''}</span>
          <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn primary" disabled={!name.trim() || !plan || busy} onClick={() => void save()} data-testid="share-save">{busy ? t('share.busy') : t('share.saveFile')}</button>
        </div>
      </div>
    </>
  );
}
