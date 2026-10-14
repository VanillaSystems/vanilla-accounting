/**
 * «Mit KI ändern…» and «KI fragen» on an object (docs/0.4.0/views.md, "AI is always marked"): the
 * sidebar opens in a new conversation with that object as its reference. Areas use this and never
 * talk to the assistant themselves.
 */
import { t } from '../i18n/index.js';
import { BotIcon } from '../areas/automation/Graph.js';
import type { AssistantMode, ContextRef } from '../../types/assistant.js';
import { askAbout } from './store.js';

export function AskAi({ context, mode = 'change' }: { context: ContextRef; mode?: AssistantMode }) {
  return (
    <button type="button" className="btn ghost askai" onClick={() => askAbout(context, mode)}>
      <BotIcon />{mode === 'change' ? t('assistant.askAbout') : t('assistant.askWhy')}
    </button>
  );
}
