/**
 * Firma › Quellen (ADR 0014), read-only in this unit: every source with its verdict (ready, waiting
 * to be switched on with what its reach adds, or invalid with file and line), its feeds, its reach
 * and whether each channel's secret is set.
 */
import { Fragment, useEffect, useState } from 'react';
import { language, t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { reachLines } from '../../../platform/sources/reach.js';
import type { SourceRow } from '../../../platform/sources/model.js';

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

export function SourcesSection() {
  const [rows, setRows] = useState<SourceRow[]>();
  const [error, setError] = useState<string>();
  const reload = () => { api.sources().then(setRows, (e) => setError(errorText(e))); };
  useEffect(reload, []);
  if (error) return <p className="warnline">{error}</p>;
  if (!rows) return <p className="m">{t('changes.loading')}</p>;
  if (!rows.length) return <p className="m">{t('sources.none')}</p>;
  return (
    <div className="srcs">
      {rows.map(({ verdict, secrets }) => {
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
                <dl className="kv">
                  <dt>{t('sources.feeds')}</dt>
                  <dd>{verdict.decl.feeds.map((f) => `${f.id} · ${f.output.kind === 'records' ? f.output.record : t(`sources.output.${f.output.kind}` as 'sources.output.document')} · ${t(`sources.every.${f.every}` as 'sources.every.daily')}`).join('; ')}</dd>
                  <dt>{t('sources.reach')}</dt>
                  <dd className="mono"><Lines lines={reachLines(verdict.decl.reach).map((l) => `${l.channel} · ${l.what}`)} /></dd>
                  <dt>{t('sources.code')}</dt>
                  <dd className="mono">{`${verdict.decl.code.kind === 'app' ? `app:${verdict.decl.code.id}` : verdict.decl.code.entry} · ${verdict.decl.version}`}</dd>
                  {secrets.map((s) => (
                    <Fragment key={s.channel}><dt>{t('sources.secret', { channel: s.channel })}</dt><dd>{s.present ? t('sources.secretSet') : <span className="warnline">{t('sources.secretMissing', { name: `source:${id}:${s.channel}` })}</span>}</dd></Fragment>
                  ))}
                </dl>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
