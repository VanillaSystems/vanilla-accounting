/**
 * A mailbox's senders whose attachments are no receipts: offered to be skipped (Firma › Quellen),
 * one click. A sender is an address, not its domain: a supplier sends its invoices and its
 * newsletter from one domain. It counts when 3 or more of its documents, and nearly all of them,
 * were no receipt: quarantined by their words (the ledger says so), or marked as no receipt by a
 * person in Belege (the receipt of a delivered file). Skipping narrows the reach (the address in
 * reach.mail.skip), so the new version is switched on with the person's click (src/server/routes/sources.ts).
 *
 * A person's «kein Beleg» on one collected file offers the same at once (#186, «Immer so?»): the
 * sender of that file, with what the mailbox delivered from it and which of those stand in the
 * books as receipts, shown on a card before the person keeps it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { Receipt } from '../../types/index.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { LedgerLine } from './ledger.js';
import type { MacMailReach, MailReach, ReceiptSkipOffer, SkipOffer, SourceDecl } from './model.js';
import { senderAllowed } from './reach.js';

const AT_LEAST = 3;
const SHARE = 0.8;

/** Kinds that set a file aside: it is no receipt the books count. */
const ASIDE = new Set<Receipt['kind']>(['noise', 'duplicate', 'supporting', 'statement']);

/** A mailbox's reach and the key of source.yaml it stands under: an IMAP server's or the Mail app's on this Mac. */
export function mailReachOf(decl: Pick<SourceDecl, 'reach'>): { key: 'mail' | 'mac-mail'; reach: MailReach | MacMailReach } | undefined {
  if (decl.reach.mail) return { key: 'mail', reach: decl.reach.mail };
  if (decl.reach.macMail) return { key: 'mac-mail', reach: decl.reach.macMail };
  return undefined;
}

type DocumentLine = Extract<LedgerLine, { got: { kind: 'document' } }>;
const isDocument = (l: LedgerLine): l is DocumentLine => 'got' in l && l.got.kind === 'document' && !l.got.duplicateOf;
/** A delivered file is the receipt read from it: the receipt's id is the start of the file's SHA-256, its first name the file's. */
const delivered = (l: DocumentLine, r: Pick<Receipt, 'id' | 'originalFilename'>) => l.got.sha256.startsWith(r.id) || (!!l.got.file && l.got.file === r.originalFilename);

/**
 * The skip a person's «kein Beleg» on `receipt` offers: the company mailbox that delivered it and
 * its sender, while the mailbox still reads that sender. Undefined for a file no mailbox brought,
 * one a person did not set aside, or a sender skipped already.
 */
export function receiptSkipOffer(
  receipt: Pick<Receipt, 'id' | 'originalFilename' | 'kind' | 'kindBy'>,
  mailboxes: ReadonlyArray<{ decl: Pick<SourceDecl, 'id' | 'label' | 'origin' | 'version' | 'reach'>; lines: readonly LedgerLine[] }>,
  receipts: readonly Pick<Receipt, 'id' | 'originalFilename' | 'filename' | 'date' | 'kind'>[],
): ReceiptSkipOffer | undefined {
  if (receipt.kind !== 'noise' || receipt.kindBy !== 'human') return undefined;
  for (const { decl, lines } of mailboxes) {
    const mail = mailReachOf(decl);
    if (decl.origin !== 'company' || !mail) continue;
    const from = lines.filter(isDocument).find((l) => l.got.from && delivered(l, receipt))?.got.from?.toLowerCase();
    if (!from || !senderAllowed(mail.reach, from)) continue;
    const theirs = lines.filter(isDocument).filter((l) => l.got.from?.toLowerCase() === from);
    const taken = receipts.filter((r) => r.id !== receipt.id && !ASIDE.has(r.kind) && theirs.some((l) => delivered(l, r)));
    return {
      source: decl.id,
      label: decl.label,
      version: decl.version,
      sender: from,
      delivered: theirs.length,
      receipts: taken.map((r) => ({ id: r.id, filename: r.filename, ...(r.date ? { date: r.date } : {}) })),
    };
  }
  return undefined;
}

export function skipOffers(lines: readonly LedgerLine[], receipts: readonly Pick<Receipt, 'originalFilename' | 'kind' | 'kindBy'>[], reach: Pick<MailReach, 'from' | 'skip'>): SkipOffer[] {
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

/** Adds the sender's address to the source's reach.mail.skip (reach.mac-mail.skip for the Mail app) in its source.yaml, comments and all. */
export function addSkip(ws: Pick<Workspace, 'paths'>, source: string, address: string, key: 'mail' | 'mac-mail' = 'mail'): void {
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(address)) throw new Error(`${address} is no mail address`);
  const file = join(ws.paths.root, 'sources', source, 'source.yaml');
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const pattern = address.toLowerCase();
  const skip = doc.getIn(['reach', key, 'skip']);
  const list = skip && typeof skip === 'object' && 'items' in (skip as object) ? (skip as { items: Array<{ value?: unknown }> }).items.map((i) => String(i.value ?? i)) : [];
  if (list.includes(pattern)) return;
  if (list.length) doc.addIn(['reach', key, 'skip'], pattern);
  else doc.setIn(['reach', key, 'skip'], doc.createNode([pattern]));
  writeFileSync(file, doc.toString());
}
