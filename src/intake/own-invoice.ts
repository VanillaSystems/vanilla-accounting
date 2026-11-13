/**
 * The firm's own invoice among the receipts, and the number it gives itself (#365): the only
 * receipt money in may pay by its number alone (src/intake/pairing.ts fitOf). Pure and browser-safe.
 */
import type { BankTransaction, Mapping, Receipt } from '../types/index.js';
import type { DocumentsData } from '../core/modules/schema.js';
import { documents } from '../engines/index.js';
import { HEAD, compoundLines } from '../core/modules/words.js';
import { documentKind, titleIn } from './document-kind.js';
import { labelledNumbers } from './duplicates.js';
import { normUid, uidsIn } from '../parsers/receipt-text.js';

/** The firm: its UID (company.uid), its name (company.name) and its owner (company.owner). */
export interface Firm { uid?: string; name?: string; owner?: string }

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether the firm issued the receipt, and how sure that is. `uid`: the firm has a UID, the receipt
 * shows it (the read VAT number, or in its text with or without the VAT word after it: a firm not registered for
 * VAT prints none) and no other UID, compared whole; a supplier's invoice that prints the customer's
 * UID beside its own is none. `name`: the firm has no UID in its settings (#452: the setup does not
 * ask it), its name is the name of the first line (the letterhead; the whole name before an address
 * after a comma, never the start of a longer name: «Beispiel GmbH Treuhand» is another firm), and
 * the text shows no UID or one only, in the letterhead under the name: the firm's own, which its VAT
 * invoice prints. That is no proof (a supplier's logo can be an image, so the addressee is the first
 * line), so its pairs are proposed, never linked by code. False: someone else's.
 */
export function issuedByFirm(r: Pick<Receipt, 'vatId' | 'extractedText'>, firm: Firm | undefined): 'uid' | 'name' | false {
  if (!firm) return false;
  const shown = uidsIn(r.extractedText ?? '');
  if (r.vatId) shown.add(normUid(r.vatId));
  if (firm.uid) return shown.size === 1 && shown.has(normUid(firm.uid)) ? 'uid' : false;
  const name = firm.name ? fold(firm.name) : '';
  const lines = (r.extractedText ?? '').split('\n').filter((l) => fold(l));
  if (!name || !lines.length || fold(lines[0].split(NAME_END)[0]) !== name) return false;
  if (!shown.size) return 'name';
  return shown.size === 1 && uidsIn(lines.slice(0, LETTERHEAD).join('\n')).has([...shown][0]) ? 'name' : false;
}

/** The lines of a letterhead: the name, its address, its UID. */
const LETTERHEAD = 5;
/** Where the name of a letterhead's first line ends: an address or a VAT number after it. */
const NAME_END = /\s*[,·|–—;\t]\s*|\s{2,}|\s+CHE[-\s]*\d/u;

/**
 * The UID on the firm's own invoice while its settings have none (#452): the one UID its letterhead
 * shows (issuedByFirm 'name'), as CHE-###.###.###, offered only once more than the letterhead says
 * the invoice is hers: `paidIn`, it is linked to money in (her customer's payment, paired by her or
 * proposed by its number and confirmed). A supplier's invoice that only looks like hers (her name as
 * the addressee on the first line, its UID near it) is linked to money out. The person decides
 * whether it is the firm's and keeps it through Firma's own checks; code never keeps it on its own.
 */
export function uidToKeep(r: Pick<Receipt, 'vatId' | 'extractedText'>, firm: Firm | undefined, paidIn: boolean): string | undefined {
  if (!paidIn || !firm || firm.uid || issuedByFirm(r, firm) !== 'name') return undefined;
  const [uid] = uidsIn(r.extractedText ?? '');
  const m = uid ? /^CHE(\d{3})(\d{3})(\d{3})$/.exec(uid) : null;
  return m ? `CHE-${m[1]}.${m[2]}.${m[3]}` : undefined;
}

/** A vendor's name to compare: lower case, letters and digits only (src/intake/receipt-sets.ts vendorOf keys by it). */
export const vendorKey = (name: string | undefined): string => name?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') ?? '';

