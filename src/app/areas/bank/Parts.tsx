/**
 * The parts of a collective payment (Sammelauftrag) as the bank gave them: payee, reference (the
 * invoice number) and amount per part, on the payment's page and its task card, so the owner
 * splits by them instead of blind (r9k-6). Nothing for a payment without parts.
 */
import type { BankTransaction } from '../../../types/index.js';
import { partText } from '../../../accounting/batch-parts.js';
import { fmt } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';

export function Parts({ tx }: { tx: BankTransaction }) {
  const parts = tx.parts ?? [];
  if (parts.length < 2) return null;
  return (
    <div className="payparts" data-testid="payment-parts">
      <span className="m">{t('bank.parts', { n: parts.length })}</span>
      <ul>
        {parts.map((p, i) => (
          <li key={i}><span>{partText(p) || '–'}</span><span className="mono">{p.currency} {fmt(Math.abs(p.amount))}</span></li>
        ))}
      </ul>
    </div>
  );
}
