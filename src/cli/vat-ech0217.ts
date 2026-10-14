/**
 * Generate an eCH-0217 E-MWST v2.0.0 XML for import into the ESTV "MWST abrechnen" portal.
 *
 * Standard: eCH-0217 Spezifikation E-MWST V2.0.0 (see docs/specs/eCH-0217-V2.0.0-E-MWST_de.pdf).
 * Namespaces: eCH-0217/2, eCH-0108/6 (UID), eCH-0058/5 (sendingApplication).
 *
 * IMPORTANT — compliance choices baked in here (per the spec):
 *  - Effective reporting method (effectiveReportingMethod), gross figures (grossOrNet = 2),
 *    since our bookings are VAT-inclusive.
 *  - formOfReporting = 2 (vereinnahmt / cash basis).
 *  - payableTax (Ziff. 500/510) is recomputed the eCH way — tax on the rate-total turnover,
 *    NOT the per-entry tax sum (rule 7.5/7.6, error MWST-0006). This can differ from the UI's
 *    figure by a Rappen; the XML value is the authoritative one for filing.
 *  - 299 = Σ turnover holds by construction (rule 7.5, error MWST-0005).
 *
 * The declaring company's UID and name are the workspace manifest's (rule 7.7, error MWST-0009).
 *
 * Usage: npm run vat-xml -- <YYYY-Qn> [outfile]   (the period is required: a default would regenerate filed returns)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuarterKey } from '../types/index.js';
import { loadBooks, periodLock } from '../books/store.js';
import { derivePeriod } from '../accounting/periods.js';
import { TAX_RATE_ROWS, TURNOVER_DEDUCTIONS, INPUT_TAX } from '../accounting/ziffern.js';
import { openWorkspace } from '../workspace/workspace.js';
import { vat } from '../engines/index.js';

const ws = openWorkspace();
const index = loadBooks(ws);
const entries = index.journalEntries ?? [];
const adjustments = index.config?.vatAdjustments ?? [];


// Declaring company (rule 7.7). eCH-0108/7 uidType: CHE[1-9][0-9]{8}, no dots or dashes.
const UID_TEXT = ws.company.uid.replace(/[.-]/g, '');
const ORG_NAME = ws.company.name;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const amt = (n: number) => n.toFixed(2);

function utcStamp(): string {
  // xs:dateTime in UTC, format YYYY-MM-DDThh:mm:ss (spec 4.1). No BOM, no milliseconds.
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

function buildXml(periodKey: QuarterKey): { xml: string; payable: number } {
  const { from, to } = derivePeriod(periodKey)!;
  const { ziffern, payable } = vat().figures(entries, periodKey, adjustments);
  const z = (n: string) => ziffern[n] ?? 0;
  // variousDeduction (280) is a complex type, and 0 in this dataset, so it is guarded, not written.
  if (z('280') !== 0) {
    console.error(`⚠ ${periodKey}: Ziffer 280 (variousDeduction) is non-zero and needs the complex variousDeductionType — add it manually.`);
  }

  const deductionEls = TURNOVER_DEDUCTIONS
    .filter(([nr]) => z(nr) !== 0)
    .map(([nr, el]) => `    <eCH-0217:${el}>${amt(z(nr))}</eCH-0217:${el}>`)
    .join('\n');

  const rateEls = (kind: 'supply' | 'acquisition', el: string) => TAX_RATE_ROWS
    .filter((row) => row.kind === kind && z(row.ziffer) !== 0)
    .sort((a, b) => b.rate - a.rate)
    .map((row) => `    <eCH-0217:${el}>
      <eCH-0217:taxRate>${row.rate}</eCH-0217:taxRate>
      <eCH-0217:turnover>${amt(z(row.ziffer))}</eCH-0217:turnover>
    </eCH-0217:${el}>`).join('\n');
  const supplyEls = rateEls('supply', 'suppliesPerTaxRate');
  const acquisitionEls = rateEls('acquisition', 'acquisitionTax');

  const inputEls = INPUT_TAX
    .filter(([nr]) => z(nr) !== 0)
    .map(([nr, el]) => `    <eCH-0217:${el}>${amt(z(nr))}</eCH-0217:${el}>`)
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<eCH-0217:VATDeclaration
    xmlns:eCH-0217="http://www.ech.ch/xmlns/eCH-0217/2"
    xmlns:eCH-0058="http://www.ech.ch/xmlns/eCH-0058/5">
  <eCH-0217:generalInformation>
    <eCH-0217:uid>${UID_TEXT}</eCH-0217:uid>
    <eCH-0217:organisationName>${esc(ORG_NAME)}</eCH-0217:organisationName>
    <eCH-0217:generationTime>${utcStamp()}</eCH-0217:generationTime>
    <eCH-0217:reportingPeriodFrom>${from}</eCH-0217:reportingPeriodFrom>
    <eCH-0217:reportingPeriodTill>${to}</eCH-0217:reportingPeriodTill>
    <eCH-0217:typeOfSubmission>1</eCH-0217:typeOfSubmission>
    <eCH-0217:formOfReporting>2</eCH-0217:formOfReporting>
    <eCH-0217:businessReferenceId>MWST-${periodKey}</eCH-0217:businessReferenceId>
    <eCH-0217:sendingApplication>
      <eCH-0058:manufacturer>Vanilla Accounting</eCH-0058:manufacturer>
      <eCH-0058:product>Vanilla Accounting</eCH-0058:product>
      <eCH-0058:productVersion>1.0</eCH-0058:productVersion>
    </eCH-0217:sendingApplication>
  </eCH-0217:generalInformation>
  <eCH-0217:turnoverComputation>
    <eCH-0217:totalConsideration>${amt(z('200'))}</eCH-0217:totalConsideration>
${deductionEls}
  </eCH-0217:turnoverComputation>
  <eCH-0217:effectiveReportingMethod>
    <eCH-0217:grossOrNet>2</eCH-0217:grossOrNet>
${supplyEls}
${acquisitionEls}
${inputEls}
  </eCH-0217:effectiveReportingMethod>
  <eCH-0217:payableTax>${amt(payable)}</eCH-0217:payableTax>
</eCH-0217:VATDeclaration>
`;
  return { xml, payable };
}

// The period is required: a default would regenerate returns that are already filed.
const key = process.argv[2] ?? '';
const isQuarterKey = (k: string): k is QuarterKey => /^\d{4}-Q[1-4]$/.test(k);
if (!isQuarterKey(key)) {
  console.error(`Usage: npm run vat-xml -- <YYYY-Qn> [out.xml]   (e.g. 2026-Q3; got "${key}")`);
  process.exit(1);
}
// Golden rule 1 (AGENTS.md): a filed return is set in stone and is never regenerated.
const lock = periodLock(index);
if (lock.isClosed(derivePeriod(key)!.to)) {
  console.error(`${key} is filed (closed through ${lock.closedThrough}); its return is filings/${key.slice(0, 4)}/mwst-ech0217-${key}.xml and is never regenerated.`);
  console.error(`A correction is an entry dated in the open period with corrects: "${key}"; it is declared in ${key}'s Korrekturabrechnung (form 0535, MWST tab).`);
  process.exit(1);
}
{
  const { xml, payable } = buildXml(key);
  const out = process.argv[3] || join(ws.paths.root, `mwst-ech0217-${key}.xml`);
  writeFileSync(out, xml);
  const res = payable >= 0 ? `zu bezahlen CHF ${payable.toFixed(2)}` : `Guthaben CHF ${(-payable).toFixed(2)}`;
  console.log(`✓ ${out}  —  ${key}: ${res}`);
}
