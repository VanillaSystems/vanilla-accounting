/**
 * Firma › KI (issue #48, docs/0.4.0/ai-setup.md): which AI the app asks on this computer. The AI
 * programs on this Mac as cards (src/app/ai/CliCard.tsx), which install and sign in from here;
 * the API keys folded under «Erweitert: mit API-Schlüssel»; and a model per step, whose list holds
 * only the models that can do what it needs.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import type { AiProviderView, AiStepView, AiView } from '../../../llm/view.js';
import type { ProviderId } from '../../../llm/provider.js';
import type { Nav } from '../index.js';
import { TERMINAL_CLIS, type TerminalCli } from '../../../platform/terminal.js';
import type { Probation, SetupKey } from '../../../platform/ai-setup.js';
import { isSetupKey } from '../../../platform/ai-setup.js';
import { CliCard } from '../../ai/CliCard.js';
import { testLine, WithoutCli } from '../../ai/KeyBlock.js';
import { useAiSetup, type AiSetup } from '../../ai/useAiSetup.js';
import '../../ai/ai-setup.css';
import { TIERS } from '../../../llm/steps.js';
import { formatDate } from '../../lib/utils.js';
import { setAiOff } from '../../ai/ai-off.js';

const fits = (step: AiStepView, can: readonly string[]) => step.needs.every((n) => can.includes(n));
const usable = (p: AiProviderView) => p.state === 'ready' || p.state === 'set';
const pick = (provider: ProviderId, model: string) => `${provider} ${model}`;
const label = (r: { provider: ProviderId; model: string }) => t('ai.modelOf', { provider: t(`ai.provider.${r.provider}`), model: r.model });

export function AiSection({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
  const [view, setView] = useState<AiView>();
  const setup = useAiSetup();
  const [tests, setTests] = useState<Partial<Record<SetupKey, Probation>>>({});
  useEffect(() => { api.ai().then(setView, (e) => nav.toast(errorText(e))); }, [setup.view?.available, setup.view?.keys.map((k) => k.set).join()]);
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

  const switchOff = (off: boolean) => apply(async () => {
    const next = await api.setAiOff(off);
    setAiOff(next.off);
    return next;
  }, t(off ? 'aiOff.saved.on' : 'aiOff.saved.off'));

  return (
    <div className="ai">
      <p>{t('ai.intro')}</p>
      <div className={view.off ? 'aioff on' : 'aioff'} data-testid="ai-off">
        <label className="aicheck">
          <input type="checkbox" name="ai-off" checked={view.off} disabled={!canEdit} onChange={(e) => void switchOff(e.target.checked)} />
          {t('aiOff.switch')}
        </label>
        <small>{t(view.off ? 'aiOff.isOn' : 'aiOff.hint')}</small>
      </div>
      <Programs setup={setup} ai={view} canEdit={canEdit} apply={apply} />
      <details className="aiadv" open={view.providers.some((p) => p.state === 'set') || undefined}>
        <summary>{t('aiSetup.key.summary')}</summary>
        <div className="aiadvin">
          <p className="m">{t('aiSetup.key.firmaIntro')}</p>
          <dl className="kv2 wide">
            {view.providers.filter((p) => p.billing === 'key').map((p) => (
              <ProviderRow
                key={p.id} p={p} view={view} canEdit={canEdit} test={isSetupKey(p.id) ? tests[p.id] : undefined}
                onKey={(key) => (isSetupKey(p.id)
                  ? setup.saveKey(p.id, key).then((saved) => { setTests((x) => ({ ...x, [p.id]: saved.test })); return api.ai(); }).then(setView, (e) => nav.toast(errorText(e)))
                  : apply(() => api.setAiKey(p.id, key), t(key ? 'ai.keySaved' : 'ai.keyRemoved', { provider: t(`ai.provider.${p.id}`) })))}
              />
            ))}
          </dl>
          <small className="m">{t('aiSetup.key.where')}</small>
          <WithoutCli />
        </div>
      </details>
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
    </div>
  );
}

/**
 * «KI-Programme auf diesem Mac»: one card per CLI, installing and signing in from here. With two
 * installed, «Die App fragt» (issue #121): the one the steps and «Im Terminal» ask, and whether to
 * ask the other when it cannot answer (decision 4, off by default).
 */
