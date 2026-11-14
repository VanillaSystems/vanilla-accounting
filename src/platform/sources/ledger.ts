/**
 * The collected ledger (ADR 0014): `collected/<source>.jsonl` in the app's folder, in git,
 * append-only, committed with the run at rest. The only state of collection: a feed's cursor is
 * its last `cursor` line, the keys it delivered are its `got` lines. A crash between a delivery
 * and its checkpoint redelivers at most what came after the last checkpoint, and the keys tell it.
 * A `deleted` line says a file a delivery set aside was deleted after 30 days (src/intake/quarantine.ts):
 * its bytes are no longer held, so the same file sent again is delivered anew.
 *
 * What would show a mail's content in git stays out of it: the mail's subject, the attachment's own
 * name and the VAT number its text shows go into `data/collected/<source>.details.jsonl` (outside
 * git, keyed by the line's feed and key); the ledger keeps the name's shape, which is all a rule learns from.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Workspace } from '../../workspace/workspace.js';
import type { OtherWhy } from '../../core/modules/schema.js';

/**
 * A delivered document. `file`: its name in the inbox; `quarantined`: set aside instead, by its words
 * (`why` the kind), by a group the person keeps aside (`group`, the file-name shape) or as a
 * `duplicate` of the receipt `of`. What a later rule learns from is logged beside (absent on lines
 * written before): `shape` the attachment name's shape (src/platform/sources/aside.ts nameShape),
 * `date` the mail's day, `size` in bytes, `pages` and `text` (whether its first pages have a text
 * layer) for a PDF.
 */
export interface DeliveredDocument {
  kind: 'document';
  sha256: string;
  file?: string;
  duplicateOf?: string;
  from?: string;
  quarantined?: { file: string; why: OtherWhy | 'group' | 'duplicate'; group?: string; of?: string };
  shape?: string;
  date?: string;
  size?: number;
  pages?: number;
  text?: boolean;
}

export type LedgerLine =
  | { at: string; run: string; feed: string; key: string; got: DeliveredDocument }
  | { at: string; run: string; feed: string; key: string; got: { kind: 'record'; record: string; id: string; change: 'new' | 'updated' | 'same' | 'refused-closed' } }
  | { at: string; run: string; feed: string; cursor: unknown }
  | { at: string; run: string; feed: string; deleted: { sha256: string; file: string; after: number } };

export const ledgerPath = (ws: Pick<Workspace, 'paths'>, source: string): string => join(ws.paths.root, 'collected', `${source}.jsonl`);

export function readLedger(ws: Pick<Workspace, 'paths'>, source: string): LedgerLine[] {
  const p = ledgerPath(ws, source);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerLine) : [];
}

export function appendLedger(ws: Pick<Workspace, 'paths'>, source: string, line: LedgerLine): void {
  const p = ledgerPath(ws, source);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(line) + '\n');
}

/** A feed's position: its last cursor, the keys it delivered, and when it last delivered or checkpointed. */
export function feedState(lines: LedgerLine[], feed: string): { cursor: unknown; keys: Set<string>; last?: string } {
  const own = lines.filter((l) => l.feed === feed && !('deleted' in l));
  const cursorLine = [...own].reverse().find((l): l is Extract<LedgerLine, { cursor: unknown }> => 'cursor' in l);
  return { cursor: cursorLine?.cursor, keys: new Set(own.flatMap((l) => ('key' in l ? [l.key] : []))), ...(own.length ? { last: own.at(-1)!.at } : {}) };
}

/** What the app keeps of a delivered file outside git: the mail's subject, the attachment's own name, the VAT number its text shows. */
export interface DeliveryDetails { feed: string; key: string; name?: string; subject?: string; vatId?: string }

export const detailsPath = (ws: Pick<Workspace, 'paths'>, source: string): string => join(ws.paths.data, 'collected', `${source}.details.jsonl`);

export function appendDetails(ws: Pick<Workspace, 'paths'>, source: string, d: DeliveryDetails): void {
  const p = detailsPath(ws, source);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(d) + '\n');
}

/** A source's details by `<feed> <key>`; none where the app kept none (data/ is this computer's). */
export function readDetails(ws: Pick<Workspace, 'paths'>, source: string): Map<string, DeliveryDetails> {
  const p = detailsPath(ws, source);
  const out = new Map<string, DeliveryDetails>();
  if (!existsSync(p)) return out;
  for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    try { const d = JSON.parse(l) as DeliveryDetails; out.set(`${d.feed} ${d.key}`, d); } catch { /* a cut line */ }
  }
  return out;
}

/** The SHA-256 of every file a sweep deleted: no longer held, so no longer a duplicate. */
export const deletedShas = (lines: readonly LedgerLine[]): Set<string> => new Set(lines.flatMap((l) => ('deleted' in l ? [l.deleted.sha256] : [])));
