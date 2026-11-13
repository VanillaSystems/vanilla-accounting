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

/** The books' currency, or none before a jurisdiction is loaded (a list drawn that early still renders). */
const booksCurrency = (): string => { try { return baseCurrency(); } catch { return ''; } };

/** The currencies an amount in a text is read with: the books' own and the common ones (#398 review). */
const TEXT_CURRENCIES = ['EUR', 'USD', 'GBP', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF'];

/**
 * An amount a reader or a model wrote into a receipt's words («EUR 3200.00»), in the app's one money
 * format («EUR 3'200.00», #398): a currency code of the books or a common one, then digits with two
 * decimals. Anything else stays as written («UBS 2026.09» is no amount). Never for a file name.
 */
export function moneyInText(text: string, currencies: readonly string[] = TEXT_CURRENCIES): string {
  const codes = new Set([...currencies, booksCurrency()]);
  return text.replace(/\b([A-Z]{3}) ?(-?\d{4,})[.,](\d{2})\b/g, (whole: string, cur: string, int: string, dec: string) => (codes.has(cur) ? `${cur} ${fmt(Number(`${int}.${dec}`))}` : whole));
}
