/** Firma's way back into the setup (docs/0.4.0/onboarding.md): open it, or continue where it stands. */
import { useEffect } from 'react';
import { t } from '../i18n/index.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { setupCount } from '../../onboarding/conversation.js';
import { loadSetup, openSetup, useSetup } from './state.js';
import './onboarding.css';

export function SetupEntry() {
  const { view } = useSetup();
  useEffect(() => { if (!view) void loadSetup(); }, [view]);
  if (!view) return null;
  const { n, of } = setupCount(view.progress, view.facts);
  const going = !!view.progress.started && n < of;
  return (
    <div className="obentry">
      <button type="button" className="aiact" data-tip={going ? t('onboarding.progress', { n, of }) : undefined} onClick={() => void openSetup()}>
        <BotIcon />{t(going ? 'onboarding.entry.continue' : 'onboarding.entry.start')}{going ? <small className="mono">{n}/{of}</small> : null}
      </button>
    </div>
  );
}