function Programs({ setup, ai, canEdit, apply }: { setup: AiSetup; ai: AiView; canEdit: boolean; apply: (call: () => Promise<AiView>, done: string) => Promise<void> }) {
  const { view, cards } = setup;
  if (!view) return null;
  const installed = TERMINAL_CLIS.filter((cli) => { const card = cards[cli]; return !!card && card.kind !== 'silent' && 'bin' in card && !!card.bin; });
  const ready = TERMINAL_CLIS.filter((cli) => cards[cli]?.kind === 'ready');
  return (
    <>
      <h3>{t('aiSetup.firma.title')}</h3>
      <p className="m">{t('aiSetup.firma.plans')}</p>
      <div className="aiclis wide">
        {TERMINAL_CLIS.map((cli) => cards[cli] ? (
          <CliCard key={cli} cli={cli} state={cards[cli]!} opens={view.opens}
            actions={canEdit ? { install: () => void setup.install(cli), signIn: () => void setup.signIn(cli), again: () => setup.again(cli) } : undefined}>
            {cli === 'codex' && 'version' in cards[cli]! ? <CodexTiers view={ai} canEdit={canEdit} recheck={() => apply(api.recheckCodexModels, t('ai.codex.rechecked'))} /> : null}
          </CliCard>
        ) : null)}
      </div>
      {setup.error ? <p className="warnline">{setup.error}</p> : null}
      {installed.length > 1 ? (
        <dl className="kv2 wide aichoose">
          <dt>{t('ai.cli.asks')}</dt>
          <dd>
            <select aria-label={t('ai.cli.asks')} value={ai.cli ?? 'claude'} disabled={!canEdit}
              onChange={(e) => void apply(() => api.setAiCli({ cli: e.target.value as TerminalCli }), t('ai.cli.saved', { cli: t(`terminal.cli.${e.target.value as TerminalCli}`) }))}>
              {installed.map((cli) => <option key={cli} value={cli}>{t(`terminal.cli.${cli}`)}</option>)}
            </select>
            <label className="aicheck">
              <input type="checkbox" checked={ai.askOther} disabled={!canEdit}
                onChange={(e) => void apply(() => api.setAiCli({ askOther: e.target.checked }), t(e.target.checked ? 'ai.cli.askOtherOn' : 'ai.cli.askOtherOff'))} />
              {t('ai.cli.askOther')}
            </label>
            <small>{t('aiSetup.firma.askOtherHint')}</small>
          </dd>
        </dl>
      ) : null}
      {view.noAi && !ready.length ? <p className="m">{t('aiSetup.firma.noAiKept')} <button type="button" className="linkbtn" onClick={() => void setup.choose({ noAi: false })}>{t('aiSetup.firma.noAiUndo')}</button></p> : null}
    </>
  );
}

function ProviderRow({ p, view, canEdit, test, onKey }: { p: AiProviderView; view: AiView; canEdit: boolean; test?: Probation; onKey: (key: string | null) => Promise<void> }) {
  const [key, setKey] = useState('');
  const name = t(`ai.provider.${p.id}`);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    await onKey(key);
    setKey('');
  };
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
        {isSetupKey(p.id) ? testLine(p.id, test) : null}
        <small>{t('ai.key.costs')}</small>
        {p.id === 'jev' ? <small>{t('ai.typedOnly')}</small> : null}
        {p.listError ? <small className="warnline">{t('ai.listError', { detail: p.listError })}</small> : null}
      </dd>
    </>
  );
}

/** In the Codex card (issue #180): the model each tier takes from the ChatGPT account's list, a tier that borrows another's said so, and «Nochmals prüfen». */
function CodexTiers({ view, canEdit, recheck }: { view: AiView; canEdit: boolean; recheck: () => Promise<void> }) {
  const { tiers, checkedAt } = view.providers.find((p) => p.id === 'codex-cli') ?? {};
  if (!tiers) return null;
  return (
    <div className="aitiers">
      <b>{t('ai.codex.tiers')}</b>
      {TIERS.map((tier) => {
        const c = tiers[tier];
        const name = t(`ai.tier.${tier}`);
        return <span key={tier} className="aitier">{c.from ? t('ai.codex.borrowed', { tier: name, model: c.model, from: t(`ai.tier.${c.from}`) }) : t('ai.codex.tier', { tier: name, model: c.model })}</span>;
      })}
      <small className="m">{checkedAt ? t('ai.codex.checked', { date: formatDate(checkedAt.slice(0, 10)) }) : t('ai.codex.unchecked')}</small>
      {canEdit ? <span className="ruleacts"><button type="button" className="linkbtn" onClick={() => void recheck()}>{t('ai.codex.recheck')}</button></span> : null}
    </div>
  );
}
