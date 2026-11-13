/**
 * The order pages of the provider way, as the server derives them from the books and the business
 * files (GET /api/receipts/order-pages, #253), loaded with the books: Belege reads them beside the books.
 */
import type { OrderPage } from '../../booking/order-pages.js';
import type { VatCorrection } from '../../booking/vat-corrections.js';
import type { ProviderIssues } from '../../booking/provider-issues.js';

let pages: ReadonlyMap<string, OrderPage> = new Map();
let corrections: ReadonlyMap<string, VatCorrection> = new Map();

export function setOrderPages(byReceipt: Record<string, OrderPage>): void {
  pages = new Map(Object.entries(byReceipt));
}

export const orderPagesNow = (): ReadonlyMap<string, OrderPage> => pages;

/** The bills that prove a VAT-only correction (GET /api/receipts/vat-corrections, #190), loaded with the books like the order pages. */
export function setVatCorrections(byReceipt: Record<string, VatCorrection>): void {
  corrections = new Map(Object.entries(byReceipt));
}

export const vatCorrectionsNow = (): ReadonlyMap<string, VatCorrection> => corrections;

const NO_PROVIDER_ISSUES: ProviderIssues = { held: [], bills: [], payouts: {} };
let providerIssues: ProviderIssues = NO_PROVIDER_ISSUES;

/** What the providers' reports leave open (GET /api/receipts/provider-issues, #405), loaded with the books like the order pages. */
export function setProviderIssues(issues: ProviderIssues | undefined): void {
  providerIssues = issues ?? NO_PROVIDER_ISSUES;
}

export const providerIssuesNow = (): ProviderIssues => providerIssues;

let outlayWaits: ReadonlySet<string> = new Set();

/** The open payments to the owner that wait for her outlays (GET /api/rules/outlay-waits, #428), loaded with the books: the server knows her rules and wages. */
export function setOutlayWaits(refs: readonly string[] | undefined): void {
  outlayWaits = new Set(refs ?? []);
}

export const outlayWaitsNow = (): ReadonlySet<string> => outlayWaits;
