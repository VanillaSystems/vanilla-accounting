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
