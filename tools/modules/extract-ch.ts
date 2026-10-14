/**
 * Writes modules/ch/{module,rates,tax-codes,return}.yaml from the Swiss constants they replace
 * (src/accounting/ziffern.ts and the code table of vat-report.ts), so the data module starts
 * equal to today's engine by construction. tests/engine-equivalence.test.ts proves it.
 *
 *   npx tsx tools/modules/extract-ch.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { APP_ROOT } from '../../src/workspace/workspace.js';
import { NAMED_VAT_CODES, parseVatCode } from '../../src/accounting/vat-report.js';
import { INPUT_TAX, TAX_RATE_ROWS, TURNOVER_DEDUCTIONS, VARIOUS_DEDUCTION } from '../../src/accounting/ziffern.js';
import type { CodeMeaning, ModuleManifest, RatesData, ReturnData, TaxCodesData } from '../../src/core/modules/schema.js';

const dir = join(APP_ROOT, 'modules/ch');
mkdirSync(dir, { recursive: true });
const write = (file: string, header: string, data: unknown) =>
  writeFileSync(join(dir, file), `${header.trim().split('\n').map((l) => `# ${l}`.trimEnd()).join('\n')}\n\n${stringify(data, { lineWidth: 0 })}`);

const manifest: ModuleManifest = {
  id: 'ch', kind: 'jurisdiction', version: '2026.4.0', schema: 1,
  provides: ['accounting.tax.vat-codes@1', 'accounting.tax.rates@1', 'accounting.tax.vat-return@1'],
};
write('module.yaml', 'Switzerland: the MWST codes, rates and return as data (docs/0.4.0/modules.md).', manifest);

const rates: RatesData = {
  rows: Object.fromEntries(TAX_RATE_ROWS.map((r) => [r.ziffer, {
    rate: r.rate, kind: r.kind, code: r.vatCode, name: r.name, ...(r.superseded ? { superseded: true } : {}),
  }])),
};
write('rates.yaml', `The rate rows of section II of the MWST return (effective method), keyed by Ziffer.
A supply row is declared gross, a Bezugsteuer row net. Superseded rates ended on 31.12.2023.`, rates);

const codes: Record<string, CodeMeaning> = {};
for (const code of NAMED_VAT_CODES) {
  const i = parseVatCode(code)!;
  codes[code] = {
    rate: i.rate,
    ...(i.revenueZiffer ? { revenue: i.revenueZiffer } : {}),
    ...(i.deductionZiffer ? { deduction: i.deductionZiffer } : {}),
    ...(i.inputTaxZiffer ? { inputTax: i.inputTaxZiffer } : {}),
    ...(i.correctionZiffer ? { correction: i.correctionZiffer } : {}),
    ...(i.acquisitionZiffer ? { acquisition: i.acquisitionZiffer } : {}),
  };
}
const taxCodes: TaxCodesData = {
  negativePrefix: '-',
  amountSuffix: { families: ['M', 'I', 'B'], net: '-1', tax: '-2' },
  codes,
  patterns: [{ match: '^K(\\d*)-([ABC])$', rateGroup: 1, rateDivisor: 10, correctionGroup: 2, correction: { A: '410', B: '415', C: '420' } }],
};
write('tax-codes.yaml', `The MWST codes (Banana's names, reference/MWST-codes.txt) and the boxes each feeds.
"-" before a code reverses it (a refund). On M, I and B codes the suffix -1 means the amount is
net, -2 that it is the tax itself; without a suffix it is gross.`, taxCodes);

const vatReturn: ReturnData = {
  turnoverBox: '200',
  turnoverLabel: 'Gesamtumsatz',
  rateOrder: TAX_RATE_ROWS.map((r) => r.ziffer),
  deductions: Object.fromEntries([
    ...TURNOVER_DEDUCTIONS.map(([z, element, label]) => [z, { label, element }]),
    [VARIOUS_DEDUCTION.ziffer, { label: VARIOUS_DEDUCTION.label }],
  ]),
  inputTax: Object.fromEntries(INPUT_TAX.map(([z, element, label, sign]) => [z, { label, element, sign }])),
  derived: {
    '289': { label: 'Total Abzüge', formula: { sum: [...TURNOVER_DEDUCTIONS.map(([z]) => z), VARIOUS_DEDUCTION.ziffer] } },
    '299': { label: 'Steuerbarer Umsatz', formula: { minus: ['200', '289'] } },
    '399': { label: 'Total geschuldete Steuer', formula: { taxOfRows: true } },
    '479': { label: 'Total Vorsteuer', formula: { signed: Object.fromEntries(INPUT_TAX.map(([z, , , sign]) => [z, sign])) } },
    '500': { label: 'Zu bezahlender Betrag', formula: { positive: { minus: ['399', '479'] } } },
    '510': { label: 'Guthaben', formula: { positive: { minus: ['479', '399'] } } },
  },
  payable: '500',
  credit: '510',
};
write('return.yaml', `The MWST return (ESTV form 0550, effective method, eCH-0217 v2.0.0), keyed by Ziffer.
Deductions and input tax are listed in eCH-0217 schema order; derived Ziffern are formulas over
other Ziffern (sum, minus, positive, signed, taxOfRows), so the loader can check every reference.`, vatReturn);

console.log(`Wrote ${dir}: ${NAMED_VAT_CODES.length} codes, ${TAX_RATE_ROWS.length} rate rows.`);