/** Whether `names` (vendorKey) are two vendors or more: two names one of which holds the other («digitec», «digitecgalaxus») are one. */
export function twoVendors(names: Iterable<string>): boolean {
  const all = [...new Set(names)].filter(Boolean);
  return all.some((a, i) => all.slice(i + 1).some((b) => !a.includes(b) && !b.includes(a)));
}

const uidDigits = (uid: string) => uid.replace(/\D/g, '');

/**
 * The firm's silent UIDs, as digits: those that say nothing of who wrote a receipt, since they are
 * the buyer's (a supplier prints its customer's VAT number beside the address). The UID of the settings when there is one,
 * and only that. Without it (#466: the setup does not ask it) the ones the books show to be the
 * buyer's: a UID read on the receipts of two vendors or more (by the vendor of their title, else by
 * the counterparty of the payment they are linked to; twoVendors), and the one UID on the firm's
 * own invoices recognised by its name (issuedByFirm 'name'). Derived on every call, never kept in
 * the settings: the person keeps the UID offered from her own invoice (uidToKeep).
 */
export function buyerUids(firm: Firm | undefined, books: { receipts: readonly Receipt[]; mappings?: readonly Mapping[]; transactions?: readonly BankTransaction[] }): string[] {
  if (firm?.uid) return [uidDigits(firm.uid)].filter(Boolean);
  const counterparty = new Map((books.transactions ?? []).map((t) => [t.ref, vendorKey(t.counterparty)]));
  const paidTo = new Map<string, string>();
  for (const m of books.mappings ?? []) { const c = counterparty.get(m.transactionRef); if (c && !paidTo.has(m.receiptId)) paidTo.set(m.receiptId, c); }
  const vendors = new Map<string, Set<string>>();
  const own = new Set<string>();
  for (const r of books.receipts) {
    if (r.kind === 'duplicate') continue;
    const shown = uidsIn(r.extractedText ?? '');
    if (r.vatId) shown.add(normUid(r.vatId));
    if (!shown.size) continue;
    if (shown.size === 1 && issuedByFirm(r, firm) === 'name') own.add(uidDigits([...shown][0]));
    const vendor = vendorKey(r.title?.vendor) || paidTo.get(r.id);
    if (!vendor) continue;
    for (const u of shown) { const d = uidDigits(u); if (!d) continue; const set = vendors.get(d); if (set) set.add(vendor); else vendors.set(d, new Set([vendor])); }
  }
  return [...new Set([...own, ...[...vendors].filter(([, v]) => twoVendors(v)).map(([d]) => d)])].filter(Boolean).sort();
}

/**
 * The numbers an invoice gives itself: those an invoice word labels («Rechnung 2026-029»,
 * «Invoice # 4471», documents.yaml receipt.number; squashed as tokensIn squashes, four characters at
 * least), also the number of its compound title, the first one of its head («Akontorechnung
 * AK-26-Q3-30871», words.ts compoundLines), never a customer, order, account, phone number, a date
 * or a year alone («Rechnung 2026 Unterhalt»). None for a document whose text names it an offer, an
 * order confirmation, a delivery note or a reminder (documentKind), or whose first lines have no
 * invoice title.
 */
export function ownNumbers(r: Pick<Receipt, 'kind' | 'extractedText'>, words: DocumentsData = documents()): string[] {
  if (r.kind && r.kind !== 'invoice') return [];
  const text = r.extractedText ?? '';
  if (documentKind(text, words).is !== 'receipt' || titleIn(text.slice(0, HEAD), words) === Infinity) return [];
  // The number of its compound title: the first such line of its head, never one below that names another bill («Akontorechnung AK-1 bezahlt» on a final invoice).
  const compound = compoundLines(text.slice(0, HEAD), words.receipt.number, words.notCompound)[0]?.number;
  return [...new Set([...labelledNumbers(text, words), ...(compound ? [compound] : [])])].map((n) => n.replace(/\s/g, '')).filter((n) => !YEAR.test(n));
}

/** A year alone (four digits, 19xx or 20xx) is no invoice number by itself. */
const YEAR = /^(?:19|20)\d{2}$/;

/** A number's shape: digits as 9, letters as A («2026029» → «9999999»): two invoice numbers of one series share it. */
export const shapeOf = (n: string): string => n.replace(/\d/g, '9').replace(/[A-Z]/g, 'A');
