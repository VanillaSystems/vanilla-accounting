/**
 * The state of each payroll check of the year-end (docs/specs/payroll.md §6.7), without the texts (a test
 * loads it without Vite): a difference is a hint (`warn`), what is still to do a fact (`open`), the rest
 * agrees (`ok`). None of them keeps the year from closing.
 */
import type { InsurerCheck, PayrollYearEnd, StatementCheck } from '../../../payroll/year-end.js';

export type PayrollState = 'ok' | 'warn' | 'open';

export const clearingState = (p: PayrollYearEnd): PayrollState | undefined => (p.clearing ? (p.clearing.difference ? 'warn' : 'ok') : undefined);
/** Open with nothing that says what the insurer bills: no final statement booked. */
export const insurerState = (i: InsurerCheck): PayrollState => (i.open === 0 || i.settlement.length ? 'ok' : 'open');
export const wagesState = (p: PayrollYearEnd): PayrollState | undefined => (p.wages ? (p.wages.persons.some((x) => x.difference) || p.wages.opening?.difference ? 'warn' : 'ok') : undefined);
export function statementState(s: StatementCheck): PayrollState {
  if (s.difference || s.unmapped.length || (s.issued && s.issued.value !== s.today)) return 'warn';
  return !s.issued || s.openMonths.length ? 'open' : 'ok';
}
export const withheldState = (p: PayrollYearEnd): PayrollState | undefined => (p.withheld ? (p.withheld.uncleared.length ? 'warn' : 'ok') : undefined);

/** Every check's state, in the page's order. */
export const payrollStates = (p: PayrollYearEnd): PayrollState[] => [
  clearingState(p), ...p.insurers.map(insurerState), wagesState(p), ...p.statements.map(statementState), withheldState(p),
].filter((s): s is PayrollState => !!s);
