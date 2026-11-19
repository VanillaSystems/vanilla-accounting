/**
 * The payment reference of an invoice, made from its number. With a QR-IBAN the QR-bill must
 * carry a QR reference (QRR: 26 digits and a recursive mod-10 check digit, Swiss Payment
 * Standards); with a plain IBAN a creditor reference (SCOR: ISO 11649, RF and two mod-97 check
 * digits). The bank hands the reference back in the camt.053 line, which is how a payment finds
 * its invoice (src/invoices/payments.ts).
 */
import { checkFormat, checkNumbering, type DocumentKind, type FormatRefusal, type NumberFormat, type Numbering } from '../../workspace/numbering.js';

const MOD10 = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

export function qrrCheckDigit(digits: string): string {
  let carry = 0;
  for (const d of digits) carry = MOD10[(carry + Number(d)) % 10];
  return String((10 - carry) % 10);
}

/** ISO 7064 mod 97-10 over digits and letters (A = 10 … Z = 35). */
function mod97(s: string): number {
  let m = 0;
  for (const c of s) {
    const v = /\d/.test(c) ? c : String(c.charCodeAt(0) - 55);
    for (const d of v) m = (m * 10 + Number(d)) % 97;
  }
  return m;
}

/**
 * The digits of a number's QR reference: its digits, and a letter of its prefix as two (A = 10 … Z = 35,
 * as ISO 7064 reads it), so RE-2026-00001 and GS-2026-00001 get references of their own. A number
 * without letters (2026-001) keeps its digits as before.
 */
const qrrDigitsOf = (invoiceNumber: string): string =>
  invoiceNumber.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

/** The QR reference for an invoice number: its digits (qrrDigitsOf), left-padded to 26, and the check digit. */
export function qrReference(invoiceNumber: string): string {
  const digits = qrrDigitsOf(invoiceNumber);
  if (!digits || digits.length > 26) throw new Error(`${invoiceNumber}: an invoice number needs 1 to 26 digits for a QR reference`);
  const body = digits.padStart(26, '0');
  return body + qrrCheckDigit(body);
}

/** The creditor reference for an invoice number: RF, the check digits, and the number's digits and letters. */
export function scorReference(invoiceNumber: string): string {
  const body = invoiceNumber.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!body || body.length > 21) throw new Error(`${invoiceNumber}: an invoice number needs 1 to 21 letters or digits for a creditor reference`);
  return `RF${String(98 - mod97(`${body}RF00`)).padStart(2, '0')}${body}`;
}

/** Whether a number fits both references a QR-bill may carry: QRR's 26 digits (a letter is two) and SCOR's 21 characters. */
export function referenceTooLong(invoiceNumber: string): 'tooLongQrr' | 'tooLongScor' | undefined {
  if (qrrDigitsOf(invoiceNumber).length > 26) return 'tooLongQrr';
  if (invoiceNumber.toUpperCase().replace(/[^0-9A-Z]/g, '').length > 21) return 'tooLongScor';
  return undefined;
}

/** A kind's number format checked with the references a QR-bill carries (src/workspace/numbering.ts checkFormat). */
export const formatFits = (kind: DocumentKind, nf: NumberFormat): FormatRefusal | undefined => checkFormat(kind, nf, referenceTooLong);
/** The firm's whole numbering so checked. */
export const numberingFits = (n: Numbering) => checkNumbering(n, referenceTooLong);

/** Whether two numbers make the same QR or creditor reference (2026-001 and 2026001 do): a payment could not tell them apart. */
export function sameReference(a: string, b: string): boolean {
  const safe = (f: (n: string) => string, n: string) => { try { return f(n); } catch { return undefined; } };
  const qa = safe(qrReference, a), sa = safe(scorReference, a);
  return (!!qa && qa === safe(qrReference, b)) || (!!sa && sa === safe(scorReference, b));
}

export type ReferenceKind = 'QRR' | 'SCOR';

