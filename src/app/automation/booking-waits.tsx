/**
 * «Buchen» waits for «Einschalten» (#413): the one sentence every place says where she tries to
 * book meanwhile (the drop, «Eingang verarbeiten», «Automatisch buchen», a payout, a rule kept, «Neu
 * buchen»): what changed (the files, as the switch-on page names them), why the app waits (it books
 * with no rule she has not seen) and what ends it, with «Einschalten» right there. Switched on, the
 * server books what waited (src/server/provider-payouts.ts bookWhatWaited).
 */
import { useState } from 'react';
import { t } from '../i18n/index.js';
import { automationCommand, useAutomation } from './store.js';
import { commandRefusalText } from './refusal.js';
import { BOOKING_SWITCH_ON } from '../lib/payouts.js';
import { errorText } from '../lib/api.js';
import { bookingWaitsText } from '../lib/booking-waits.js';
import type { AutomationView } from '../../workflows/model.js';
import type { PayoutsBooked } from '../../types/drop.js';
import type { Route } from '../shell/route.js';

export const BOOKING_WORKFLOW = 'booking';

/** The files the booking waits for «Einschalten» with, or undefined while it runs as switched on. */
export const bookingWaitsOf = (view: AutomationView | undefined): string[] | undefined => view?.pending.find((p) => p.workflow === BOOKING_WORKFLOW)?.files;


/** What switching the booking on came to, in the words of the switch-on page. */
export async function switchBookingOn(): Promise<string> {
  const r = await automationCommand({ kind: 'approve', workflow: BOOKING_WORKFLOW });
  if (!r.ok) return commandRefusalText(r);
  const p = (r as { payouts?: PayoutsBooked }).payouts;
  return p ? t('automation.pending.onPayouts', { n: p.booked, of: p.of }) : t('automation.pending.on');
}

/**
 * The sentence with «Einschalten» and the way to the switch-on page. `files`: the server's answer's,
 * until the polled view is there. After the click it shows what
 * the click came to. `onOn`: what the place does after (a report's
 * row is taken again).
 */
export function BookingWaits({ files, go, onOn }: { files?: readonly string[]; go(route: Route): void; onOn?(): unknown }) {
  const { view } = useAutomation();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  // The polled view decides once it is there: switched on elsewhere, the sentence goes.
  const waits = view ? bookingWaitsOf(view) : files;
  if (said) return <span className="wfsaid" role="status" data-testid="booking-waits-done">{said}</span>;
  if (!waits) return null;
  const on = async () => {
    setBusy(true);
    try {
      setSaid(await switchBookingOn());
      await onOn?.();
    } catch (e) { setSaid(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <span className="wfsaid" role="status" data-testid="booking-waits">
      {bookingWaitsText(waits)}{' '}
      <button type="button" className="btn" data-act="booking-switch-on" disabled={busy} onClick={(e) => { e.stopPropagation(); void on(); }}>{t('automation.pending.approve')}</button>{' '}
      <button type="button" className="linkbtn" data-act="booking-look" onClick={(e) => { e.stopPropagation(); go(BOOKING_SWITCH_ON); }}>{t('bookingWaits.look')}</button>
    </span>
  );
}
