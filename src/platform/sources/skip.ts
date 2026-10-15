/**
 * A mailbox's senders whose attachments are no receipts: offered to be skipped (Firma › Quellen),
 * one click. A sender is an address, not its domain: a supplier sends its invoices and its
 * newsletter from one domain. It counts when 3 or more of its documents, and nearly all of them,
 * were no receipt: quarantined by their words (the ledger says so), or marked as no receipt by a
 * person in Belege (the receipt of a delivered file). Skipping narrows the reach (the address in
 * reach.mail.skip), so the new version is switched on with the person's click (src/server/routes/sources.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { Receipt } from '../../types/index.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { LedgerLine } from './ledger.js';
import type { MailReach, SkipOffer } from './model.js';
import { senderAllowed } from './reach.js';

const AT_LEAST = 3;
const SHARE = 0.8;

export function skipOffers(lines: readonly LedgerLine[], receipts: readonly Pick<Receipt, 'originalFilename' | 'kind' | 'kindBy'>[], reach: MailReach): SkipOffer[] {
  const noReceipt = new Set(receipts.filter((r) => r.kind === 'noise' && r.kindBy === 'human').map((r) => r.originalFilename));
  const by = new Map<string, { all: number; bad: number }>();
  for (const l of lines) {
    if (!('got' in l) || l.got.kind !== 'document' || !l.got.from || l.got.duplicateOf) continue;
    const sender = l.got.from.toLowerCase();
    if (!senderAllowed(reach, sender)) continue;
    const c = by.get(sender) ?? { all: 0, bad: 0 };
    c.all++;
    if (l.got.quarantined || (l.got.file && noReceipt.has(l.got.file))) c.bad++;
    by.set(sender, c);
  }
  return [...by].filter(([, c]) => c.bad >= AT_LEAST && c.bad / c.all >= SHARE).map(([sender, c]) => ({ sender, n: c.bad })).sort((a, b) => b.n - a.n);
}

/** Adds the sender's address to the source's reach.mail.skip in its source.yaml, comments and all. */
export function addSkip(ws: Pick<Workspace, 'paths'>, source: string, address: string): void {
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(address)) throw new Error(`${address} is no mail address`);
  const file = join(ws.paths.root, 'sources', source, 'source.yaml');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const pattern = address.toLowerCase();
  const skip = doc.getIn(['reach', 'mail', 'skip']);
  const list = skip && typeof skip === 'object' && 'items' in (skip as object) ? (skip as { items: Array<{ value?: unknown }> }).items.map((i) => String(i.value ?? i)) : [];
  if (list.includes(pattern)) return;
  if (list.length) doc.addIn(['reach', 'mail', 'skip'], pattern);
  else doc.setIn(['reach', 'mail', 'skip'], doc.createNode([pattern]));
  writeFileSync(file, doc.toString());
}
