/**
 * npm run evidence -- <YYYY-Qn> [--apply]
 *
 * The rules stage of processes/evidence.flow.yaml: link receipts to the transactions they
 * pay, deterministically, and re-runnable at any time (matching used to run once, at intake,
 * and never again). Dry run by default.
 *
 * A receipt links to a transaction only when exactly ONE transaction fits:
 *   - the receipt's amount equals the booked amount in the same currency, OR the original
 *     amount Wise prints in the bank text ("Card transaction of 151.26 USD"), OR one part of
 *     a batch payment (camt053 Sammelzahlung parts);
 *   - the receipt is dated at most 45 days before or 10 days after the payment.
 * Several candidates, or a candidate that already carries a receipt of the same amount (a
 * likely duplicate), are listed for a person instead. A provider's order page and payout are no
 * pair here: the page goes with its order's sale (src/booking/order-pages.ts), the payout settles the
 * provider's clearing account.
 *
 * Never touches a closed period (golden rule 1) or a link a person made.
 */

import type { Receipt, BankTransaction } from '../types/index.js';
import { loadBooks, periodLock, saveBooks, update, PERSON } from '../books/store.js';
import { derivePeriod, isFilingKey } from '../accounting/periods.js';
import { documentTypeOf } from '../knowledge/counterparties.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { isProvider, providerOfMoneyIn } from '../booking/providers.js';
import { noPaymentOf } from '../booking/order-pages.js';
import { vatCorrectionsOf } from '../booking/vat-corrections.js';
import { APP_ROOT, openWorkspace } from '../workspace/workspace.js';
import { documents, filing } from '../engines/index.js';
import { duplicatesIn } from '../intake/duplicates.js';
import { MODEL_RULE } from '../intake/unclear.js';
import { isBankFee } from '../booking/separate-fee.js';

const ws = openWorkspace();
const BEFORE_DAYS = 45; // invoice dated up to 45 days before the payment
const AFTER_DAYS = 10; // ...or up to 10 days after it (invoices issued after charging)

type Link = { receipt: Receipt; tx: BankTransaction; rule: string };

const day = (d: string) => Date.parse(d) / 86_400_000;

