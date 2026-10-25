/**
 * Firma › KI (issue #48): which AI the app asks for each step, on this computer. The providers
 * that are there (the Claude subscription through Claude Code, the ChatGPT subscription through
 * Codex, an API key kept in the keychain), which of the two CLIs the app asks (issue #121), and a
 * model per step; a step's list holds only the models that can do what it needs.
 */
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import type { AiProviderView, AiStepView, AiView } from '../../../llm/view.js';
import type { ProviderId } from '../../../llm/provider.js';
import type { Nav } from '../index.js';
import { chooseCli, type TerminalCli, type TerminalView } from '../../../platform/terminal.js';

const fits = (step: AiStepView, can: readonly string[]) => step.needs.every((n) => can.includes(n));
const usable = (p: AiProviderView) => p.state === 'ready' || p.state === 'set';
const pick = (provider: ProviderId, model: string) => `${provider} ${model}`;
const label = (r: { provider: ProviderId; model: string }) => t('ai.modelOf', { provider: t(`ai.provider.${r.provider}`), model: r.model });
const CLI_OF: Partial<Record<ProviderId, TerminalCli>> = { 'claude-cli': 'claude', 'codex-cli': 'codex' };

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
        <CliChoice view={view} canEdit={canEdit} apply={apply} />
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
                  <option value="">{s.standard.unserved ? t('ai.standard.none') : t('ai.standard', { model: label(s.standard) })}</option>
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
      <TerminalSection nav={nav} />
    </div>
  );
}

/** «Im Terminal öffnen» (issue #146): which of Claude Code and Codex this computer has, and the one the button starts when both are there. */
function TerminalSection({ nav }: { nav: Nav }) {
  const [view, setView] = useState<TerminalView>();
  useEffect(() => { api.terminal().then(setView, (e) => nav.toast(errorText(e))); }, []);
  if (!view) return null;
  const installed = view.clis.filter((c) => c.installed).map((c) => c.cli);
  const chosen = chooseCli(view.clis, view.preferred);
  return (
    <>
      <h3>{t('ai.terminal.title')}</h3>
      <p className="m">{t('ai.terminal.intro')}</p>
      <dl className="kv2 wide">
        {view.clis.map((c) => (
          <Fragment key={c.cli}>
            <dt>{t(`terminal.cli.${c.cli}`)}</dt>
            <dd>{t(!c.installed ? 'ai.terminal.missing' : c.signedIn === false ? 'ai.terminal.signedOut' : 'ai.terminal.installed')}</dd>
          </Fragment>
        ))}
        {installed.length > 1 && chosen.kind === 'open' ? (
          <>
            <dt>{t('ai.terminal.opensWith')}</dt>
            <dd>{t(`terminal.cli.${chosen.cli}`)}</dd>
          </>
        ) : null}
      </dl>
    </>
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
    const state = p.state === 'ready' ? 'ai.cli.ready' : p.state === 'signedOut' ? 'ai.cli.signedOut' : p.id === 'codex-cli' ? 'ai.cli.codexMissing' : 'ai.cli.missing';
    return (
      <>
        <dt>{name}</dt>
        <dd className={p.state === 'ready' ? '' : 'warnline'}>
          {t(state)}
          {p.id === 'codex-cli' ? <small>{t('ai.cli.noPdf')}</small> : null}
        </dd>
      </>
    );
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

/** «Die App fragt» (issue #121): with Claude Code and Codex both on this Mac, the one the steps and «Im Terminal» ask, and whether to ask the other when it cannot answer. */
function CliChoice({ view, canEdit, apply }: { view: AiView; canEdit: boolean; apply: (call: () => Promise<AiView>, done: string) => Promise<void> }) {
  const here = view.providers.filter((p) => p.billing === 'subscription' && p.state !== 'missing').flatMap((p) => CLI_OF[p.id] ?? []);
  if (here.length < 2) return null;
  const chosen = view.cli ?? 'claude';
  return (
    <>
      <dt>{t('ai.cli.asks')}</dt>
      <dd>
        <select aria-label={t('ai.cli.asks')} value={chosen} disabled={!canEdit}
          onChange={(e) => void apply(() => api.setAiCli({ cli: e.target.value as TerminalCli }), t('ai.cli.saved', { cli: t(`terminal.cli.${e.target.value as TerminalCli}`) }))}>
          {here.map((cli) => <option key={cli} value={cli}>{t(`terminal.cli.${cli}`)}</option>)}
        </select>
        <label className="m aiother">
          <input type="checkbox" checked={view.askOther} disabled={!canEdit}
            onChange={(e) => void apply(() => api.setAiCli({ askOther: e.target.checked }), t(e.target.checked ? 'ai.cli.askOtherOn' : 'ai.cli.askOtherOff'))} />
          {t('ai.cli.askOther')}
        </label>
      </dd>
    </>
  );
}
