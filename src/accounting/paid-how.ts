/**
 * Whether a receipt's own words say it was paid in cash or out of a private pocket (#216): «bar
 * bezahlt», «Rückgeld», «privat ausgelegt», «payé en espèces», «pagato in contanti», «paid in
 * cash». Code reads it, the AI is not asked: the Aktionen menu then proposes «Privat bezahlt buchen»
 * first, beside «Noch keine Zahlung» (the receipt stays unpaid in the books until it is booked).
 *
 * Only a statement that the payment happened counts: «bezahlt»/«payé»/«pagato»/«paid» with cash or
 * private, the change handed back, or «Zahlungsart: Bar». A word about cash alone does not
 * («Barzahlung», «comptant», «contanti», a hotel bill's «Bar 18.50» line), nor a clause that denies or
 * conditions it («Bei Barzahlung 2 % Skonto», «payable net comptant», «non accettato», «We do not
 * accept cash»). A card's words («Kartenzahlung», «TWINT», «Visa») outweigh a cash word, since a
 * till prints both lines; only an explicit «privat …» wins over them.
 */

/** Out of a private pocket, whatever paid at the till. */
const PRIVATE = /\b(privat\s+(ausgelegt|bezahlt|vorgeschossen|beglichen)|aus\s+eigener\s+tasche\s+(bezahlt|beglichen)|pay[ée]e?\s+(à\s+titre\s+)?priv[ée]e?|pagat[oa]\s+privatamente|paid\s+(privately|personally|out\s+of\s+pocket))\b/iu;

/** Paid in cash at the till: the payment said done, or the change handed back. */
const CASH = /(\b(in\s+)?bar\s+(bezahlt|beglichen|erhalten|gegeben)\b|\b(zahlungsart|zahlart|zahlungsmittel|bezahlt|bezahlung)\s*:?\s*bar\b|\bbezahlt\s+in\s+bar\b|\brückgeld\b|\bwechselgeld\b|\b(pay[ée]e?|r[ée]gl[ée]e?)\s+(en\s+esp[èe]ces|comptant)\b|\bpagat[oa]\s+in\s+contanti\b|\bpaid\s+(in\s+)?cash\b|\bcash\s+(paid|tendered|received)\b|\bchange\s+(due|given)\b)/iu;

/** A clause that denies the payment or makes it a condition or a term: its cash words say nothing about this receipt. */
const NOT_SO = /\b(nicht|kein(e|en|er)?|ohne|bei|falls|wenn|möglich|akzeptiert|zahlbar|non|pas|aucune?|si|payable|accept[ée]e?s?|accettat[oa]|se|no|not|never|if|accept(ed)?|possible)\b/iu;

/** A card, a phone or an invoice paid it: the cash words of the same till receipt are its other lines. */
const CARD = /\b(kartenzahlung|karte\s*:|bargeldlos|debit\s*card|credit\s*card|maestro|mastercard|visa|v\s*pay|postfinance\s*card|twint|apple\s*pay|carte\s+(bancaire|de\s+cr[ée]dit|de\s+d[ée]bit)|carta\s+di\s+credito|paid\s+by\s+card|zahlbar\s+(bis|innert|innerhalb)|einzahlungsschein)\b/iu;

/** The receipt's clauses: its lines, cut at «·», «;» and a full stop that ends a sentence (not one inside an amount). */
const clauses = (text: string): string[] => text.split(/[\n·;|]|\.(?=\s|$)/u).map((c) => c.trim()).filter(Boolean);

/** A clause that states it, without a denial or a condition. */
const says = (re: RegExp, text: string): boolean => clauses(text).some((c) => re.test(c) && !NOT_SO.test(c));

export function paidPrivately(text: string): boolean {
  const words = text.slice(0, 6000);
  if (says(PRIVATE, words)) return true;
  return says(CASH, words) && !CARD.test(words);
}
