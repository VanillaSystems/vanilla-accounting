/**
 * «Im Terminal weitermachen» in the composer (issue #146 follow-up, #210): when the chat is not
 * enough, one click opens Claude Code or Codex in the books folder by the same way as the card under
 * an answer (POST /api/terminal/open), in the terminal app chosen on this Mac (asked once when there
 * are several), with what src/assistant/handover.ts hands over. A chat with no request of the
 * person's starts the CLI with no prompt and shows the app's suggestion to copy. With neither CLI
 * installed it shows the card's install guide. Only where the app opens a terminal (the API answers
 * and says `opens`): not in the static export, not off the Mac, not with the AI switched off.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { ICONS } from '../areas/icons.js';
import { chooseCli, chooseTerminalApp, type TerminalApp, type TerminalCli, type TerminalView } from '../../platform/terminal.js';
import { TerminalCard } from './TerminalCard.js';
import { useAiOff } from '../ai/ai-off.js';
import { TerminalAppAsk, TerminalOpened, keepApp } from './TerminalAppAsk.js';

type Shown =
  | { kind: 'install'; request: string }
  | { kind: 'ask'; apps: TerminalApp[]; request: string }
  | { kind: 'opened'; cli: TerminalCli; app: TerminalApp; suggestion?: string }
  | { kind: 'error'; text: string };

export function TerminalButton({ request }: { request(): string }) {
  const [view, setView] = useState<TerminalView>();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown>();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const aiOff = useAiOff();
  useEffect(() => { api.terminal().then(setView, () => undefined); }, []);
  useEffect(() => {
    if (!shown) return;
    const away = (e: MouseEvent) => { const at = e.target as Node; if (!box.current?.contains(at) && !button.current?.contains(at)) setShown(undefined); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [shown]);
  // With the AI switched off (issue #212) Terminal's AI is not started either.
  if (!view?.opens || aiOff) return null;

  const open = (text: string, app: TerminalApp) => {
    setBusy(true);
    api.openTerminal(text, { app })
      .then((r) => setShown({ kind: 'opened', cli: r.cli, app: r.app, ...(text ? {} : { suggestion: t('terminal.handover.empty') }) }), (e) => setShown({ kind: 'error', text: errorText(e) }))
      .finally(() => setBusy(false));
  };

  const go = async () => {
    const text = request();
    const fresh = await api.terminal().catch(() => view);
    setView(fresh);
    if (chooseCli(fresh.clis, fresh.preferred).kind === 'install') { setShown({ kind: 'install', request: text }); return; }
    const terminal = chooseTerminalApp(fresh.apps, fresh.app);
    if (terminal.kind === 'ask') { setShown({ kind: 'ask', apps: terminal.apps, request: text }); return; }
    open(text, terminal.app);
  };

  const pick = (text: string) => (app: TerminalApp, remember: boolean) => {
    setBusy(true);
    keepApp(app, remember).then(() => open(text, app), (e) => { setBusy(false); setShown({ kind: 'error', text: errorText(e) }); });
  };

  return (
    <>
      <button
        ref={button} type="button" className="aimic aiterm" data-testid="terminal-composer" disabled={busy}
        aria-label={t('terminal.title')} onClick={() => void go()}
      >{ICONS.terminal}</button>
      {shown ? (
        <div ref={box} className="aitermpop" role="status" onKeyDown={(e) => { if (e.key === 'Escape') setShown(undefined); }}>
          {shown.kind === 'install' ? <TerminalCard request={shown.request} />
            : shown.kind === 'ask' ? <TerminalAppAsk apps={shown.apps} busy={busy} onPick={pick(shown.request)} />
            : shown.kind === 'opened' ? <TerminalOpened cli={shown.cli} app={shown.app} suggestion={shown.suggestion} testId="terminal-composer-opened" />
            : <span className="warnline">{shown.text}</span>}
        </div>
      ) : null}
    </>
  );
}
