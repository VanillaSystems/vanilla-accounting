/**
 * The terminal app's question and the note after opening (issue #210). With several terminal apps
 * on this Mac and none chosen, the first click asks «In welchem Terminal öffnen?» with the apps
 * found as buttons and «merken» on: kept, the choice lies in Firma › KI beside the CLI's. Opened
 * without a request of the person's, the CLI waits for their own words; the app's suggestion is
 * shown to copy, never sent (neither Claude Code nor Codex can prefill its input).
 */
import { useState } from 'react';
import { t } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { TERMINAL_APP_FACTS, type TerminalApp, type TerminalCli } from '../../platform/terminal.js';

export function TerminalAppAsk({ apps, busy, onPick }: { apps: readonly TerminalApp[]; busy?: boolean; onPick(app: TerminalApp, remember: boolean): void }) {
  const [remember, setRemember] = useState(true);
  return (
    <div className="aitermask" data-testid="terminal-app-ask">
      <b>{t('terminal.app.ask')}</b>
      <span className="ruleacts">
        {apps.map((app) => (
          <button key={app} type="button" className="btn" data-app={app} disabled={busy} onClick={() => onPick(app, remember)}>{TERMINAL_APP_FACTS[app].name}</button>
        ))}
      </span>
      <label>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {t('terminal.app.remember')}
      </label>
    </div>
  );
}

/** Kept on this Mac when `remember`; the open goes on either way. */
export const keepApp = (app: TerminalApp, remember: boolean): Promise<unknown> => (remember ? api.setTerminalApp(app) : Promise.resolve());

/** «Claude Code ist in iTerm2 geöffnet …»; without a request, the suggestion to copy. */
export function TerminalOpened({ cli, app, suggestion, testId }: { cli: TerminalCli; app: TerminalApp; suggestion?: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const names = { cli: t(`terminal.cli.${cli}`), app: TERMINAL_APP_FACTS[app].name };
  if (!suggestion) return <span className="m" data-testid={testId}>{t('terminal.opened', names)}</span>;
  return (
    <div className="aitermsuggest" data-testid={testId}>
      <span className="m">{t('terminal.openedEmpty', names)}</span>
      <span className="rk">{t('terminal.suggestion')}</span>
      <p>{suggestion}</p>
      <button type="button" className="linkbtn" onClick={() => { void navigator.clipboard?.writeText(suggestion).then(() => setCopied(true), () => undefined); }}>
        {t(copied ? 'terminal.copied' : 'terminal.copySuggestion')}
      </button>
    </div>
  );
}
