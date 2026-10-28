/**
 * Whether a receipt's own words say it was paid in cash or out of a private pocket (#216): «bar
 * bezahlt», «Rückgeld», «privat ausgelegt», «payé en espèces», «pagato in contanti», «paid in
 * cash». Code reads it, the AI is not asked: the Aktionen menu then offers «Privat bezahlt buchen»
 * first instead of «Noch keine Zahlung». A card's words («Kartenzahlung», «TWINT», «Visa») outweigh
 * a cash word, since a till prints both lines; only an explicit «privat …» wins over them.
 */

/** Out of a private pocket, whatever paid at the till. */
const PRIVATE = /\b(privat\s+(ausgelegt|bezahlt|vorgeschossen|beglichen)|aus\s+eigener\s+tasche|pay[ée]e?\s+(à\s+titre\s+)?priv[ée]e?|pagat[oa]\s+privatamente|paid\s+(privately|personally|out\s+of\s+pocket))\b/iu;

/** Cash at the till: never «bargeldlos». */
const CASH = /(\bbar\s*(bezahlt|erhalten|gegeben|zahlung|chf|eur|fr\.?)|\bbarzahlung|\b(zahlungsart|zahlart|zahlungsmittel|bezahlt|bezahlung)\s*:?\s*bar\b|\bin\s+bar\b|\brückgeld\b|\bwechselgeld\b|\b(pay[ée]e?|paiement|r[èe]glement)\s+(en\s+)?esp[èe]ces\b|\bcomptant\b|\b(pagat[oa]|pagamento)\s+in\s+contanti\b|\bcontanti\b|\bpaid\s+(in\s+)?cash\b|\bcash\s+(payment|paid|tendered)\b|\bchange\s+(due|given)\b)/iu;

/** A card, a phone or an invoice paid it: the cash words of the same till receipt are its other lines. */
const CARD = /\b(kartenzahlung|karte\s*:|bargeldlos|debit\s*card|credit\s*card|maestro|mastercard|visa|v\s*pay|postfinance\s*card|twint|apple\s*pay|carte\s+(bancaire|de\s+cr[ée]dit|de\s+d[ée]bit)|carta\s+di\s+credito|paid\s+by\s+card|zahlbar\s+(bis|innert|innerhalb)|qr-rechnung|einzahlungsschein)\b/iu;

export function paidPrivately(text: string): boolean {
  const words = text.slice(0, 6000);
  if (PRIVATE.test(words)) return true;
  return CASH.test(words) && !CARD.test(words);
}
