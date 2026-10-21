/**
 * The VAT-code catalogue: what every MWST code means, which Ziffern it feeds, and when to use it.
 * Nothing here is copied by hand. The codes, their German text and Banana's Ziffern come from
 * reference/MWST-codes.txt, the examples from examples/cases/ (both via vat-codes.source.ts,
 * `npm run vat-codes`); the rate, the amount type and the Ziffern from the engine itself
 * (parseVatCode, sourceZiffern). This file adds only what no source says: which kind of supply or
 * expense a code is, and the guide rules that choose it. The texts are in the UI dictionaries
 * (vatCodes.kind.<kind>.*), so the app, docs/vat-codes.md and the CLI explain a code alike.
 */
import { BANANA_VAT_CODES, VAT_CODE_EXAMPLES, type VatCodeExample } from './vat-codes.source.js';
import { chart, invoicing, statements, vat, vatSetup } from '../engines/index.js';
import { normalRate } from './sales-without-vat.js';
import { methodOf } from '../workspace/vat-setup.js';
import { inGroup } from '../engines/chart.js';
import type { TaxCodeInfo } from '../engines/tax-codes.js';

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
  { kind: 'export', family: 'V', match: /^V0$/, rules: ['sv-order-tax', 'sv-no-invoice'] },
  { kind: 'abroad', family: 'V', match: /^V0-E$/, rules: ['sv-service-abroad', 'sv-place-abroad'] },
  { kind: 'notification', family: 'V', match: /^V0-T$/, rules: [] },
  { kind: 'notTaxable', family: 'V', match: /^V0-N$/, rules: [] },
  { kind: 'various', family: 'V', match: /^V0-D$/, rules: [] },
  { kind: 'saleOpted', family: 'V', match: /^V\d+-B$/, rules: [] },
  { kind: 'sale', family: 'V', match: /^V\d+(-N)?$/, rules: ['sv-order-tax', 'sv-no-invoice', 'sv-card-terminal', 'sid-sale-refund'] },
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
  amountIs: TaxCodeInfo['amountIs'];
  /** What the engine books for the code, in form order; null when the app does not declare it at all. */
  ziffern: VatCodeZiffer[] | null;
  rules: readonly string[];
  examples: readonly VatCodeExample[];
}

const BANANA = new Map(BANANA_VAT_CODES.map((b) => [b.code, b]));

/** The ESTV's name of a rate (Normalsatz, Reduzierter Satz, Beherbergungssatz), from the form's rate rows. */
export function vatCodeRateName(rate: number): string | undefined {
  return vat().rateRows.find((r) => r.kind === 'supply' && r.rate === rate)?.name;
}

function figureOf(ziffer: string): VatCodeZiffer['figure'] {
  if (vat().rateRows.some((r) => r.kind === 'supply' && r.ziffer === ziffer)) return 'taxable';
  return Number(ziffer) < 300 ? 'turnover' : 'tax';
}

function describe(code: string): VatCodeEntry | null {
  const spec = VAT_CODE_KINDS.find((k) => k.match.test(code));
  if (!spec) return null;
  const banana = BANANA.get(code);
  const info = vat().codes.parse(code);
  const rate = info ? info.rate : banana?.rate ?? null;
  return {
    code,
    family: spec.family,
    kind: spec.kind,
    bananaText: banana?.text,
    bananaZiffern: banana?.ziffern ?? [],
    rate,
    superseded: rate !== null && vat().rateRows.some((r) => r.superseded && r.rate === rate),
    amountIs: info?.amountIs ?? (banana?.amountType === '2' ? 'tax' : banana?.amountType === '1' ? 'net' : 'gross'),
    ziffern: info ? vat().codes.sourceBoxes(info).sort((a, b) => Number(a) - Number(b)).map((ziffer) => ({ ziffer, figure: figureOf(ziffer) })) : null,
    rules: spec.rules,
    examples: VAT_CODE_EXAMPLES[code] ?? [],
  };
}

const familyOrder = (c: VatCodeEntry) => VAT_CODE_FAMILIES.indexOf(c.family) * 100 + VAT_CODE_KINDS.findIndex((k) => k.kind === c.kind && k.family === c.family);

let catalogue: { engine: ReturnType<typeof vat>; codes: readonly VatCodeEntry[]; byCode: Map<string, VatCodeEntry> } | undefined;

/** Banana's codes and every code the jurisdiction knows by name, by family and kind, Banana's order within. */
export function vatCodes(): readonly VatCodeEntry[] {
  if (catalogue?.engine !== vat()) {
    const codes = [...new Set([...BANANA_VAT_CODES.map((b) => b.code), ...vat().codes.named])]
      .map((code) => describe(code))
      .filter((c): c is VatCodeEntry => c !== null)
      .map((c, i) => ({ c, i }))
      .sort((a, b) => familyOrder(a.c) - familyOrder(b.c) || a.i - b.i)
      .map(({ c }) => c);
    catalogue = { engine: vat(), codes, byCode: new Map(codes.map((c) => [c.code, c])) };
  }
  return catalogue.codes;
}

