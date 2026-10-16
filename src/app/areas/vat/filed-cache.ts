/**
 * A read kept for one load of the books (r8f-45). The VAT pages ask for the returns as filed on
 * every render; one read per year is enough, but only as long as the books are the ones that read
 * saw: a filing made in the app writes filings/ and closes the period, and the books are loaded
 * again. A cache kept for the whole session said «keine eingereichte Abrechnung» of a return filed
 * a minute earlier, until the page was reloaded.
 */
export function perBooks<T>(load: (year: string) => Promise<T>): (books: object, year: string) => Promise<T> {
  const cache = new WeakMap<object, Map<string, Promise<T>>>();
  return (books, year) => {
    const years = cache.get(books) ?? new Map<string, Promise<T>>();
    cache.set(books, years);
    if (!years.has(year)) years.set(year, load(year));
    return years.get(year)!;
  };
}
