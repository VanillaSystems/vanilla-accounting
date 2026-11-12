/**
 * How far the step a run is on has come: the items it finished of those it works on (the receipts a
 * reading step read, the payments a booking step booked), as the step itself counts them. Kept in
 * memory while the step runs, never in the run's files: a progress bar's fact, gone with the step
 * (#341: the drop window's bar stood while one run read sixteen files).
 */
export interface StepProgress { done: number; total: number }

const live = new Map<string, StepProgress>();

/** The step of run `run` says where it is; a total of 0 is no progress to show. */
export function noteProgress(run: string, done: number, total: number): void {
  if (total > 0) live.set(run, { done: Math.min(done, total), total });
  else live.delete(run);
}

/** The step ended (or a new one starts): what it counted is no longer the run's. */
export const clearProgress = (run: string): void => { live.delete(run); };

export const progressOf = (run: string): StepProgress | undefined => live.get(run);
