/**
 * Rebook a quarter's Shopify webshop sales per ORDER: sales and fees dated on the order date,
 * the payout leg on the bank date.
 *
 * Why: `classify` only sees the aggregated Stripe payout ("Received money from Stripe
 * Payments UK Ltd with reference Shopify A1B2C3"): no country, no tax line, no order
 * number. So it booked revenue per payout at V0, and Swiss deliveries' 8.1% output tax
 * was never recognised. Earlier books also mixed two shapes: payouts as sale/fee/bank-leg
 * triples and payouts booked bank → revenue in one entry, sometimes with a V0 code on the
 * bank leg (which the VAT report counts as revenue).
 *
 * The pattern, through the 1093 Stripe clearing account:
 *   per order   D 1093  C 3450   paid − refunded   V81|V0   Webshop Bestellung #<n>, <customer>, <country>
 *               D 6580  C 1093   paid − paid out   I0       Webshop Gebühren #<n>
 *   per payout  D 1023  C 1093   the bank amount   —        Stripe, Auszahlung <reference>
 * Sales and fees are dated at the ORDER date; the payout leg at the bank date. An order
 * paid out after the quarter leaves a receivable on 1093, which is correct.
 *
 * The VAT code comes from the order page's own Taxes line, never from a country guess:
 * "MwSt 8.1%" (Swiss delivery) → V81; an EU VAT line or no tax line → V0 (EU VAT collected
 * by Shopify is not Swiss output tax; how to book it is an open question with the tax
 * advisor, processes/suppliers/shopify.yaml sv-eu-vat).
 *
 * What it replaces: EVERY journal entry on the quarter's Stripe payout transactions (open
 * period only), so no old aggregated revenue survives next to the per-order sales. Orders
 * paid by bank transfer (no Stripe payout) are left as they are.
 *
 * Usage: npm run extract-shopify-orders -- <YYYY-Qn>
 *        npm run rebook-shopify -- data/shopify-orders-<YYYY-Qn>.json [--apply]
 *        (dry-run by default; prints every entry it would remove and add)
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { JournalEntry, BankTransaction } from '../types/index.js';
import { loadBooks, mutateJournal, periodLock, saveBooks } from '../books/store.js';
import type { ShopifyOrder } from './extract-shopify-orders.js';
import { derivePeriod } from '../accounting/periods.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { roundCHF } from '../accounting/rappen.js';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();

const ordersPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!ordersPath) { console.error('usage: npm run rebook-shopify -- <data/shopify-orders-YYYY-Qn.json> [--apply]'); process.exit(1); }

const input = JSON.parse(readFileSync(ordersPath, 'utf8')) as { period: string; orders: ShopifyOrder[]; problems: unknown[] };
const period = derivePeriod(input.period);
if (!period) throw new Error(`unknown period ${input.period}`);
const quarterEnd = period.to;
if (input.problems.length) { console.error(`${input.problems.length} order page(s) did not parse; fix them first:`, input.problems); process.exit(1); }

const index = loadBooks(ws);
const lock = periodLock(index);
if (lock.isClosed(period.to)) { console.error(`${input.period} is filed (closed through ${lock.closedThrough}) — golden rule 1: never rebooked.`); process.exit(1); }
const fx = loadFxResolver();
const rate = (d: string) => {
  const r = fx.daily('EUR', d);
  if (!r) throw new Error(`no ESTV EUR rate for ${d}`);
  return r;
};
const mkId = (...parts: (string | number)[]) => createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 16);
const inQ = (d: string) => d >= period.from && d <= period.to && !lock.isClosed(d);

// The quarter's Stripe payouts, as the bank reports them.
const payouts: BankTransaction[] = index.transactions.filter(
  (t) => t.direction === 'CRDT' && /stripe/i.test(t.description) && inQ(t.date),
);
const payoutRefs = new Set(payouts.map((t) => t.ref));

// The payout a sale/fee hangs under: the Stripe credit nearest the date Shopify names.
// It only groups entries in the UI; amounts and VAT do not depend on it.
function payoutFor(o: ShopifyOrder): string {
  const named = (o.payouts[0] ?? o.pendingPayouts[0])?.date;
  // Paid out after the quarter: no payout of this quarter contains it, however close the date.
  if (!named || named > quarterEnd) return `SHOPIFY-${o.num}`;
  const near = payouts
    .map((t) => ({ t, d: Math.abs(Date.parse(t.date) - Date.parse(named)) / 86_400_000 }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d);
  return near[0]?.t.ref ?? `SHOPIFY-${o.num}`;
}

const toRemove: JournalEntry[] = index.journalEntries.filter((e) => payoutRefs.has(e.transactionRef) && !lock.isClosed(e.date));

const toAdd: JournalEntry[] = [];
for (const t of payouts) {
  const reference = t.description.match(/with reference (.+)$/)?.[1]?.trim() ?? '';
  toAdd.push({
    id: mkId('payout', t.ref), transactionRef: t.ref, date: t.date,
    accountDebit: '1023', accountCredit: '1093', amount: roundCHF(t.amount),
    description: `Stripe, Auszahlung${reference ? ` ${reference.replace(/^Shopify\s*/, 'Shopify ')}` : ''}`,
    exchangeCurrency: 'EUR', exchangeRate: rate(t.date),
  });
}

