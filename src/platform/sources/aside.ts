/**
 * What a mailbox sets aside besides the words of a file (src/intake/recognize.ts), learned from what
 * it delivered and what became of it, never by a model. The rule above all: a real receipt is never
 * lost; in doubt a file comes in.
 *
 * - «Immer beiseite» per sender × file-name shape: a sender's files of one shape («report.pdf»,
 *   «newsletter_#.pdf») of which two or more were set aside (by their words, or a person's «kein
 *   Beleg») and none stands in the books are offered as one group, one click (Firma › Quellen).
 *   Kept, the group stands in the source's `settings.aside` and its next files go to quarantine at
 *   delivery. A sender is an address and its shapes are told apart, so a supplier that sends
 *   brochures and invoices from one address keeps its invoices: measured on a real mailbox, this
 *   lost no receipt where a rule per sender did. Never offered: a shape without a word that says
 *   anything («#.pdf», «img_#.pdf», «scan.pdf»), a shape of a receipt's words («rechnung_#.pdf»).
 *   Never set aside by a group: a file whose own words name it a receipt.
 * - A duplicate by content: a file whose sender, own invoice number, signed amount and day (within a
 *   week; both must show one) are those of a receipt in the books, with other bytes, is set aside as
 *   that receipt's duplicate. A credit note, a proforma, an instalment or a reminder repeats an
 *   invoice's number without being its copy: never a duplicate. Where a fact is missing, nothing is
 *   decided.
 *
 * What is set aside never enters the books: it waits under «Aussortiert» with its reason, and what
 * a mailbox set aside is deleted 30 days after it came unless a person keeps it
 * (src/intake/quarantine.ts). «Doch behalten» on a file of a group switches the group off, and the
 * group's other files are kept from then on.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, YAMLSeq, isMap, type Document } from 'yaml';
import type { Receipt } from '../../types/index.js';
import type { DocumentsData } from '../../core/modules/schema.js';
import type { Workspace } from '../../workspace/workspace.js';
import { readDetails, readLedger, type DeliveredDocument, type LedgerLine } from './ledger.js';
import { SourceVersionChanged, sources } from './index.js';
import type { AsideOffer, MailReach } from './model.js';
import { senderAllowed } from './reach.js';
import { textFacts } from '../../parsers/receipt-text.js';
import { labelledNumbers } from '../../intake/duplicates.js';
import { wordsRe } from '../../core/modules/words.js';

/** Files of a group that must have been set aside before the group is offered. */
export const ASIDE_AT_LEAST = 2;

/** Kinds of a receipt that do not stand in the books: what was set aside stays out of them. */
const NOT_IN_BOOKS = new Set<Receipt['kind']>(['noise', 'duplicate']);

/**
 * A file name's shape: what stays of it when its numbers are taken out, so the monthly «report.pdf»,
 * an invoice's «5714779795.pdf» and a phone's «IMG_1771.pdf» each name the files of one kind.
 *
 * Lower case; a copy's mark before the extension goes («report (1).pdf», «report-2.pdf»,
 * «IMG_1760 2.pdf»: a 1–2 digit number after a separator, or a number in brackets); the rest is
 * cut at every character that is no letter or digit; a part that is a number, or a hexadecimal id
 * with a digit («9BF0758D»), becomes `#`, and digits inside a word become `#` («v3» → «v#»);
 * neighbouring `#` parts fold into one. The parts are joined by `_`, the extension kept:
 * «Invoice-9BF0758D-7523929.pdf» → «invoice_#.pdf», «Rechnung 2026-04.pdf» → «rechnung_#.pdf».
 */
