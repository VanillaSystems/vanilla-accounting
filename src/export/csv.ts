/** A table as CSV, the one way the app writes one: the export (bundle.ts), the reports, and the lists a page downloads (Zu bezahlen, #571). No node import, so a page in the browser writes it too. */
import type { Table } from './tables.js';

/** A table as CSV: UTF-8 with its BOM, semicolons, CRLF, amounts with two decimals. */
export function csvOf(tb: Pick<Table, 'head' | 'rows' | 'money'>): string {
  const cell = (v: string | number, money: boolean) => {
    const s = typeof v === 'number' ? (money ? v.toFixed(2) : String(v)) : v;
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [tb.head.map((h) => cell(h, false)), ...tb.rows.map((r) => r.map((v, i) => cell(v, tb.money.includes(i))))];
  return '\uFEFF' + lines.map((l) => l.join(';')).join('\r\n') + '\r\n';
}
