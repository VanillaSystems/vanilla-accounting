/**
 * «<Name> hat N Änderungen geschickt» (docs/specs/e2e-and-fiduciary.md B5.2): a detail of Änderungen.
 * On top the effect on the VAT figures, then his changes by kind, each with before → after, his
 * «Warum?» and who made the booking he changed. «Übernehmen» per group and «Alles übernehmen»;
 * per row «Auslassen» and «Frage zurück»; a record both changed shows both versions to pick; a
 * change into a period filed meanwhile is offered as a correction. After the take-over, «Immer so?»
 * offers what his corrections may teach (B6), and «Rückgängig» takes the take-over back whole.
 */
import { useEffect, useState } from 'react';
import './handover.css';
import { t } from '../i18n/index.js';
import { errorText, request } from '../lib/api.js';
import { formatDate } from '../lib/utils.js';
import { periodName } from '../lib/period-label.js';
import { localToday, parsePeriod } from '../../accounting/periods.js';
import { ICONS } from '../areas/icons.js';
import { Go, entryAt } from '../areas/vat/links.js';
import { LearnOffer } from '../areas/company/LearnOffer.js';
import type { Nav } from '../areas/index.js';
import type { Period } from '../../accounting/periods.js';
import type { JournalEntry } from '../../types/index.js';
import type { Decision, GroupId, Review as ReviewData, ReviewRow } from '../../handover/returns.js';
import { reloadHandover } from './store.js';

const money = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
type Rec = Record<string, unknown> | undefined;
const asRec = (x: unknown): Rec => (x && typeof x === 'object' ? (x as Record<string, unknown>) : undefined);

/** A record in one line, as the row shows it before → after. */
function said(r: ReviewRow, x: unknown): string {
  const o = asRec(x);
  if (x === undefined) return t('review.none');
  if (r.kind === 'journalEntries' && o) return [`${o.accountDebit ?? '–'} / ${o.accountCredit ?? '–'}`, o.vatCode, typeof o.amount === 'number' ? money(o.amount) : undefined, o.date !== r.date ? formatDate(String(o.date)) : undefined].filter(Boolean).join(' · ');
  if (r.kind === 'mappings' && o) return t('review.linked', { receipt: String(o.receiptId) });
  if (r.kind === 'receipts' && o) return String(o.originalFilename ?? o.filename ?? r.key);
  if (r.kind === 'file') return t('review.fileText', { n: String(x).split('\n').length });
  return typeof x === 'object' ? JSON.stringify(x).slice(0, 80) : String(x);
}

/** Who made the booking he changed: a rule, the AI, a person, the app's code. */
function madeBy(r: ReviewRow): string | undefined {
  const b = asRec(r.before);
  if (r.kind !== 'journalEntries' || !b) return undefined;
  const by = asRec(b.by);
  if (by?.kind === 'rule') return t('review.by.rule', { rule: String(by.rule) });
  if (by?.kind === 'model') return t('review.by.model');
  if (by?.kind === 'assistant') return t('review.by.assistant');
  if (by?.kind === 'person' || b.origin === 'manual') return t('review.by.person');
  return b.origin ? t('review.by.app') : undefined;
}

const GROUP_ORDER: readonly GroupId[] = ['corrects', 'vat', 'account', 'amount', 'split', 'link', 'new', 'deleted', 'knowledge', 'other'];
/** Whether «Übernehmen» would take the row with the decisions as they stand (returns.ts `takes`). */
const takes = (r: ReviewRow) => !r.applied && r.decision !== 'skip' && !r.question && (r.status === 'apply' || (r.status === 'conflict' && r.decision === 'theirs') || (r.status === 'sealed' && r.decision === 'correction'));

