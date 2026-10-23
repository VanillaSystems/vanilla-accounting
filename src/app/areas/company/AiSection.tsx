/**
 * Firma › KI (issue #48): which AI the app asks for each step, on this computer. The providers
 * that are there (the Claude subscription through Claude Code, an API key kept in the keychain),
 * and a model per step; a step's list holds only the models that can do what it needs.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import type { AiProviderView, AiStepView, AiView } from '../../../llm/view.js';
import type { ProviderId } from '../../../llm/provider.js';
import type { Nav } from '../index.js';

const fits = (step: AiStepView, can: readonly string[]) => step.needs.every((n) => can.includes(n));
const usable = (p: AiProviderView) => p.state === 'ready' || p.state === 'set';
const pick = (provider: ProviderId, model: string) => `${provider} ${model}`;
const label = (r: { provider: ProviderId; model: string }) => t('ai.modelOf', { provider: t(`ai.provider.${r.provider}`), model: r.model });

export function AiSection({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
  const [view, setView] = useState<AiView>();
  useEffect(() => { api.ai().then(setView, (e) => nav.toast(errorText(e))); }, []);
  if (!view) return <p className="m">{t('changes.loading')}</p>;

  const apply = async (call: () => Promise<AiView>, done: string) => {
    try {
      setView(await call());
      nav.toast(done);
    } catch (e) {
      nav.toast(errorText(e));
    }
  };
  const choose = (step: AiStepView, value: string) => {
    const [provider, ...model] = value.split(' ');
    return apply(
      () => api.setAiStep(step.id, value ? { provider: provider as ProviderId, model: model.join(' ') } : { provider: null }),
      t('ai.stepSaved', { step: t(`ai.step.${step.id}`) }),
    );
  };

  return (
    <div className="ai">
      <p>{t('ai.intro')}</p>
      <h3>{t('ai.providers')}</h3>
      <dl className="kv2 wide">
        {view.providers.map((p) => (
          <ProviderRow key={p.id} p={p} view={view} canEdit={canEdit} onKey={(key) => apply(() => api.setAiKey(p.id, key), t(key ? 'ai.keySaved' : 'ai.keyRemoved', { provider: t(`ai.provider.${p.id}`) }))} />
        ))}
      </dl>
      <h3>{t('ai.steps')}</h3>
      <div className="ftab aisteps" role="table" aria-label={t('ai.steps')}>
        <div className="fh" role="row"><span>{t('ai.step')}</span><span>{t('ai.model')}</span></div>
        {view.steps.map((s) => {
          const value = s.choice ? pick(s.choice.provider, s.choice.model ?? '') : '';
          const unavailable = s.choice && s.resolved.source === 'default';
          return (
            <div className="fr" role="row" key={s.id}>
              <span>
                {t(`ai.step.${s.id}`)}
                {s.needs.includes('agent') ? <small>{t('ai.needs.agent')}</small>
                  : s.needs.includes('pdf') ? <small>{t('ai.needs.pdf')}</small>
                  : s.confident !== undefined ? <small>{t('ai.needs.typed', { percent: Math.round(s.confident * 100) })}</small> : null}
              </span>
              <span>
                <select aria-label={t(`ai.step.${s.id}`)} value={unavailable ? '' : value} disabled={!canEdit} onChange={(e) => void choose(s, e.target.value)}>
                  <option value="">{t('ai.standard', { model: label(s.standard) })}</option>
                  {view.providers.filter(usable).map((p) => {
                    const models = p.models.filter((m) => fits(s, m.can));
                    return models.length ? (
                      <optgroup key={p.id} label={t(`ai.provider.${p.id}`)}>
                        {models.map((m) => <option key={m.id} value={pick(p.id, m.id)}>{label({ provider: p.id, model: m.id })}</option>)}
                      </optgroup>
                    ) : null;
                  })}
                </select>
                {unavailable ? <small className="warnline">{t('ai.unavailable', { model: label({ provider: s.choice!.provider, model: s.choice!.model ?? '' }) })}</small> : null}
              </span>
            </div>
          );
        })}
      </div>
      <p className="m src-note">{t('ai.fallback')}</p>
    </div>
  );
}

function ProviderRow({ p, view, canEdit, onKey }: { p: AiProviderView; view: AiView; canEdit: boolean; onKey: (key: string | null) => Promise<void> }) {
  const [key, setKey] = useState('');
  const name = t(`ai.provider.${p.id}`);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    await onKey(key);
    setKey('');
  };
  if (p.billing === 'subscription') {
    return <><dt>{name}</dt><dd className={p.state === 'missing' ? 'warnline' : ''}>{t(p.state === 'ready' ? 'ai.cli.ready' : 'ai.cli.missing')}</dd></>;
  }
  return (
    <>
      <dt>{name}</dt>
      <dd>
        {p.state === 'set' ? (
          <span className="aikey">
            <span>{t('ai.key.set')}</span>
            {canEdit && view.keysInApp ? <button type="button" className="btn ghost" onClick={() => void onKey(null)}>{t('ai.key.remove')}</button> : null}
          </span>
        ) : view.keysInApp ? (
          canEdit ? (
            <form className="aikey" onSubmit={save}>
              <input type="password" name={`${p.id}-key`} autoComplete="off" spellCheck={false} aria-label={t('ai.key.label', { provider: name })}
                placeholder={t('ai.key.placeholder')} value={key} onChange={(e) => setKey(e.target.value)} />
              <button type="submit" className="btn" disabled={!key.trim()}>{t('common.save')}</button>
            </form>
          ) : <span className="m">{t('ai.key.unset')}</span>
        ) : <span className="m">{t('ai.key.where', { where: view.keysWhere[p.id] ?? '' })}</span>}
        <small>{t('ai.key.costs')}</small>
        {p.id === 'jev' ? <small>{t('ai.typedOnly')}</small> : null}
        {p.listError ? <small className="warnline">{t('ai.listError', { detail: p.listError })}</small> : null}
      </dd>
    </>
  );
}
