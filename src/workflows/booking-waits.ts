/**
 * Whether the booking waits for «Einschalten» (#413), for any process: the server's routes
 * (src/server/booking-waits.ts) and the CLI (`npm run classify`) ask it before they book by the
 * firm's rules or the model. `firstSeen`: a process that may be the first to see the workspace
 * takes what it runs today as switched on, as the app's engine does (switch-on.ts baseline).
 */
import { loadWorkflows } from './load.js';
import { BOOKING_WORKFLOW, baseline, openSwitch } from './switch-on.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';

export function bookingWaitsIn(ws: Pick<Workspace, 'paths'>, { firstSeen = false } = {}): string[] | undefined {
  const all = loadWorkflows(APP_ROOT, ws.paths.root).workflows;
  if (firstSeen) baseline(ws, all);
  const booking = all.find((w) => w.id === BOOKING_WORKFLOW);
  return booking ? openSwitch(ws).pending(booking)?.files : undefined;
}
