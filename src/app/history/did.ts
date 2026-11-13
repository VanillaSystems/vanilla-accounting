import type { Receipt } from '../../types/index.js';
import { readsNothing } from '../../parsers/receipt-text.js';

/**
 * What a run that wrote a receipt did to it: read it, or filed it unread (a photo no AI read,
 * #344), and then what it says is what a person entered (#438).
 */
export function receiptDid(r: Pick<Receipt, 'extractedText' | 'extractionMethod' | 'vatBy'> | undefined): 'history.didReceipt' | 'history.keptReceipt' | 'history.keptByHand' {
  if (!r || !readsNothing(r)) return 'history.didReceipt';
  return r.vatBy === 'human' ? 'history.keptByHand' : 'history.keptReceipt';
}
