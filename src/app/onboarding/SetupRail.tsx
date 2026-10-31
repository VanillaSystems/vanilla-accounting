/**
 * The setup mode of the AI sidebar (docs/0.4.0/onboarding.md): who the person talks to, and the
 * checklist as a rail of its topics, each as the app sees it (src/onboarding/conversation.ts
 * topicStates). A topic links to where it is done by hand, so the app beside the conversation
 * shows what was set up.
 */
import { useEffect } from 'react';
import { t } from '../i18n/index.js';
import { BotIcon } from '../areas/automation/Graph.js';
import type { Route } from '../shell/route.js';
import { SETUP_TOPICS, nextTopic, type SetupTopic } from '../../onboarding/model.js';
import { TOPIC_HAND, handKeys } from '../../onboarding/hand.js';
import { loadSetup, useSetup } from './state.js';
import './onboarding.css';

const label = (topic: SetupTopic) => t(`onboarding.topic.${topic}`);
const place = (topic: SetupTopic) => handKeys(topic).map((k) => t(k as 'area.company')).join(' › ');

/** The sidebar's title in setup mode. */
export function SetupTitle() {
  return (
    <span className="obwho">
      <span className="obface"><BotIcon /></span>
      <span><b>{t('onboarding.title')}</b><small>{t('onboarding.who')}</small></span>
    </span>
  );
}

export function SetupRail({ onGo }: { onGo(route: Route): void }) {
  const { view } = useSetup();
  useEffect(() => { if (!view) void loadSetup(); }, [view]);
  if (!view) return null;
  const states = view.states;
  const next = nextTopic(states);
  return (
    <div className="obtop">
      <nav className="obrail" aria-label={t('onboarding.rail')}>
        {SETUP_TOPICS.map((k) => {
          const hand = TOPIC_HAND[k];
          return (
            <button
              key={k} type="button" className={`${states[k]}${k === next ? ' next' : ''}`} disabled={!hand}
              data-tip={[`${label(k)}: ${t(`onboarding.state.${states[k]}`)}`, hand ? t('onboarding.byHand', { place: place(k) }) : t('onboarding.noHand')].join(' · ')}
              onClick={() => { if (hand) onGo(hand); }}
            ><span className="dot" />{label(k)}</button>
          );
        })}
        <span className="obcount">{t('onboarding.progress', { n: SETUP_TOPICS.filter((k) => states[k] === 'done').length, of: SETUP_TOPICS.length })}</span>
      </nav>
    </div>
  );
}
