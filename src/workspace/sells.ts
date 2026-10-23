/**
 * The default accounts of «Was verkauft ihr?» (#46, the setup's `sells`): what the firm buys for its
 * own production goes on material, goods for resale on Handelswaren; its sales of own products,
 * traded goods and services each on their revenue account (modules/ch/setup.yaml `sells`). A
 * supplier or customer can still differ by its own rule; the classifier gets them as context.
 */
import { setup } from '../engines/index.js';
import type { SalesKind } from './setup.js';

/** The default accounts of the kinds, in the kinds' order: purchases (none for services) and sales. */
export interface SalesDefaults { kinds: SalesKind[]; purchase: Array<{ kind: SalesKind; account: string }>; sales: Array<{ kind: SalesKind; account: string }> }

export function salesDefaults(kinds: readonly SalesKind[]): SalesDefaults {
  const table = setup().sells;
  return {
    kinds: [...kinds],
    purchase: kinds.flatMap((kind) => (table[kind].purchase ? [{ kind, account: table[kind].purchase! }] : [])),
    sales: kinds.map((kind) => ({ kind, account: table[kind].sales })),
  };
}

/** The revenue account a payout's gross sales go on when no rule names the provider: the one kind's, else the table's for several. */
export function payoutSales(kinds: readonly SalesKind[]): string {
  const { sells, answers } = setup();
  return kinds.length === 1 ? sells[kinds[0]].sales : answers.payouts.sales.otherwise;
}