/**
 * The catalogue entry of a code as booked, and whether it carries a minus (a refund or reversal:
 * the same Ziffern, the amount counts against them). A code outside the catalogue that the engine
 * still accepts (I26-2) is described the same way; an unknown code gives null.
 */
export function lookupVatCode(code: string): { entry: VatCodeEntry; negative: boolean } | null {
  const negative = code.startsWith('-');
  const unsigned = negative ? code.slice(1) : code;
  vatCodes();
  const entry = catalogue!.byCode.get(unsigned) ?? describe(unsigned);
  return entry ? { entry, negative } : null;
}

/**
 * Whether the firm's form takes `code`. On the effective method every code as written (a person
 * sees a code the engine does not know); a firm not registered takes none, one on the net tax rate
 * method only its own (F1, B81, V0 …), never an input-tax code such as I81 or K81-B.
 */
export const formTakes = (code: string): boolean => methodOf(vatSetup()) === 'effective' || !!vat().codes.parse(code);

/** The catalogue's codes this firm may book: what a VAT field offers and the codes area lists. */
export const firmCodes = (): readonly VatCodeEntry[] => vatCodes().filter((c) => formTakes(c.code));

/** A rate as a person types it: «8.1», «8,1», «8.1 %», «-8.1» (a refund). */
export function parseRate(text: string): { rate: number; negative: boolean } | null {
  const m = /^(-)?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%?$/.exec(text.trim());
  return m ? { rate: Number(m[2].replace(',', '.')), negative: !!m[1] } : null;
}

/**
 * The code a typed rate stands for on an entry: a sale's code when one side is a revenue account,
 * else the input-tax code of its expense or investment account, in the box its income section
 * names. A revenue or expense account on its unusual side (a refund) gets the code's minus.
 * Null when the rate is no rate of the jurisdiction or the accounts say neither.
 */
export function codeForRate(rate: number, accountDebit: string, accountCredit: string, negative = false): string | null {
  if (!(rate > 0)) return null;
  const type = (a: string) => (a ? chart().typeOf(a) : undefined);
  const neg = vat().codes.negativePrefix;
  const signed = (code: string | undefined, refund: boolean) => (code ? (refund !== negative ? neg + code : code) : null);
  const purchase = (account: string) => {
    const boxes = vat().codes.purchaseBoxes;
    return vat().codes.purchaseAt(rate, inGroup(statements().income.costOfGoods)(account) ? boxes.costOfGoods : boxes.otherwise);
  };
  // A sale at a statutory rate, or, on the net tax rate method, at one of the firm's approved rates.
  const saleAt = (r: number) => vat().codes.saleAt(r) ?? vat().rateRows.find((row) => row.kind === 'net-rate' && row.rate === r)?.code;
  if (type(accountCredit) === 'revenue') return signed(saleAt(rate), false);
  if (type(accountDebit) === 'revenue') return signed(saleAt(rate), true);
  if (type(accountDebit) === 'expense') return signed(purchase(accountDebit), false);
  if (type(accountCredit) === 'expense') return signed(purchase(accountCredit), true);
  if (type(accountDebit) === 'asset') return signed(purchase(accountDebit), false);
  return null;
}

/** A code as a person types it, or the code a typed rate («8.1») stands for on these accounts; null when it is neither. */
export function vatCodeOf(typed: string, accountDebit: string, accountCredit: string): { code: string; fromRate?: number } | null {
  if (!typed || lookupVatCode(typed)) return { code: typed };
  const r = parseRate(typed);
  const code = r && codeForRate(r.rate, accountDebit, accountCredit, r.negative);
  return code ? { code, fromRate: r!.rate } : null;
}

/**
 * A purchase code on an entry whose account changed: the same rate and sign, the family the
 * account takes (pv-prefix-from-account): M on material and goods, I on operating costs and
 * investments. Undefined for any other code (a sale, a correction, Bezugsteuer, an amount suffix)
 * or when the accounts say neither.
 */
export function codeOnAccount(code: string | undefined, accountDebit: string, accountCredit: string): string | undefined {
  const m = /^(-?)([MI])(\d+)$/.exec(code ?? '');
  const info = m && vat().codes.parse(code!);
  if (!m || !info) return undefined;
  const probe = info.rate > 0 ? info.rate : vat().rateRows.find((r) => r.kind === 'supply' && !r.superseded)?.rate;
  const family = probe ? codeForRate(probe, accountDebit, accountCredit)?.replace(/^-/, '')[0] : undefined;
  return family === 'M' || family === 'I' ? `${m[1]}${family}${m[3]}` : undefined;
}