export function nameShape(name: string): string {
  const lower = name.normalize('NFC').toLowerCase().trim();
  const dot = lower.lastIndexOf('.');
  const hasExt = dot > 0 && /^[\p{L}\p{N}]{1,5}$/u.test(lower.slice(dot + 1));
  const ext = hasExt ? lower.slice(dot + 1) : '';
  // `#` stands for a number (in a shape, and in «Invoice #123»), read after a copy's mark is gone.
  const stem = (hasExt ? lower.slice(0, dot) : lower).replace(/\s*\(\d+\)$|[-_ ]\d{1,2}$/u, '').replace(/#/g, '0');
  const parts: string[] = [];
  for (const raw of stem.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const part = /^[0-9a-f]+$/.test(raw) && /\d/.test(raw) ? '#' : raw.replace(/\d+/g, '#');
    if (part === '#' && parts.at(-1) === '#') continue;
    parts.push(part);
  }
  const base = parts.join('_') || '#';
  return ext ? `${base}.${ext}` : base;
}

const letters = (s: string) => s.replace(/[^\p{L}]+/gu, '');
const wordsOf = (phrases: readonly string[]) => phrases.flatMap((p) => p.toLowerCase().split(/[^\p{L}]+/u)).filter((w) => w.length >= 4);

/**
 * Whether a shape may be offered as a group: it has a word that says what its files are (not only
 * numbers, not a camera's or scanner's default from `genericFileNames`), and none of its words is,
 * or holds, a receipt's word (its title or the label of its number: «rechnung_#.pdf», «beleg.pdf»).
 */
export function offerableShape(shape: string, words: DocumentsData): boolean {
  const dot = shape.lastIndexOf('.');
  const parts = (dot > 0 ? shape.slice(0, dot) : shape).split('_').map(letters).filter((p) => p.length >= 2);
  const generic = new Set((words.genericFileNames ?? []).map((w) => letters(w.toLowerCase())));
  const telling = parts.filter((p) => !generic.has(p) && !generic.has(p.replace(/s$/, '')));
  if (!telling.length) return false;
  const receiptWords = wordsOf([...words.receipt.title, ...words.receipt.number]);
  return !parts.some((p) => receiptWords.some((w) => p.includes(w)));
}

/** The line's shape: logged since the ledger kept it, else read off the name the file got. */
export const shapeOf = (l: { got: DeliveredDocument }): string => l.got.shape ?? nameShape(l.got.quarantined?.file ?? l.got.file ?? '');

type DocumentLine = Extract<LedgerLine, { got: { kind: 'document' } }>;
const isDelivered = (l: LedgerLine): l is DocumentLine => 'got' in l && l.got.kind === 'document' && !l.got.duplicateOf && l.got.quarantined?.why !== 'duplicate';

/**
 * The line a receipt was read from: the one whose SHA-256 starts with the receipt's id; only when no
 * line has those bytes, the one line that delivered a file of the receipt's original name.
 */
export function lineOfReceipt<L extends DocumentLine>(lines: readonly L[], r: Pick<Receipt, 'id' | 'originalFilename'>): L | undefined {
  const bySha = lines.filter((l) => l.got.sha256.startsWith(r.id));
  if (bySha.length) return bySha[0];
  const byName = lines.filter((l) => !!l.got.file && l.got.file === r.originalFilename);
  return byName.length === 1 ? byName[0] : undefined;
}

/** A group the person keeps aside, as `settings.aside` of source.yaml holds it. */
export interface AsideGroup { from: string; name: string; source?: string; off?: boolean }

/** The groups in a source's settings; anything not shaped like one is left out. */
export function asideGroups(settings: Record<string, unknown>): AsideGroup[] {
  const list = Array.isArray(settings.aside) ? settings.aside : [];
  return list.flatMap((g): AsideGroup[] => {
    if (!g || typeof g !== 'object') return [];
    const { from, name, source, off } = g as Record<string, unknown>;
    if (typeof from !== 'string' || typeof name !== 'string' || !from || !name) return [];
    return [{ from: from.toLowerCase(), name, ...(typeof source === 'string' ? { source } : {}), ...(off === true ? { off: true } : {}) }];
  });
}

/**
 * The group switched on that a delivered file of `from` named `name` falls in, or undefined. Never a
 * file whose own words name it a receipt (`saysReceipt`), and never by a shape that may not be a group.
 */
export function asideGroupOf(settings: Record<string, unknown>, from: string | undefined, name: string, words: DocumentsData, saysReceipt = false): AsideGroup | undefined {
  if (!from || saysReceipt) return undefined;
  const sender = from.toLowerCase(), shape = nameShape(name);
  if (!offerableShape(shape, words)) return undefined;
  return asideGroups(settings).find((g) => !g.off && g.from === sender && g.name === shape);
}

/** What the app keeps of a delivered file outside git (data/, src/platform/sources/ledger.ts details): its own name, its VAT number. */
export interface Details { name?: string; vatId?: string }

export interface AsideInput {
  lines: readonly LedgerLine[];
  /** The whole books' receipts. */
  receipts: readonly Pick<Receipt, 'id' | 'originalFilename' | 'kind' | 'kindBy' | 'vatId' | 'extractedText'>[];
  reach: Pick<MailReach, 'from' | 'skip'>;
  settings: Record<string, unknown>;
  words: DocumentsData;
  /** Each line's details by its key (`<feed> <key>`), where the app kept them. */
  details?: ReadonlyMap<string, Details>;
  /** The senders of the books' receipts by receipt id, from every mailbox's ledger. */
  senders?: ReadonlyMap<string, string>;
  /** File names waiting in the inbox: what is read next counts as in the books. */
  pending?: ReadonlySet<string>;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);
export const detailKey = (l: { feed: string; key: string }) => `${l.feed} ${l.key}`;

/**
 * The groups a mailbox could keep aside (sender × file-name shape): two or more of their files set
 * aside (by their words, or by a person's «kein Beleg»), none of them standing in the books or
 * waiting in the inbox, and no receipt anywhere in the books of that shape from that sender (its
 * address by any mailbox's ledger, a VAT number one of the group's files showed, or its domain in
 * the receipt's text); the sender still read; the shape one that may be a group; the group not in
 * the settings yet (switched off counts: a person said no).
 */
export function asideOffers(input: AsideInput): AsideOffer[] {
  const { lines, receipts, reach, settings, words, details = new Map(), senders = new Map(), pending = new Set() } = input;
  const docs = lines.filter(isDelivered).filter((l) => !!l.got.from);
  const state = new Map<DocumentLine, 'aside' | 'books'>();
  for (const l of docs) {
    if (l.got.quarantined) state.set(l, 'aside');
    else if (l.got.file && pending.has(l.got.file)) state.set(l, 'books');
  }
  for (const r of receipts) {
    const l = lineOfReceipt(docs, r);
    if (!l) continue;
    if (r.kind === 'noise' && r.kindBy === 'human') state.set(l, 'aside');
    else if (!NOT_IN_BOOKS.has(r.kind)) state.set(l, 'books');
  }
  const kept = new Set(asideGroups(settings).map((g) => `${g.from} ${g.name}`));
  const groups = new Map<string, { sender: string; shape: string; lines: DocumentLine[] }>();
  for (const l of docs) {
    const sender = l.got.from!.toLowerCase(), shape = shapeOf(l);
    const key = `${sender} ${shape}`;
    if (kept.has(key) || !senderAllowed(reach, sender) || !offerableShape(shape, words)) continue;
    const g = groups.get(key) ?? { sender, shape, lines: [] };
    g.lines.push(l);
    groups.set(key, g);
  }
  const standing = receipts.filter((r) => !NOT_IN_BOOKS.has(r.kind));
  const elsewhere = (g: { sender: string; shape: string; lines: DocumentLine[] }) => {
    const vatIds = new Set(g.lines.map((l) => details.get(detailKey(l))?.vatId).filter(Boolean));
    const domain = domainOf(g.sender);
    const named = domain ? wordsRe([domain]) : undefined;
    return standing.some((r) => nameShape(r.originalFilename) === g.shape
      && (senders.get(r.id) === g.sender || (!!r.vatId && vatIds.has(r.vatId)) || (!!named && named.test(r.extractedText ?? ''))));
  };
  const nameOf = (l: DocumentLine) => details.get(detailKey(l))?.name ?? l.got.quarantined?.file ?? l.got.file ?? '';
  return [...groups.values()]
    .filter((g) => g.lines.filter((l) => state.get(l) === 'aside').length >= ASIDE_AT_LEAST && !g.lines.some((l) => state.get(l) === 'books') && !elsewhere(g))
    .map((g) => ({
      sender: g.sender,
      shape: g.shape,
      files: g.lines.map((l) => ({ name: nameOf(l), date: (l.got.date ?? l.at).slice(0, 10), aside: state.get(l) === 'aside' })),
      inBooks: 0 as const,
    }))
    .sort((a, b) => b.files.length - a.files.length || a.sender.localeCompare(b.sender) || a.shape.localeCompare(b.shape));
}

/** The sender of each receipt of the books that a mailbox brought, by any mailbox's ledger: the whole books, not one mailbox's. */
export function receiptSenders(ws: Pick<Workspace, 'paths'>, appRoot: string, receipts: readonly Pick<Receipt, 'id' | 'originalFilename'>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of sources(ws, appRoot)) {
    if (v.kind === 'invalid') continue;
    const docs = readLedger(ws, v.decl.id).filter((l): l is DocumentLine => 'got' in l && l.got.kind === 'document' && !!l.got.from);
    if (!docs.length) continue;
    for (const r of receipts) {
      if (out.has(r.id)) continue;
      const l = lineOfReceipt(docs, r);
      if (l?.got.from) out.set(r.id, l.got.from.toLowerCase());
    }
  }
  return out;
}

