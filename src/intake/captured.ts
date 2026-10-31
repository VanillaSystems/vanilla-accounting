/**
 * The moment a phone took a receipt (the upload's X-Captured-At) travels in the inbox file's name,
 * `YYYYMMDD-HHMMSS` in this computer's time, `-2`, `-3`, … for files of the same second. A receipt
 * that shows no date of its own is dated by it (match.ts), marked `dateSource: 'captured'`.
 */
import { isIsoDate } from '../accounting/periods.js';

const pad = (n: number) => String(n).padStart(2, '0');

export const capturedStem = (at: Date): string =>
  `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;

const CAPTURED = /^(\d{4})(\d{2})(\d{2})-\d{6}(?:-\d+)?\.[a-z]+$/i;

/** The day in a name the upload gave; undefined for any other name. */
export function capturedDay(filename: string): string | undefined {
  const m = CAPTURED.exec(filename);
  const day = m && `${m[1]}-${m[2]}-${m[3]}`;
  return day && isIsoDate(day) ? day : undefined;
}
