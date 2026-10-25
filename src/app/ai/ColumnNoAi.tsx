/**
 * The KI column on a Mac where its CLI does not answer (docs/0.4.0/ai-setup.md, «Where the same
 * help appears later»): what the column needs, and the card that installs or signs in from here.
 * The composer is off meanwhile, with the reason as its placeholder. The column runs on the CLI the
 * server names (`view.sidebar`: Claude Code or Codex, src/llm/ask.ts sidebarAgent), so the card is that one's.
 */
import type { CardState } from '../../platform/ai-setup.js';
import { t } from '../i18n/index.js';
import { CliCard } from './CliCard.js';
import { useAiSetup } from './useAiSetup.js';
import './ai-setup.css';

const BLOCKED: ReadonlySet<CardState['kind']> = new Set(['missing', 'installing', 'silent', 'signedOut', 'signingIn', 'notFound']);

/** Undefined while the column's CLI answers (or before the first look); else the card to show and the composer's placeholder. */
export function useColumnNoAi(): { card: JSX.Element; placeholder: string } | undefined {
  const ai = useAiSetup();
  const cli = ai.view?.sidebar;
  const state = cli && ai.cards[cli];
  if (!ai.view || !cli || !state || !BLOCKED.has(state.kind)) return undefined;
  return {
    placeholder: t('aiSetup.side.placeholder'),
    card: (
      <div className="aisidecard" data-testid="column-no-ai">
        <p><b>{t('aiSetup.side.title')}</b> {t('aiSetup.side.lead')}</p>
        <CliCard cli={cli} state={state} opens={ai.view.opens} compact actions={{ install: () => void ai.install(cli), signIn: () => void ai.signIn(cli), again: () => ai.again(cli) }} />
        {ai.error ? <p className="warnline">{ai.error}</p> : null}
      </div>
    ),
  };
}
