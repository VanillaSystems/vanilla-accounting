/**
 * The CLI card (docs/0.4.0/ai-setup.md, «The flow»): one program, its vendor, its state, the
 * minimum plan and one action. The same card stands in the setup conversation, Firma › KI and the
 * KI column; `actions` puts the buttons into the card (in the conversation the answers below it
 * are the buttons). Before anything is installed the card says in plain words what the program
 * needs and what will happen (an account with the vendor, a paid plan, Terminal, a sign-in in the
 * browser in English, that it can wait); the vendor's command stays folded under «Befehl zeigen»
 * until the person asks for it or installs, so copying it still works the same as Terminal.
 */
import { useState, type ReactNode } from 'react';
import { planName, type CardState } from '../../platform/ai-setup.js';
import { AI_CLIS, type TerminalCli } from '../../platform/terminal.js';
import { t } from '../i18n/index.js';
import { ICONS } from '../areas/icons.js';

export interface CardActions {
  install(): void;
  signIn(): void;
  again(): void;
}

const dirOf = (bin: string) => bin.slice(0, bin.lastIndexOf('/')) || bin;

function Pill({ state }: { state: CardState }) {
  switch (state.kind) {
    case 'missing': return <span className="aipill">{t('aiSetup.pill.missing')}</span>;
    case 'installing': return <span className="aipill now"><span className="aispin" aria-hidden="true" />{t('aiSetup.pill.installing')}</span>;
    case 'silent': return <span className="aipill warn">{t('aiSetup.pill.silent')}</span>;
    case 'signedOut': return <span className="aipill now">{t('aiSetup.pill.signedOut')}</span>;
    case 'signingIn': return <span className="aipill now"><span className="aispin" aria-hidden="true" />{t('aiSetup.pill.signingIn')}</span>;
    case 'testing': return <span className="aipill now"><span className="aispin" aria-hidden="true" />{t('aiSetup.pill.testing')}</span>;
    case 'ready': return <span className="aipill ok">{ICONS.check}{t('aiSetup.pill.ready')}</span>;
    case 'refused': return <span className="aipill warn">{t(state.why === 'limit' ? 'aiSetup.pill.limit' : 'aiSetup.pill.refused')}</span>;
    case 'notFound': return <span className="aipill warn">{t('aiSetup.pill.notFound')}</span>;
  }
}

/** The vendor's command, to copy. */
export function Command({ cli }: { cli: TerminalCli }) {
  const [copied, setCopied] = useState(false);
  const { install } = AI_CLIS[cli];
  return (
    <div className="aicmd">
      <code>{install}</code>
      <button type="button" className="linkbtn" onClick={() => void navigator.clipboard?.writeText(install).then(() => setCopied(true), () => undefined)}>{t(copied ? 'terminal.copied' : 'aiSetup.copy')}</button>
    </div>
  );
}

/**
 * What a program not yet on this Mac needs and what «installieren» does, before Terminal opens; the
 * plan and its price come from the one table of CLI facts. The command is folded, open only where
 * the app cannot open Terminal itself and copying is the way.
 */
function Needs({ cli, opens }: { cli: TerminalCli; opens: boolean }) {
  const { vendor, minPlan, minPlanUsd, plans } = AI_CLIS[cli];
  return (
    <>
      <p className="m" data-needs={cli}>{t('aiSetup.needs.account', { vendor, plan: minPlan, usd: minPlanUsd })} <a className="linkbtn" href={plans} target="_blank" rel="noopener noreferrer">{t('aiSetup.plans', { vendor })}{ICONS.external}</a></p>
      <p className="m">{t(opens ? 'aiSetup.needs.steps' : 'aiSetup.needs.stepsCopy', { vendor })}</p>
      <p className="m">{t('aiSetup.needs.later')}</p>
      <details className="aishow" open={!opens || undefined}>
        <summary>{t('aiSetup.needs.showCommand')}</summary>
        <p className="m">{t('aiSetup.installer', { vendor })}</p>
        <Command cli={cli} />
      </details>
    </>
  );
}

/**
 * What the sign-in shows a person who has no account yet (#385), said before the browser opens: the
 * vendor's page in English, the account made there, the plan the card named, and that the app notices
 * the sign-in by itself. Facts from AI_CLIS only.
 */
export function NoAccount({ cli }: { cli: TerminalCli }) {
  const { vendor, minPlan, minPlanUsd, plans } = AI_CLIS[cli];
  return <p className="m" data-no-account={cli}>{t('aiSetup.noAccount', { vendor, plan: minPlan, usd: minPlanUsd })} <a className="linkbtn" href={plans} target="_blank" rel="noopener noreferrer">{t('aiSetup.plans', { vendor })}{ICONS.external}</a></p>;
}

