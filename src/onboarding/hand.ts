/**
 * Where a person sets up each topic by hand (MISSION: whatever the AI does, a person can also do by
 * hand): the place the setup rail links to and the prompt names. Keyed by the checklist, so a topic
 * added without its place does not compile.
 */
import type { SetupTopic } from './model.js';
import type { QuestionKey } from '../workspace/setup.js';

/** A place of the app (a Route of src/app/shell/route.ts, which the UI's onGo checks), spelled here so the checklist stays core. */
export type HandPlace = { area: 'company'; section: 'profile' | 'vat' | 'periods' | 'opening' | 'banks' | 'accounts' | 'sources' | 'rules' };

export const TOPIC_HAND: { readonly [T in SetupTopic]: HandPlace | null } = {
  firm: { area: 'company', section: 'vat' },
  opening: { area: 'company', section: 'opening' },
  bank: { area: 'company', section: 'banks' },
  receipts: { area: 'company', section: 'sources' },
  knowledge: { area: 'company', section: 'rules' },
};

/** What an answer set up elsewhere, named on its link (#387 review): the link leads to that, not to the answer. */
export type AnswerConsequence = 'ownerAccount' | 'accounts' | 'opening' | 'ownUse';

/**
 * Where a setup answer the kind of firm assumed can be changed by hand (#385): the VAT setup is the
 * setting itself; for others only what the answer set up can be changed, and the link names it
 * (`what`). Null where nothing in the app changes it (the legal form, the fiscal year), or nothing was
 * set up (customers abroad, staff), or only the setup conversation asks it again («Was verkauft ihr?»).
 */
export const ANSWER_HAND: { readonly [K in QuestionKey]: { go: HandPlace; what?: AnswerConsequence } | null } = {
  legalForm: null,
  vatRegistered: { go: { area: 'company', section: 'vat' } },
  vatMethod: { go: { area: 'company', section: 'vat' } },
  basis: { go: { area: 'company', section: 'vat' } },
  period: { go: { area: 'company', section: 'vat' } },
  fiscalYear: null,
  start: { go: { area: 'company', section: 'opening' }, what: 'opening' },
  sells: null,
  foreignCustomers: null,
  imports: { go: { area: 'company', section: 'accounts' }, what: 'accounts' },
  employees: null,
  ownerPaysPrivately: { go: { area: 'company', section: 'banks' }, what: 'ownerAccount' },
  privateUse: { go: { area: 'company', section: 'rules' }, what: 'ownUse' },
  payouts: { go: { area: 'company', section: 'accounts' }, what: 'accounts' },
};

/**
 * Of the answers the setup did not ask and filled with their `later` answer (#452), those the books
 * mark as assumed: the ones she can change somewhere. The fiscal year and the customers abroad have
 * no place, so a «stimmt» on them would ask her to check what she cannot change.
 */
export const assumedLater = (filled: readonly QuestionKey[]): QuestionKey[] => filled.filter((k) => ANSWER_HAND[k] !== null);

/** The keys of the place's words as the app shows them, outermost first: «Firma › Bankkonten» is area.company, company.banks. */
export function handKeys(topic: SetupTopic): string[] {
  const r = TOPIC_HAND[topic];
  return r ? placeKeys(r) : [];
}

export const placeKeys = (place: HandPlace): string[] => ['area.company', `company.${place.section}`];
