/**
 * Synthetic IBANs for tests. The leak guard flags every valid IBAN written in the public repo,
 * so fixtures write a Swiss IBAN with the never-valid check digits 00 and tests compute the
 * valid one at run time.
 */

/** The valid Swiss IBAN of a 17-digit account number (5-digit clearing number + 12 digits). */
export function testIban(bban: string): string {
  const digits = (bban + 'CH00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return `CH${String(98 - rest).padStart(2, '0')}${bban}`;
}

/** `xml` with every CH00 placeholder IBAN given its check digits. */
export function withTestIbans(xml: string): string {
  return xml.replace(/CH00(\d{17})/g, (_, bban: string) => testIban(bban));
}
