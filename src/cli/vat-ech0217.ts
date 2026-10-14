/**
 * npm run vat-xml -- <YYYY-Qn> [outfile]: the open period's return as eCH-0217 XML
 * (src/providers/ech0217/xml.ts) for the ESTV "MWST abrechnen" import. The period is required: a
 * default would regenerate returns that are already filed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuarterKey } from '../types/index.js';
import { loadBooks, periodLock } from '../books/store.js';
import { derivePeriod, isFilingKey } from '../accounting/periods.js';
import { openWorkspace } from '../workspace/workspace.js';
import { vat, filing } from '../engines/index.js';
import { ech0217Xml } from '../providers/ech0217/xml.js';

const ws = openWorkspace();
const index = loadBooks(ws);
const entries = index.journalEntries ?? [];
const adjustments = index.config?.vatAdjustments ?? [];

function buildXml(periodKey: QuarterKey): { xml: string; payable: number } {
  const { from, to } = derivePeriod(periodKey)!;
  const { ziffern, payable } = vat().figures(entries, periodKey, adjustments);
  const { xml, warnings } = ech0217Xml({
    uid: ws.company.uid, organisationName: ws.company.name, period: { key: periodKey, from, to },
    ziffern, payable, form: vat().form, rateRows: vat().rateRows,
    generationTime: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
  });
  for (const w of warnings) console.error(`⚠ ${periodKey}: ${w}`);
  return { xml, payable };
}

// The period is required: a default would regenerate returns that are already filed.
const key = process.argv[2] ?? '';
const isQuarterKey = (k: string): k is QuarterKey => isFilingKey(k, filing().length);
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
