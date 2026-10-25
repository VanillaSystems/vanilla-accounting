/**
 * The jurisdiction the open workspace uses, as engines, computed for the firm's VAT setup. Node
 * sets both when a workspace opens (src/workspace/workspace.ts), the browser when /modules.json
 * arrives (src/app/hooks/use-index.ts), so the CLI, the server and the UI compute the same
 * figures from the same data for the same kind of firm.
 */
import type { Jurisdiction } from '../core/modules/schema.js';
import { EFFECTIVE_QUARTERLY, filingLengthOf, methodOf, onAgreedBasis, type VatBasis, type VatMethod, type VatSetup } from '../workspace/vat-setup.js';
import { chartEngine, type ChartEngine } from './chart.js';
import { useDocumentWords } from '../books/statement-facts.js';
import { returnEngine, type ReturnEngine } from './return.js';

let current: { source: Jurisdiction; setup?: VatSetup; vat: ReturnEngine; chart: ChartEngine } | undefined;

/**
 * Computes with `j` for a firm set up as `setup`. Without a setup (a test, a tool without a
 * workspace) the engines take the jurisdiction as it ships: its effective form and its own period.
 */
export function setJurisdiction(j: Jurisdiction, setup?: VatSetup): void {
  if (current?.source !== j || current.setup !== setup) current = { source: j, setup, vat: returnEngine(j, setup), chart: chartEngine(j.chart) };
  useDocumentWords(j.documents);
}

function loaded() {
  if (!current) throw new Error('No jurisdiction loaded: open a workspace (CLI, server) or load /modules.json (UI) first.');
  return current;
}

/** The VAT engine of the open workspace's jurisdiction, for the firm's method. */
export const vat = (): ReturnEngine => loaded().vat;

/** The firm's VAT setup: registered or not, its method and its filing period (src/workspace/vat-setup.ts); the effective method where no firm is open. */
export const vatSetup = (): VatSetup => loaded().setup ?? EFFECTIVE_QUARTERLY;

/** Whether the firm reports on the agreed consideration (src/accounting/tax-point.ts): its VAT arises with the invoice, not the payment. */
export const agreedBasis = (): boolean => onAgreedBasis(vatSetup());

/** The method the firm's return is written in; a firm that is not registered has none to write. */
export function filingMethod(): VatMethod {
  const method = methodOf(vatSetup());
  if (method === 'none') throw new Error('the firm is not registered for VAT: there is no return to write');
  return method;
}

/** The basis the firm's return is written on (the electronic return names it); a firm that is not registered has none. */
export function filingBasis(): VatBasis {
  const setup = vatSetup();
  if (!setup.registered) throw new Error('the firm is not registered for VAT: there is no return to write');
  return setup.reporting;
}

/**
 * Why the firm claims no input tax: it is not registered (`none`), or it is on the net tax rate
 * method, whose rate on the turnover stands for it; undefined on the effective method.
 */
export function withoutInputTax(): 'none' | 'net-rate' | undefined {
  const method = methodOf(vatSetup());
  return method === 'effective' ? undefined : method;
}

/** The open workspace's chart: what an account is. */
export const chart = (): ChartEngine => loaded().chart;

/** What an invoice may charge. */
export const invoicing = (): Jurisdiction['invoicing'] => loaded().source.invoicing;

/** Whether the firm's invoices carry VAT at all: a firm not registered prints none (what it shows, it owes). */
export const chargesVat = (): boolean => vatSetup().registered;

/**
 * The firm's net tax rates whose activity code of the tax authority is missing, among those a
 * return has turnover on (by box): the electronic return names each rate by that code, so without
 * it the return's file cannot be written (r6f-22). Named by the rate's label, else its percent.
 */
export const ratesWithoutActivityId = (figures: Record<string, number>): string[] => vat().rateRows
  .filter((row) => row.kind === 'net-rate' && !row.activityId && (figures[row.ziffer] ?? 0) !== 0)
  .map((row) => row.name ?? `${row.rate} %`);

/** The rates an invoice line may take: the jurisdiction's for a registered firm, 0 alone for one not registered. */
export const invoiceRates = (): readonly number[] => (chargesVat() ? invoicing().rates : [0]);

/** The jurisdiction's year close: its accounts, entry forms and withholding tax. */
export const yearEnd = (): Jurisdiction['yearEnd'] => loaded().source.yearEnd;

/** The open workspace's statement layout. */
export const statements = (): Jurisdiction['statements'] => loaded().source.statements;

/**
 * The length of one filing period and when its tax is due: the firm's period when it files
 * returns, else the jurisdiction's default as the bookkeeping period a firm closes by.
 */
export const filing = (): Jurisdiction['periods']['vat'] => {
  const { source, setup } = loaded();
  return setup ? { length: filingLengthOf(setup, source.periods.vat.length), dueDays: source.periods.vat.dueDays } : source.periods.vat;
};

/** When a firm must register for VAT; undefined for a jurisdiction that states no threshold. */
export const registration = (): Jurisdiction['registration'] => loaded().source.registration;

/** The currency the books are kept in: every amount without an exchange currency is in it. */
export const baseCurrency = (): string => loaded().source.manifest.baseCurrency;

/** What a new workspace gets from the setup's answers, the owner's private account among them. */
export const setup = (): Jurisdiction['setup'] => loaded().source.setup;

/** The words that say what a document is: a receipt, a document beside one, or none. */
export const documents = (): Jurisdiction['documents'] => loaded().source.documents;
