/**
 * The order pages of the provider way, as the server derives them from the books and the business
 * files (GET /api/receipts/order-pages, #253), loaded with the books: Belege reads them beside the books.
 */
import type { OrderPage } from '../../booking/order-pages.js';
import type { VatCorrection } from '../../booking/vat-corrections.js';

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
