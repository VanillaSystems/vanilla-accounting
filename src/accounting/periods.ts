/**
 * VAT reporting periods, DERIVED from their name, never enumerated: a
 * hardcoded list silently refuses (or worse, silently replaces) every later
 * quarter. Accepts YYYY-Qn, YYYY-Hn and YYYY.
 */
export function derivePeriod(key: string): { from: string; to: string } | null {
  let m = key.match(/^(\d{4})-Q([1-4])$/);
  if (m) {
    const y = +m[1], q = +m[2];
    const lastDay = new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10);
    return { from: `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`, to: lastDay };
  }
  m = key.match(/^(\d{4})-H([12])$/);
  if (m) {
    const y = +m[1], h = +m[2];
    return h === 1 ? { from: `${y}-01-01`, to: `${y}-06-30` } : { from: `${y}-07-01`, to: `${y}-12-31` };
  }
  m = key.match(/^(\d{4})$/);
  if (m) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
  return null;
}