export function ReturnReview({ id, nav, period, canEdit }: { id: string; nav: Nav; period: Period; canEdit: boolean }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  useEffect(() => { setData(null); request<ReviewData>('GET', `/api/handover/returns/${id}`).then(setData, (e) => setError(errorText(e))); }, [id]);

  if (error && !data) return <div className="detail-in"><p className="warnline">{error}</p></div>;
  if (!data) return <div className="detail-in"><p className="m">{t('app.loading')}</p></div>;
  const name = data.from.name;
  const live = data.applied.filter((a) => !a.undone);
  const shown = data.rows.filter((r) => r.status !== 'same' || r.applied);

  async function act<T extends { review: ReviewData }>(path: string, body: unknown, done?: (r: T) => void) {
    setBusy(true); setError('');
    try {
      const r = await request<T | ReviewData>('POST', path, body);
      const review = 'review' in (r as T) ? (r as T).review : (r as ReviewData);
      setData(review);
      done?.(r as T);
      nav.refresh();
      void reloadHandover();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const decide = (row: string, decision: Decision | null | undefined, q?: string | null) => act(`/api/handover/returns/${id}/decide`, { row, ...(decision !== undefined ? { decision } : {}), ...(q !== undefined ? { question: q } : {}) });
  const apply = (groups: GroupId[] | 'all') => act<{ review: ReviewData; applied: number; corrections: number; version: { n: number } }>(`/api/handover/returns/${id}/apply`, { groups }, (r) => {
    nav.toast(t('review.appliedToast', { n: r.applied + r.corrections, name, v: r.version.n }), () => void undo());
  });
  const undo = () => act<{ review: ReviewData; restored: number }>(`/api/handover/returns/${id}/undo`, {}, (r) => nav.toast(t('review.undoneToast', { n: r.restored })));

  const effect = data.effect.filter((e) => Math.round(e.before * 100) !== Math.round(e.after * 100) || e.filed);
  const groups = GROUP_ORDER.map((g) => ({ g, rows: shown.filter((r) => r.group === g) })).filter((x) => x.rows.length);
  const open = shown.filter(takes).length;

  return (
    <div className="detail-in chpage rv" data-testid="return-review">
      <div className="head">
        <h2 className="who">{t('review.title', { name })}
          <small>{formatDate(data.at.slice(0, 10))} · {t('review.fromRole', { name })} · {t('review.count', { n: data.rows.length })} · {t('review.basedOn', { n: data.basedOn })}</small>
        </h2>
      </div>
      {data.message ? <div className="msgp"><small>{t('review.writes', { name })}</small>{data.message}</div> : null}
      {effect.length ? (
        <div className="effect" data-testid="review-effect">
          {effect.map((e) => {
            const p = parsePeriod(e.period, localToday());
            const diff = Math.round((e.after - e.before) * 100) / 100;
            return (
              <div key={e.period}>
                <span className="ek">{e.filed ? t('review.effect.filed', { period: p ? periodName(p) : e.period }) : t('review.effect.open', { period: p ? periodName(p) : e.period })}</span>
                <span className="ev">{money(e.before)}<span className="rvar">→</span>{money(e.after)}</span>
                <span className={`ed${diff > 0 ? ' up' : ''}`}>{diff === 0 ? t('review.effect.none') : `${diff > 0 ? '+' : ''}${money(diff)}`}</span>
              </div>
            );
          })}
        </div>
      ) : null}
      {live.length ? (
        <div className="rvdone">{ICONS.check}<span><b>{t('review.applied')}</b> — {t('review.appliedBy', { name, date: formatDate(live.at(-1)!.at.slice(0, 10)), v: live.at(-1)!.version })}</span>
          {canEdit ? <button type="button" className="linkbtn" disabled={busy} onClick={() => void undo()}>{t('review.undo')}</button> : null}
        </div>
      ) : null}
      {data.learn.length && live.length ? (
        <div className="rvlearn">
          <div className="t">{t('review.learn')}</div>
          <div className="m">{t('review.learnNote', { name })}</div>
          {data.learn.map((ref) => <LearnOffer key={ref} payment={ref} nav={nav} />)}
        </div>
      ) : null}
      {canEdit && open ? (
        <div className="all"><button type="button" className="btn primary" disabled={busy} onClick={() => void apply('all')} data-testid="review-all">{ICONS.check}{t('review.all')}</button><span className="m">{t('review.allNote')}</span></div>
      ) : null}
      {error ? <p className="warnline" role="alert">{error}</p> : null}
      {groups.map(({ g, rows }) => {
        const taking = rows.filter(takes).length;
        const done = rows.every((r) => r.applied);
        return (
          <section key={g} className={`rvg${done ? ' taken' : ''}`} data-group={g}>
            <div className="gh">
              <span className="t">{t(`review.group.${g}` as 'review.group.vat')}</span><span className="n">{rows.length}</span>
              {done ? <span className="done">{ICONS.check}{t('review.taken')}</span>
                : canEdit && taking ? <button type="button" className="btn" disabled={busy} onClick={() => void apply([g])}>{t('review.take')}</button> : null}
            </div>
            {rows.map((r) => (
              <div key={r.id} className={`rvr${r.decision === 'skip' || r.question ? ' skipped' : ''}`} data-row={r.id} data-status={r.status}>
                <span className="rvdt">{r.date ? formatDate(r.date).slice(0, 6) : ''}</span>
                <div className="rvtx">
                  {r.kind === 'journalEntries' && (r.mine || r.after) ? <Go to={entryAt((r.mine ?? r.after) as JournalEntry, period)} nav={nav} className="golink">{r.label}</Go> : <span className="golink">{r.label}</span>}
                  {asRec(r.after)?.corrects ? <span className="rvtag fq">{t('review.corrects', { period: String(asRec(r.after)!.corrects) })}</span> : null}
                  <div className="rvba">
                    {r.before !== undefined ? <><span className="rvwas">{said(r, r.before)}</span><span className="rvar">→</span></> : null}
                    <span className="rvnow">{r.after === undefined ? t('review.removed') : said(r, r.after)}</span>
                  </div>
                  {r.why ? <div className="rvwhy"><span className="m">{name}: </span>{r.why}</div> : null}
                  {madeBy(r) ? <div className="rvorig">{madeBy(r)}</div> : null}
                  {r.applied ? <div className="rvorig">{t('review.rowTaken')}</div> : null}
                  {r.decision === 'skip' ? <div className="rvorig">{t('review.skipped')}</div> : null}
                </div>
                <div className="rvra">
                  {typeof asRec(r.after ?? r.before)?.amount === 'number' ? <span className="rvamt">{money(asRec(r.after ?? r.before)!.amount as number)}</span> : null}
                  {canEdit && !r.applied ? (
                    <span>
                      <button type="button" className="quiet2" disabled={busy} onClick={() => void decide(r.id, r.decision === 'skip' ? null : 'skip')}>{r.decision === 'skip' ? t('review.unskip') : t('review.skip')}</button>
                      {' · '}
                      <button type="button" className="quiet2" disabled={busy} onClick={() => { setAsking(r.id); setQuestion(r.question ?? ''); }}>{t('review.ask')}</button>
                    </span>
                  ) : null}
                </div>
                {r.status === 'conflict' && !r.applied ? (
                  <>
                    <div className="rvconf">{t('review.conflict')}</div>
                    <div className="rvc" role="radiogroup" aria-label={t('review.conflictPick')}>
                      <button type="button" role="radio" aria-checked={r.decision === 'mine'} className={r.decision === 'mine' ? 'on' : ''} disabled={!canEdit || busy} onClick={() => void decide(r.id, 'mine')}>
                        <span className="ck">{t('review.mine')}</span><span className="cv">{said(r, r.mine)}</span>
                      </button>
                      <button type="button" role="radio" aria-checked={r.decision === 'theirs'} className={r.decision === 'theirs' ? 'on' : ''} disabled={!canEdit || busy} onClick={() => void decide(r.id, 'theirs')}>
                        <span className="ck">{t('review.theirs', { name })}</span><span className="cv">{said(r, r.after)}</span>
                      </button>
                    </div>
                  </>
                ) : null}
                {r.status === 'sealed' && !r.applied ? (
                  <div className="rvconf">
                    {t('review.sealed', { period: r.period ?? '' })}
                    {canEdit ? <button type="button" className={`btn${r.decision === 'correction' ? ' on' : ''}`} aria-pressed={r.decision === 'correction'} disabled={busy} onClick={() => void decide(r.id, r.decision === 'correction' ? null : 'correction')}>{r.decision === 'correction' ? t('review.asCorrectionOn') : t('review.asCorrection')}</button> : null}
                  </div>
                ) : null}
                {r.status === 'fixed' ? <div className="rvconf">{t('review.fixed')}</div> : null}
                {asking === r.id ? (
                  <div className="rvask">
                    <input autoFocus value={question} maxLength={500} aria-label={t('review.askTo', { name })} onChange={(e) => setQuestion(e.target.value)} />
                    <button type="button" className="btn" disabled={busy || !question.trim()} onClick={() => { setAsking(null); void decide(r.id, undefined, question); }}>{t('review.askSave')}</button>
                  </div>
                ) : r.question ? (
                  <div className="rvasked">{t('review.asked', { name, q: r.question })} <button type="button" className="linkbtn" onClick={() => void decide(r.id, undefined, null)}>{t('review.askDrop')}</button></div>
                ) : null}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
