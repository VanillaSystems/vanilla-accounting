/**
 * Every step of the app that asks a model, with what it needs (issue #48). A call site names only
 * its step; the resolver (resolve.ts) picks the provider and the model that meet the step's needs:
 * the person's setting for this machine, else the default provider's model for the step's tier.
 */

/** What a model can do: answer in free text, in JSON, read an attached PDF or image, work as an agent with tools and a session. */
export type Capability = 'text' | 'json' | 'pdf' | 'image' | 'agent';

/** How much model a step needs; each provider names its model per tier. */
export type Tier = 'fast' | 'standard' | 'strong';

export interface Step {
  /** The ledger's name of the step (data/llm-ledger.jsonl), the guide section it serves. */
  ledger: string;
  tier: Tier;
  needs: readonly Capability[];
}

export const STEPS = {
  'receipt-vision': { ledger: 'receipt-intake.guide.yaml#vision', tier: 'standard', needs: ['text', 'pdf'] },
  // Haiku read the VAT facts of 100 receipts as well as Sonnet (facts-only run, #64: 85 % code exact for both) at about 1/18 of the cost.
  'receipt-vat': { ledger: 'receipt-intake.guide.yaml#vat_facts', tier: 'fast', needs: ['json'] },
  'receipt-titles': { ledger: 'receipt-intake.guide.yaml#titles', tier: 'fast', needs: ['json'] },
  'receipt-match': { ledger: 'evidence.guide.yaml#ai', tier: 'standard', needs: ['json', 'pdf'] },
  classify: { ledger: 'booking.guide.yaml#classify', tier: 'standard', needs: ['json'] },
  // Haiku proposed as well as Sonnet in the learning-loop eval (#7 M2c), at a fraction of the cost.
  'learn-rule': { ledger: 'learn.correction', tier: 'fast', needs: ['json'] },
  saving: { ledger: 'saving', tier: 'standard', needs: ['json'] },
  tutti: { ledger: 'receipt-collection.guide.yaml#tutti', tier: 'standard', needs: ['json'] },
  sidebar: { ledger: 'assistant', tier: 'standard', needs: ['agent'] },
} as const satisfies Record<string, Step>;

export type StepId = keyof typeof STEPS;

export const STEP_IDS = Object.keys(STEPS) as StepId[];

export const isStepId = (s: string): s is StepId => Object.hasOwn(STEPS, s);

/** Whether a model with these capabilities can serve the step. */
export const meets = (can: readonly Capability[], step: StepId): boolean => STEPS[step].needs.every((n) => can.includes(n));
