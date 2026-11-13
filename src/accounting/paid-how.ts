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

/** The private mark on a payment line: «(privat)», «(private card)», «Privatkarte». */
const PRIVATE_MARK = /(\(\s*(privat|private|priv[ée]e?|privat[oa]|personal)\b|\b(privatkarte|private\s+card|personal\s+card|carte\s+priv[ée]e|carta\s+privata)\b)/iu;

/** A card's word: its brand, or the word for a card. */
const CARD_WORD = '(?:visa|master\\s?card|maestro|amex|american\\s+express|diners|postfinance|v\\s?pay|debit|kredit|credit|karte|card|carte|carta)';

/** Masked digits of a card after a card's word, within one line: «Mastercard ****1150», «Visa XXXX XXXX XXXX 4242». */
const CARD_DIGITS = new RegExp(`\\b${CARD_WORD}\\b[^\\n]{0,24}?(?:[*xX•·]{2,}[\\s-]?)+(\\d{4})\\b`, 'iu');

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
  if (says(PRIVATE, words) || markedLine(words)) return true;
  return says(CASH, words) && !CARD.test(words);
}

/** A payment line that names its card and marks it private («Bezahlt mit Mastercard ****1150 (privat)»): the mark in the line of the card, never in running text. */
function markedLine(text: string): boolean {
  return text.split('\n').some((line) => CARD_DIGITS.test(line) && PRIVATE_MARK.test(line) && !NOT_SO.test(line));
}

/** The last four digits of the card a receipt names after a card's word («Mastercard ****1150»): never masked digits of an IBAN or a customer number. */
export function cardOf(text: string): string | undefined {
  return CARD_DIGITS.exec(text.slice(0, 6000))?.[1];
}

/** Why the books know a card as the owner's: the receipt that shows it, its day and file. */
export interface CardSeen { date?: string; file: string }

/** The cards the books know: the owner's (`private`, with the receipt that shows it) and the firm's (`firm`); a card on both sides is in neither. */
export interface PaidCards { private: ReadonlyMap<string, CardSeen>; firm: ReadonlySet<string> }

export const NO_CARDS: PaidCards = { private: new Map(), firm: new Set() };

/**
 * The cards from the receipts and what paid them: `owner` (a private outlay, «Privat bezahlt»),
 * `firm` (a payment of the firm's own statements), none (not paid yet). A card is the owner's when a
 * receipt's own words say it was paid privately, or when two receipts paid privately show it; one
 * outlay alone may have been paid with the firm's card by mistake.
 */
export function paidCards(receipts: ReadonlyArray<{ text: string; paidBy?: 'owner' | 'firm'; date?: string; file: string }>): PaidCards {
  const marked = new Map<string, CardSeen>();
  const outlays = new Map<string, CardSeen[]>();
  const firm = new Set<string>();
  for (const r of receipts) {
    const card = cardOf(r.text);
    if (!card) continue;
    const seen = { ...(r.date && { date: r.date }), file: r.file };
    if (r.paidBy === 'firm') firm.add(card);
    else if (paidPrivately(r.text)) { if (!marked.has(card)) marked.set(card, seen); }
    else if (r.paidBy === 'owner') outlays.set(card, [...(outlays.get(card) ?? []), seen]);
  }
  const own = new Map(marked);
  for (const [card, seen] of outlays) if (seen.length >= 2 && !own.has(card)) own.set(card, seen[0]);
  return { private: new Map([...own].filter(([c]) => !firm.has(c))), firm: new Set([...firm].filter((c) => !own.has(c))) };
}

/** Why a receipt reads as paid privately: its words say so, or the owner's card paid it (which, and the receipt that shows it); false when neither. */
export type PrivateRead = false | { by: 'words' } | { by: 'card'; card: string; seen: CardSeen };

export function readsPrivately(text: string, cards: PaidCards): PrivateRead {
  if (paidPrivately(text)) return { by: 'words' };
  const card = cardOf(text);
  const seen = card ? cards.private.get(card) : undefined;
  return card && seen ? { by: 'card', card, seen } : false;
}
