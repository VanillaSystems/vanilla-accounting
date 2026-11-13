/**
 * What a rule started from the hand-booking form takes from it (#383): the account and the VAT of
 * its first line on the side opposite the bank, and, with a line on the owner's account, her share
 * of the payment. Browser-safe and pure: the form's fields come in by name.
 *
 * The VAT goes over only when it is a receipt's rate or the person typed it herself. A proposal's
 * code (a precedent's, a rule's, the zero code of a payment without a receipt yet) is right for
 * that one booking only: written into a rule it would book every later payment so, input tax lost
 * on receipts that show 8.1 %. Without it the rule takes its rate from the receipts, or the card asks.
 */
import { followedVat, type DraftLine } from '../../../accounting/manual-booking.js';

/** What the hand-booking form held when the person asked for a rule: the rule starts with it. */
export interface HandSeed { account?: string; vat?: string; share?: string }

const parse = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/**
 * `names`: the form's field names; `get`: a field's value; `lines`: the draft the form opened with
 * (a field `accountDebit-<n>` of the n-th of them); `other`: the side opposite the bank.
 */
export function seedOf(names: readonly string[], get: (name: string) => string, lines: readonly DraftLine[], other: 'accountDebit' | 'accountCredit' | undefined, owner: string | undefined): HandSeed {
  if (!other) return {};
  const keys = names.filter((k) => k.startsWith(`${other}-`)).map((k) => k.slice(other.length + 1));
  const rows = keys.map((k) => {
    const init = /^\d+$/.test(k) ? lines[Number(k)] : undefined;
    const vat = get(`vatCode-${k}`).trim();
    const proposed = init ? followedVat(init, get(`accountDebit-${k}`).trim(), get(`accountCredit-${k}`).trim()) : '';
    const fromReceipt = init?.source?.vat?.from === 'receipt';
    return { account: get(`${other}-${k}`).trim(), vat: vat && (fromReceipt || vat !== proposed) ? vat : '', amount: Math.abs(parse(get(`amount-${k}`))) };
  });
  const business = rows.find((l) => l.account && l.account !== owner);
  const own = owner ? rows.filter((l) => l.account === owner).reduce((s, l) => s + l.amount, 0) : 0;
  const total = rows.reduce((s, l) => s + l.amount, 0);
  const share = own && total && business ? Math.round((own / total) * 1000) / 10 : 0;
  return { ...(business?.account ? { account: business.account } : {}), ...(business?.vat ? { vat: business.vat } : {}), ...(share > 0 && share < 100 ? { share: String(share) } : {}) };
}
