/**
 * The five fields of a cron schedule (minute, hour, day of month, month, day of week) matched
 * against a time in the computer's time zone: `*`, lists `a,b`, ranges `a-b` and steps `*\/n`.
 * Enough for a workflow's schedule trigger; no dependency.
 */
const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function fieldMatches(field: string, value: number, [lo, hi]: [number, number]): boolean {
  return field.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    const [from, to] = range === '*' ? [lo, hi] : range.includes('-') ? range.split('-').map(Number) : [Number(range), stepText ? hi : Number(range)];
    return value >= from && value <= to && (value - from) % step === 0;
  });
}

export function cronMatches(cron: string, at: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()];
  return fields.every((f, i) => fieldMatches(f, values[i], RANGES[i]));
}

/**
 * The first whole minute after `from` the schedule matches, looked for up to `days` ahead
 * (a minute at a time: 8 days are 11 520 checks); undefined for an invalid schedule or none so near.
 */
export function nextRun(cron: string, from: Date, days = 8): Date | undefined {
  if (!cronValid(cron)) return undefined;
  const at = new Date(from);
  at.setSeconds(0, 0);
  for (let i = 0; i < days * 1440; i++) {
    at.setMinutes(at.getMinutes() + 1);
    if (cronMatches(cron, at)) return at;
  }
  return undefined;
}

/** Whether a schedule is five fields of numbers, `*`, lists, ranges and steps, each within its range. */
export function cronValid(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f, i) => f.split(',').every((part) => {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return false;
    const [lo, hi] = RANGES[i];
    const nums = m[1] === '*' ? [] : m[1].split('-').map(Number);
    return nums.every((n) => n >= lo && n <= hi) && (!m[2] || Number(m[2]) > 0);
  }));
}
