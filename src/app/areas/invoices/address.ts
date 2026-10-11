/**
 * Addresses of customers anywhere: the country decides the form (what the postcode is called,
 * its format, whether a state or province comes with it, the order of town and postcode, the
 * house number before or after the street) and which VAT number fits. The QR-bill takes the
 * structured parts, the sheet prints them as the destination's post wants (src/invoices/sheet.ts).
 */
import type { InvoiceLanguage } from '../../../invoices/model.js';
import { NUMBER_FIRST } from '../../../invoices/sheet.js';

export type PostcodeName = 'plz' | 'codePostal' | 'cap' | 'codigoPostal' | 'postcode' | 'kodPocztowy' | 'postnummer' | 'postinumero' | 'eircode' | 'zip' | 'postalCode' | 'generic';

export interface AddressRule {
  postcode: PostcodeName;
  example: string;
  pattern: RegExp;
  /** Town (state) postcode, as in the UK, Ireland and North America. */
  townFirst?: boolean;
  /** The field for a state or province. */
  state?: 'state' | 'province';
  stateExample?: string;
}

const RULES: Record<string, AddressRule> = {
  CH: { postcode: 'plz', example: '8000', pattern: /^\d{4}$/ },
  LI: { postcode: 'plz', example: '9490', pattern: /^\d{4}$/ },
  AT: { postcode: 'plz', example: '1010', pattern: /^\d{4}$/ },
  DE: { postcode: 'plz', example: '80331', pattern: /^\d{5}$/ },
  FR: { postcode: 'codePostal', example: '75002', pattern: /^\d{5}$/ },
  IT: { postcode: 'cap', example: '20121', pattern: /^\d{5}$/ },
  ES: { postcode: 'codigoPostal', example: '28013', pattern: /^\d{5}$/ },
  NL: { postcode: 'postcode', example: '1012 AB', pattern: /^\d{4}\s?[A-Z]{2}$/i },
  BE: { postcode: 'codePostal', example: '1000', pattern: /^\d{4}$/ },
  LU: { postcode: 'codePostal', example: 'L-1111', pattern: /^(L-)?\d{4}$/i },
  PT: { postcode: 'codigoPostal', example: '1100-148', pattern: /^\d{4}-\d{3}$/ },
  PL: { postcode: 'kodPocztowy', example: '00-001', pattern: /^\d{2}-\d{3}$/ },
  SE: { postcode: 'postnummer', example: '111 22', pattern: /^\d{3}\s?\d{2}$/ },
  DK: { postcode: 'postnummer', example: '1050', pattern: /^\d{4}$/ },
  NO: { postcode: 'postnummer', example: '0150', pattern: /^\d{4}$/ },
  FI: { postcode: 'postinumero', example: '00100', pattern: /^\d{5}$/ },
  GB: { postcode: 'postcode', example: 'E1 6QR', pattern: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, townFirst: true },
  IE: { postcode: 'eircode', example: 'D02 X285', pattern: /^[A-Z\d]{3}\s?[A-Z\d]{4}$/i, townFirst: true },
  US: { postcode: 'zip', example: '94107', pattern: /^\d{5}(-\d{4})?$/, townFirst: true, state: 'state', stateExample: 'CA' },
  CA: { postcode: 'postalCode', example: 'K1A 0B1', pattern: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i, townFirst: true, state: 'province', stateExample: 'ON' },
  AU: { postcode: 'postcode', example: '2000', pattern: /^\d{4}$/, townFirst: true, state: 'state', stateExample: 'NSW' },
};

export const addressRule = (country: string): AddressRule => RULES[country] ?? { postcode: 'generic', example: '', pattern: /^.{0,16}$/ };

/** The form asks for the house number first where the address writes it first. */
export const numberFirst = (country: string) => NUMBER_FIRST.includes(country);

const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];

/** Which VAT number a customer of `country` has, its example and its shape (none: anything goes). */
export function vatRule(country: string): { kind: 'uid' | 'euVat' | 'gbVat' | 'taxNo'; example: string; pattern?: RegExp } {
  if (country === 'CH' || country === 'LI') return { kind: 'uid', example: 'CHE-123.456.789 MWST', pattern: /^CHE-\d{3}\.\d{3}\.\d{3}( MWST| TVA| IVA)?$/ };
  if (EU.includes(country)) { const p = country === 'GR' ? 'EL' : country; return { kind: 'euVat', example: `${p}123456789`, pattern: new RegExp(`^${p}[0-9A-Z+*]{2,13}$`, 'i') }; }
  if (country === 'GB') return { kind: 'gbVat', example: 'GB123456789', pattern: /^GB(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/i };
  return { kind: 'taxNo', example: '' };
}

/** The language a customer's invoices are likely in: Swiss postcodes by region, else by country. */
export function languageFor(country: string, postcode: string): InvoiceLanguage {
  if (country === 'CH') return !postcode ? 'de' : /^(1|2[0-8])/.test(postcode) ? 'fr' : /^6[5-9]/.test(postcode) ? 'it' : 'de';
  if (['DE', 'AT', 'LI'].includes(country)) return 'de';
  if (['FR', 'LU', 'MC', 'BE'].includes(country)) return 'fr';
  return country === 'IT' || country === 'SM' ? 'it' : 'en';
}

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
