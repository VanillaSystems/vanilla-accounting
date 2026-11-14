/**
 * The recipient's side of a hand-over, «Durchsicht» (docs/specs/e2e-and-fiduciary.md B4): a fact at
 * the top (whose books, which version, from whom), the sharer's message once, and at the bottom his
 * changes with «An <Name> zurücksenden», which saves the return as a `.vanilla` file.
 */
import { useEffect, useRef, useState } from 'react';
import './handover.css';
import { t } from '../i18n/index.js';
import { errorText, request } from '../lib/api.js';
import { postDownload } from '../areas/export/state.js';
import { formatDate } from '../lib/utils.js';
import { ICONS } from '../areas/icons.js';
import { useTopBarHeight } from '../shell/AuditBar.js';
import { reloadHandover, shortSum, sizeText, type DurchsichtFacts } from './store.js';

const PEN = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>;

export function DurchsichtBar({ d, onClose }: { d: DurchsichtFacts; onClose?: () => void }) {
  const bar = useRef<HTMLDivElement>(null);
  useTopBarHeight(bar);
  return (
    <div ref={bar} role="status" className="auditbar shrecv" data-testid="durchsicht-bar">
      <span><b>{t('durchsicht.books', { firm: d.firm.name })}</b> · {t('version.short', { n: d.version.n })} · {formatDate(d.version.at.slice(0, 10))} · {t('durchsicht.from', { name: d.sharer.name })}</span>
      <span className="mode">{PEN}{t('durchsicht.mode')}</span>
      <span className="m">{t('durchsicht.fact', { name: d.sharer.name })}</span>
      {onClose ? <button type="button" className="linkbtn" onClick={onClose}>{t('durchsicht.close')}</button> : null}
    </div>
  );
}

const SEEN = 'handover.welcomed';
const seen = (key: string) => { try { return localStorage.getItem(SEEN) === key; } catch { return false; } };
const keepSeen = (key: string) => { try { localStorage.setItem(SEEN, key); } catch { /* per viewer only */ } };

/** Once per version: what the copy is, the sharer's message, her questions back. */
export function Welcome({ d }: { d: DurchsichtFacts }) {
  const key = `${d.firm.name}:${d.version.n}`;
  const [shown, setShown] = useState(() => !seen(key));
  if (!shown) return null;
  const close = () => { keepSeen(key); setShown(false); };
  return (
    <div className="shwelcome" role="dialog" aria-label={t('durchsicht.welcome', { name: d.sharer.name })}>
      <h3>{t('durchsicht.welcome', { name: d.sharer.name })}</h3>
      <p>{t('durchsicht.welcomeText', { name: d.sharer.name })}</p>
      {d.message ? <div className="msg">{d.message}<small>{t('durchsicht.messageFrom', { name: d.sharer.name, date: formatDate(d.version.at.slice(0, 10)) })}</small></div> : null}
      {d.questions.length ? (
        <div className="msg">
          {d.questions.map((q) => <div key={q.key}>{q.label ? <b>{q.label}: </b> : null}{q.text}</div>)}
          <small>{t('durchsicht.questions', { name: d.sharer.name, n: d.questions.length })}</small>
        </div>
      ) : null}
      {d.conflicts.length || d.dropped.length ? <p className="m">{t('durchsicht.movedOn', { name: d.sharer.name, conflicts: d.conflicts.length, dropped: d.dropped.length })}</p> : null}
      <div className="acts"><button type="button" className="btn primary" onClick={close}>{t('durchsicht.start')}</button></div>
    </div>
  );
}

interface ReturnPlan { changes: Array<{ kind: string; key: string; before?: Record<string, unknown>; after?: Record<string, unknown>; why?: string }>; files: number; bytes: number }

const changeLabel = (c: ReturnPlan['changes'][number]): string => {
  const r = c.after ?? c.before ?? {};
  const what = String(r.description ?? r.originalFilename ?? r.filename ?? c.key);
  return t(c.after && c.before ? 'durchsicht.changed' : c.after ? 'durchsicht.added' : 'durchsicht.removed', { what });
};

