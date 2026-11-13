/**
 * What booking a provider's payouts came to, in words (#404, src/server/provider-payouts.ts
 * bookPayouts): all booked, some of them, or none because «Buchen» waits for «Einschalten». The drop
 * row, Aufgaben' «Jetzt buchen» and «Einschalten» say it the same way.
 */
import { t } from '../i18n/index.js';
import type { Route } from '../shell/route.js';
import type { PayoutsBooked } from '../../types/drop.js';

/** Where the booking workflow is switched on. */
export const BOOKING_SWITCH_ON: Route = { area: 'automation', view: 'workflow', workflow: 'booking', tab: 'graph' };

export function payoutsBookedText(r: PayoutsBooked, provider: string): string {
  if (r.waits) return t('drop.booked.payoutsWait', { provider });
  if (r.booked === r.of) return t('drop.booked.payouts', { n: r.booked, provider });
  return t('drop.booked.payoutsSome', { n: r.booked, of: r.of, provider });
}
