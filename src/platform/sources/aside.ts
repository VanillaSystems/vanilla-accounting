/**
 * What a mailbox sets aside besides the words of a file (src/intake/recognize.ts), learned from what
 * it delivered and what became of it, never by a model:
 *
 * - «Immer beiseite» per sender × file-name shape: a sender's files of one shape («report.pdf»,
 *   «<Nummer>.pdf», «IMG_<Nummer>.pdf») of which two or more were set aside (by their words, or a
 *   person's «kein Beleg») and none stands in the books are offered as one group, one click
 *   (Firma › Quellen). Kept, the group stands in the source's `settings.aside` and its next files go
 *   to quarantine at delivery. A sender is an address and its shapes are told apart, so a supplier
 *   that sends brochures and invoices from one address keeps its invoices: measured on a real
 *   mailbox, this lost no receipt where a rule per sender did.
 * - A duplicate by content: a file whose sender, invoice number and amount (and date, where both
 *   show one) are those of a receipt in the books, with other bytes, is set aside as that
 *   receipt's duplicate. Where a fact is missing, nothing is decided.
 *
 * What is set aside never enters the books: it waits under «Aussortiert» with its reason, and is
 * deleted after 30 days unless a person keeps it (src/intake/quarantine.ts). «Ist ein Beleg» on a
 * file of a group switches the group off.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, YAMLSeq, isMap } from 'yaml';
import type { Receipt } from '../../types/index.js';
import type { DocumentsData } from '../../core/modules/schema.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { LedgerLine } from './ledger.js';
import type { AsideOffer, MailReach } from './model.js';
import { senderAllowed } from './reach.js';
import { textFacts } from '../../parsers/receipt-text.js';
import { labelledNumbers } from '../../intake/duplicates.js';

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

type DocumentLine = Extract<LedgerLine, { got: { kind: 'document' } }>;
const isDelivered = (l: LedgerLine): l is DocumentLine => 'got' in l && l.got.kind === 'document' && !l.got.duplicateOf && l.got.quarantined?.why !== 'duplicate';

/** The attachment's own name: logged since the ledger kept it, else the name it got in the inbox or the quarantine (a copy's mark falls away in its shape). */
export const nameOf = (l: DocumentLine): string => l.got.name ?? l.got.quarantined?.file ?? l.got.file ?? '';

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

/** The group switched on that a delivered file of `from` named `name` falls in, or undefined. */
export function asideGroupOf(settings: Record<string, unknown>, from: string | undefined, name: string): AsideGroup | undefined {
  if (!from) return undefined;
  const sender = from.toLowerCase(), shape = nameShape(name);
  return asideGroups(settings).find((g) => !g.off && g.from === sender && g.name === shape);
}

/**
 * The groups a mailbox could keep aside (sender × file-name shape): two or more of their files set
 * aside (by their words, or by a person's «kein Beleg»), none of them standing in the books, the
 * sender still read, the group not in the settings yet (switched off counts: a person said no).
 */
export function asideOffers(
  lines: readonly LedgerLine[],
  receipts: readonly Pick<Receipt, 'id' | 'originalFilename' | 'kind' | 'kindBy'>[],
  reach: Pick<MailReach, 'from' | 'skip'>,
  settings: Record<string, unknown>,
): AsideOffer[] {
  const docs = lines.filter(isDelivered).filter((l) => !!l.got.from);
  const state = new Map<DocumentLine, 'aside' | 'books'>();
  for (const l of docs) if (l.got.quarantined) state.set(l, 'aside');
  for (const r of receipts) {
    const l = lineOfReceipt(docs, r);
    if (!l) continue;
    if (r.kind === 'noise' && r.kindBy === 'human') state.set(l, 'aside');
    else if (!NOT_IN_BOOKS.has(r.kind)) state.set(l, 'books');
  }
  const kept = new Set(asideGroups(settings).map((g) => `${g.from} ${g.name}`));
  const groups = new Map<string, { sender: string; shape: string; lines: DocumentLine[] }>();
  for (const l of docs) {
    const sender = l.got.from!.toLowerCase(), shape = nameShape(nameOf(l));
    const key = `${sender} ${shape}`;
    if (kept.has(key) || !senderAllowed(reach, sender)) continue;
    const g = groups.get(key) ?? { sender, shape, lines: [] };
    g.lines.push(l);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.lines.filter((l) => state.get(l) === 'aside').length >= ASIDE_AT_LEAST && !g.lines.some((l) => state.get(l) === 'books'))
    .map((g) => ({
      sender: g.sender,
      shape: g.shape,
      files: g.lines.map((l) => ({ name: nameOf(l), date: (l.got.date ?? l.at).slice(0, 10), aside: state.get(l) === 'aside' })),
      inBooks: 0 as const,
    }))
    .sort((a, b) => b.files.length - a.files.length || a.sender.localeCompare(b.sender) || a.shape.localeCompare(b.shape));
}

