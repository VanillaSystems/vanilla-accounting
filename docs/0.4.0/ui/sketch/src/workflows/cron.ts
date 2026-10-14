/**
 * Five-field cron (minute hour day month weekday; `*`, lists, ranges, steps), enough for
 * "0 6 * * *" and "0 7 * * 1-5". No dependency: the schedules of a bookkeeping app are few and
 * simple, and the engine asks only "when is the next time after t" and "is t a match".
 */
export interface Cron { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number>; source: string }

export class CronError extends Error {}

export function parseCron(text: string): Cron {
  throw new Error('not implemented');
}

/** The first match strictly after `after`, within a year, in the machine's local time. */
export function nextAfter(cron: Cron, after: Date): Date | undefined {
  throw new Error('not implemented');
  // TODO: step minute by minute from after+1min, bounded by 366 days; cheap enough for a tick per minute over a few schedules.
}

/** "0 6 * * *" → "täglich 06:00" style words come from the UI's i18n over the parsed fields, not from here. */
