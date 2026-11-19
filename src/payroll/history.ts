/**
 * The state of every payslip, derived from the append-only events (docs/specs/payroll.md §9.3): the last
 * `close` of an id is the payslip unless a `reopen` came after it; corrections stand against the closed
 * payslip they correct and are carried by the next close that names them. Pure, browser-safe.
 */
import type { PayslipClose, PayslipCorrection, PayslipEvent } from './model.js';

export interface PayslipHistory {
  /** The closed payslips as they stand, by id. */
  closed: Map<string, PayslipClose>;
  /** Every event of an id, in order: its history on the detail. */
  events: Map<string, PayslipEvent[]>;
  corrections: PayslipCorrection[];
  /** The correction ids a standing close carries, with the payslip that carries each. */
  carriedBy: Map<string, string>;
}

const idOf = (e: PayslipEvent): string => (e.event === 'correction' ? e.of : e.id);

export function historyOf(events: readonly PayslipEvent[]): PayslipHistory {
  const closed = new Map<string, PayslipClose>();
  const byId = new Map<string, PayslipEvent[]>();
  const corrections: PayslipCorrection[] = [];
  for (const e of events) {
    const id = idOf(e);
    byId.set(id, [...(byId.get(id) ?? []), e]);
    if (e.event === 'close') closed.set(e.id, e);
    else if (e.event === 'reopen') closed.delete(e.id);
    else corrections.push(e);
  }
  const carriedBy = new Map<string, string>();
  for (const c of closed.values()) for (const l of c.lines) if (l.correction) carriedBy.set(l.correction, c.id);
  return { closed, events: byId, corrections, carriedBy };
}

/** The person's closed payslips, oldest month first. */
export const closedOf = (h: PayslipHistory, employee: string): PayslipClose[] =>
  [...h.closed.values()].filter((c) => c.employee === employee).sort((a, b) => a.month.localeCompare(b.month));

/** The person's latest closed payslip: the only one «Wieder öffnen» is offered for (§6.5). */
export const latestClosed = (h: PayslipHistory, employee: string): PayslipClose | undefined => closedOf(h, employee).at(-1);
