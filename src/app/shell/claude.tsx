/**
 * Claude as the UI sees it (GET /api/claude): Firma › Claude shows the state and "Claude
 * einrichten", Belege and the inbox job's toast point there while Claude is missing. The desktop
 * app opens the official installer in a terminal window (src/desktop/claude-setup.ts); a browser
 * cannot, so it shows the commands. Each time the window gets the focus back, a Claude that is
 * not ready yet is looked for again: that is how the app notices the person came back from setup.
 */
import { useState, useSyncExternalStore } from 'react';
import { SETUP_COMMANDS, type ClaudeStatus } from '../../types/claude.js';
import { desktop } from '../desktop/bridge.js';
import { api, STATIC_EXPORT } from '../lib/api.js';
import { t } from '../i18n/index.js';
import { I } from '../areas/receipts/icons.js';
import type { Nav } from '../areas/index.js';

let status: ClaudeStatus | undefined;
let checking: Promise<void> | undefined;
const listeners = new Set<() => void>();
const connected = new Set<(version: string) => void>();

/** Looks for the CLI again (the desktop app re-reads the login shell's PATH), then asks the server. */
export function checkClaude(): Promise<void> {
  checking ??= (async () => {
    try {
      await desktop?.resolveClaude();
      const next = await api.claudeStatus();
      const was = status;
      status = next;
      if (was && was.state !== 'ready' && next.state === 'ready') connected.forEach((l) => l(next.version));
      listeners.forEach((l) => l());
    } catch { /* the server is not there yet: the next focus asks again */ }
  })().finally(() => { checking = undefined; });
  return checking;
}

function subscribe(l: () => void): () => void {
  if (!listeners.size && !STATIC_EXPORT) {
    if (!status) void checkClaude();
    window.addEventListener('focus', onFocus);
  }
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (!listeners.size) window.removeEventListener('focus', onFocus);
  };
}

function onFocus(): void {
  if (status?.state !== 'ready') void checkClaude();
}

/** The last known state; undefined until the first answer (and always in the static export). */
export function useClaude(): ClaudeStatus | undefined {
  return useSyncExternalStore(subscribe, () => status);
}

/** Calls `listener` when Claude turns ready after it was not; returns the unsubscribe. */
export function onClaudeConnected(listener: (version: string) => void): () => void {
  connected.add(listener);
  return () => { connected.delete(listener); };
}

export const toClaudeSetup = (nav: Nav) => nav.go({ route: { area: 'company', section: 'claude' }, query: {} });

/** Belege, next to "Eingang verarbeiten": shown only while Claude is missing or signed out. */
export function ClaudeHint({ nav }: { nav: Nav }) {
  const s = useClaude();
  if (!s || s.state === 'ready') return null;
  return (
    <button type="button" className="runinbox setup" data-testid="claude-setup-hint" title={t('claude.inboxHint')} onClick={() => toClaudeSetup(nav)}>
      {I.dot}{t('claude.setup')}
    </button>
  );
}

const windows = () => /Windows/.test(navigator.userAgent);

/** Firma › Claude. */
export function ClaudeSection({ nav }: { nav: Nav }) {
  const s = useClaude();
  const [opened, setOpened] = useState(false);
  const [commands, setCommands] = useState(!desktop);

  async function setUp() {
    if (desktop && await desktop.setupClaude()) setOpened(true);
    else setCommands(true);
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); nav.toast(t('claude.copied')); } catch { /* the text stays there to select */ }
  }

  const stateText = !s ? t('claude.state.checking')
    : s.state === 'missing' ? t('claude.state.missing')
    : s.state === 'signedOut' ? t('claude.state.signedOut')
    : t('claude.state.ready');
  return (
    <>
      <dl className="kv2 wide" data-testid="claude-status" data-state={s?.state ?? 'checking'}>
        <dt>{t('claude.status')}</dt>
        <dd className={s?.state === 'ready' ? 'okline' : s ? 'warnline' : ''}>
          {s?.state === 'ready' ? I.check : s ? I.dot : null}{stateText}
          {s && s.state !== 'missing' && s.version && <span className="m mono">{t('claude.version', { version: s.version })}</span>}
        </dd>
      </dl>
      <p className="m claude-why">{t('claude.why')}</p>
      {s?.state === 'missing' && s.desktopApp && <p className="m claude-why" data-testid="claude-desktop-app">{t('claude.desktopApp')}</p>}
      {s && s.state !== 'ready' && (
        <>
          <p className="claude-what">{t('claude.setupWhat')}</p>
          {commands && (
            <div className="claude-commands" data-testid="claude-commands">
              <p className="m">{desktop ? t('claude.commands') : t('claude.commandsBrowser')}</p>
              {SETUP_COMMANDS[windows() ? 'win32' : 'darwin'].map((c) => (
                <div key={c} className="cmd"><code className="mono">{c}</code><button type="button" className="btn ghost" onClick={() => void copy(c)}>{t('claude.copy')}</button></div>
              ))}
            </div>
          )}
          {opened && <p className="okline" data-testid="claude-opened">{t('claude.setupOpened')}</p>}
        </>
      )}
      <div className="fedit">
        {s && s.state !== 'ready' && desktop && <button type="button" className="btn primary" data-testid="claude-setup" onClick={() => void setUp()}>{t('claude.setup')}</button>}
        <button type="button" className="btn ghost" data-testid="claude-recheck" onClick={() => void checkClaude()}>{t('claude.recheck')}</button>
      </div>
    </>
  );
}
