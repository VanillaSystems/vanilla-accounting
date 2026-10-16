/**
 * Whether an account can take a booking: the chart must place it on the Bilanz or the
 * Erfolgsrechnung. A closing class such as 9xxx is on neither, so a booking there leaves the
 * statements with a difference nobody can find (persona finding x07).
 */
import { chart } from '../engines/index.js';
import type { ApiRefusal } from '../types/api-error.js';

export interface Unplaced {
  /** The German text the CLI, the tests and the logs read. */
  message: string;
  refusal: Extract<ApiRefusal, { code: 'accountOutsideStatements' }>;
}

/** Why `account` takes no booking, with the classes to use instead; undefined for an account the chart places. */
export function outsideStatements(account: string): Unplaced | undefined {
  if (!account || chart().isPlaced(account)) return undefined;
  const classes = chart().placedClasses;
  return {
    message: `Konto ${account} gehört weder in die Bilanz noch in die Erfolgsrechnung: die App könnte es nirgends zeigen. Nimm eine Nummer der Klassen ${classes}, für eine Ausgabe zum Beispiel 6xxx.`,
    refusal: { code: 'accountOutsideStatements', params: { account, classes } },
  };
}
