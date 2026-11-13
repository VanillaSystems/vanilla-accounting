/**
 * Whether the booking waits for «Einschalten» (#413): the files of its company part that changed
 * since a person switched it on (src/workflows/switch-on.ts), or undefined while it runs as switched
 * on. Every path that books by the firm's rules or the model asks this first and books nothing
 * while it waits: the inbox's book step (through the engine's `waits`), the sales report of a drop,
 * «Automatisch buchen» for all, «Neu buchen», a rule kept while another change waits, a provider's
 * payouts. The UI says why in one sentence with «Einschalten» at hand (src/app/lib/booking-waits.tsx).
 */
import { WS } from './books.js';
import { loadWorkflows } from '../workflows/load.js';
import { BOOKING_WORKFLOW, openSwitch } from '../workflows/switch-on.js';
import { APP_ROOT } from '../workspace/workspace.js';

export function bookingWaits(): string[] | undefined {
  const booking = loadWorkflows(APP_ROOT, WS.paths.root).workflows.find((w) => w.id === BOOKING_WORKFLOW);
  return booking ? openSwitch(WS).pending(booking)?.files : undefined;
}
