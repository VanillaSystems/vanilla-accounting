/** Firma's way back into the setup (docs/0.4.0/onboarding.md): open it, or continue where it stands. */
import { useEffect } from 'react';
import { t } from '../i18n/index.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { SETUP_TOPICS, settledCount } from '../../onboarding/model.js';
import { loadSetup, openSetup, useSetup } from './state.js';
import './onboarding.css';

export function SetupEntry() {
  const { view } = useSetup();
  useEffect(() => { if (!view) void loadSetup(); }, [view]);
  if (!view) return null;
  const going = !!view.progress.started && settledCount(view.states) < SETUP_TOPICS.length;
  const n = settledCount(view.states);
  return (
    <div className="obentry">
      <button type="button" className="aiact" data-tip={going ? t('onboarding.progress', { n, of: SETUP_TOPICS.length }) : undefined} onClick={() => void openSetup()}>
        <BotIcon />{t(going ? 'onboarding.entry.continue' : 'onboarding.entry.start')}{going ? <small className="mono">{n}/{SETUP_TOPICS.length}</small> : null}
      </button>
    </div>
  );
}
