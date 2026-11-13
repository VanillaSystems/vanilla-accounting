/**
 * The order pages of the provider way, as the server derives them from the books and the business
 * files (GET /api/receipts/order-pages, #253), loaded with the books: Belege reads them beside the books.
 */
import type { PaymentRefusal } from '../../workflows/history.js';
import { leftText } from './api.js';
import { fmt, formatDate } from './utils.js';
import { t } from '../i18n/index.js';
import type { BankTransaction } from '../../types/index.js';
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

let refusals: ReadonlyMap<string, PaymentRefusal> = new Map();

/** The open payments a run left unbooked, with why (GET /api/automation/refusals, #470), loaded with the books: the run log is the server's. */
export function setRefusals(list: readonly PaymentRefusal[] | undefined): void {
  refusals = new Map((list ?? []).map((r) => [r.ref, r]));
}

export const refusalsNow = (): ReadonlyMap<string, PaymentRefusal> => refusals;

/** Why a run left `ref` unbooked, in her words, when the refusal has words (#470): the payment's page, the lists, the drop and the AI's card say this. */
export const refusedWhy = (ref: string): string | undefined => { const r = refusals.get(ref); return r && leftText(r); };

/** A payment without a booking, and why a run left it so when it says (#470): the open list's line and the drop's. Its name is the provider's for a payout (Issues.tsx payerName). */
export function unbookedText(tx: Pick<BankTransaction, 'ref' | 'date' | 'currency' | 'amount' | 'counterparty' | 'description'>): string {
  const vars = { date: formatDate(tx.date), text: providerIssues.payouts[tx.ref] ?? (tx.counterparty || tx.description), amount: `${tx.currency} ${fmt(tx.amount)}` };
  const why = refusedWhy(tx.ref);
  return why ? t('issues.unbookedWhy', { ...vars, why }) : t('issues.unbooked', vars);
}