/**
 * What Firma › Quellen offers a mailbox to keep aside, with everything the offer looks at: the whole
 * books, the senders every mailbox's ledger names, what waits in the inbox, the details kept in data/.
 */
export function asideOffersOf(ws: Pick<Workspace, 'paths'>, appRoot: string, source: string, reach: Pick<MailReach, 'from' | 'skip'>, settings: Record<string, unknown>, receipts: AsideInput['receipts'], words: DocumentsData): AsideOffer[] {
  const pending = new Set(existsSync(ws.paths.inbox) ? readdirSync(ws.paths.inbox) : []);
  const details = new Map([...readDetails(ws, source)].map(([k, d]) => [k, { ...(d.name ? { name: d.name } : {}), ...(d.vatId ? { vatId: d.vatId } : {}) }]));
  return asideOffers({ lines: readLedger(ws, source), receipts, reach, settings, words, details, senders: receiptSenders(ws, appRoot, receipts), pending });
}

export const sourceYamlOf =(ws: Pick<Workspace, 'paths'>, source: string): string => join(ws.paths.root, 'sources', source, 'source.yaml');


/**
 * Edits a source's source.yaml, comments and all, atomically: written to a temporary file and
 * renamed over it, and only if the file still holds what was read (or `expect`, the text a caller
 * read before): a change made meanwhile is never overwritten. `edit` returns false to write nothing.
 */