/** The reference without spaces, upper case, and which kind it is when its check digits hold. */
export function parseReference(raw: string): { kind: ReferenceKind; reference: string } | undefined {
  const ref = raw.replace(/\s+/g, '').toUpperCase();
  if (/^\d{27}$/.test(ref)) return qrrCheckDigit(ref.slice(0, 26)) === ref[26] ? { kind: 'QRR', reference: ref } : undefined;
  if (/^RF\d{2}[0-9A-Z]{1,21}$/.test(ref)) return mod97(ref.slice(4) + ref.slice(0, 4)) === 1 ? { kind: 'SCOR', reference: ref } : undefined;
  return undefined;
}

/** A QR-IBAN: a Swiss or Liechtenstein IBAN whose institution id is 30000 to 31999. */
export function isQrIban(iban: string): boolean {
  const compact = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^(CH|LI)\d{19}$/.test(compact)) return false;
  const iid = Number(compact.slice(4, 9));
  return iid >= 30000 && iid <= 31999;
}

/** The IBAN can carry a QR-bill: Swiss or Liechtenstein. */
export const isQrBillIban = (iban: string): boolean => /^(CH|LI)/.test(iban.replace(/\s+/g, '').toUpperCase());

/**
 * Whether a QR-IBAN, and with it a QR reference, may be used for an invoice in `currency`: only in
 * CHF since the SIX Implementation Guidelines for the QR-bill v2.4 (24.02.2026, in force with the
 * SIC release of 13.11.2026; chapters 2.8, 2.10, 2.12, 4.2.2, 4.3.2): «For invoicing in euros (EUR),
 * only the combination IBAN/SCOR reference and IBAN/unstructured message is possible». v2.3 stays
 * valid until November 2027, after which banks refuse it. Saving one under another currency warns
 * (src/server/routes/config.ts); the person may keep it, and an invoice then carries it (#506).
 */
export const qrIbanTakes = (currency: string): boolean => currency === 'CHF';

/**
 * The reference an invoice gets at issue: QRR when paid to a QR-IBAN, else SCOR. A EUR account
 * without a QR-IBAN (what v2.4 wants) gets SCOR with its plain IBAN; one a person kept against the
 * warning gets QRR, her decision. Frozen on the issued invoice: a later change of the account never
 * changes what was printed.
 */
export function referenceFor(invoiceNumber: string, payTo: { qrIban?: string }): string {
  return payTo.qrIban ? qrReference(invoiceNumber) : scorReference(invoiceNumber);
}

/** Groups of five from the right (QRR) or of four (SCOR, IBAN), as printed on a QR-bill. */
export function prettyReference(ref: string): string {
  if (/^\d{27}$/.test(ref)) return `${ref.slice(0, 2)} ${ref.slice(2).replace(/(.{5})(?!$)/g, '$1 ')}`;
  return ref.replace(/(.{4})(?!$)/g, '$1 ');
}

/** Where a customer pays to, as an invoice printed it: the account, its IBAN and the QR-IBAN its bank gave. */
interface PaidTo { iban: string; qrIban?: string }

/** The account a document's payment part names: the QR-IBAN where there is one, else the IBAN. */
export const accountOnPaper = (p: PaidTo | undefined): string => (p ? p.qrIban ?? p.iban : '');

/** Two accounts to pay to alike on paper: the same IBAN and the same QR-IBAN (or none). */
export const samePaidTo = (a: PaidTo, b: PaidTo): boolean => a.iban === b.iban && (a.qrIban ?? '') === (b.qrIban ?? '');

/**
 * A request to pay an issued invoice to another account (spec 4.12): its QR reference stays with a
 * QR-IBAN, its creditor reference with an IBAN. A QR reference cannot go with a plain IBAN: the request
 * then carries no reference (the payment is matched by number and amount) and no QR-IBAN.
 */
export function paymentToNewAccount<T extends PaidTo>(reference: string, to: T): { to: T; reference: string } {
  const qrr = parseReference(reference)?.kind === 'QRR';
  if (qrr) return to.qrIban ? { to, reference } : { to: { ...to, qrIban: undefined }, reference: '' };
  return { to: { ...to, qrIban: undefined }, reference };
}
