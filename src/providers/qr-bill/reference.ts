/**
 * The payment reference of an invoice, made from its number. With a QR-IBAN the QR-bill must
 * carry a QR reference (QRR: 26 digits and a recursive mod-10 check digit, Swiss Payment
 * Standards); with a plain IBAN a creditor reference (SCOR: ISO 11649, RF and two mod-97 check
 * digits). The bank hands the reference back in the camt.053 line, which is how a payment finds
 * its invoice (src/invoices/payments.ts).
 */

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

/** The QR reference for an invoice number: its digits, left-padded to 26, and the check digit. */
export function qrReference(invoiceNumber: string): string {
  const digits = invoiceNumber.replace(/\D/g, '');
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

/** The reference an invoice gets at issue: QRR when paid to a QR-IBAN, else SCOR. */
export function referenceFor(invoiceNumber: string, payTo: { qrIban?: string }): string {
  return payTo.qrIban ? qrReference(invoiceNumber) : scorReference(invoiceNumber);
}

/** Groups of five from the right (QRR) or of four (SCOR, IBAN), as printed on a QR-bill. */
export function prettyReference(ref: string): string {
  if (/^\d{27}$/.test(ref)) return `${ref.slice(0, 2)} ${ref.slice(2).replace(/(.{5})(?!$)/g, '$1 ')}`;
  return ref.replace(/(.{4})(?!$)/g, '$1 ');
}