export function editSourceYaml(ws: Pick<Workspace, 'paths'>, source: string, edit: (doc: Document) => boolean, expect?: string): boolean {
  const file = sourceYamlOf(ws, source);
  const text = readFileSync(file, 'utf8');
  if (expect !== undefined && text !== expect) throw new SourceVersionChanged(`sources/${source}/source.yaml changed meanwhile`);
  const doc = parseDocument(text);
  if (!edit(doc)) return false;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, doc.toString());
  if (readFileSync(file, 'utf8') !== text) {
    rmSync(tmp, { force: true });
    throw new SourceVersionChanged(`sources/${source}/source.yaml changed meanwhile`);
  }
  renameSync(tmp, file);
  return true;
}

const indexOf = (list: YAMLSeq, from: string, name: string, on?: boolean) =>
  list.items.findIndex((i) => isMap(i) && String(i.get('from')).toLowerCase() === from && i.get('name') === name && (on === undefined || (i.get('off') !== true) === on));

/** Adds the group to settings.aside of the source's source.yaml, switched on: `source: hand <date>`. A group there already is switched on again. */
export function addAside(ws: Pick<Workspace, 'paths'>, source: string, group: { from: string; name: string }, now: Date = new Date(), expect?: string): void {
  const from = group.from.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(from)) throw new Error(`${group.from} is no mail address`);
  if (!group.name || group.name !== nameShape(group.name)) throw new Error(`${group.name} is no file-name shape`);
  editSourceYaml(ws, source, (doc) => {
    const list = doc.getIn(['settings', 'aside']);
    const entry = { from, name: group.name, source: `hand ${now.toISOString().slice(0, 10)}` };
    if (!(list instanceof YAMLSeq)) { doc.setIn(['settings', 'aside'], doc.createNode([entry])); return true; }
    const at = indexOf(list, from, group.name);
    if (at >= 0) doc.deleteIn(['settings', 'aside', at, 'off']);
    else list.add(doc.createNode(entry));
    return true;
  }, expect);
}

