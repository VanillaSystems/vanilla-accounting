/**
 * The order pages of the provider way, as the server derives them from the books and the business
 * files (GET /api/receipts/order-pages, #253), loaded with the books: Belege reads them beside the books.
 */
import type { OrderPage } from '../../booking/order-pages.js';

let pages: ReadonlyMap<string, OrderPage> = new Map();

export function setOrderPages(byReceipt: Record<string, OrderPage>): void {
  pages = new Map(Object.entries(byReceipt));
}

export const orderPagesNow = (): ReadonlyMap<string, OrderPage> => pages;
