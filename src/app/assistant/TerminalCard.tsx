/**
 * «Im Terminal öffnen» under an answer that needs more than the sidebar can do (issue #146): the
 * request written out, the button that opens Claude Code or Codex in the books folder (the other
 * one offered), the command to copy, and with neither installed a short guide to the vendors' pages.
 */
import { useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { AI_CLIS, chooseCli, copyCommand, type TerminalCli, type TerminalView } from '../../platform/terminal.js';

const nameOf = (cli: TerminalCli) => t(`terminal.cli.${cli}`);

export function TerminalCard({ request }: { request: string }) {
  const [view, setView] = useState<TerminalView>();
  const [error, setError] = useState<string>();
  const [opened, setOpened] = useState<TerminalCli>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'command' | 'request'>();
  const load = () => { setError(undefined); api.terminal().then(setView, (e) => setError(errorText(e))); };
  useEffect(load, []);
  const copy = (what: 'command' | 'request', text: string) => { void navigator.clipboard?.writeText(text).then(() => setCopied(what), () => undefined); };
  const open = (cli: TerminalCli) => {
    setBusy(true);
    setError(undefined);
    api.openTerminal(request, cli).then((r) => setOpened(r.cli), (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  const plan = view && chooseCli(view.clis, view.preferred);

  return (
    <div className="ruledraft aiterminal" data-testid="terminal-offer">
      <b>{t('terminal.title')}</b>
      <span className="m">{t('terminal.lead')}</span>
      <div className="aiterminalreq">
        <span className="rk">{t('terminal.request')}</span>
        <p>{request}</p>
        <button type="button" className="linkbtn" onClick={() => copy('request', request)}>{t(copied === 'request' ? 'terminal.copied' : 'terminal.copyRequest')}</button>
      </div>
      {plan?.kind === 'open' ? (
        <>
          {plan.signIn ? <span className="m" data-testid="terminal-sign-in">{t('terminal.signIn', { cli: nameOf(plan.cli) })}</span> : null}
          {view!.opens ? (
            <span className="ruleacts">
              <button type="button" className="btn primary" disabled={busy} data-cli={plan.cli} onClick={() => open(plan.cli)}>{t('terminal.open')}</button>
              {plan.other ? <button type="button" className="linkbtn" disabled={busy} data-cli={plan.other} onClick={() => open(plan.other!)}>{t('terminal.orWith', { cli: nameOf(plan.other) })}</button> : null}
            </span>
          ) : null}
          {opened ? <span className="m" data-testid="terminal-opened">{t('terminal.opened', { cli: nameOf(opened) })}</span> : null}
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
