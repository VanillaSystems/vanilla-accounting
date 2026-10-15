/**
 * «Mit KI …» on an object (docs/0.4.0/views.md, "AI is always marked"): the
 * sidebar opens in a new conversation with that object as its reference. Areas use this and never
 * talk to the assistant themselves.
 */
import { t } from '../i18n/index.js';
import { BotIcon } from '../areas/automation/Graph.js';
import type { ContextRef } from '../../types/assistant.js';
import { askAbout } from './store.js';

export function AskAi({ context }: { context: ContextRef }) {
  return (
    <button type="button" className="btn ghost askai" onClick={() => askAbout(context)}>
      <BotIcon />{t('assistant.askAbout')}
    </button>
  );
}