/** Switches a group off (`off: true`, kept so it is not offered again): a person said a file of it is a receipt. False when the source holds no such group switched on. */
export function switchAsideOff(ws: Pick<Workspace, 'paths'>, source: string, group: { from: string; name: string }, expect?: string): boolean {
  return editSourceYaml(ws, source, (doc) => {
    const list = doc.getIn(['settings', 'aside']);
    if (!(list instanceof YAMLSeq)) return false;
    const at = indexOf(list, group.from.toLowerCase(), group.name, true);
    if (at < 0) return false;
    doc.setIn(['settings', 'aside', at, 'off'], true);
    return true;
  }, expect);
}

/** Days apart two copies of one invoice may be dated (a re-download carries the day it was made). */
const DAYS = 7;
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

/** The labels of a document's own number: never a receipt's bare title word («Rechnung», «Invoice»), which also names the invoice a credit note refers to. */
const ownNumberWords = new WeakMap<DocumentsData, DocumentsData>();
function ownNumbers(words: DocumentsData): DocumentsData {
  let out = ownNumberWords.get(words);
  if (!out) {
    const titles = new Set(words.receipt.title.map((w) => w.toLowerCase()));
    out = { ...words, receipt: { ...words.receipt, number: words.receipt.number.filter((w) => !titles.has(w.toLowerCase())) } };
    ownNumberWords.set(words, out);
  }
  return out;
}

/** Words of a document that repeats another's number without being its copy: a credit note, a proforma, an instalment, a reminder. */
const notDuplicateRe = new WeakMap<DocumentsData, RegExp | undefined>();
function repeatsWithoutCopy(text: string, words: DocumentsData): boolean {
  if (!notDuplicateRe.has(words)) {
    const list = [...(words.notDuplicate ?? []), ...words.supporting.reminder];
    notDuplicateRe.set(words, list.length ? wordsRe(list) : undefined);
  }
  return !!notDuplicateRe.get(words)?.test(text);
}

/**
 * The receipt of the books a delivered file repeats with other bytes: the same sender (the line the
 * receipt came by names it), or failing that the same VAT number on both; a number both label as
 * their own (Rechnungsnummer …, never the bare title word); the same amount, sign and all; and both
 * dated, within a week. Undefined where the file shows no own number, no amount or no day, and for
 * a credit note, a proforma, an instalment or a reminder, which repeat a number without being a copy.
 */
export function contentTwin(
  text: string,
  from: string | undefined,
  receipts: ReadonlyArray<{ receipt: Pick<Receipt, 'id' | 'filename' | 'extractedText' | 'amount' | 'currency' | 'date' | 'vatId' | 'kind'>; from?: string }>,
  words: DocumentsData,
): Pick<Receipt, 'id' | 'filename'> | undefined {
  if (!text.trim() || repeatsWithoutCopy(text, words)) return undefined;
  const facts = textFacts(text, words);
  const own = ownNumbers(words);
  const numbers = labelledNumbers(text, own);
  if (facts.amount === undefined || !facts.date || !numbers.size) return undefined;
  const sender = from?.toLowerCase();
  for (const { receipt: r, from: theirs } of receipts) {
    if (NOT_IN_BOOKS.has(r.kind) || r.amount === undefined || !r.date || !near(r.amount, facts.amount)) continue;
    if (facts.currency && r.currency && facts.currency !== r.currency) continue;
    const sameSender = (!!sender && theirs?.toLowerCase() === sender) || (!!facts.vatId && facts.vatId === r.vatId);
    if (!sameSender) continue;
    if (repeatsWithoutCopy(r.extractedText ?? '', words)) continue;
    if (Math.abs(Date.parse(facts.date) - Date.parse(r.date)) > DAYS * 86_400_000) continue;
    const theirNumbers = labelledNumbers(r.extractedText ?? '', own);
    if (![...numbers].some((n) => theirNumbers.has(n))) continue;
    return { id: r.id, filename: r.filename };
  }
  return undefined;
}
