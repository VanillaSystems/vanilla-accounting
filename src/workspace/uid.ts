/**
 * The Swiss company identification number (UID, CHE-###.###.###). The last digit is a check digit
 * (eCH-0097): weights 5 4 3 2 7 6 5 4 over the first eight digits, 11 minus the sum mod 11,
 * where 11 becomes 0 and 10 never occurs in a valid UID.
 */
import type { Uid } from './workspace.js';

const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4];

/** The UID in its canonical form, from any spacing, dots or "MWST" suffix; or why it is not one. */
export function parseUid(input: string): { uid: Uid } | { error: string } {
  const m = /^\s*CHE[-\s]?(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})(?:\s*(?:MWST|TVA|IVA))?\s*$/i.exec(input);
  if (!m) return { error: `"${input}" is not a UID. It looks like CHE-###.###.### (see uid.admin.ch).` };
  const digits = (m[1] + m[2] + m[3]).split('').map(Number);
  const rest = 11 - (WEIGHTS.reduce((sum, w, i) => sum + w * digits[i], 0) % 11);
  const check = rest === 11 ? 0 : rest;
  if (check === 10 || check !== digits[8]) {
    return { error: `CHE-${m[1]}.${m[2]}.${m[3]} has a wrong check digit: a typo? Copy it from uid.admin.ch.` };
  }
  return { uid: `CHE-${m[1]}.${m[2]}.${m[3]}` as Uid };
}
