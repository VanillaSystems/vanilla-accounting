/**
 * The KI column on a Mac where Claude Code does not answer (docs/0.4.0/ai-setup.md, «Where the same
 * help appears later»): what the column needs, and the card that installs or signs in from here.
 * The composer is off meanwhile, with the reason as its placeholder. The column runs only on
 * Claude Code (its step needs an agent), so Codex is not offered here until it is a provider (#121).
 */
import type { CardState } from '../../platform/ai-setup.js';
import { t } from '../i18n/index.js';
import { CliCard } from './CliCard.js';
import { useAiSetup } from './useAiSetup.js';
import './ai-setup.css';

const BLOCKED: ReadonlySet<CardState['kind']> = new Set(['missing', 'installing', 'silent', 'signedOut', 'signingIn', 'notFound']);

/** Undefined while Claude Code answers (or before the first look); else the card to show and the composer's placeholder. */
export function useColumnNoAi(): { card: JSX.Element; placeholder: string } | undefined {
  const ai = useAiSetup();
  const state = ai.cards.claude;
  if (!ai.view || !state || !BLOCKED.has(state.kind)) return undefined;
  return {
    placeholder: t('aiSetup.side.placeholder'),
    card: (
      <div className="aisidecard" data-testid="column-no-ai">
        <p><b>{t('aiSetup.side.title')}</b> {t('aiSetup.side.lead')}</p>
        <CliCard cli="claude" state={state} opens={ai.view.opens} compact actions={{ install: () => void ai.install('claude'), signIn: () => void ai.signIn('claude'), again: () => ai.again('claude') }} />
        {ai.error ? <p className="warnline">{ai.error}</p> : null}
      </div>
    ),
  };
}
