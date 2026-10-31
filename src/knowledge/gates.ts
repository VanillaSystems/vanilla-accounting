/**
 * Gate tests: rules that hold for every counterparty and run before any of
 * them. A guide gate with `test: <name>` is evaluated by code, so routing can
 * never filter it out and the model never sees it; a gate without `test` is
 * rendered at the top of every prompt for its step. The lint checks that every
 * `test:` in a guide names an entry here.
 *
 * Predicates arrive with decide() (docs/adr/0002); until then this is the one
 * list both the lint and that code read.
 */
export const GATE_TESTS = [
  'closed-period', // transaction dated on or before config.closedThrough
  'unsettled', // transaction's evidence state is not settled
  'no-receipt', // transaction has no linked receipt
  'wise-fee', // a fee row of the bank (src/booking/separate-fee.ts isBankFee); the name predates the account's fee
  'own-transfer', // money between two of our own accounts
  'human-answered', // a person already decided this item
] as const;

export type GateTest = (typeof GATE_TESTS)[number];
