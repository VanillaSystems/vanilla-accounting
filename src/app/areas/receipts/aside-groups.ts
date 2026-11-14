/**
 * «Aussortiert» grouped as a person decides on it (src/app/areas/receipts/Aside.tsx): a group a
 * mailbox keeps aside (its sender and file-name shape), the duplicates of receipts, each kind of
 * word verdict (newsletters, terms …), what a person set aside, what no reader opens. Groups come
 * in the order of their newest file; «Doch behalten» takes a whole group back at once.
 */
import type { QuarantinedFile, QuarantineReason } from '../../../types/drop.js';

export interface AsideGroupView { key: string; reason: QuarantineReason; files: QuarantinedFile[] }

export function groupKey(r: QuarantineReason): string {
  if (r.kind === 'held' || r.kind === 'unreadable' || r.kind === 'duplicate') return r.kind;
  if (r.why === 'group') return `group ${r.source ?? ''} ${r.from ?? ''} ${r.shape ?? ''}`;
  return `why ${r.why ?? 'no-receipt'}`;
}

/** The files by group, in the order of their newest file (the list comes newest first). */
export function asideGroups(files: readonly QuarantinedFile[]): AsideGroupView[] {
  const out = new Map<string, AsideGroupView>();
  for (const q of files) {
    const key = groupKey(q.reason);
    const g = out.get(key) ?? { key, reason: q.reason, files: [] };
    g.files.push(q);
    out.set(key, g);
  }
  return [...out.values()];
}
