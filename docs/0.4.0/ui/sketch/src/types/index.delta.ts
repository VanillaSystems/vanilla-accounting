/**
 * DELTA to src/types/index.ts: the one books-schema addition of 0.4.0's UI work. A record a run
 * wrote carries the run's id (decisions.md D3: "the booking links to the run id"). Optional, so
 * no migration and no seal changes: a closed year's records never gain it, and a record without
 * it was written by a person, a module or an older app. The effect handles (engine.ts
 * effectsFor) are the only writers; the write door's ownership table treats `run` like
 * `origin`: an entry with `run` is the run actor's and a person may still change it (a person
 * step inside the run is a person).
 */
export interface JournalEntryDelta {
  origin?: 'classify' | 'manual' | 'year-close' | 'invoice';
  /** The run that booked it (src/workflows/run.ts). The journal shows "von KI gebucht · Lauf …" when the run's deciding step was an AI step. */
  run?: string;
}

export interface MappingDelta {
  /** The evidence run that settled it. */
  run?: string;
}

export interface ReceiptDelta {
  /** The intake run that archived it. */
  run?: string;
}
