/**
 * Recognizing a dropped file cheaply, before anything enters the books (docs/0.4.0/intake.md,
 * ADR 0008 §2): by its structure first (the bytes of a PDF, an image or a ZIP, the namespace of a
 * bank statement, the columns of a payment provider's report), then by hints (words of the first pages, the name; what the words say a document
 * is, src/intake/document-kind.ts). No model: what stays unclear is asked in the row, and the
 * workflow reads it properly later.
 */
import type { DropRow } from '../types/drop.js';
import type { DocumentsData, OtherWhy } from '../core/modules/schema.js';
import { STATEMENT_FILES } from '../providers/statement-files.js';
import { documents } from '../engines/index.js';
import { documentKind } from './document-kind.js';
import { isBankStatement } from '../core/modules/words.js';
import { pdfRuns, textOf } from '../parsers/pdf-text.js';
import { csvTable } from '../providers/statement-read/csv.js';

/** What the file is, and a PDF's text of its first pages (for the duplicate check; never stored in the row). */
type Recognized = Pick<DropRow, 'kind' | 'how' | 'facts' | 'state' | 'reason' | 'document' | 'provider'> & { text?: string };

/** Whose sales or fee report a CSV is, by the columns the providers' business files name (src/intake/sales-report-import.ts recognizeCsv). */
export type ReportOf = (bytes: Buffer) => { provider: string; name: string; kind: 'sales' | 'fees' } | undefined;

const starts = (b: Buffer, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);
const head = (b: Buffer, n = 4096) => b.subarray(0, n).toString('latin1');

/**
 * The text of a PDF's first two pages, read in Node (src/parsers/pdf-text.ts) as the run reads it:
 * the packed app has no poppler, so a program outside Node would leave every drop unjudged
 * (r5h-28). '' for a PDF without text (a scan); undefined for one pdf.js cannot open (r8k-9).
 */
export async function firstPages(bytes: Buffer): Promise<string | undefined> {
  try {
    return textOf(await pdfRuns(bytes, 2), 'reading');
  } catch {
    return undefined;
  }
}

const IBAN = /\b(CH|LI|DE|AT|GB|BE|NL|FR|IT)\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/;

export async function recognize(bytes: Buffer, name: string, words?: DocumentsData, reportOf?: ReportOf): Promise<Recognized> {
  const lower = name.toLowerCase();
  if (starts(bytes, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || starts(bytes, 0x52, 0x61, 0x72, 0x21) || /\.(7z|rar)$/.test(lower)) {
    return { state: 'refused', reason: 'as-zip' };
  }
  if (/\.(docx?|xlsx?|pptx?|pages|numbers|key|odt|ods)$/.test(lower)) return { state: 'refused', reason: 'office' };
  if (starts(bytes, 0x50, 0x4b, 0x03, 0x04)) return { kind: 'zip', how: 'structure', state: 'take' };
  if (starts(bytes, 0x25, 0x50, 0x44, 0x46)) {
    if (/\/Encrypt\b/.test(bytes.subarray(Math.max(0, bytes.length - 65_536)).toString('latin1'))) {
      return { kind: 'receipt', how: 'structure', state: 'take', reason: 'pdf-password' };
    }
    const text = await firstPages(bytes);
    // A PDF header on bytes no reader opens (cut short, damaged): no step would ever read it, so it waits in quarantine, not in the inbox.
    if (text === undefined) return { kind: 'receipt', how: 'structure', state: 'quarantine', reason: 'unreadable' };
    const iban = IBAN.exec(text)?.[0];
    if (isBankStatement(text, words ?? documents())) {
      return { kind: 'statement-pdf', how: 'hint', state: 'take', ...(iban ? { facts: { iban: iban.replace(/\s/g, '') } } : {}) };
    }
    const doc = text.trim() ? documentKind(text, words ?? documents()) : undefined;
    if (doc?.is === 'other') return { kind: 'receipt', how: 'hint', state: 'quarantine', reason: 'not-receipt', document: doc.why, text };
    return { kind: 'receipt', how: 'structure', state: 'take', ...(doc?.is === 'supporting' ? { document: doc.why } : {}), ...(text.trim() ? { text } : {}) };
  }
  if (starts(bytes, 0x89, 0x50, 0x4e, 0x47) || starts(bytes, 0xff, 0xd8, 0xff) || /ftypheic|ftypheix|ftypmif1/.test(head(bytes, 32)) || /\.(heic|jpe?g|png)$/.test(lower)) {
    return { kind: 'photo', how: 'structure', state: 'take' };
  }
  const statement = STATEMENT_FILES.map((r) => r(bytes)).find(Boolean);
  if (statement) return { kind: 'camt', how: 'structure', state: 'take', facts: statement.facts };
  if (/^\s*(<\?xml|<Document)/.test(head(bytes))) return { state: 'refused', reason: 'not-statement' };
  // A payment provider's sales or fee report, by its columns (#203): booked onto the provider's clearing account.
  const report = reportOf?.(bytes);
  if (report) return { kind: 'sales-report', how: 'structure', state: 'take', provider: { id: report.provider, name: report.name, kind: report.kind } };
  if (/\.csv$/.test(lower) || /^[^\n]*(buchung|valuta|booking|date)[^\n]*[;,\t][^\n]*(saldo|betrag|belastung|gutschrift|amount|balance)/i.test(head(bytes, 1024))) {
    // A bank's CSV export: read by its columns into a statement (#217); one that reads as no table is refused.
    return csvTable(bytes) ? { kind: 'statement-csv', how: 'structure', state: 'take' } : { state: 'refused', reason: 'bank-csv' };
  }
  return { state: 'refused', reason: 'as-pdf' };
}

/**
 * What a collected attachment's words say it is, when it is clearly no receipt (a newsletter, terms,
 * a price list): a mailbox source puts it into quarantine instead of the inbox. A PDF without text
 * (a scan) is left to the run's reading.
 */
export async function notReceipt(bytes: Buffer, words?: DocumentsData): Promise<OtherWhy | undefined> {
  if (!starts(bytes, 0x25, 0x50, 0x44, 0x46)) return undefined;
  const text = await firstPages(bytes);
  if (!text?.trim()) return undefined;
  const v = documentKind(text, words ?? documents());
  return v.is === 'other' ? v.why : undefined;
}