const sourceFile = (ws: Pick<Workspace, 'paths'>, source: string) => join(ws.paths.root, 'sources', source, 'source.yaml');

/** Adds the group to settings.aside of the source's source.yaml (comments and all), switched on: `source: hand <date>`. A group there already is switched on again. */
export function addAside(ws: Pick<Workspace, 'paths'>, source: string, group: { from: string; name: string }, now: Date = new Date()): void {
  const from = group.from.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(from)) throw new Error(`${group.from} is no mail address`);
  if (!group.name || group.name !== nameShape(group.name)) throw new Error(`${group.name} is no file-name shape`);
  const file = sourceFile(ws, source);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const list = doc.getIn(['settings', 'aside']);
  const items = list instanceof YAMLSeq ? list.items : [];
  const at = items.findIndex((i) => isMap(i) && String(i.get('from')).toLowerCase() === from && i.get('name') === group.name);
  if (at >= 0) {
    doc.deleteIn(['settings', 'aside', at, 'off']);
  } else {
    const entry = doc.createNode({ from, name: group.name, source: `hand ${now.toISOString().slice(0, 10)}` });
    if (list instanceof YAMLSeq) list.add(entry);
    else doc.setIn(['settings', 'aside'], doc.createNode([{ from, name: group.name, source: `hand ${now.toISOString().slice(0, 10)}` }]));
  }
  writeFileSync(file, doc.toString());
}

/** Switches a group off (`off: true`, kept so it is not offered again): a person said a file of it is a receipt. False when the source holds no such group switched on. */
export function switchAsideOff(ws: Pick<Workspace, 'paths'>, source: string, group: { from: string; name: string }): boolean {
  const file = sourceFile(ws, source);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const list = doc.getIn(['settings', 'aside']);
  if (!(list instanceof YAMLSeq)) return false;
  const from = group.from.toLowerCase();
  const at = list.items.findIndex((i) => isMap(i) && String(i.get('from')).toLowerCase() === from && i.get('name') === group.name && i.get('off') !== true);
  if (at < 0) return false;
  doc.setIn(['settings', 'aside', at, 'off'], true);
  writeFileSync(file, doc.toString());
  return true;
}

/** Days apart two copies of one invoice may be dated (a re-download carries the day it was made). */
const DAYS = 7;
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

/**
 * The receipt of the books a delivered file repeats with other bytes: the same sender (the line the
 * receipt came by names it), or failing that the same VAT number on both; a number both label as
 * their own (Rechnungsnummer …); the same amount; and the same day give or take a week where both
 * show one. Undefined where the file's text shows no labelled number or no amount: nothing is decided.
 */
export function contentTwin(
  text: string,
  from: string | undefined,
  receipts: ReadonlyArray<{ receipt: Pick<Receipt, 'id' | 'filename' | 'extractedText' | 'amount' | 'currency' | 'date' | 'vatId' | 'kind'>; from?: string }>,
  words: DocumentsData,
): Pick<Receipt, 'id' | 'filename'> | undefined {
  if (!text.trim()) return undefined;
  const facts = textFacts(text, words);
  const numbers = labelledNumbers(text, words);
  if (facts.amount === undefined || !numbers.size) return undefined;
  const sender = from?.toLowerCase();
  for (const { receipt: r, from: theirs } of receipts) {
    if (NOT_IN_BOOKS.has(r.kind) || r.amount === undefined || !near(r.amount, facts.amount)) continue;
    if (facts.currency && r.currency && facts.currency !== r.currency) continue;
    const sameSender = (!!sender && theirs?.toLowerCase() === sender) || (!!facts.vatId && facts.vatId === r.vatId);
    if (!sameSender) continue;
    const theirNumbers = labelledNumbers(r.extractedText ?? '', words);
    if (![...numbers].some((n) => theirNumbers.has(n))) continue;
    if (facts.date && r.date && Math.abs(Date.parse(facts.date) - Date.parse(r.date)) > DAYS * 86_400_000) continue;
    return { id: r.id, filename: r.filename };
  }
  return undefined;
}
