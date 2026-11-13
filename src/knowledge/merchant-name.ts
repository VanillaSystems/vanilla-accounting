/** A payment's merchant as a name, without the file system: the hand form in the browser needs it too (#357). */
import type { BankTransaction } from '../types/index.js';
import { merchantOf } from './counterparties.js';
import { BANK_WORDS } from '../intake/pairing.js';

/**
 * The name a payment gives its merchant, as a learned name keeps it: the bank's counterparty field,
 * else the merchant of its text (merchantOf), cut before the first part with a digit (a card's
 * reference «*AB12CD», a terminal's number) and trimmed. None when what is left names nothing: fewer
 * than four letters, or only the bank's own words («Karte», «Einkauf»).
 */
export function merchantName(tx: Pick<BankTransaction, 'counterparty' | 'description'>): string | undefined {
  const raw = (tx.counterparty?.trim() || merchantOf(tx.description)).replace(/\s+/g, ' ');
  const cut = raw.search(/[\s*#/]*[^\s*#/]*\d/);
  const name = (cut < 0 ? raw : raw.slice(0, cut)).replace(/[\s*#/.,;:–-]+$/u, '').trim();
  const words = name.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  if ((name.match(/\p{L}/gu) ?? []).length < 4 || !words.some((w) => !BANK_WORDS.has(w))) return undefined;
  return name;
}
