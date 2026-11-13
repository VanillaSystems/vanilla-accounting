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
 * till prints both lines; only an explicit «privat …» wins over them, or the payment line itself
 * marked private («Bezahlt mit Mastercard ****1150 (privat)», #402).
 *
 * A card alone says nothing of whose it is. The books do (paidCards, #402): a card a receipt paid
 * privately or marked private names is the owner's, a card on a receipt of a payment of the firm's
 * own statements (its business card's statement, its debit card) is the firm's; a receipt paid with
 * the owner's card reads as paid privately (readsPrivately).
 */

/** Out of a private pocket, whatever paid at the till. */
const PRIVATE = /\b(privat\s+(ausgelegt|bezahlt|vorgeschossen|beglichen)|aus\s+eigener\s+tasche\s+(bezahlt|beglichen)|pay[ée]e?\s+(à\s+titre\s+)?priv[ée]e?|pagat[oa]\s+privatamente|paid\s+(privately|personally|out\s+of\s+pocket))\b/iu;

/** A payment line that names its card or its payment and marks it private: «Bezahlt mit Mastercard ****1150 (privat)», «Paid by Visa (private card)». */
const PAID_MARKED = /\b(bezahlt|beglichen|zahlung|paid|payment|pay[ée]e?|paiement|pagat[oa]|pagamento)\b.*(\(\s*(privat|private|priv[ée]e?|privat[oa]|personal)\b|\b(privatkarte|private\s+card|personal\s+card|carte\s+priv[ée]e|carta\s+privata)\b)/iu;

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
  if (says(PRIVATE, words) || says(PAID_MARKED, words)) return true;
  return says(CASH, words) && !CARD.test(words);
}

/** The last four digits of the card a receipt names («Mastercard ****1150», «Visa XXXX XXXX XXXX 4242»): masked digits, never a plain number. */
export function cardOf(text: string): string | undefined {
  return /(?:[*xX•·]{2,}[\s-]?)+(\d{4})\b/u.exec(text.slice(0, 6000))?.[1];
}

/** The cards the books know: the owner's (`private`) and the firm's (`firm`); a card on both sides is in neither. */
export interface PaidCards { private: ReadonlySet<string>; firm: ReadonlySet<string> }

/**
 * The cards from the receipts and what paid them: `owner` (a private outlay, «Privat bezahlt»),
 * `firm` (a payment of the firm's own statements), none (not paid yet). A receipt whose words say it
 * was paid privately names the owner's card too.
 */
export function paidCards(receipts: ReadonlyArray<{ text: string; paidBy?: 'owner' | 'firm' }>): PaidCards {
  const own = new Set<string>();
  const firm = new Set<string>();
  for (const r of receipts) {
    const card = cardOf(r.text);
    if (!card) continue;
    if (r.paidBy === 'firm') firm.add(card);
    else if (r.paidBy === 'owner' || paidPrivately(r.text)) own.add(card);
  }
  return { private: new Set([...own].filter((c) => !firm.has(c))), firm: new Set([...firm].filter((c) => !own.has(c))) };
}

/** Whether a receipt reads as paid privately: its words say so, or the owner's card paid it. */
export function readsPrivately(text: string, cards: PaidCards): boolean {
  if (paidPrivately(text)) return true;
  const card = cardOf(text);
  return !!card && cards.private.has(card);
}
