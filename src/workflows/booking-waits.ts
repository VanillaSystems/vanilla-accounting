/**
 * Whether the booking waits for «Einschalten» (#413), for any process: the server's routes
 * (src/server/booking-waits.ts) and the CLI (`npm run classify`) ask it before they book by the
 * firm's rules or the model. Only the app takes the first baseline of a workspace it finds
 * (src/server/routes/automation.ts engine), and the creation of a new one (`npm run init`, the
 * desktop's setup) writes it (switchOnCreated): a process that finds no switch-on record (`seen`
 * false) books nothing.
 */
import { existsSync } from 'node:fs';
import { loadWorkflows } from './load.js';
import { BOOKING_WORKFLOW, approvalsPath, baseline, brokenPart, openSwitch } from './switch-on.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';

export function bookingWaitsIn(ws: Pick<Workspace, 'paths'>): string[] | undefined {
  const loaded = loadWorkflows(APP_ROOT, ws.paths.root);
  // Its overlay does not load: it waits (fail closed), with the file that cannot be read first.
  const broken = brokenPart(BOOKING_WORKFLOW, ws.paths.root, loaded.problems);
  if (broken) return broken;
  const booking = loaded.workflows.find((w) => w.id === BOOKING_WORKFLOW);
  return booking ? openSwitch(ws).pending(booking)?.files : undefined;
}

/** Whether the app has seen this workspace on this computer: its switch-on record exists. */
export const switchOnSeen = (ws: Pick<Workspace, 'paths'>): boolean => existsSync(approvalsPath(ws));

/**
 * A workspace a person just created (`npm run init`, the desktop's setup): she made it and its
 * rules, so what it runs is switched on, its baseline written now. Never for a workspace merely
 * found: that gets its baseline only from the app.
 */
export function switchOnCreated(ws: Pick<Workspace, 'paths'>): void {
  baseline(ws, loadWorkflows(APP_ROOT, ws.paths.root).workflows);
}