const skipped: string[] = [];
for (const o of input.orders) {
  if (!inQ(o.odate)) { skipped.push(`#${o.num} ${o.odate}: order date outside the open quarter`); continue; }
  if (o.paidByBank) { skipped.push(`#${o.num}: paid by bank transfer, booked on its bank transaction`); continue; }
  const paidOut = o.payouts.reduce((s, p) => s + p.eur, 0) || o.pendingPayouts.reduce((s, p) => s + p.eur, 0);
  if (!paidOut) { skipped.push(`#${o.num}: no payout made or announced`); continue; }
  const swiss = o.taxlabel === 'MwSt 8.1%' && o.taxcur === 'CHF';
  // EU VAT that Shopify collected at checkout is a pass-through item, not turnover of the
  // GmbH (owner, 2026-10-08): it goes to 4030 ausl. MWST, where the couriers' EU import VAT
  // (EUSt on DDP shipments) is booked, and the sale is booked without it.
  const eu = /^[A-Z]{2} /.test(o.taxlabel) && o.taxcur === 'EUR';
  const euVat = eu ? roundCHF(o.taxamt * (o.paidEur - o.refundEur) / o.paidEur) : 0;
  const sale = roundCHF(o.paidEur - o.refundEur - euVat);
  const fee = roundCHF(o.paidEur - paidOut);
  const ref = payoutFor(o);
  const country = swiss ? 'Schweiz' : o.country;
  // A Swiss order is priced in CHF: the CHF total is the taxable consideration, so the sale
  // is booked at the order's own EUR→CHF settlement and its output tax equals the tax on
  // the order page. Everything else converts at the ESTV rate of the order date (ADR 0001).
  const saleRate = swiss && o.chfPaid && !o.refundEur ? o.chfPaid / o.paidEur : rate(o.odate);
  toAdd.push({
    id: mkId('sale', o.num, o.odate), transactionRef: ref, date: o.odate,
    accountDebit: '1093', accountCredit: '3450', amount: sale, vatCode: swiss ? 'V81' : 'V0',
    description: `Webshop Bestellung #${o.num}, ${o.customer}, ${country}${o.refundEur ? ` (nach Rückerstattung EUR ${o.refundEur.toFixed(2)})` : ''}`,
    exchangeCurrency: 'EUR', exchangeRate: saleRate,
  });
  if (euVat > 0) {
    toAdd.push({
      id: mkId('euvat', o.num, o.odate), transactionRef: ref, date: o.odate,
      accountDebit: '1093', accountCredit: '4030', amount: euVat,
      description: `EU-MWST ${o.taxlabel} Bestellung #${o.num} (Durchlaufposten)`,
      exchangeCurrency: 'EUR', exchangeRate: rate(o.odate),
    });
  }
  if (fee > 0) {
    toAdd.push({
      id: mkId('fee', o.num, o.odate), transactionRef: ref, date: o.odate,
      accountDebit: '6580', accountCredit: '1093', amount: fee, vatCode: 'I0',
      description: `Webshop Gebühren #${o.num}`,
      exchangeCurrency: 'EUR', exchangeRate: rate(o.odate),
    });
  }
}

