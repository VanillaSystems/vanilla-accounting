/**
 * The VAT-code catalogue: what every MWST code means, which Ziffern it feeds, and when to use it.
 * Nothing here is copied by hand. The codes, their German text and Banana's Ziffern come from
 * reference/MWST-codes.txt, the examples from examples/cases/ (both via vat-codes.source.ts,
 * `npm run vat-codes`); the rate, the amount type and the Ziffern from the engine itself
 * (parseVatCode, sourceZiffern). This file adds only what no source says: which kind of supply or
 * expense a code is, and the guide rules that choose it. The texts are in the UI dictionaries
 * (vatCodes.kind.<kind>.*), so the app, docs/vat-codes.md and the CLI explain a code alike.
 */
import { NAMED_VAT_CODES, parseVatCode, sourceZiffern, type VatCodeInfo } from './vat-report.js';
import { TAX_RATE_ROWS } from './ziffern.js';
import { BANANA_VAT_CODES, VAT_CODE_EXAMPLES, type VatCodeExample } from './vat-codes.source.js';

/** Banana's families (MWST-codes.txt, "Erläuterungen"), in the order of the ESTV form. */
export const VAT_CODE_FAMILIES = ['V', 'VS', 'F', 'B', 'M', 'I', 'K', 'Z'] as const;
export type VatCodeFamily = (typeof VAT_CODE_FAMILIES)[number];

interface KindSpec {
  kind: string;
  family: VatCodeFamily;
  /** The unsigned codes of this kind. The first kind that matches wins. */
  match: RegExp;
  /** Rule ids in processes/*.guide.yaml that choose a code of this kind. */
  rules: readonly string[];
}

/** Every kind of code, in the order the catalogue lists them. */
export const VAT_CODE_KINDS = [
  { kind: 'export', family: 'V', match: /^V0$/, rules: ['sv-order-tax'] },
  { kind: 'abroad', family: 'V', match: /^V0-E$/, rules: ['sv-service-abroad'] },
  { kind: 'notification', family: 'V', match: /^V0-T$/, rules: [] },
  { kind: 'notTaxable', family: 'V', match: /^V0-N$/, rules: [] },
  { kind: 'various', family: 'V', match: /^V0-D$/, rules: [] },
  { kind: 'saleOpted', family: 'V', match: /^V\d+-B$/, rules: [] },
  { kind: 'sale', family: 'V', match: /^V\d+(-N)?$/, rules: ['sv-order-tax', 'sid-sale-refund'] },
  { kind: 'discount', family: 'VS', match: /^VS\d+(-N)?$/, rules: [] },
  { kind: 'flatRate', family: 'F', match: /^FS?\d$/, rules: [] },
  { kind: 'acquisition', family: 'B', match: /^B\d+(-[12])?$/, rules: ['pv-bezugsteuer'] },
  { kind: 'inputNoVat', family: 'M', match: /^M0$/, rules: ['pv-no-receipt', 'pv-che-but-zero', 'pv-otherwise'] },
  { kind: 'material', family: 'M', match: /^M\d+(-[12])?$/, rules: ['pv-charged', 'pv-prefix-from-account', 'pv-import-vat-evv'] },
  { kind: 'inputNoVat', family: 'I', match: /^I0$/, rules: ['pv-no-receipt', 'pv-che-but-zero', 'pv-otherwise'] },
  { kind: 'investment', family: 'I', match: /^I\d+(-[12])?$/, rules: ['pv-charged', 'pv-prefix-from-account'] },
  { kind: 'depositRelief', family: 'K', match: /^K\d*-A$/, rules: [] },
  { kind: 'inputCorrection', family: 'K', match: /^K\d*-B$/, rules: ['eig-entry'] },
  { kind: 'inputReduction', family: 'K', match: /^K\d*-C$/, rules: [] },
  { kind: 'taxCredit', family: 'K', match: /^F10\d\d$/, rules: [] },
  { kind: 'subsidies', family: 'Z', match: /^Z0-A$/, rules: [] },
  { kind: 'nonConsideration', family: 'Z', match: /^Z0$/, rules: [] },
] as const satisfies readonly KindSpec[];

export type VatCodeKind = (typeof VAT_CODE_KINDS)[number]['kind'];

/**
 * What a code's amount does to a Ziffer: `turnover` adds the gross amount (200, 220…280),
 * `taxable` makes it taxable turnover whose tax the rate row computes (303, 313, …), `tax` adds
 * only the VAT in it (382/383, 400…420).
 */
