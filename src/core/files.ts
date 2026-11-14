/**
 * What a linked file is, by its name: its content type, and how the UI shows it (FileView in
 * src/app/areas/receipts/FileView.tsx). The API serves a receipt with this type and the audit export
 * keeps its extension, so the live app and the export show the same file the same way.
 */

/** How a file is shown: drawn as paper, as an image, a table, text, a mail's body, a page, or not at all (name, type, size and a download). */
export type FileView = 'pdf' | 'image' | 'table' | 'text' | 'mail' | 'html' | 'none';

export interface FileKind {
  /** The extension, lower case, without the dot; '' when the name has none a path may carry. */
  ext: string;
  type: string;
  view: FileView;
}

const KINDS: Record<string, readonly [type: string, view: FileView]> = {
  pdf: ['application/pdf', 'pdf'],
  png: ['image/png', 'image'],
  jpg: ['image/jpeg', 'image'],
  jpeg: ['image/jpeg', 'image'],
  gif: ['image/gif', 'image'],
  webp: ['image/webp', 'image'],
  avif: ['image/avif', 'image'],
  svg: ['image/svg+xml', 'image'],
  // Most browsers draw neither: downloaded.
  heic: ['image/heic', 'none'],
  heif: ['image/heif', 'none'],
  tif: ['image/tiff', 'none'],
  tiff: ['image/tiff', 'none'],
  csv: ['text/csv', 'table'],
  tsv: ['text/tab-separated-values', 'table'],
  txt: ['text/plain', 'text'],
  xml: ['application/xml', 'text'],
  json: ['application/json', 'text'],
  eml: ['message/rfc822', 'mail'],
  html: ['text/html', 'html'],
  htm: ['text/html', 'html'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'none'],
  xls: ['application/vnd.ms-excel', 'none'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'none'],
  zip: ['application/zip', 'none'],
};

export function fileKindOf(filename: string): FileKind {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  const ext = m ? m[1].toLowerCase() : '';
  const known = KINDS[ext];
  return known ? { ext, type: known[0], view: known[1] } : { ext, type: 'application/octet-stream', view: 'none' };
}

/**
 * The headers a linked file is served with: its own type, never sniffed. A file the UI does not draw itself
 * (a mail's HTML, an SVG) runs no script when opened on its own: sandboxed, without the app's origin.
 */
export function fileHeaders(filename: string): Record<string, string> {
  const kind = fileKindOf(filename);
  return { 'Content-Type': kind.type, 'X-Content-Type-Options': 'nosniff', ...(kind.view !== 'pdf' && { 'Content-Security-Policy': 'sandbox' }) };
}

/** A text file's characters: UTF-8 when it is that, else Windows-1252 (a bank's or a shop's CSV often is). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** The rows of a CSV file: its separator found on the header line (comma, semicolon or tab), quotes as RFC 4180 writes them. */
export function csvRows(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const nl = body.search(/\r?\n/);
  const head = nl < 0 ? body : body.slice(0, nl);
  const sep = [',', ';', '\t'].map((c) => ({ c, n: head.split(c).length })).sort((a, b) => b.n - a.n)[0].c;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}