// ── report ────────────────────────────────────────────────────────────────────
const sum = (es: JournalEntry[]) => roundCHF(es.reduce((s, e) => s + e.amount, 0));
const chf = (es: JournalEntry[]) => roundCHF(es.reduce((s, e) => s + e.amount * (e.exchangeRate ?? 1), 0));
const sales = toAdd.filter((e) => e.accountCredit === '3450');
const v81 = sales.filter((e) => e.vatCode === 'V81');
const fees = toAdd.filter((e) => e.accountDebit === '6580');
const legs = toAdd.filter((e) => e.accountDebit === '1023');
console.log(`REMOVE ${toRemove.length} entries on ${payouts.length} Stripe payouts:`);
const shape = new Map<string, { n: number; eur: number }>();
for (const e of toRemove) { const k = `${e.accountDebit || '-'}/${e.accountCredit || '-'} ${e.vatCode ?? 'no code'}`; const v = shape.get(k) ?? { n: 0, eur: 0 }; v.n++; v.eur += e.amount; shape.set(k, v); }
for (const [k, v] of shape) console.log(`   ${k.padEnd(20)} ${String(v.n).padStart(3)}  EUR ${v.eur.toFixed(2)}`);
console.log(`ADD ${toAdd.length} entries:`);
console.log(`   bank legs 1023/1093     ${String(legs.length).padStart(3)}  EUR ${sum(legs).toFixed(2)}   (= bank Stripe credits EUR ${roundCHF(payouts.reduce((s, t) => s + t.amount, 0)).toFixed(2)})`);
console.log(`   sales V81 (Swiss)       ${String(v81.length).padStart(3)}  EUR ${sum(v81).toFixed(2)}   CHF ${chf(v81).toFixed(2)} → output tax ≈ CHF ${roundCHF(chf(v81) * 8.1 / 108.1).toFixed(2)}`);
console.log(`   sales V0 (export/EU)    ${String(sales.length - v81.length).padStart(3)}  EUR ${sum(sales.filter((e) => e.vatCode === 'V0')).toFixed(2)}`);
console.log(`   Webshop Gebühren I0     ${String(fees.length).padStart(3)}  EUR ${sum(fees).toFixed(2)}`);
const euv = toAdd.filter((e) => e.accountCredit === '4030');
console.log(`   EU-MWST → 4030          ${String(euv.length).padStart(3)}  EUR ${sum(euv).toFixed(2)}   (pass-through, not turnover)`);
if (skipped.length) { console.log('skipped:'); for (const s of skipped) console.log(`   ${s}`); }
console.log('\nSwiss orders (Taxes line → V81):');
for (const o of input.orders.filter((o) => o.taxlabel === 'MwSt 8.1%')) {
  const e = v81.find((x) => x.description?.includes(`#${o.num},`));
  console.log(`   #${o.num} ${o.odate} ${o.customer.padEnd(16)} page tax CHF ${o.taxamt.toFixed(2).padStart(6)}  booked EUR ${e?.amount.toFixed(2).padStart(7)} → CHF ${e ? roundCHF(e.amount * e.exchangeRate! * 8.1 / 108.1).toFixed(2).padStart(6) : '—'} tax`);
}

// 1093 must net to: orders sold in the quarter but paid out after it, plus what Q2
// orders still owed when the quarter opened (paid out in this quarter).
const after = index.journalEntries.filter((e) => !toRemove.includes(e)).concat(toAdd);
const bal1093 = (es: JournalEntry[], to: string) => roundCHF(es.filter((e) => e.date <= to).reduce((s, e) => s + (e.accountDebit === '1093' ? e.amount : 0) - (e.accountCredit === '1093' ? e.amount : 0), 0));
const open = input.orders.filter((o) => o.payouts.length === 0 && o.pendingPayouts.length && !o.paidByBank);
const late = input.orders.filter((o) => o.payouts.some((p) => p.date > period.to)).concat(open);
console.log(`\n1093 Stripe clearing (EUR): opening ${bal1093(after, lock.closedThrough ?? '').toFixed(2)} → closing ${bal1093(after, period.to).toFixed(2)}`);
console.log(`   expected closing ≈ owed for orders paid out after ${period.to}: ${late.map((o) => '#' + o.num).join(', ')} = EUR ${roundCHF(late.reduce((s, o) => s + (o.payouts.filter((p) => p.date > period.to).reduce((a, p) => a + p.eur, 0) || o.pendingPayouts.reduce((a, p) => a + p.eur, 0)), 0)).toFixed(2)}`);

if (!apply) { console.log('\nDRY RUN — nothing written. Pass --apply to write.'); process.exit(0); }

const removeIds = new Set(toRemove.map((e) => e.id));
const addIds = new Set(toAdd.map((e) => e.id));
mutateJournal(index, (books) => {
  books.journalEntries = books.journalEntries.filter((e) => !removeIds.has(e.id) && !addIds.has(e.id)).concat(toAdd);
});
saveBooks(ws, index);
console.log(`\n✓ applied: -${toRemove.length} +${toAdd.length} journal entries`);