const Facts = ({ state }: { state: Extract<CardState, { version: string }> }) => (
  <dl className="aifacts">
    {state.kind !== 'signedOut' && state.kind !== 'signingIn' ? <><dt>{t('aiSetup.fact.signedIn')}</dt><dd>{'plan' in state && state.plan ? planName(state.plan) : t('aiSetup.fact.yes')}</dd></> : null}
    <dt>{t('aiSetup.fact.version')}</dt><dd className="mono">{state.version}</dd>
    {state.kind === 'signedOut' ? <><dt>{t('aiSetup.fact.place')}</dt><dd className="mono">{dirOf(state.bin)}</dd></> : null}
    {state.kind === 'ready' && state.ms !== undefined ? <><dt>{t('aiSetup.fact.test')}</dt><dd>{t('aiSetup.fact.answered', { seconds: (state.ms / 1000).toFixed(1) })}</dd></> : null}
  </dl>
);

/** `children`: what a place adds at the card's foot (Firma › KI: Codex's model per tier). */
export function CliCard({ cli, state, opens, compact, actions, children }: { cli: TerminalCli; state: CardState; opens: boolean; compact?: boolean; actions?: CardActions; children?: ReactNode }) {
  const facts = AI_CLIS[cli];
  const vendor = facts.vendor;
  const guide = <a className="linkbtn" href={facts.guide} target="_blank" rel="noopener noreferrer">{t('aiSetup.guide', { vendor })}{ICONS.external}</a>;
  const installButton = actions && opens ? <button type="button" className="btn primary" data-act={`install-${cli}`} onClick={actions.install}>{ICONS.terminal}{t('aiSetup.installInTerminal')}</button> : null;
  return (
    <div className={compact ? 'aicli compact' : 'aicli'} data-cli={cli} data-state={state.kind}>
      <div className="aiclihd"><b>{t(`terminal.cli.${cli}`)}</b><span className="aivendor">{t('aiSetup.vendor', { vendor })}</span><Pill state={state} /></div>
      {state.kind !== 'ready' && state.kind !== 'testing' && state.kind !== 'missing' ? (
        <p className="aiplan">{t(`aiSetup.plan.${cli}`)} <a className="linkbtn" href={facts.plans} target="_blank" rel="noopener noreferrer">{t('aiSetup.plans', { vendor })}{ICONS.external}</a></p>
      ) : null}
      {state.kind === 'missing' ? (
        <>
          <Needs cli={cli} opens={opens} />
          {actions ? <span className="ruleacts">{installButton}{guide}</span> : null}
        </>
      ) : state.kind === 'installing' ? (
        <>
          <p className="m">{t(opens ? 'aiSetup.installing.lead' : 'aiSetup.installing.copy', { vendor })}</p>
          {/* Folded as before the click (#385): Terminal has the command already; open only where copying is the way. */}
          <details className="aishow" open={!opens || undefined}>
            <summary>{t('aiSetup.needs.showCommand')}</summary>
            <Command cli={cli} />
          </details>
          <p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.installing.wait', { cli: t(`terminal.cli.${cli}`) })}</p>
        </>
      ) : state.kind === 'silent' ? (
        <>
          <p className="warnline">{t('aiSetup.silent', { cli: t(`terminal.cli.${cli}`), place: dirOf(state.bin) })}</p>
          {actions ? <span className="ruleacts"><button type="button" className="btn" onClick={actions.again}>{t('aiSetup.again')}</button>{guide}</span> : null}
        </>
      ) : state.kind === 'signedOut' ? (
        <>
          <Facts state={state} />
          <p className="m">{t('aiSetup.signedOut.lead', { vendor })}</p>
          {compact ? null : <NoAccount cli={cli} />}
          {actions && opens ? <span className="ruleacts"><button type="button" className="btn primary" data-act={`signin-${cli}`} onClick={actions.signIn}>{ICONS.terminal}{t('aiSetup.signIn')}</button></span> : null}
        </>
      ) : state.kind === 'signingIn' ? (
        <p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.signingIn.wait')}</p>
      ) : state.kind === 'testing' ? (
        <>
          <Facts state={state} />
          <p className="aiwait"><span className="aispin" aria-hidden="true" />{t('aiSetup.testing')}</p>
        </>
      ) : state.kind === 'ready' ? (
        <>
          <Facts state={state} />
          {actions ? <span className="ruleacts"><button type="button" className="linkbtn" onClick={actions.again}>{t('aiSetup.again')}</button></span> : null}
        </>
      ) : state.kind === 'refused' ? (
        <>
          <Facts state={state} />
          <p className="warnline">{t(`aiSetup.refused.${state.why}`, { said: state.said })}</p>
          {actions ? (
            <span className="ruleacts">
              <button type="button" className="btn" onClick={actions.again}>{t('aiSetup.again')}</button>
              {opens ? <button type="button" className="linkbtn" onClick={actions.signIn}>{t('aiSetup.otherAccount')}</button> : null}
            </span>
          ) : null}
        </>
      ) : (
        <>
          <p className="warnline">{t(state.waited === 'install' ? 'aiSetup.notFound.install' : 'aiSetup.notFound.signIn', { cli: t(`terminal.cli.${cli}`) })}</p>
          {state.looked.length ? <small className="m">{t('aiSetup.notFound.looked', { places: state.looked.join(', ') })}</small> : null}
          {actions ? <span className="ruleacts"><button type="button" className="btn" onClick={actions.again}>{t('aiSetup.again')}</button>{guide}</span> : null}
        </>
      )}
      {children}
    </div>
  );
}
