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

/** What an invoice may charge. */
export const invoicing = (): Jurisdiction['invoicing'] => loaded().source.invoicing;

/** The jurisdiction's year close: its accounts, entry forms and withholding tax. */
export const yearEnd = (): Jurisdiction['yearEnd'] => loaded().source.yearEnd;

/** The open workspace's statement layout. */
export const statements = (): Jurisdiction['statements'] => loaded().source.statements;

/** The length of one VAT return and when its tax is due. */
export const filing = (): Jurisdiction['periods']['vat'] => loaded().source.periods.vat;

/** The currency the books are kept in: every amount without an exchange currency is in it. */
export const baseCurrency = (): string => loaded().source.manifest.baseCurrency;

/** What a new workspace gets from the setup's answers, the owner's private account among them. */
export const setup = (): Jurisdiction['setup'] => loaded().source.setup;

/** The words that say what a document is: a receipt, a document beside one, or none. */
export const documents = (): Jurisdiction['documents'] => loaded().source.documents;
