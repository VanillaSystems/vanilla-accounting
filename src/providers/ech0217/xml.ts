/**
 * The eCH-0217 E-MWST v2.0.0 XML for the ESTV "MWST abrechnen" import, from a return's figures
 * (docs/specs/eCH-0217-V2.0.0-E-MWST_de.pdf). Pure: the caller computes the figures and passes the
 * form, so the same figures make the same file.
 *
 * Compliance choices (per the spec):
 *  - Effective reporting method, gross figures (grossOrNet = 2): the bookings are VAT-inclusive.
 *  - Net tax rate method (periods from 2025): simpleTaxRateMethod, each approved rate with the
 *    authority's activity code (5.3.11), the turnover gross, Bezugsteuer net at the statutory rate.
 *  - formOfReporting = 2 (vereinnahmt / cash basis).
 *  - payableTax is the eCH way (tax on the rate-total turnover, rule 7.5/7.6, error MWST-0006);
 *    it can differ from a per-entry sum by a Rappen and is the authoritative figure for filing.
 *  - The declaring company's UID and name are the workspace's (rule 7.7, error MWST-0009).
 */
import type { BoxId, ReturnData } from '../../core/modules/schema.js';
import type { VatMethod } from '../../workspace/vat-setup.js';

export interface Ech0217Input {
  uid: string;
  organisationName: string;
  period: { key: string; from: string; to: string };
  ziffern: Record<BoxId, number>;
  payable: number;
  form: Pick<ReturnData, 'turnoverBox' | 'deductions' | 'inputTax'>;
  rateRows: ReadonlyArray<{ ziffer: BoxId; rate: number; kind: 'supply' | 'acquisition' | 'net-rate'; name?: string; activityId?: string }>;
  /** Which method's element carries section II; the effective one when absent. */
  method?: VatMethod;
  /** xs:dateTime in UTC without milliseconds (spec 4.1). */
  generationTime: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const amt = (n: number) => n.toFixed(2);

/** The XML, and the figures it cannot carry (a deduction with no eCH element needs manual entry). */
export function ech0217Xml(input: Ech0217Input): { xml: string; warnings: string[] } {
  const { ziffern, form, period } = input;
  const method = input.method ?? 'effective';
  const z = (n: BoxId) => ziffern[n] ?? 0;
  const warnings = Object.entries(form.deductions).filter(([nr, d]) => !d.element && z(nr) !== 0)
    .map(([nr, d]) => `Ziffer ${nr} (${d.label}) is ${amt(z(nr))} and has no eCH-0217 element: enter it in the portal by hand.`);
  // eCH-0108/7 uidType: CHE[1-9][0-9]{8}, no dots or dashes.
  const uid = input.uid.replace(/[.-]/g, '');

  const deductionEls = Object.entries(form.deductions).flatMap(([nr, d]) => (d.element ? [[nr, d.element] as const] : []))
    .filter(([nr]) => z(nr) !== 0)
    .map(([nr, el]) => `    <eCH-0217:${el}>${amt(z(nr))}</eCH-0217:${el}>`)
    .join('\n');
  const rateEls = (kind: 'supply' | 'acquisition', el: string) => input.rateRows
    .filter((row) => row.kind === kind && z(row.ziffer) !== 0)
    .sort((a, b) => b.rate - a.rate)
    .map((row) => `    <eCH-0217:${el}>
      <eCH-0217:taxRate>${row.rate}</eCH-0217:taxRate>
      <eCH-0217:turnover>${amt(z(row.ziffer))}</eCH-0217:turnover>
    </eCH-0217:${el}>`).join('\n');
  const inputEls = Object.entries(form.inputTax).map(([nr, b]) => [nr, b.element] as const)
    .filter(([nr]) => z(nr) !== 0)
    .map(([nr, el]) => `    <eCH-0217:${el}>${amt(z(nr))}</eCH-0217:${el}>`)
    .join('\n');
  // The net tax rate method names each approved rate by the authority's activity code (activityIdTurnoverTaxRateType).
  const netRateEls = () => input.rateRows
    .filter((row) => row.kind === 'net-rate' && z(row.ziffer) !== 0)
    .map((row) => {
      if (!row.activityId) throw new Error(`Ziffer ${row.ziffer} (${row.name ?? row.rate}): the tax authority's activity code of this rate is missing (company.vat.rates[].activityId, Firma › MWST), so the XML cannot name it.`);
      return `    <eCH-0217:suppliesPerTaxRate>
      <eCH-0217:activityId>${esc(row.activityId)}</eCH-0217:activityId>
      <eCH-0217:taxRate>${row.rate}</eCH-0217:taxRate>
      <eCH-0217:turnover>${amt(z(row.ziffer))}</eCH-0217:turnover>
    </eCH-0217:suppliesPerTaxRate>`;
    }).join('\n');

  const sectionTwo = method === 'net-rate'
    ? `  <eCH-0217:simpleTaxRateMethod>
${netRateEls()}
${rateEls('acquisition', 'acquisitionTax')}
  </eCH-0217:simpleTaxRateMethod>`
    : `  <eCH-0217:effectiveReportingMethod>
    <eCH-0217:grossOrNet>2</eCH-0217:grossOrNet>
${rateEls('supply', 'suppliesPerTaxRate')}
${rateEls('acquisition', 'acquisitionTax')}
${inputEls}
  </eCH-0217:effectiveReportingMethod>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<eCH-0217:VATDeclaration
    xmlns:eCH-0217="http://www.ech.ch/xmlns/eCH-0217/2"
    xmlns:eCH-0058="http://www.ech.ch/xmlns/eCH-0058/5">
  <eCH-0217:generalInformation>
    <eCH-0217:uid>${uid}</eCH-0217:uid>
    <eCH-0217:organisationName>${esc(input.organisationName)}</eCH-0217:organisationName>
    <eCH-0217:generationTime>${input.generationTime}</eCH-0217:generationTime>
    <eCH-0217:reportingPeriodFrom>${period.from}</eCH-0217:reportingPeriodFrom>
    <eCH-0217:reportingPeriodTill>${period.to}</eCH-0217:reportingPeriodTill>
    <eCH-0217:typeOfSubmission>1</eCH-0217:typeOfSubmission>
    <eCH-0217:formOfReporting>2</eCH-0217:formOfReporting>
    <eCH-0217:businessReferenceId>MWST-${period.key}</eCH-0217:businessReferenceId>
    <eCH-0217:sendingApplication>
      <eCH-0058:manufacturer>Vanilla Accounting</eCH-0058:manufacturer>
      <eCH-0058:product>Vanilla Accounting</eCH-0058:product>
      <eCH-0058:productVersion>1.0</eCH-0058:productVersion>
    </eCH-0217:sendingApplication>
  </eCH-0217:generalInformation>
  <eCH-0217:turnoverComputation>
    <eCH-0217:totalConsideration>${amt(z(form.turnoverBox))}</eCH-0217:totalConsideration>
${deductionEls}
  </eCH-0217:turnoverComputation>
${sectionTwo}
  <eCH-0217:payableTax>${amt(input.payable)}</eCH-0217:payableTax>
</eCH-0217:VATDeclaration>
`;
  return { xml, warnings };
}
