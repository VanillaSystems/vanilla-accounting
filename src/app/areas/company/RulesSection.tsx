/**
 * Firma › Regeln: every rule of the company in plain words, where it came from and how often it
 * applied, with «Ausschalten» and «Löschen» (each with an undo in the toast). RuleDraft is the card
 * of a rule the AI drafted: the sidebar and Änderungen show it, «Behalten» saves it at once.
 */
import { useEffect, useState } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import type { RuleRow } from '../../../booking/rule-book.js';
import type { RuleWords } from '../../../booking/rules.js';
import type { DraftView, RulesView } from '../../../saving/rules.js';
import type { Nav } from '../index.js';
import { lineOf, namesOf, refusalKey, ruleLines } from './rules-model.js';

const words = ((key: string, vars: Record<string, string>) => (t as (k: string, v: Record<string, string>) => string)(key, vars)) as RuleWords;
const money = (n: number) => fmt(n).replace(/\.00$/, '');

function origin(r: RuleRow): string {
  if (r.origin === 'other') return r.source ? t('rules.from.other', { source: r.source }) : t('rules.from.unknown');
  return t(`rules.from.${r.origin}`);
}

const refusalText = (r: RuleRow) => (r.kind === 'note' ? t('rules.refuse.prose') : r.refusal ? (() => { const k = refusalKey(r.refusal); return t(k.key, k.vars as never); })() : '');

export function RulesSection({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
  const [view, setView] = useState<RulesView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const reload = () => { api.rules().then(setView, (e) => setError(errorText(e))); };
  useEffect(reload, []);
  if (error) return <p className="warnline">{error}</p>;
  if (!view) return <p className="m">{t('changes.loading')}</p>;
  const lines = ruleLines(view, words, money);

  const act = async (row: RuleRow, kind: 'off' | 'on' | 'delete') => {
    setBusy(true);
    try {
      const r = await api.ruleCommand({ kind, file: row.file, step: row.step, id: row.id });
      if (!r.ok) { nav.toast(r.message); return; }
      reload();
      const undo = r.undo;
      nav.toast(t(`rules.done.${kind}`), undo && (() => {
        api.ruleCommand({ kind: 'restore', ...undo }).then((x) => { if (!x.ok) nav.toast(x.message); reload(); }, (e) => nav.toast(errorText(e)));
      }));
    } catch (e) {
      nav.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rules">
      <p className="m">{t('rules.lead')}</p>
      {!lines.length ? <p className="m">{t('rules.none')}</p> : null}
      <ul className="rulelist">
        {lines.map(({ key, row, line, acts, applied, last }) => (
          <li key={key} className={`rule${row.off ? ' off' : ''}${acts ? '' : ' note'}`} data-rule={row.id}>
            <b className="ruleline">{line}</b>
            <span className="m">
              {origin(row)}
              {' · '}
              {acts ? (applied ? t('rules.applied', { n: applied, date: formatDate(last) }) : t('rules.neverApplied')) : t('rules.noteOnly')}
            </span>
            {row.kind === 'broken' ? <span className="warnline">{refusalText(row)}</span> : null}
            <span className="ruleacts">
              {row.off ? <span className="wfpill muted">{t('rules.isOff')}</span> : null}
              {canEdit && row.kind === 'rule' ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(row, row.off ? 'on' : 'off')}>{t(row.off ? 'rules.switchOn' : 'rules.switchOff')}</button> : null}
              {canEdit ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(row, 'delete')}>{t('rules.delete')}</button> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Done = 'kept' | 'discarded';

/**
 * The card of one drafted rules file: each added, changed or removed rule in one plain line, then
 * «Behalten» (or «Ja, entfernen» for a removal) and «Verwerfen». A rule the app cannot carry out
 * is named with its reason and cannot be kept. A draft that holds no rule shows nothing.
 */
export function RuleDraft({ path, nav, onRules }: { path: string; nav?: Nav; onRules?(): void }) {
  const [d, setD] = useState<DraftView | null>();
  const [done, setDone] = useState<Done>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { api.draftRules(path).then(setD, () => setD(null)); }, [path]);
  if (done) {
    return (
      <div className="ruledraft done" data-draft={path}>
        <span>{t(done === 'kept' ? 'rules.draft.kept' : 'rules.draft.discarded')}</span>
        {done === 'kept' && onRules ? <button type="button" className="linkbtn" onClick={onRules}>{t('rules.draft.toRules')}</button> : null}
      </div>
    );
  }
  if (!d) return null;
  const names = namesOf(d, money);
  const say = (r: RuleRow) => lineOf(r, names, words);
  const onlyRemoval = !d.added.length && !d.changed.length && d.removed.length > 0;
  const go = async (kind: 'keep' | 'discard') => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.draftCommand(kind === 'keep' ? { kind, path, basis: d.basis } : { kind, path });
      if (r.ok) setDone(kind === 'keep' ? 'kept' : 'discarded');
      else setError('message' in r ? r.message : t('rules.draft.gone'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const business = d.path.startsWith('knowledge/rules/') ? undefined : d.path.split('/').pop()!.replace(/\.yaml$/, '');
  return (
    <div className="ruledraft" data-draft={path}>
      <span className="m">{t('rules.draft.title')}</span>
      <ul>
        {d.added.map((r) => <li key={`a${r.step}${r.id}`}><span className="rk">{t('rules.draft.added')}</span> <b>{say(r)}</b></li>)}
        {d.changed.map((r) => <li key={`c${r.step}${r.id}`}><span className="rk">{t('rules.draft.changed')}</span> <b>{say(r)}</b></li>)}
        {d.removed.map((r) => <li key={`r${r.step}${r.id}`}><span className="rk">{t('rules.draft.removed')}</span> <b>{say(r)}</b></li>)}
      </ul>
      {d.others && business ? <span className="m">{t('rules.draft.others', { name: names.business(business) ?? business })}</span> : null}
      {d.broken ? <span className="warnline">{t('rules.draft.broken', { why: d.broken })}</span> : null}
      {d.refused.map((r) => <span key={`x${r.id}`} className="warnline">{t('rules.draft.refused', { id: r.id || '?', why: refusalText(r) })}</span>)}
      {error ? <span className="warnline">{error}</span> : null}
      <span className="ruleacts">
        {d.keepable ? <button type="button" className="btn primary" disabled={busy} onClick={() => void go('keep')}>{t(onlyRemoval ? 'rules.draft.remove' : 'rules.draft.keep')}</button> : null}
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void go('discard')}>{t('rules.draft.discard')}</button>
        {nav && !d.keepable ? <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'changes', commit: 'draft', file: path }, query: {} })}>{t('rules.draft.diff')}</button> : null}
      </span>
    </div>
  );
}