export interface VatCodeZiffer {
  ziffer: string;
  figure: 'turnover' | 'taxable' | 'tax';
}

export interface VatCodeEntry {
  /** Unsigned, as Banana lists it. */
  code: string;
  family: VatCodeFamily;
  kind: VatCodeKind;
  /** Banana's German text, or undefined for a code only the engine knows. */
  bananaText?: string;
  /** The Ziffern Banana declares the code in. */
  bananaZiffern: readonly string[];
  /** Percent; null where neither Banana nor the engine names one (flat tax rates). */
  rate: number | null;
  /** A rate that ended on 31.12.2023. */
  superseded: boolean;
  amountIs: VatCodeInfo['amountIs'];
  /** What the engine books for the code, in form order; null when the app does not declare it at all. */
  ziffern: VatCodeZiffer[] | null;
  rules: readonly string[];
  examples: readonly VatCodeExample[];
}

const SUPERSEDED_RATES = new Set(TAX_RATE_ROWS.filter((r) => r.superseded).map((r) => r.rate));
const SUPPLY_ROW_ZIFFERN = new Set(TAX_RATE_ROWS.filter((r) => r.kind === 'supply').map((r) => r.ziffer));
const BANANA = new Map(BANANA_VAT_CODES.map((b) => [b.code, b]));

/** The ESTV's name of a rate (Normalsatz, Reduzierter Satz, Beherbergungssatz), from the form's rate rows. */
export function vatCodeRateName(rate: number): string | undefined {
  return TAX_RATE_ROWS.find((r) => r.kind === 'supply' && r.rate === rate)?.name;
}

function figureOf(ziffer: string): VatCodeZiffer['figure'] {
  if (SUPPLY_ROW_ZIFFERN.has(ziffer)) return 'taxable';
  return Number(ziffer) < 300 ? 'turnover' : 'tax';
}

function describe(code: string): VatCodeEntry | null {
  const spec = VAT_CODE_KINDS.find((k) => k.match.test(code));
  if (!spec) return null;
  const banana = BANANA.get(code);
  const info = parseVatCode(code);
  const rate = info ? info.rate : banana?.rate ?? null;
  return {
    code,
    family: spec.family,
    kind: spec.kind,
    bananaText: banana?.text,
    bananaZiffern: banana?.ziffern ?? [],
    rate,
    superseded: rate !== null && SUPERSEDED_RATES.has(rate),
    amountIs: info?.amountIs ?? (banana?.amountType === '2' ? 'tax' : banana?.amountType === '1' ? 'net' : 'gross'),
    ziffern: info ? sourceZiffern(info).sort((a, b) => Number(a) - Number(b)).map((ziffer) => ({ ziffer, figure: figureOf(ziffer) })) : null,
    rules: spec.rules,
    examples: VAT_CODE_EXAMPLES[code] ?? [],
  };
}

const familyOrder = (c: VatCodeEntry) => VAT_CODE_FAMILIES.indexOf(c.family) * 100 + VAT_CODE_KINDS.findIndex((k) => k.kind === c.kind && k.family === c.family);

/** Banana's codes and every code the engine knows by name, by family and kind, Banana's order within. */
export const VAT_CODES: readonly VatCodeEntry[] = [...new Set([...BANANA_VAT_CODES.map((b) => b.code), ...NAMED_VAT_CODES])]
  .map((code) => describe(code))
  .filter((c): c is VatCodeEntry => c !== null)
  .map((c, i) => ({ c, i }))
  .sort((a, b) => familyOrder(a.c) - familyOrder(b.c) || a.i - b.i)
  .map(({ c }) => c);

const BY_CODE = new Map(VAT_CODES.map((c) => [c.code, c]));

/**
 * The catalogue entry of a code as booked, and whether it carries a minus (a refund or reversal:
 * the same Ziffern, the amount counts against them). A code outside the catalogue that the engine
 * still accepts (I26-2) is described the same way; an unknown code gives null.
 */
export function lookupVatCode(code: string): { entry: VatCodeEntry; negative: boolean } | null {
  const negative = code.startsWith('-');
  const unsigned = negative ? code.slice(1) : code;
  const entry = BY_CODE.get(unsigned) ?? describe(unsigned);
  return entry ? { entry, negative } : null;
}
