/**
 * Whether the booking waits for «Einschalten» (#413), for any process: the server's routes
 * (src/server/booking-waits.ts) and the CLI (`npm run classify`) ask it before they book by the
 * firm's rules or the model. Only the app takes a workspace's first baseline (src/server/routes/
 * automation.ts engine): a process that finds no switch-on record (`seen` false) books nothing.
 */
import { existsSync } from 'node:fs';
import { loadWorkflows } from './load.js';
import { BOOKING_WORKFLOW, approvalsPath, openSwitch } from './switch-on.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';

export function bookingWaitsIn(ws: Pick<Workspace, 'paths'>): string[] | undefined {
  const booking = loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((w) => w.id === BOOKING_WORKFLOW);
  return booking ? openSwitch(ws).pending(booking)?.files : undefined;
}

/** Whether the app has seen this workspace on this computer: its switch-on record exists. */
export const switchOnSeen = (ws: Pick<Workspace, 'paths'>): boolean => existsSync(approvalsPath(ws));
