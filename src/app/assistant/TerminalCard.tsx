/**
 * «Im Terminal öffnen» under an answer that needs more than the sidebar can do (issue #146): the
 * request written out, the button that opens Claude Code or Codex in the books folder (the other
 * one offered) in the terminal app chosen on this Mac (asked once among several, issue #210), the
 * command to copy, and with neither installed a short guide to the vendors' pages. Shown from an
 * empty composer, it has no request: the CLI then starts with no prompt.
 */
import { useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { useAiOff } from '../ai/ai-off.js';
import { AI_CLIS, chooseCli, chooseTerminalApp, copyCommand, type TerminalApp, type TerminalCli, type TerminalView } from '../../platform/terminal.js';
import { TerminalAppAsk, TerminalOpened, keepApp } from './TerminalAppAsk.js';

const nameOf = (cli: TerminalCli) => t(`terminal.cli.${cli}`);

export function TerminalCard({ request }: { request: string }) {
  const [view, setView] = useState<TerminalView>();
  const [error, setError] = useState<string>();
  const [opened, setOpened] = useState<{ cli: TerminalCli; app: TerminalApp }>();
  const [asking, setAsking] = useState<{ cli: TerminalCli; apps: TerminalApp[] }>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'command' | 'request'>();
  const aiOff = useAiOff();
  const load = () => { setError(undefined); api.terminal().then(setView, (e) => setError(errorText(e))); };
  useEffect(load, []);
  const copy = (what: 'command' | 'request', text: string) => { void navigator.clipboard?.writeText(text).then(() => setCopied(what), () => undefined); };
  const start = (cli: TerminalCli, app: TerminalApp) => {
    setBusy(true);
    setError(undefined);
    setAsking(undefined);
    api.openTerminal(request, { cli, app }).then(setOpened, (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  const open = (cli: TerminalCli) => {
    const terminal = chooseTerminalApp(view!.apps, view!.app);
    if (terminal.kind === 'ask') setAsking({ cli, apps: terminal.apps }); else start(cli, terminal.app);
  };
  const pick = (app: TerminalApp, remember: boolean) => {
    const cli = asking!.cli;
    setBusy(true);
    keepApp(app, remember).then(() => start(cli, app), (e) => { setBusy(false); setError(errorText(e)); });
  };
  const plan = view && chooseCli(view.clis, view.preferred);

  return (
    <div className="ruledraft aiterminal" data-testid="terminal-offer">
      <b>{t('terminal.title')}</b>
      <span className="m">{t('terminal.lead')}</span>
      {request.trim() ? (
        <div className="aiterminalreq">
          <span className="rk">{t('terminal.request')}</span>
          <p>{request}</p>
          <button type="button" className="linkbtn" onClick={() => copy('request', request)}>{t(copied === 'request' ? 'terminal.copied' : 'terminal.copyRequest')}</button>
        </div>
      ) : null}
      {aiOff ? <span className="m" data-testid="terminal-ai-off">{t('terminal.aiOff')}</span> : plan?.kind === 'open' ? (
        <>
          {plan.signIn ? <span className="m" data-testid="terminal-sign-in">{t('terminal.signIn', { cli: nameOf(plan.cli) })}</span> : null}
          {view!.opens ? (
            <span className="ruleacts">
              <button type="button" className="btn primary" disabled={busy} data-cli={plan.cli} onClick={() => open(plan.cli)}>{t('terminal.open')}</button>
              {plan.other ? <button type="button" className="linkbtn" disabled={busy} data-cli={plan.other} onClick={() => open(plan.other!)}>{t('terminal.orWith', { cli: nameOf(plan.other) })}</button> : null}
            </span>
          ) : null}
          {asking ? <TerminalAppAsk apps={asking.apps} busy={busy} onPick={pick} /> : null}
          {opened ? <TerminalOpened cli={opened.cli} app={opened.app} testId="terminal-opened" {...(request.trim() ? {} : { suggestion: t('terminal.handover.empty') })} /> : null}
          <details className="aiterminalcmd" open={!view!.opens}>
            <summary>{t('terminal.command', { cli: nameOf(plan.cli) })}</summary>
            <code>{copyCommand(view!.folder, plan.cli, request)}</code>
            <button type="button" className="linkbtn" onClick={() => copy('command', copyCommand(view!.folder, plan.cli, request))}>{t(copied === 'command' ? 'terminal.copied' : 'terminal.copyCommand')}</button>
          </details>
        </>
      ) : plan?.kind === 'install' ? (
        <div className="aiterminalinstall" data-testid="terminal-install">
          <span>{t('terminal.install.lead')}</span>
          <ul>
            {(['claude', 'codex'] as const).map((cli) => (
              <li key={cli}><a href={AI_CLIS[cli].guide} target="_blank" rel="noopener noreferrer">{t('terminal.install.link', { cli: nameOf(cli) })}</a></li>
            ))}
          </ul>
          <span className="m">{t('terminal.install.after')}</span>
          <span className="ruleacts"><button type="button" className="btn" onClick={load}>{t('terminal.install.again')}</button></span>
        </div>
      ) : null}
      {error ? <div className="warnline">{error}</div> : null}
    </div>
  );
}
