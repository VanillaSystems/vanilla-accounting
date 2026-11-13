import { baseCurrency } from '../../engines/index.js';
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
  const ccy = currency?.trim() || baseCurrency();
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

/**
 * An amount a reader or a model wrote into a text («EUR 3200.00»), in the app's one money format
 * («EUR 3'200.00», #398): a currency code, then digits with two decimals. Anything else stays as written.
 */
export function moneyInText(text: string): string {
  return text.replace(/\b([A-Z]{3}) ?(-?\d{4,})[.,](\d{2})\b/g, (_, cur: string, int: string, dec: string) => `${cur} ${fmt(Number(`${int}.${dec}`))}`);
}
