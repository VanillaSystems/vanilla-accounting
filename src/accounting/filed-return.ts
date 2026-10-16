import { XMLParser } from 'fast-xml-parser';
import type { QuarterKey } from '../types/index.js';
import { derivePeriod, rangeToken } from './periods.js';
import { vat } from '../engines/index.js';
import type { ReturnFigures } from '../engines/return.js';

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => name === 'suppliesPerTaxRate' || name === 'acquisitionTax',
});

/**
 * Reads a filed eCH-0217 return (filings/<year>/mwst-ech0217-<period>.xml, as written by
 * src/cli/vat-ech0217.ts) into its form Ziffern: the effective method's element, or the net tax
 * rate method's (simpleTaxRateMethod). Throws on anything it does not map, so a figure is never
 * silently dropped.
 */
export function parseFiledReturn(xml: string): ReturnFigures {
  const root = parser.parse(xml).VATDeclaration as Node | undefined;
  if (!root) throw new Error('not an eCH-0217 VATDeclaration');
  const info = root.generalInformation as Node;
  const period = periodOf(String(info.reportingPeriodFrom), String(info.reportingPeriodTill));
  const turnover = root.turnoverComputation as Node;

  const declared: Record<string, number> = { '200': num(turnover.totalConsideration) };
  const known = new Set(['totalConsideration']);
  for (const [nr, el] of Object.entries(vat().form.deductions).flatMap(([nr, d]) => (d.element ? [[nr, d.element] as const] : []))) {
    known.add(el);
    if (el in turnover) declared[nr] = num(turnover[el]);
  }
  rejectUnknown(period, 'turnoverComputation', turnover, known);

  const effective = root.effectiveReportingMethod as Node | undefined;
  const simple = root.simpleTaxRateMethod as Node | undefined;
  if (effective) readEffective(period, effective, declared);
  else if (simple) readNetRate(period, simple, declared);
  else throw new Error(`${period}: only the effective and the net tax rate method (simpleTaxRateMethod) are supported`);

  const flows = root.otherFlowsOfFunds as Node | undefined;
  if (flows) {
    if ('subsidies' in flows) declared['900'] = num(flows.subsidies);
    if ('donations' in flows) declared['910'] = num(flows.donations);
    rejectUnknown(period, 'otherFlowsOfFunds', flows, new Set(['subsidies', 'donations']));
  }

  // 500/510 are what was filed, not a recomputation.
  const payable = num(root.payableTax);
  const { ziffern } = vat().complete(period, declared);
  return { period, ziffern: { ...ziffern, '500': Math.max(0, payable), '510': Math.max(0, -payable) } };
}

function readEffective(period: QuarterKey, effective: Node, declared: Record<string, number>): void {
  if (String(effective.grossOrNet) !== '2') throw new Error(`${period}: only gross figures (grossOrNet = 2) are supported`);
  const known = new Set(['grossOrNet', 'opted', 'suppliesPerTaxRate', 'acquisitionTax']);
  if ('opted' in effective) declared['205'] = num(effective.opted);
  readRates(period, effective, 'suppliesPerTaxRate', 'supply', declared);
  readRates(period, effective, 'acquisitionTax', 'acquisition', declared);
  for (const [nr, el] of Object.entries(vat().form.inputTax).map(([nr, b]) => [nr, b.element] as const)) {
    known.add(el);
    if (el in effective) declared[nr] = num(effective[el]);
  }
  rejectUnknown(period, 'effectiveReportingMethod', effective, known);
}

/** The net tax rate method's section II: each approved rate's gross turnover, matched to the firm's row by activity code, else by rate. */
function readNetRate(period: QuarterKey, simple: Node, declared: Record<string, number>): void {
  for (const r of (simple.suppliesPerTaxRate ?? []) as Node[]) {
    const rate = num(r.taxRate);
    const id = r.activityId === undefined ? undefined : String(r.activityId);
    const rows = vat().rateRows.filter((x) => x.kind === 'net-rate');
    const row = rows.find((x) => id && x.activityId === id) ?? rows.find((x) => x.rate === rate);
    if (!row) throw new Error(`${period}: suppliesPerTaxRate at ${rate}% (activity ${id ?? 'none'}) is none of the firm's approved net rates`);
    declared[row.ziffer] = (declared[row.ziffer] ?? 0) + num(r.turnover);
  }
  readRates(period, simple, 'acquisitionTax', 'acquisition', declared);
  if ('inputTaxCorrections' in simple) throw new Error(`${period}: inputTaxCorrections (Ziffer 415) of the net tax rate method is not modelled`);
  rejectUnknown(period, 'simpleTaxRateMethod', simple, new Set(['suppliesPerTaxRate', 'acquisitionTax']));
}

function readRates(period: QuarterKey, node: Node, el: string, kind: 'supply' | 'acquisition', declared: Record<string, number>): void {
  for (const r of (node[el] ?? []) as Node[]) {
    const rate = num(r.taxRate);
    const row = vat().rateRows.find((x) => x.kind === kind && x.rate === rate);
    if (!row) throw new Error(`${period}: ${el} at rate ${rate}% has no Ziffer`);
    declared[row.ziffer] = num(r.turnover);
  }
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

/** The filing period the dates span exactly: a quarter or a half year. */
function periodOf(from: string, to: string): QuarterKey {
  const key = rangeToken(from, to);
  const kind = derivePeriod(key)?.kind;
  if (kind !== 'quarter' && kind !== 'half') throw new Error(`reporting period ${from}…${to} is neither a quarter nor a half year`);
  return key as QuarterKey;
}
