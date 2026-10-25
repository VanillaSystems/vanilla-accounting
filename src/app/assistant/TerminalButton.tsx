/**
 * «Im Terminal weitermachen» in the composer (issue #146 follow-up): when the chat is not enough,
 * one click opens Claude Code or Codex in the books folder by the same way as the card under an
 * answer (POST /api/terminal/open), with what src/assistant/handover.ts hands over. With neither
 * CLI installed it shows the card's install guide. Only where the app opens Terminal (the API
 * answers and says `opens`): not in the static export, not off the Mac.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { api, errorText } from '../lib/api.js';
import { ICONS } from '../areas/icons.js';
import { chooseCli, type TerminalCli, type TerminalView } from '../../platform/terminal.js';
import { TerminalCard } from './TerminalCard.js';

type Shown = { kind: 'install'; request: string } | { kind: 'opened'; cli: TerminalCli } | { kind: 'error'; text: string };

export function TerminalButton({ request }: { request(): string }) {
  const [view, setView] = useState<TerminalView>();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown>();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { api.terminal().then(setView, () => undefined); }, []);
  useEffect(() => {
    if (!shown) return;
    const away = (e: MouseEvent) => { const at = e.target as Node; if (!box.current?.contains(at) && !button.current?.contains(at)) setShown(undefined); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [shown]);
  if (!view?.opens) return null;

  const go = async () => {
    const text = request() || t('terminal.handover.empty');
    const fresh = await api.terminal().catch(() => view);
    setView(fresh);
    if (chooseCli(fresh.clis, fresh.preferred).kind === 'install') { setShown({ kind: 'install', request: text }); return; }
    setBusy(true);
    api.openTerminal(text).then((r) => setShown({ kind: 'opened', cli: r.cli }), (e) => setShown({ kind: 'error', text: errorText(e) })).finally(() => setBusy(false));
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
            : shown.kind === 'opened' ? <span className="m" data-testid="terminal-composer-opened">{t('terminal.opened', { cli: t(`terminal.cli.${shown.cli}`) })}</span>
            : <span className="warnline">{shown.text}</span>}
        </div>
      ) : null}
    </>
  );
}
