import { XMLParser } from 'fast-xml-parser';
import type { QuarterKey } from '../types/index.js';
import { derivePeriod } from './periods.js';
import { completeFigures, type ReturnFigures } from './return-figures.js';
import { INPUT_TAX, TAX_RATE_ROWS, TURNOVER_DEDUCTIONS } from './ziffern.js';

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => name === 'suppliesPerTaxRate' || name === 'acquisitionTax',
});

/**
 * Reads a filed eCH-0217 return (filings/<year>/mwst-ech0217-<year>-Qn.xml, as written by
 * src/cli/vat-ech0217.ts) into its form Ziffern. Throws on anything it does not map, so a
 * figure is never silently dropped.
 */
export function parseFiledReturn(xml: string): ReturnFigures {
  const root = parser.parse(xml).VATDeclaration as Node | undefined;
  if (!root) throw new Error('not an eCH-0217 VATDeclaration');
  const info = root.generalInformation as Node;
  const period = quarterOf(String(info.reportingPeriodFrom), String(info.reportingPeriodTill));
  const turnover = root.turnoverComputation as Node;
  const effective = root.effectiveReportingMethod as Node | undefined;
  if (!effective) throw new Error(`${period}: only the effective reporting method is supported`);
  if (String(effective.grossOrNet) !== '2') throw new Error(`${period}: only gross figures (grossOrNet = 2) are supported`);

  const declared: Record<string, number> = { '200': num(turnover.totalConsideration) };
  const known = new Set(['totalConsideration']);
  for (const [nr, el] of TURNOVER_DEDUCTIONS) {
    known.add(el);
    if (el in turnover) declared[nr] = num(turnover[el]);
  }
  rejectUnknown(period, 'turnoverComputation', turnover, known);

  const knownEffective = new Set(['grossOrNet', 'opted', 'suppliesPerTaxRate', 'acquisitionTax']);
  if ('opted' in effective) declared['205'] = num(effective.opted);
  for (const kind of ['supply', 'acquisition'] as const) {
    const el = kind === 'supply' ? 'suppliesPerTaxRate' : 'acquisitionTax';
    for (const r of (effective[el] ?? []) as Node[]) {
      const rate = num(r.taxRate);
      const row = TAX_RATE_ROWS.find((x) => x.kind === kind && x.rate === rate);
      if (!row) throw new Error(`${period}: ${el} at rate ${rate}% has no Ziffer`);
      declared[row.ziffer] = num(r.turnover);
    }
  }
  for (const [nr, el] of INPUT_TAX) {
    knownEffective.add(el);
    if (el in effective) declared[nr] = num(effective[el]);
  }
  rejectUnknown(period, 'effectiveReportingMethod', effective, knownEffective);

  const flows = root.otherFlowsOfFunds as Node | undefined;
  if (flows) {
    if ('subsidies' in flows) declared['900'] = num(flows.subsidies);
    if ('donations' in flows) declared['910'] = num(flows.donations);
    rejectUnknown(period, 'otherFlowsOfFunds', flows, new Set(['subsidies', 'donations']));
  }

  // 500/510 are what was filed, not a recomputation.
  const payable = num(root.payableTax);
  const { ziffern } = completeFigures(period, declared);
  return { period, ziffern: { ...ziffern, '500': Math.max(0, payable), '510': Math.max(0, -payable) } };
}

function num(v: unknown): number {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) throw new Error(`not an amount: ${String(v)}`);
  return n;
}

function rejectUnknown(period: string, parent: string, node: Node, known: Set<string>) {
  const unknown = Object.keys(node).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`${period}: ${parent} has unsupported element(s) ${unknown.join(', ')}`);
}

function quarterOf(from: string, to: string): QuarterKey {
  const m = /^(\d{4})-(\d{2})-01$/.exec(from);
  const key = m && `${m[1]}-Q${Math.ceil(+m[2] / 3)}`;
  const p = key ? derivePeriod(key) : null;
  if (!p || p.from !== from || p.to !== to) throw new Error(`reporting period ${from}…${to} is not a quarter`);
  return key as QuarterKey;
}
