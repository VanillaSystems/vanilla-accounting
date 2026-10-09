import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | undefined): string {
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(
      new Date(date),
    );
  } catch {
    return date;
  }
}

export function formatAmount(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined) return '—';
  const ccy = currency?.trim() || 'CHF';
  try {
    return new Intl.NumberFormat('de-CH', { style: 'currency', currency: ccy }).format(amount);
  } catch {
    // Invalid/unknown currency code — fall back to a plain formatted number + raw code.
    return `${ccy} ${fmt(amount)}`;
  }
}

/** An amount as the books show it: "1'234.56". */
export function fmt(n: number): string {
  return n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "CHF 1'234.56" */
export function fmtCHF(n: number): string {
  return 'CHF ' + fmt(n);
}

/** Extract YYYY-MM-DD from a filename: a YYYYMMDD prefix, or the last ISO
 *  date embedded elsewhere (statement filenames encode a period's end date). */
export function dateFromFilename(filename: string): string | undefined {
  const prefix = filename.match(/^(\d{4})(\d{2})(\d{2})/);
  if (prefix) return `${prefix[1]}-${prefix[2]}-${prefix[3]}`;
  const isoDates = filename.match(/\d{4}-\d{2}-\d{2}/g);
  if (isoDates) return isoDates[isoDates.length - 1];
  return undefined;
}

/** Strip extension and leading date prefix to get a human-readable label */
export function labelFromFilename(filename: string): string {
  return filename.replace(/\.pdf$/i, '').replace(/^\d{8}-?/, '');
}

/** Deep-link to a receipt's detail view (opens in 'all' period so it's always visible). */
export function buildReceiptUrl(id: string): string {
  return `/receipts?receipt=${encodeURIComponent(id)}`;
}

/** Deep-link to a transaction's detail view (opens in 'all' period so it's always visible). */
export function buildTxUrl(ref: string): string {
  return `/transactions?tx=${encodeURIComponent(ref)}`;
}

/**
 * Returns true if `date` (YYYY-MM-DD) falls within the given period.
 * period: 'all' | 'YYYY' | 'YYYY-Qn'
 */
export function periodMatchesDate(period: string, date: string | undefined): boolean {
  if (period === 'all' || !date) return true;
  if (/^\d{4}$/.test(period)) return date.startsWith(period);
  const m = period.match(/^(\d{4})-Q(\d)$/);
  if (m) {
    if (!date.startsWith(m[1])) return false;
    const month = parseInt(date.slice(5, 7));
    return Math.ceil(month / 3) === parseInt(m[2]);
  }
  return true;
}
