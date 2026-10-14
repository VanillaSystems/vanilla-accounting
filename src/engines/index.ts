/**
 * The jurisdiction the open workspace uses, as engines. Node sets it when a workspace opens
 * (src/workspace/workspace.ts), the browser when /modules.json arrives (src/app/hooks/use-index.ts),
 * so the CLI, the server and the UI compute the same figures from the same data.
 */
import type { Jurisdiction } from '../core/modules/schema.js';
import { chartEngine, type ChartEngine } from './chart.js';
import { returnEngine, type ReturnEngine } from './return.js';

let current: { source: Jurisdiction; vat: ReturnEngine; chart: ChartEngine } | undefined;

export function setJurisdiction(j: Jurisdiction): void {
  if (current?.source !== j) current = { source: j, vat: returnEngine(j), chart: chartEngine(j.chart) };
}

function loaded() {
  if (!current) throw new Error('No jurisdiction loaded: open a workspace (CLI, server) or load /modules.json (UI) first.');
  return current;
}

/** The VAT engine of the open workspace's jurisdiction. */
export const vat = (): ReturnEngine => loaded().vat;

/** The open workspace's chart: what an account is. */
export const chart = (): ChartEngine => loaded().chart;