/**
 * What a line states of its VAT: the facts a reader sees on the document, never a code (issue #64).
 * Code derives the code from them and the line's accounts (codeOfFacts), so the letter and the sign
 * follow the accounts and the amount suffix the booking pattern, whoever read the document.
 */
export interface VatLineFacts {
  /** The supplier charged the jurisdiction's VAT, charged none, or charged none on a service from abroad on which the firm owes acquisition tax (Bezugsteuer). */
  charge: 'charged' | 'none' | 'acquisition';
  /** The rate charged, in percent (8.1); absent: the normal rate. */
  rate?: number;
  /** The amount is the tax itself: a single-leg entry whose code supplies its other leg. */
  amountIs?: 'tax';
  /** On a sale without VAT: a service supplied abroad, else an export of goods. */
  supply?: 'goods' | 'service' | 'exempt';
}

/**
 * A rate as a rule or the model writes it: 8.1, «8.1», «8,1 %», or a code's suffix «81» for 8.1.
 * Undefined for a rate the jurisdiction and the firm's form do not know (a foreign 19 %) and for
 * anything that is no rate.
 */
export function rateOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseRate(v)?.rate : undefined;
  if (n === undefined || !Number.isFinite(n) || n < 0) return undefined;
  const known = (r: number) => r === 0 || vat().isDomesticRate(r) || vat().rateRows.some((row) => row.rate === r);
  return known(n) ? n : known(n / 10) ? n / 10 : undefined;
}

/**
 * The code `facts` stand for on a line with these accounts (one of them empty on a tax amount), or
 * undefined when the accounts take none:
 * - charged: the input-tax or sales code of the account at the rate (codeForRate,
 *   pv-prefix-from-account), the minus on money back; on a tax amount the account's code with the
 *   tax-amount suffix (M81-2);
 * - acquisition: the acquisition-tax code on the net amount (B81-1), the minus on money back;
 * - none: a sale's exemption code (a service supplied abroad V0-E, else the export V0), a
 *   purchase's zero code of its account (M0, I0).
 */
export function codeOfFacts(facts: VatLineFacts, accountDebit: string, accountCredit: string): string | undefined {
  const type = (a: string) => (a ? chart().typeOf(a) : undefined);
  const neg = vat().codes.negativePrefix;
  const rate = facts.rate ?? normalRate();
  if (facts.charge === 'acquisition') {
    const code = vat().codes.acquisitionAt(rate);
    return code && (type(accountCredit) === 'expense' && type(accountDebit) !== 'expense' ? neg + code : code);
  }
  if (facts.charge === 'charged' && rate > 0) {
    if (facts.amountIs !== 'tax') return codeForRate(rate, accountDebit, accountCredit) ?? undefined;
    const gross = [accountDebit, accountCredit].filter(Boolean).map((a) => codeForRate(rate, a, a)).find((c) => c);
    return gross ? vat().codes.taxAmountCode(gross) : undefined;
  }
  if (type(accountCredit) === 'revenue' || type(accountDebit) === 'revenue') {
    const code = vat().codes.deductedIn(invoicing().exemptions[facts.supply === 'service' ? 'abroad' : 'export']);
    return code && (type(accountDebit) === 'revenue' && type(accountCredit) !== 'revenue' ? neg + code : code);
  }
  return codeOnAccount('I0', accountDebit, accountCredit);
}

/**
 * The facts a code states, read back: what a model that still writes a code meant, and what a
 * casebook example shows the model. Undefined for a code facts cannot state (a correction, a net
 * tax rate, another exemption, a reversed tax amount): such a code stays as written.
 */
export function factsOfCode(code: string | undefined): VatLineFacts | undefined {
  const info = code ? vat().codes.parse(code) : null;
  if (!info || info.flatOnGross || info.correctionZiffer) return undefined;
  if (info.acquisitionZiffer) return info.amountIs === 'net' ? { charge: 'acquisition', rate: info.rate } : undefined;
  if (info.amountIs === 'tax') return info.isNegative || !(info.rate > 0) ? undefined : { charge: 'charged', rate: info.rate, amountIs: 'tax' };
  if (info.amountIs !== 'gross') return undefined;
  if (info.rate > 0) return info.revenueZiffer || info.inputTaxZiffer ? { charge: 'charged', rate: info.rate } : undefined;
  const { abroad, export: goods } = invoicing().exemptions;
  if (info.deductionZiffer === abroad) return { charge: 'none', supply: 'service' };
  if (info.deductionZiffer === goods) return { charge: 'none', supply: 'goods' };
  return info.deductionZiffer ? undefined : { charge: 'none' };
}
