/**
 * A mailbox's senders whose attachments are no receipts: offered to be skipped (Firma › Quellen),
 * one click. A sender is an address, not its domain: a supplier sends its invoices and its
 * newsletter from one domain. It counts when 3 or more of its documents were no receipt
 * (quarantined by their words, the ledger says so, or marked as no receipt by a person in Belege)
 * and none of its documents stands in the books: a supplier with one real invoice among its
 * brochures is never offered (its brochures can be kept aside by their file-name shape instead,
 * src/platform/sources/aside.ts). Skipping narrows the reach (the address in
 * reach.mail.skip), so the new version is switched on with the person's click (src/server/routes/sources.ts).
 *
 * A person's «kein Beleg» on one collected file offers the same at once (#186, «Immer so?»): the
 * sender of that file, with what the mailbox delivered from it and which of those stand in the
 * books as receipts, shown on a card before the person keeps it.
 */
import type { Receipt } from '../../types/index.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { LedgerLine } from './ledger.js';
import type { MacMailReach, MailReach, ReceiptSkipOffer, SkipOffer, SourceDecl } from './model.js';
import { senderAllowed } from './reach.js';
import { editSourceYaml } from './aside.js';

const AT_LEAST = 3;

/** Kinds that set a file aside: a skip loses nothing the books keep. A document kept beside an invoice counts as kept. */
const ASIDE = new Set<Receipt['kind']>(['noise', 'duplicate']);

/** A mailbox's reach and the key of source.yaml it stands under: an IMAP server's or the Mail app's on this Mac. */
export function mailReachOf(decl: Pick<SourceDecl, 'reach'>): { key: 'mail' | 'mac-mail'; reach: MailReach | MacMailReach } | undefined {
  if (decl.reach.mail) return { key: 'mail', reach: decl.reach.mail };
  if (decl.reach.macMail) return { key: 'mac-mail', reach: decl.reach.macMail };
  return undefined;
}

type DocumentLine = Extract<LedgerLine, { got: { kind: 'document' } }>;
const isDocument = (l: LedgerLine): l is DocumentLine => 'got' in l && l.got.kind === 'document' && !l.got.duplicateOf;
const senderOf = (l: DocumentLine) => l.got.from?.toLowerCase();

/**
 * Who sent the file a receipt was read from: the line whose SHA-256 starts with the receipt's id.
 * Only when no line has those bytes (a photo turned into a PDF) does the file's name count, and
 * only if one sender alone sent a file of that name: «Rechnung.pdf» from two senders names neither,
 * so a skip never hits a supplier that happened to name its invoice alike.
 */
function senderOfReceipt(lines: readonly DocumentLine[], r: Pick<Receipt, 'id' | 'originalFilename'>): string | undefined {
  const bySha = lines.filter((l) => l.got.sha256.startsWith(r.id));
  const matched = bySha.length ? bySha : lines.filter((l) => !!l.got.file && l.got.file === r.originalFilename);
  const senders = new Set(matched.map(senderOf));
  return senders.size === 1 ? [...senders][0] : undefined;
}

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
    const documents = lines.filter(isDocument);
    const from = senderOfReceipt(documents, receipt);
    if (!from || !senderAllowed(mail.reach, from)) continue;
    const theirs = documents.filter((l) => senderOf(l) === from);
    const taken = receipts.filter((r) => r.id !== receipt.id && !ASIDE.has(r.kind) && senderOfReceipt(documents, r) === from);
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

export function skipOffers(lines: readonly LedgerLine[], receipts: readonly Pick<Receipt, 'id' | 'originalFilename' | 'kind' | 'kindBy'>[], reach: Pick<MailReach, 'from' | 'skip'>): SkipOffer[] {
  const documents = lines.filter(isDocument);
  const noReceipt = new Set(receipts.filter((r) => r.kind === 'noise' && r.kindBy === 'human').map((r) => r.originalFilename));
  const inBooks = new Set(receipts.filter((r) => !ASIDE.has(r.kind)).map((r) => senderOfReceipt(documents, r)).filter(Boolean));
  const bad = new Map<string, number>();
  for (const l of documents) {
    if (!l.got.from || l.got.quarantined?.why === 'duplicate') continue;
    const sender = l.got.from.toLowerCase();
    if (!senderAllowed(reach, sender)) continue;
    if (l.got.quarantined || (l.got.file && noReceipt.has(l.got.file))) bad.set(sender, (bad.get(sender) ?? 0) + 1);
  }
  return [...bad].filter(([sender, n]) => n >= AT_LEAST && !inBooks.has(sender)).map(([sender, n]) => ({ sender, n })).sort((a, b) => b.n - a.n);
}

/** Adds the sender's address to the source's reach.mail.skip (reach.mac-mail.skip for the Mail app) in its source.yaml, comments and all. */
export function addSkip(ws: Pick<Workspace, 'paths'>, source: string, address: string, key: 'mail' | 'mac-mail' = 'mail', expect?: string): void {
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(address)) throw new Error(`${address} is no mail address`);
  const pattern = address.toLowerCase();
  editSourceYaml(ws, source, (doc) => {
    const skip = doc.getIn(['reach', key, 'skip']);
    const list = skip && typeof skip === 'object' && 'items' in (skip as object) ? (skip as { items: Array<{ value?: unknown }> }).items.map((i) => String(i.value ?? i)) : [];
    if (list.includes(pattern)) return false;
    if (list.length) doc.addIn(['reach', key, 'skip'], pattern);
    else doc.setIn(['reach', key, 'skip'], doc.createNode([pattern]));
    return true;
  }, expect);
}
