/**
 * payroll.json as a page may show it (Änderungen' diff): the payslip password and the social security
 * number never reach the UI from the file. The number reads as the lists show it, the password as dots.
 * Text, not parsed JSON: a file mid-edit or malformed is redacted all the same. Pure, browse-safe.
 */
import { maskedNumber } from './views.js';

export const PASSWORD_SHOWN = '••••••';
const STRING = '"((?:[^"\\\\]|\\\\.)*)"';

/** Whether a workspace path is the payroll's store. */
export const isPayrollStore = (path: string): boolean => /(^|\/)payroll\.json$/.test(path);

export function redactPayroll(text: string): string {
  return text
    .replace(new RegExp(`("mailPassword"\\s*:\\s*)${STRING}`, 'g'), (_m, key: string) => `${key}"${PASSWORD_SHOWN}"`)
    .replace(new RegExp(`("socialSecurityNumber"\\s*:\\s*)${STRING}`, 'g'), (_m, key: string, n: string) => `${key}"${maskedNumber(n) ?? ''}"`);
}
