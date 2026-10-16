/**
 * The bookings a link by hand replaced (Zahlung verknüpfen in Belege), kept beside the books in
 * data/link-history/, so that «Lösen» puts back the booking that stood before the link instead of
 * booking the payment anew (r8h-21). One record per link (payment, receipt); taking it reads and
 * removes it. Outside git, like the trash: the saved books tell the same story.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';

interface Replaced { at: string; entries: JournalEntry[] }

const fileOf = (ws: Pick<Workspace, 'paths'>, payment: string, receipt: string) =>
  join(ws.paths.data, 'link-history', `${payment.replace(/[^A-Za-z0-9_.-]/g, '_')}__${receipt}.json`);

/** Records the bookings of `payment` that linking `receipt` took away. */
export function recordReplaced(ws: Pick<Workspace, 'paths'>, payment: string, receipt: string, entries: readonly JournalEntry[]): void {
  const file = fileOf(ws, payment, receipt);
  mkdirSync(join(file, '..'), { recursive: true });
  const record: Replaced = { at: new Date().toISOString(), entries: [...entries] };
  writeFileSync(file, JSON.stringify(record, null, 2));
}

/** Whether a record of bookings the link of `receipt` to `payment` replaced is kept. */
export const hasReplaced = (ws: Pick<Workspace, 'paths'>, payment: string, receipt: string): boolean => existsSync(fileOf(ws, payment, receipt));

/** The bookings the link of `receipt` to `payment` replaced, and the record is gone; undefined when none was kept. */
export function takeReplaced(ws: Pick<Workspace, 'paths'>, payment: string, receipt: string): JournalEntry[] | undefined {
  const file = fileOf(ws, payment, receipt);
  if (!existsSync(file)) return undefined;
  const record = JSON.parse(readFileSync(file, 'utf8')) as Replaced;
  rmSync(file, { force: true });
  return record.entries;
}
