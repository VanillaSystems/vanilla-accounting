/**
 * npm run extract-shopify-orders -- <YYYY-Qn>
 *
 * Reads the quarter's archived Shopify order pages (receipts named
 * *-shopify-order-<n>*.pdf) into structured orders for rebook-shopify-orders:
 * order date, customer, country, the order's own Taxes line, the EUR amount
 * the customer paid, every payout the order went into, and refunds deducted
 * from a payout. Writes data/shopify-orders-<YYYY-Qn>.json.
 *
 * Deterministic, no model. An order whose page does not add up (paid amount
 * not found, payouts larger than paid, a pending refund) is listed under
 * `problems` and left out, never guessed.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks } from '../books/store.js';
import { derivePeriod } from '../accounting/periods.js';
import { openWorkspace } from '../workspace/workspace.js';

export interface ShopifyOrder {
  num: string;
  /** Order date, YYYY-MM-DD: the date the sale is booked on. */
  odate: string;
  customer: string;
  /** "Schweiz", an EU country code from the Taxes line, or the shipping country. */
  country: string;
  /** The order page's own Taxes line, e.g. "MwSt 8.1%" or "DE MwSt 19%"; "" when there is none. */
  taxlabel: string;
  taxrate: number;
  taxcur: string | null;
  taxamt: number;
  /** EUR the customer paid (Shopify's EUR figure for converted orders). */
  paidEur: number;
  /** CHF the customer paid, when the order was priced in CHF: the taxable consideration itself. */
  chfPaid: number | null;
  /** EUR refunded to the customer and deducted from a payout. */
  refundEur: number;
  /** Payouts this order went into: EUR added, and the payout date Shopify names. */
  payouts: { eur: number; date: string }[];
  /** Payouts announced but not yet made ("will be added to your … payout"), when none was made yet. */
  pendingPayouts: { eur: number; date: string }[];
  /** Paid outside Shopify Payments (bank transfer marked as paid): no payout ever comes. */
  paidByBank: boolean;
  refunds: { eur: number; date: string }[];
  file: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COUNTRIES = ['United States', 'United Kingdom', 'Canada', 'Australia', 'New Zealand', 'Norway', 'Poland', 'Japan', 'Singapore', 'Hong Kong',
  'Israel', 'United Arab Emirates', 'South Africa', 'Brazil', 'Mexico', 'Iceland', 'Liechtenstein', 'Switzerland', 'Germany', 'France', 'Italy',
  'Austria', 'Belgium', 'Netherlands', 'Spain', 'Portugal', 'Sweden', 'Denmark', 'Finland', 'Ireland', 'Czech Republic', 'Czechia', 'Slovakia',
  'Hungary', 'Slovenia', 'Croatia', 'Greece', 'Luxembourg', 'Romania', 'Bulgaria', 'Estonia', 'Latvia', 'Lithuania', 'South Korea', 'Taiwan', 'Thailand'];

const money = (s: string) => +s.replace(/,/g, '');

