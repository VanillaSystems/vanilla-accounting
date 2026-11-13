/**
 * A provider's report dropped while «Buchen» waits for «Einschalten» (#413) and left in its row when
 * the drop window closed: kept in data/reports-waiting/, never in quarantine (where «Ist ein Beleg»
 * would send a CSV to the inbox as a receipt). «Einschalten» of the booking takes each as the drop
 * row would have (bookWhatWaited), and so does any drop or inbox run that finds the booking switched
 * on again otherwise (the change taken back): booked, it goes; one that still asks (a clearing account, a payout
 * the app does not see) or is refused waits in quarantine as a row left unanswered does.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from './books.js';
import { freeName, putInQuarantine } from '../intake/quarantine.js';
import { importSalesReport } from '../intake/sales-report-import.js';
import { bookingWaits } from './booking-waits.js';

const dirOf = (data: string) => join(data, 'reports-waiting');

/** Keeps a waiting report's bytes until «Einschalten»; returns its name there. */
export function keepWaitingReport(name: string, bytes: Buffer): string {
  const dir = dirOf(WS.paths.data);
  mkdirSync(dir, { recursive: true });
  const file = freeName(dir, name);
  writeFileSync(join(dir, file), bytes);
  return file;
}

/** The reports kept so, by name. */
export const waitingReports = (): string[] => {
  const dir = dirOf(WS.paths.data);
  return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : [];
};

/** Takes every kept report now (the booking was switched on): how many were booked. */
export function takeWaitingReports(): number {
  const dir = dirOf(WS.paths.data);
  let booked = 0;
  for (const file of waitingReports()) {
    const path = join(dir, file);
    const bytes = readFileSync(path);
    let ok = false;
    try { ok = importSalesReport(WS, bytes, file).ok; } catch (e) { console.error(`${file}: ${(e as Error).message}`); }
    if (ok) booked++;
    else putInQuarantine(WS.paths.data, file, bytes, { kind: 'held' });
    rmSync(path, { force: true });
  }
  return booked;
}

/** Takes the kept reports when the booking does not wait (any more): a drop, an inbox run come to rest. */
export function takeWaitingReportsIfOn(): number {
  return waitingReports().length && !bookingWaits() ? takeWaitingReports() : 0;
}
