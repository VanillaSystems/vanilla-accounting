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

/**
 * Where what a setup answer set up is changed by hand (#385), for an answer the kind of firm assumed:
 * the VAT setup in its section of Firma, the opening on Firma › Eröffnung, the owner's account (paid privately)
 * among the money accounts, the accounts an answer added (legal form, imports, payouts) in the chart,
 * own use as a rule. Null: the answer sets up nothing that changes later (customers abroad, staff),
 * or only the setup conversation asks it again («Was verkauft ihr?», «Etwas ändern»).
 */
export const ANSWER_HAND: { readonly [K in QuestionKey]: HandPlace | null } = {
  legalForm: { area: 'company', section: 'accounts' },
  vatRegistered: { area: 'company', section: 'vat' },
  vatMethod: { area: 'company', section: 'vat' },
  basis: { area: 'company', section: 'vat' },
  period: { area: 'company', section: 'vat' },
  fiscalYear: { area: 'company', section: 'periods' },
  start: { area: 'company', section: 'opening' },
  sells: null,
  foreignCustomers: null,
  imports: { area: 'company', section: 'accounts' },
  employees: null,
  ownerPaysPrivately: { area: 'company', section: 'banks' },
  privateUse: { area: 'company', section: 'rules' },
  payouts: { area: 'company', section: 'accounts' },
};

/** The keys of the place's words as the app shows them, outermost first: «Firma › Bankkonten» is area.company, company.banks. */
export function handKeys(topic: SetupTopic): string[] {
  const r = TOPIC_HAND[topic];
  return r ? placeKeys(r) : [];
}

export const placeKeys = (place: HandPlace): string[] => ['area.company', `company.${place.section}`];