/** The bar at the bottom: «N Änderungen · An <Name> zurücksenden», and its dialog. */
export function ReturnBar({ d, toast }: { d: DurchsichtFacts; toast(msg: string): void }) {
  const [open, setOpen] = useState(false);
  if (!d.changes && !d.sent) return null;
  return (
    <>
      <div className={`shret${d.changes ? '' : ' done'}`} role="status" data-testid="return-bar">
        {d.changes ? (
          <>
            <span><b>{t('durchsicht.changes', { n: d.changes })}</b></span>
            <button type="button" className="btn primary" onClick={() => setOpen(true)} data-testid="return-open">{ICONS.upload}{t('durchsicht.sendBack', { name: d.sharer.name })}</button>
          </>
        ) : d.sent ? <>{ICONS.check}<span>{t('durchsicht.sent', { name: d.sharer.name, date: formatDate(d.sent.at.slice(0, 10)), n: d.sent.changes })}</span></> : null}
      </div>
      {open && <ReturnDialog d={d} toast={toast} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReturnDialog({ d, toast, onClose }: { d: DurchsichtFacts; toast(msg: string): void; onClose(): void }) {
  const [plan, setPlan] = useState<ReturnPlan | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { request<ReturnPlan>('GET', '/api/handover/return').then(setPlan, (e) => setError(errorText(e))); }, []);
  const LIMIT = 50;
  async function send() {
    setBusy(true);
    try {
      const file = await postDownload('/api/handover/return', { message }, 'rücksendung.vanilla');
      await reloadHandover();
      toast(t('durchsicht.saved', { file, name: d.sharer.name }));
      onClose();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="scrim shscrim" onClick={onClose} />
      <div className="palette shdlg" role="dialog" aria-label={t('durchsicht.sendBack', { name: d.sharer.name })}>
        <div className="xhd">
          <div><span className="lbl">{t('durchsicht.sendLabel')}</span><b>{t('durchsicht.to', { name: d.sharer.name })}</b></div>
          <button type="button" className="x" aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>
        <div className="shbody form">
          <div className="chg" data-testid="return-changes">
            <div className="gh">{t('durchsicht.yourChanges', { n: plan?.changes.length ?? d.changes })}</div>
            {(plan?.changes ?? []).slice(0, LIMIT).map((c) => (
              <div key={`${c.kind}:${c.key}`} className="r"><span>{changeLabel(c)}{c.why ? <i> · «{c.why}»</i> : null}</span><span className="mono">{formatDate(String((c.after ?? c.before)?.date ?? ''))}</span></div>
            ))}
            {plan && plan.changes.length > LIMIT ? <div className="r m">{t('durchsicht.moreChanges', { n: plan.changes.length - LIMIT, limit: LIMIT })}</div> : null}
          </div>
          <label>{t('share.message')}<textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} /></label>
          <div className="lock">{ICONS.lock}<span>{t('durchsicht.decides', { name: d.sharer.name })}</span></div>
          {error ? <div className="err" role="alert">{error}</div> : null}
        </div>
        <div className="xft">
          <span className="m">{plan ? `${t('durchsicht.summary', { n: plan.changes.length, files: plan.files })} · ${sizeText(plan.bytes)} · ${t('durchsicht.basedOn', { n: d.version.n, sum: shortSum(d.version.checksum) })}` : ''}</span>
          <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn primary" disabled={!plan?.changes.length || busy} onClick={() => void send()} data-testid="return-save">{t('durchsicht.saveFile')}</button>
        </div>
      </div>
    </>
  );
}

/** «Warum? (für <Name>)» under an entry of a copy: his note on the change, which the return carries. */
export function WhyField({ d, entry }: { d: DurchsichtFacts; entry: string }) {
  const key = `entry:${entry}`;
  const [text, setText] = useState(d.notes[key] ?? '');
  useEffect(() => setText(d.notes[key] ?? ''), [key, d.notes]);
  const save = () => { if ((d.notes[key] ?? '') !== text) void request('PUT', '/api/handover/notes', { key, text }).then(() => reloadHandover()); };
  return (
    <label className="shwhy form" data-testid="why-field">
      <span>{t('durchsicht.why', { name: d.sharer.name })}</span>
      <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}
