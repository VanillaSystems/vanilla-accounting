/**
 * The repayments of the owner's outlays the model judged and did not book onto her account (#402
 * review): asked once, as a waiting payment is (`waitsForReceipt.decided`), then left to the person
 * with the hand form's proposal and a reason of its own. Kept beside the books in the workspace's
 * data/ (no books format changes): a mark lost only means the model is asked once more.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../invoices/store.js';
import type { Workspace } from '../workspace/workspace.js';

export const JUDGED_FILE = 'repayments-judged.json';

type Ws = Pick<Workspace, 'paths'>;
const fileOf = (ws: Ws) => join(ws.paths.data, JUDGED_FILE);

/** The payments judged so, by ref, with when. */
export function judgedRepayments(ws: Ws): Record<string, string> {
  const file = fileOf(ws);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
  } catch { return {}; }
}

/** Adds `refs` as judged now; `open`: the payments still unbooked, the others' marks go. */
export function markJudged(ws: Ws, refs: readonly string[], open: ReadonlySet<string>, now: string): void {
  const before = judgedRepayments(ws);
  const kept = Object.fromEntries(Object.entries(before).filter(([ref]) => open.has(ref)));
  for (const ref of refs) kept[ref] ??= now;
  if (JSON.stringify(kept) === JSON.stringify(before)) return;
  mkdirSync(ws.paths.data, { recursive: true });
  writeAtomic(fileOf(ws), JSON.stringify(kept, null, 2) + '\n');
}
