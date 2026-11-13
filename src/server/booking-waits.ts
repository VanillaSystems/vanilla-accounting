/**
 * Whether the booking waits for «Einschalten» (#413): the files of its company part that changed
 * since a person switched it on (src/workflows/switch-on.ts), or undefined while it runs as switched
 * on. Every path that books by the firm's rules or the model asks this first and books nothing
 * while it waits: the inbox's book step (through the engine's `waits`), the sales report of a drop,
 * «Automatisch buchen» for all, «Neu buchen», a rule kept while another change waits, a provider's
 * payouts, `npm run classify`. The UI says why in one sentence with «Einschalten» at hand
 * (src/app/automation/booking-waits.tsx).
 */
import { WS } from './books.js';
import { bookingWaitsIn } from '../workflows/booking-waits.js';

export const bookingWaits = (): string[] | undefined => bookingWaitsIn(WS);