/** Bank statements and payment reminders are documents about payments, not receipts for them. */
const NOT_A_RECEIPT = /auszug|statement|zahlungserinnerung|mahnung|reminder/i;
/** When two documents of the same amount fit one payment, the invoice is the receipt; the rest are copies. */
function receiptRank(r: Receipt): number {
  const f = r.filename.toLowerCase();
  if (/-\d\.pdf$/.test(f)) return 3; // a re-download (…-2.pdf)
  if (/lieferschein|delivery|waybill/.test(f)) return 2;
  if (/rechnung|invoice|bill|quittung|receipt/.test(f)) return 0;
  return 1;
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

/** The original amount and currency printed in a Wise card/transfer description. */
function originalAmount(t: BankTransaction): { amount: number; currency: string } | null {
  const m = t.description.match(/of (-?[\d,]+\.\d{2}) ([A-Z]{3})/);
  return m ? { amount: Math.abs(+m[1].replace(/,/g, '')), currency: m[2] } : null;
}

const compact = (s: string) => s.replace(/[\s'.’]/g, '').toLowerCase();
/**
 * What of a payment reference can be looked for in a receipt's text: the whole reference
 * (when long enough to be specific) and every run of 6+ digits in it (invoice numbers, QR
 * references), so "Invoice 1000000001 Ref.: 2000000001-1" finds a receipt that prints 1000000001.
 */
function referenceTokens(reference: string): string[] {
  const whole = compact(reference);
  const digits = reference.match(/\d{6,}/g) ?? [];
  return [...new Set([...(whole.length >= 8 ? [whole] : []), ...digits])];
}

/** Does the receipt carry this token: the whole reference, or a digit run standing on its own (not inside a longer number)? */
function carries(text: string, token: string): boolean {
  // A long reference (a 27-digit QR reference) is specific on its own; a QR bill also prints it
  // twice in a row, so after removing spaces it runs into its own copy.
  if (!/^\d+$/.test(token) || token.length >= 16) return text.includes(token);
  return new RegExp(`(?<!\\d)${token}(?!\\d)`).test(text);
}

/** Which rule makes this transaction fit this receipt, if any. */
function fits(r: Receipt, t: BankTransaction): string | null {
  const dd = day(t.date) - day(r.date!);
  if (dd < -AFTER_DAYS || dd > BEFORE_DAYS) return null;
  const amt = r.amount!;
  if (near(Math.abs(t.amount), amt) && (!r.currency || t.currency === r.currency)) return 'amount';
  const o = originalAmount(t);
  if (o && near(o.amount, amt) && (!r.currency || o.currency === r.currency)) return 'original-amount';
  if ((t.parts ?? []).some((p) => near(p.amount, amt) && (!r.currency || p.currency === r.currency))) return 'batch-part';
  return null;
}

function main() {
  const key = process.argv[2] ?? '';
  const period = isFilingKey(key, filing().length) ? derivePeriod(key) : null;
  if (!period) { console.error('Usage: npm run evidence -- <YYYY-Qn> [--apply]'); process.exit(1); }
  const apply = process.argv.includes('--apply');
  const index = loadBooks(ws);
  const lock = periodLock(index);
  const inPeriod = (d?: string) => !!d && d >= period.from && d <= period.to && !lock.isClosed(d);

  // ── what each document is: only invoices need a payment ────────────────────
  const { counterparties } = loadKnowledge(APP_ROOT, ws.paths.root);
  const kinded: { receipt: Receipt; kind: string; rule: string }[] = [];
  for (const r of index.receipts) {
    if (r.kindBy === 'human' || !inPeriod(r.date)) continue;
    const t = documentTypeOf(r, counterparties);
    if (t && (r.kind !== t.kind || r.kindRule !== t.rule)) kinded.push({ receipt: r, kind: t.kind, rule: t.rule });
  }
  const kindOf = (r: Receipt) => kinded.find((k) => k.receipt.id === r.id)?.kind ?? r.kind;
  const providers = counterparties.filter(isProvider);
  const page = noPaymentOf(index, providers);
  // A bill that proves a VAT-only correction is no receipt of a payment either (#190).
  const corrections = vatCorrectionsOf(index, counterparties);
  const noPayment = (r: Receipt) => page(r) || corrections.has(r.id);

  const linkedReceipts = new Set(index.mappings.map((m) => m.receiptId));
  const twins = duplicatesIn(index.receipts, linkedReceipts, documents());
  const receiptsOf = (ref: string) => index.mappings.filter((m) => m.transactionRef === ref).map((m) => index.receipts.find((r) => r.id === m.receiptId)).filter(Boolean) as Receipt[];
  // A Wise fee row shares its transfer's reference and amount pattern; it is never what a receipt pays.
  const txs = index.transactions.filter((t) => !lock.isClosed(t.date) && !t.ref.startsWith('FEE-') && !isBankFee(t));

  const links: Link[] = [];
  const several: { receipt: Receipt; cands: BankTransaction[] }[] = [];
  const duplicates: { receipt: Receipt; tx: BankTransaction; existing: Receipt }[] = [];
  let none = 0;

  // ── payment receipts ──────────────────────────────────────────────────────
  const open = index.receipts
    .filter((r) => !linkedReceipts.has(r.id) && r.location === 'archived' && inPeriod(r.date) && !noPayment(r) && !NOT_A_RECEIPT.test(r.filename))
    .filter((r) => (kindOf(r) ?? 'invoice') === 'invoice')
    // A copy of another receipt (by its facts) is no second receipt for a payment: a person says first (Belege).
    .filter((r) => twins.get(r.id)?.relation !== 'duplicate')
    .sort((a, b) => receiptRank(a) - receiptRank(b) || a.filename.localeCompare(b.filename));
  const claimed = new Map<string, Receipt[]>(); // tx ref → receipts this run links to it
  // A payment reference printed on the receipt proves the link, whatever the amount or date.
  // A provider's payout names the provider in its reference, never an invoice of a receipt.
  const withRef = txs.filter((t) => t.reference && !providerOfMoneyIn(t, receiptsOf(t.ref), counterparties)).map((t) => ({ t, tokens: referenceTokens(t.reference!) })).filter((x) => x.tokens.length);
  for (const r of open) {
    const text = compact(r.extractedText ?? '');
    const byRef = [...new Map(withRef.filter((x) => x.tokens.some((tok) => carries(text, tok))).map((x) => [x.t.ref, x.t])).values()]
      // A credit note mentions the order it refunds; it is not the receipt for the payment out.
      .filter((t) => !((r.amount ?? 0) < 0 && t.direction === 'DBIT'));
    if (byRef.length === 1) {
      const t = byRef[0];
      const twin = [...receiptsOf(t.ref), ...(claimed.get(t.ref) ?? [])].find((x) => x.amount && r.amount && near(x.amount, r.amount));
      if (twin) { duplicates.push({ receipt: r, tx: t, existing: twin }); continue; }
      links.push({ receipt: r, tx: t, rule: 'reference' });
      claimed.set(t.ref, [...(claimed.get(t.ref) ?? []), r]);
      continue;
    }
    if (!r.amount) { none++; continue; }
    // One payment can be several ledger rows under one ref (a Wise multi-currency split): count it once.
    const cands = [...new Map(txs.map((t) => ({ t, rule: fits(r, t) })).filter((c) => c.rule).map((c) => [c.t.ref, c])).values()];
    if (cands.length === 0) { none++; continue; }
    // Several fit: if exactly one is within 3 days of the receipt, it is the payment (monthly
    // subscriptions repeat the same amount; the date tells them apart).
    const close = cands.filter((c) => Math.abs(day(c.t.date) - day(r.date!)) <= 3);
    const pick = cands.length === 1 ? cands[0] : close.length === 1 ? { ...close[0], rule: `${close[0].rule}+nearest` } : null;
    if (!pick) { several.push({ receipt: r, cands: cands.map((c) => c.t) }); continue; }
    const { t, rule } = pick;
    const twin = [...receiptsOf(t.ref), ...(claimed.get(t.ref) ?? [])].find((x) => x.amount && near(x.amount, r.amount!));
    if (twin && (t.parts ?? []).length === 0) { duplicates.push({ receipt: r, tx: t, existing: twin }); continue; }
    links.push({ receipt: r, tx: t, rule: rule! });
    claimed.set(t.ref, [...(claimed.get(t.ref) ?? []), r]);
  }

  // ── links a reference contradicts ─────────────────────────────────────────
  const conflicts: { receipt: Receipt; linkedTo: string[]; proven: BankTransaction }[] = [];
  for (const r of index.receipts.filter((x) => linkedReceipts.has(x.id) && inPeriod(x.date) && !NOT_A_RECEIPT.test(x.filename))) {
    const text = compact(r.extractedText ?? '');
    const byRef = [...new Map(withRef.filter((x) => x.tokens.some((tok) => carries(text, tok))).map((x) => [x.t.ref, x.t])).values()];
    const linkedTo = index.mappings.filter((m) => m.receiptId === r.id).map((m) => m.transactionRef);
    // Other documents print a supplier's invoice number too (a customs invoice lists the goods'
    // invoice): overrule an existing link only when the amount agrees with the proven payment.
    const t = byRef[0];
    if (byRef.length === 1 && !linkedTo.includes(t.ref) && r.amount && fits({ ...r, date: t.date }, t)) conflicts.push({ receipt: r, linkedTo, proven: t });
  }

  // ── report ────────────────────────────────────────────────────────────────
  const byRule = new Map<string, number>();
  for (const l of links) byRule.set(l.rule, (byRule.get(l.rule) ?? 0) + 1);
  const byKind = new Map<string, number>();
  for (const k of kinded) byKind.set(`${k.kind} (${k.rule})`, (byKind.get(`${k.kind} (${k.rule})`) ?? 0) + 1);
  if (kinded.length) console.log(`document types: ${[...byKind].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  console.log(`${key}: ${open.length} unlinked receipts with an amount`);
  console.log(`  link by rule: ${links.length}  (${[...byRule].map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`  several candidates (you decide): ${several.length}`);
  console.log(`  likely duplicates (a same-amount receipt is already linked): ${duplicates.length}`);
  console.log(`  no candidate: ${none}  (supporting documents, private payments, or a missing bank record)\n`);
  for (const l of links) console.log(`  + [${l.rule}] ${l.receipt.filename}  →  ${l.tx.date} ${l.tx.amount} ${l.tx.currency} ${l.tx.description.slice(0, 55)}`);
  if (several.length) { console.log('\n  several candidates:'); for (const s of several) console.log(`  ? ${s.receipt.filename} ${s.receipt.amount} ${s.receipt.currency}: ${s.cands.map((t) => `${t.date} ${t.ref}`).join(' | ')}`); }
  if (conflicts.length) { console.log('\n  linked to a different payment than its reference proves (you decide):'); for (const c of conflicts) console.log(`  ! ${c.receipt.filename}: linked to ${c.linkedTo.join(', ')}, reference proves ${c.proven.ref} (${c.proven.date} ${c.proven.amount} ${c.proven.currency})`); }
  if (duplicates.length) { console.log('\n  likely duplicates:'); for (const d of duplicates) console.log(`  = ${d.receipt.filename}  same as  ${d.existing.filename}  (${d.tx.ref})`); }

  if (!apply) { console.log('\nDRY RUN — nothing written. Pass --apply to link the "+" lines.'); return; }
  update(index, PERSON, (books) => {
    for (const l of links) books.mappings.push({ transactionRef: l.tx.ref, receiptId: l.receipt.id, by: 'rule', rule: l.rule });
    for (const k of kinded) {
      Object.assign(k.receipt, { kind: k.kind, kindBy: 'rule', kindRule: k.rule });
      // The model's reason goes with the model's kind (src/intake/unclear.ts).
      if (!k.rule.startsWith(MODEL_RULE)) delete k.receipt.kindWhy;
    }
  });
  saveBooks(ws, index);
  console.log(`\n✓ linked ${links.length} receipt(s), typed ${kinded.length}`);
}

main();