function isoFromWords(day: string, month: string, year: string): string {
  const m = MONTHS.findIndex((x) => x.startsWith(month.slice(0, 3)));
  return `${year}-${String(m + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function parseOrderPage(file: string, raw: string): ShopifyOrder | { file: string; problem: string } {
  const num = file.match(/shopify-order-(\d+)/)?.[1];
  if (!num) return { file, problem: 'no order number in filename' };
  // Shopify inserts a word-joiner in "-⁠€45.00"; line breaks split payout sentences.
  const text = raw.replace(/⁠/g, '');
  const flat = text.replace(/\s+/g, ' ');

  const d1 = text.match(/(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4}) at/);
  const d2 = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})/);
  const odate = d1 ? isoFromWords(d1[1], d1[2], d1[3]) : d2 ? isoFromWords(d2[2], d2[1], d2[3]) : null;
  if (!odate) return { file, problem: 'order date not found' };

  const tax = flat.match(/(CHF|€)\s?([\d,]+\.\d{2})(?: EUR)? • (?:([A-Z]{2}) )?(MwSt|TVA|IVA|BTW|VAT|USt)\s?([\d.]+)%/);
  const taxlabel = tax ? `${tax[3] ? tax[3] + ' ' : ''}${tax[4]} ${tax[5]}%` : '';

  // What the customer paid, in EUR. A converted order prints "€X EUR (1 EUR = …)" once per
  // payment (an order edited later can carry a second payment); a refund prints "-€Y EUR (…)".
  let paidEur: number | null = null;
  const conv = [...flat.matchAll(/(-?)€([\d,]+\.\d{2}) EUR \(1 EUR =/g)].filter((m) => m[1] === '');
  const processed = [...flat.matchAll(/€([\d,]+\.\d{2}) EUR payment was processed/g)];
  if (conv.length) paidEur = conv.reduce((s, m) => s + money(m[2]), 0);
  else if (processed.length) paidEur = processed.reduce((s, m) => s + money(m[1]), 0);
  else {
    // A EUR order prints Total and Paid as the same amount, one after the other.
    const start = flat.indexOf('Subtotal');
    const section = flat.slice(start, start + 900);
    const amounts = [...section.matchAll(/(?<![-\d])€([\d,]+\.\d{2})(?! EUR •)/g)].map((m) => money(m[1]));
    for (let i = 1; i < amounts.length; i++) if (amounts[i] === amounts[i - 1]) { paidEur = amounts[i]; break; }
  }
  if (paidEur === null) return { file, problem: 'paid EUR amount not found' };
  const chfConv = [...flat.matchAll(/(-?)€[\d,]+\.\d{2} EUR \(1 EUR = [\d.]+ CHF([\d,]+\.\d{2}) CHF\)/g)].filter((m) => m[1] === '');
  let chfPaid = chfConv.length ? chfConv.reduce((s, m) => s + money(m[2]), 0) : null;
  if (chfPaid === null && /\(1 EUR = [\d.]+ CHF\)/.test(flat)) {
    // Other layout: the rate stands alone and the CHF total is printed as Total and Paid.
    const start = flat.indexOf('Subtotal');
    const chf = [...flat.slice(start, start + 900).matchAll(/CHF\s?([\d,]+\.\d{2})(?! •)/g)].map((m) => money(m[1]));
    for (let i = 1; i < chf.length; i++) if (chf[i] === chf[i - 1]) { chfPaid = chf[i]; break; }
  }

  const payouts = [...flat.matchAll(/€([\d,]+\.\d{2}) EUR was added to your (\w{3}) (\d{1,2}), (\d{4}) payout/g)]
    .map((m) => ({ eur: money(m[1]), date: isoFromWords(m[3], m[2], m[4]) }));
  const pendingPayouts = payouts.length ? [] : [...flat.matchAll(/€([\d,]+\.\d{2}) EUR will be added to your (\w{3}) (\d{1,2}), (\d{4}) payout/g)]
    .map((m) => ({ eur: money(m[1]), date: isoFromWords(m[3], m[2], m[4]) })).slice(0, 1);
  const paidByBank = /manually marked €[\d,.]+ EUR as paid by Bank/.test(flat);
  const refunds = [...flat.matchAll(/€([\d,]+\.\d{2}) EUR refund was deducted from your (\w{3}) (\d{1,2}), (\d{4}) payout/g)]
    .map((m) => ({ eur: money(m[1]), date: isoFromWords(m[3], m[2], m[4]) }));
  const pendingRefund = /refund will be deducted/.test(flat) && refunds.length === 0;
  if (pendingRefund) return { file, problem: 'refund pending, not yet deducted from a payout' };

  const added = payouts.reduce((s, p) => s + p.eur, 0);
  if (payouts.length && added > paidEur + 0.005) return { file, problem: `payouts ${added.toFixed(2)} exceed paid ${paidEur.toFixed(2)}` };

  // The customer's name, as Shopify writes it in the timeline ("… email was sent to NAME (address)").
  const fromTimeline = flat.match(/email was sent to ([^()]+?) \(/)?.[1]
    ?? flat.match(/sent a [a-z ]+ email to ([^()]+?) \(/)?.[1]
    ?? flat.match(/([A-Za-zÀ-ž' .-]+?) placed this order/)?.[1];
  const slug = file.match(/shopify-order-\d+-([a-z-]+?)(?:-refund|-canceled)*\.pdf$/)?.[1]?.replace(/-/g, ' ');
  const full = (fromTimeline ?? slug ?? '').trim().toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
  const parts = full.split(/\s+/).filter(Boolean);
  const customer = parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : (parts[0] || 'Kunde unbekannt');

  const shipIdx = text.indexOf('Shipping address');
  const afterShip = shipIdx >= 0 ? text.slice(shipIdx) : text;
  const shipCountry = COUNTRIES.map((c) => ({ c, i: afterShip.indexOf(c) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0]?.c;
  const country = tax && !tax[3] && tax[1] === 'CHF' ? 'Schweiz' : tax?.[3] ?? shipCountry ?? 'Export';

  return {
    num, odate, customer, country, taxlabel,
    taxrate: tax ? +tax[5] : 0, taxcur: tax ? (tax[1] === 'CHF' ? 'CHF' : 'EUR') : null, taxamt: tax ? money(tax[2]) : 0,
    paidEur, chfPaid, refundEur: refunds.reduce((s, r) => s + r.eur, 0), payouts, pendingPayouts, paidByBank, refunds, file,
  };
}

function main() {
  const key = process.argv[2] ?? '';
  const period = derivePeriod(key);
  if (!period || !/^\d{4}-Q[1-4]$/.test(key)) { console.error('Usage: npm run extract-shopify-orders -- <YYYY-Qn>'); process.exit(1); }
  const ws = openWorkspace();
  const index = loadBooks(ws);
  const pages = index.receipts.filter((r) => /shopify-order-\d+/.test(r.filename));
  const orders: ShopifyOrder[] = [];
  const problems: { file: string; problem: string }[] = [];
  for (const r of pages) {
    const o = parseOrderPage(r.filename, r.extractedText ?? '');
    if ('problem' in o) { if ((r.date ?? '') >= period.from && (r.date ?? '') <= period.to) problems.push(o); continue; }
    if (o.odate >= period.from && o.odate <= period.to) orders.push(o);
  }
  // The same order can be archived twice (re-downloads); keep one per number.
  const byNum = new Map<string, ShopifyOrder>();
  for (const o of orders) if (!byNum.has(o.num)) byNum.set(o.num, o);
  const out = [...byNum.values()].sort((a, b) => a.odate.localeCompare(b.odate) || a.num.localeCompare(b.num));
  mkdirSync(ws.paths.data, { recursive: true });
  const path = join(ws.paths.data, `shopify-orders-${key}.json`);
  writeFileSync(path, JSON.stringify({ period: key, orders: out, problems }, null, 2) + '\n');
  console.log(`${out.length} orders → ${path}${problems.length ? `; ${problems.length} problem(s):` : ''}`);
  for (const p of problems) console.log(`  ✗ ${p.file}: ${p.problem}`);
}

if (process.argv[1]?.endsWith('extract-shopify-orders.ts')) main();
