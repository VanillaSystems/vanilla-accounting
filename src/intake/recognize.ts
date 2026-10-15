/**
 * Recognizing a dropped file cheaply, before anything enters the books (docs/0.4.0/intake.md,
 * ADR 0008 §2): by its structure first (the bytes of a PDF, an image or a ZIP, the namespace of a
 * bank statement), then by hints (words of the first pages, the name; what the words say a document
 * is, src/intake/document-kind.ts). No model: what stays unclear is asked in the row, and the
 * workflow reads it properly later.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DropRow } from '../types/drop.js';
import type { DocumentsData, OtherWhy } from '../core/modules/schema.js';
import { STATEMENT_FILES } from '../providers/statement-files.js';
import { documents } from '../engines/index.js';
import { documentKind } from './document-kind.js';

/** What the file is, and a PDF's text of its first pages (for the duplicate check; never stored in the row). */
type Recognized = Pick<DropRow, 'kind' | 'how' | 'facts' | 'state' | 'reason' | 'document'> & { text?: string };

const starts = (b: Buffer, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);
const head = (b: Buffer, n = 4096) => b.subarray(0, n).toString('latin1');

/** The text of a PDF's first two pages, or '' without pdftotext. */
export function firstPages(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'drop-'));
  try {
    const file = join(dir, 'f.pdf');
    writeFileSync(file, bytes);
    const r = spawnSync('pdftotext', ['-l', '2', '-q', file, '-'], { encoding: 'utf8', timeout: 10_000 });
    return r.status === 0 ? r.stdout : '';
  } catch {
    return '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const IBAN = /\b(CH|LI|DE|AT|GB|BE|NL|FR|IT)\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/;

export function recognize(bytes: Buffer, name: string, words?: DocumentsData): Recognized {
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
    const text = firstPages(bytes);
    const iban = IBAN.exec(text)?.[0];
    if (/kontoauszug|account statement|relevé de compte|estratto conto/i.test(text) && iban) {
      return { kind: 'statement-pdf', how: 'hint', state: 'take', facts: { iban: iban.replace(/\s/g, '') } };
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
  if (/\.csv$/.test(lower) || /^[^\n]*(buchung|valuta|booking|date)[^\n]*[;,\t][^\n]*(saldo|betrag|belastung|gutschrift|amount|balance)/i.test(head(bytes, 1024))) {
    return { state: 'refused', reason: 'bank-csv' };
  }
  return { state: 'refused', reason: 'as-pdf' };
}

/**
 * What a collected attachment's words say it is, when it is clearly no receipt (a newsletter, terms,
 * a price list): a mailbox source puts it into quarantine instead of the inbox. A PDF without text
 * (a scan) is left to the run's reading.
 */
export function notReceipt(bytes: Buffer, words?: DocumentsData): OtherWhy | undefined {
  if (!starts(bytes, 0x25, 0x50, 0x44, 0x46)) return undefined;
  const text = firstPages(bytes);
  if (!text.trim()) return undefined;
  const v = documentKind(text, words ?? documents());
  return v.is === 'other' ? v.why : undefined;
}
