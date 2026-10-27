/**
 * Which tab of the drop dialog a row is listed under, and whether it needs the person. A statement
 * asking its question (which account, firm or private) is a statement waiting for an answer, listed
 * under «Kontoauszüge», never under «Nicht übernommen» beside duplicates and refused files (#208).
 */
import type { DropRow } from '../../types/drop.js';

export type DropTab = 'all' | 'statements' | 'receipts' | 'unclear' | 'out';

export const tabOf = (r: DropRow): DropTab => (r.state === 'duplicate' || r.state === 'quarantine' || r.state === 'refused' || r.state === 'undone' ? 'out'
  : r.state === 'asks' ? 'statements'
  : r.state === 'locked' || r.state === 'unclear' || !r.kind ? 'unclear'
  : r.kind === 'camt' || r.kind === 'statement-pdf' ? 'statements' : 'receipts');

export const needsYou = (r: DropRow): boolean => r.state === 'locked' || r.state === 'unclear' || r.state === 'asks';
