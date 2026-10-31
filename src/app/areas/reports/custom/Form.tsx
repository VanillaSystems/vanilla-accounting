/**
 * The form of Eigene Berichte (MISSION: everything possible without AI): the same spec the
 * sidebar's AI writes, made and edited by hand: title, period, sections with their source,
 * filters, grouping and columns, a comment whose figures are placeholders. «Vorschau» runs it on
 * the books, «Bericht speichern» writes its file (with «Rückgängig»); a spec the app cannot run is
 * refused with its reason and nothing is written.
 */
import { useState } from 'react';
import type { Key } from '../../../i18n/types.js';
import { t } from '../../../i18n/index.js';
import { api, errorText } from '../../../lib/api.js';
import type { RouteOf } from '../../../shell/route.js';
import type { AreaProps } from '../../index.js';
import { ORIGINS, SOURCES, SOURCE_TAKES, placeholderNames, type Column, type Origin, type Source } from '../../../../reports/spec.js';
import { draftOf, newDraft, newSection, rawOf, withSource, type FormDraft, type SectionDraft } from '../../../../reports/form.js';
import type { ReportResult } from '../../../../reports/result.js';
import { ReportView, uiWords } from './ReportView.js';
import { editing, reloadSaved, undoWrite, useEditing } from './store.js';
import { useWorkspace } from '../../../hooks/use-workspace.js';

type Props = AreaProps<Extract<RouteOf<'reports'>, { report: 'custom' }>>;

const w = (key: string) => uiWords.t(key as Key);

function SectionFields({ s, n, set, remove }: { s: SectionDraft; n: number; set(s: SectionDraft): void; remove?: () => void }) {
  const takes = SOURCE_TAKES[s.source];
  const has = (k: string) => (takes.filters as readonly string[]).includes(k);
  const toggle = <T,>(xs: T[], x: T): T[] => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const declared = useWorkspace()?.dimensions ?? [];
  const dimensions = takes.tags ? declared : [];
  return (
    <fieldset className="rform-sec" data-testid={`form-section-${n}`}>
      <legend>{t('custom.form.section', { n })}</legend>
      <div className="rform-grid">
        <label>{t('custom.form.source')}
          <select value={s.source} data-testid="f-source" onChange={(e) => set(withSource(s, e.target.value as Source))}>
            {SOURCES.map((x) => <option key={x} value={x}>{w(`custom.source.${x}`)}</option>)}
          </select>
        </label>
        <label>{t('custom.form.sectionTitle')}
          <input value={s.title} onChange={(e) => set({ ...s, title: e.target.value })} />
        </label>
        {has('accounts') ? (
          <label>{t('custom.filter.accounts')}
            <input value={s.accounts} data-testid="f-accounts" placeholder={t('custom.form.accountsHint')} onChange={(e) => set({ ...s, accounts: e.target.value })} />
          </label>
        ) : null}
        {has('vatCodes') ? (
          <label>{t('custom.filter.vatCodes')}
            <input value={s.vatCodes} placeholder={t('custom.form.listHint')} onChange={(e) => set({ ...s, vatCodes: e.target.value })} />
          </label>
        ) : null}
        <label>{t('custom.filter.text')}
          <input value={s.text} data-testid="f-text" onChange={(e) => set({ ...s, text: e.target.value })} />
        </label>
        <label>{t('custom.filter.currencies')}
          <input value={s.currencies} placeholder={t('custom.form.listHint')} onChange={(e) => set({ ...s, currencies: e.target.value })} />
        </label>
        {has('receipt') ? (
          <label>{t('custom.filter.receipt')}
            <select value={s.receipt} onChange={(e) => set({ ...s, receipt: e.target.value as SectionDraft['receipt'] })}>
              <option value="">{t('custom.form.any')}</option>
              <option value="with">{t('custom.f.receiptWith')}</option>
              <option value="without">{t('custom.f.receiptWithout')}</option>
            </select>
          </label>
        ) : null}
        {has('tags') ? dimensions.map((d) => (
          <label key={d.id} data-dimension={d.id}>{t('custom.form.tagFilter', { dimension: d.label })}
            <input value={s.tags[d.id] ?? ''} placeholder={t('custom.form.listHint')} list={`f-tags-${d.id}`} onChange={(e) => set({ ...s, tags: { ...s.tags, [d.id]: e.target.value } })} />
            <datalist id={`f-tags-${d.id}`}>{d.values.map((v) => <option key={v.value} value={v.value}>{v.label ?? ''}</option>)}</datalist>
          </label>
        )) : null}
        <label>{t('custom.form.group')}
          <select value={s.group} data-testid="f-group" onChange={(e) => set({ ...s, group: e.target.value as SectionDraft['group'] })}>
            {takes.groups.map((g) => <option key={g} value={g}>{w(`custom.group.${g}`)}</option>)}
            {dimensions.map((d) => <option key={d.id} value={`tag:${d.id}`}>{t('custom.group.tag', { dimension: d.label })}</option>)}
          </select>
        </label>
      </div>
      {has('origins') ? (
        <div className="rform-checks"><span className="m">{t('custom.filter.origins')}</span>
          {ORIGINS.map((o: Origin) => <label key={o}><input type="checkbox" checked={s.origins.includes(o)} onChange={() => set({ ...s, origins: toggle(s.origins, o) })} />{w(`custom.origin.${o}`)}</label>)}
        </div>
      ) : null}
      <div className="rform-checks" data-testid="f-columns"><span className="m">{t('custom.form.columns')}</span>
        {takes.columns.map((c: Column) => <label key={c}><input type="checkbox" checked={s.columns.includes(c)} onChange={() => set({ ...s, columns: toggle(s.columns, c) })} />{w(`custom.col.${c}`)}</label>)}
      </div>
      {remove ? <button type="button" className="linkbtn" onClick={remove}>{t('custom.form.removeSection')}</button> : null}
    </fieldset>
  );
}

