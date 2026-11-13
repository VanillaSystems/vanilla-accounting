import type { StatementImport } from '../../../types/index.js';
import { t } from '../../i18n/index.js';

/** What an import did with payments a read before #401 left without a reference (StatementImport.emptyRefs), said as a fact. A file of its own: the drop dialog and the bank's actions both say it, and the actions import the dialog. */
export function emptyRefsLine(e: StatementImport['emptyRefs']): string {
  if (!e) return '';
  if ('repaired' in e) return e.repaired ? t('bank.emptyRefs.repaired', { n: e.repaired }) : '';
  return t(e.why === 'yours' ? 'bank.emptyRefs.yours' : 'bank.emptyRefs.unmatched', { n: e.left });
}
