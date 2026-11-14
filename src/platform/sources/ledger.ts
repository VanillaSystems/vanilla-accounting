/**
 * The collected ledger (ADR 0014): `collected/<source>.jsonl` in the app's folder, in git,
 * append-only, committed with the run at rest. The only state of collection: a feed's cursor is
 * its last `cursor` line, the keys it delivered are its `got` lines. A crash between a delivery
 * and its checkpoint redelivers at most what came after the last checkpoint, and the keys tell it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Workspace } from '../../workspace/workspace.js';
import type { OtherWhy } from '../../core/modules/schema.js';

/**
 * A delivered document. `file`: its name in the inbox; `quarantined`: set aside instead, by its words
 * (`why` the kind), by a group the person keeps aside (`group`, the file-name shape) or as a
 * `duplicate` of the receipt `of`. What a later rule learns from is logged beside (absent on lines
 * written before): `name` the attachment's own name, `subject` the mail's, `date` the mail's day,
 * `size` in bytes, `pages` and `text` (whether its first pages have a text layer) for a PDF.
 */
export interface DeliveredDocument {
  kind: 'document';
  sha256: string;
  file?: string;
  duplicateOf?: string;
  from?: string;
  quarantined?: { file: string; why: OtherWhy | 'group' | 'duplicate'; group?: string; of?: string };
  name?: string;
  subject?: string;
  date?: string;
  size?: number;
  pages?: number;
  text?: boolean;
}

export type LedgerLine =
  | { at: string; run: string; feed: string; key: string; got: DeliveredDocument }
  | { at: string; run: string; feed: string; key: string; got: { kind: 'record'; record: string; id: string; change: 'new' | 'updated' | 'same' | 'refused-closed' } }
  | { at: string; run: string; feed: string; cursor: unknown };

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
  const own = lines.filter((l) => l.feed === feed);
  const cursorLine = [...own].reverse().find((l): l is Extract<LedgerLine, { cursor: unknown }> => 'cursor' in l);
  return { cursor: cursorLine?.cursor, keys: new Set(own.flatMap((l) => ('key' in l ? [l.key] : []))), ...(own.length ? { last: own.at(-1)!.at } : {}) };
}
