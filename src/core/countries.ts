/**
 * The countries by their ISO code and their names in German, French, Italian and English, from the
 * runtime's own region names (Intl.DisplayNames): an invoice's address (src/app/areas/invoices) and
 * a place of supply a document names (src/accounting/sale-document.ts) read them. Pure and browser-safe.
 */
const regionName = (code: string, lang: string) => {
  try { return new Intl.DisplayNames([lang], { type: 'region', fallback: 'none' }).of(code); } catch { return undefined; }
};

/** Every country the browser knows by its ISO code (not the groups and the codes ISO only reserves), the common ones first. */
export const COUNTRIES: readonly string[] = (() => {
  const all: string[] = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const k = String.fromCharCode(a, b);
    const n = regionName(k, 'en');
    if (n && n !== k && !/^(EU|EZ|UN|QO|XA|XB|ZZ|UK|EA|IC|DG|CP|TA|AC)$/.test(k)) all.push(k);
  }
  const common = ['CH', 'LI', 'DE', 'AT', 'FR', 'IT'];
  return [...common, ...all.filter((k) => !common.includes(k))];
})();

export const countryName = (code: string, lang: string): string => regionName(code, lang) ?? code;

const norm = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
let byName: Map<string, string> | undefined;

/** The ISO code of a country typed by its code or its name in German, French, Italian or English. */
export function countryOf(text: string): string | undefined {
  if (!byName) {
    byName = new Map();
    for (const k of COUNTRIES) {
      byName.set(norm(k), k);
      for (const l of ['de', 'fr', 'it', 'en']) { const n = regionName(k, l); if (n && !byName.has(norm(n))) byName.set(norm(n), k); }
    }
    for (const [alias, k] of Object.entries({ usa: 'US', uk: 'GB', england: 'GB', suisse: 'CH', svizzera: 'CH', holland: 'NL' })) byName.set(alias, k);
  }
  return byName.get(norm(text));
}

let byFullName: Map<string, string> | undefined;

/**
 * The ISO code of a country written out in full, in German, French, Italian or English («Deutschland»,
 * «Allemagne», «Vereinigte Staaten»): never a code («DE», «IN»), never a name of fewer than four
 * letters, and the text must be the whole name (a place of supply, src/accounting/sale-document.ts).
 */
export function countryNamed(text: string): string | undefined {
  if (!byFullName) {
    byFullName = new Map();
    for (const k of COUNTRIES) for (const l of ['de', 'fr', 'it', 'en']) {
      const n = regionName(k, l);
      if (n && n !== k && norm(n).length >= 4 && !byFullName.has(norm(n))) byFullName.set(norm(n), k);
    }
  }
  const t = text.trim();
  return /^[\p{L}][\p{L}'’ .-]*$/u.test(t) && norm(t).length >= 4 ? byFullName.get(norm(t)) : undefined;
}
