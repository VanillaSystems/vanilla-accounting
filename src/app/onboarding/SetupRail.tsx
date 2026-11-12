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
import { setupCount, shownState, topicsTaken } from '../../onboarding/conversation.js';
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
  const count = setupCount(view.progress, view.facts);
  // The chips are what the count counts (#385): «Partner und Wissen» shows once the conversation takes it up, with the first bookings.
  const taken = topicsTaken(view.progress, view.facts);
  return (
    <div className="obtop">
      <nav className="obrail" aria-label={t('onboarding.rail')}>
        {SETUP_TOPICS.filter((k) => taken.includes(k)).map((k) => {
          const hand = TOPIC_HAND[k];
          return (
            <button
              key={k} type="button" className={`${states[k]}${k === next ? ' next' : ''}`} disabled={!hand}
              data-tip={[`${label(k)}: ${t(`onboarding.state.${shownState(view.progress, view.facts, k)}`)}`, ...(hand ? [t('onboarding.byHand', { place: place(k) })] : [])].join(' · ')}
              onClick={() => { if (hand) onGo(hand); }}
            ><span className="dot" />{label(k)}</button>
          );
        })}
        {/* Every topic the conversation is through counts, done or left for later, so the count moves with each answer (#345); one it did not take up is not counted (#364). */}
        <span className="obcount" data-progress>{t('onboarding.progress', count)}</span>
      </nav>
    </div>
  );
}