export function ReportForm({ period, nav }: Props) {
  const edit = useEditing();
  const [draft, setDraft] = useState<FormDraft>(() => (edit?.spec ? draftOf(edit.spec) : newDraft(period.token)));
  const [result, setResult] = useState<ReportResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setSection = (i: number, s: SectionDraft) => setDraft({ ...draft, sections: draft.sections.map((x, j) => (j === i ? s : x)) });

  const preview = async () => {
    setBusy(true); setError('');
    try { setResult(await api.runReport(rawOf(draft))); } catch (e) { setResult(undefined); setError(errorText(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const wr = await api.saveReport(rawOf(draft), edit?.slug);
      await reloadSaved();
      editing.set(null);
      nav.select({ area: 'reports', report: 'custom', saved: wr.slug });
      nav.toast(t('custom.savedToast', { title: draft.title }), () => { void undoWrite(wr); });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="detail-in rform" data-testid="report-form">
      <div className="head"><h2 className="who">{t(edit?.slug ? 'custom.form.editTitle' : 'custom.form.newTitle')}</h2></div>
      <p className="m">{t('custom.form.lead')}</p>
      <div className="rform-grid">
        <label>{t('custom.form.title')}<input value={draft.title} data-testid="f-title" onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
        <label>{t('custom.form.period')}<input value={draft.period} data-testid="f-period" onChange={(e) => setDraft({ ...draft, period: e.target.value })} /><small className="m">{t('custom.form.periodHint')}</small></label>
      </div>
      {draft.sections.map((s, i) => (
        <SectionFields key={i} s={s} n={i + 1} set={(x) => setSection(i, x)} remove={draft.sections.length > 1 ? () => setDraft({ ...draft, sections: draft.sections.filter((_, j) => j !== i) }) : undefined} />
      ))}
      <button type="button" className="linkbtn" data-testid="f-add-section" onClick={() => setDraft({ ...draft, sections: [...draft.sections, newSection()] })}>{t('custom.form.addSection')}</button>
      <label className="rform-comment">{t('custom.form.comment')}
        <textarea rows={3} value={draft.comment} data-testid="f-comment" onChange={(e) => setDraft({ ...draft, comment: e.target.value })} />
        <small className="m">{t('custom.form.commentHint')}</small>
      </label>
      <div className="rform-holes">
        {placeholderNames(draft.sections.length).map((p) => {
          const hole = `{${p}}`;
          return <button key={p} type="button" className="chip mono" onClick={() => setDraft({ ...draft, comment: `${draft.comment}${draft.comment && !draft.comment.endsWith(' ') ? ' ' : ''}${hole}` })}>{hole}</button>;
        })}
      </div>
      <div className="ruleacts">
        <button type="button" className="btn ghost" disabled={busy} data-testid="f-preview" onClick={() => void preview()}>{t('custom.form.preview')}</button>
        <button type="button" className="btn primary" disabled={busy} data-testid="f-save" onClick={() => void save()}>{t('custom.save')}</button>
        <button type="button" className="btn ghost" onClick={() => editing.set(null)}>{t('custom.form.cancel')}</button>
      </div>
      {error ? <p className="warnline" data-testid="form-error">{error}</p> : null}
      {result ? <ReportView result={result} go={nav.go} /> : null}
    </div>
  );
}
