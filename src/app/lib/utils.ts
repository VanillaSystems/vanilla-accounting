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
