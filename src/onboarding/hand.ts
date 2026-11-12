/**
 * Where a person sets up each topic by hand (MISSION: whatever the AI does, a person can also do by
 * hand): the place the setup rail links to and the prompt names. Keyed by the checklist, so a topic
 * added without its place does not compile.
 */
import type { SetupTopic } from './model.js';

/** A place of the app (a Route of src/app/shell/route.ts, which the UI's onGo checks), spelled here so the checklist stays core. */
export type HandPlace = { area: 'company'; section: 'profile' | 'vat' | 'periods' | 'opening' | 'banks' | 'sources' | 'rules' };

export const TOPIC_HAND: { readonly [T in SetupTopic]: HandPlace | null } = {
  firm: { area: 'company', section: 'vat' },
  opening: { area: 'company', section: 'opening' },
  bank: { area: 'company', section: 'banks' },
  receipts: { area: 'company', section: 'sources' },
  knowledge: { area: 'company', section: 'rules' },
};

/** The keys of the place's words as the app shows them, outermost first: «Firma › Bankkonten» is area.company, company.banks. */
export function handKeys(topic: SetupTopic): string[] {
  const r = TOPIC_HAND[topic];
  return r ? placeKeys(r) : [];
}

export const placeKeys = (place: HandPlace): string[] => ['area.company', `company.${place.section}`];
