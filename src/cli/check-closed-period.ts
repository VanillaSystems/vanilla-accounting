/**
 * Verifies that nothing inside the closed accounting period (config.closedThrough)
 * has changed relative to a committed baseline — the proof that a new quarter's work
 * left the filed figures untouched.
 *
 * Compares the workspace's working-tree `books.json` against the same file at a
 * git ref (default HEAD), restricted to records dated on or before closedThrough:
 * journal entries (the filed VAT figures), bank transactions, and the mappings that
 * hang off closed transactions. Also catches closedThrough itself being moved back.
 *
 * Usage: npm run check-closed [-- <git-ref>]
 * Exit code 2 on any violation, so it can gate a commit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();
const ref = process.argv[2] ?? 'HEAD';

type Index = {
  journalEntries?: any[];
  transactions?: any[];
  mappings?: any[];
  config?: { closedThrough?: string };
};

/** A ref of the legacy layout (before the app and workspace split) holds the books at public/receipts-index.json. */
function loadBaseline(gitRef: string): Index {
  const show = (path: string) => execFileSync('git', ['show', `${gitRef}:${path}`], {
    cwd: ws.paths.root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    return JSON.parse(show('./books.json'));
  } catch {
    return JSON.parse(show('./public/receipts-index.json'));
  }
}

const current: Index = JSON.parse(readFileSync(ws.paths.books, 'utf8'));
const baseline = loadBaseline(ref);

const closedThrough = baseline.config?.closedThrough;
if (!closedThrough) {
  console.error(`No config.closedThrough in baseline (${ref}) — nothing to protect.`);
  process.exit(1);
}
const isClosed = (date?: string) => !!date && date <= closedThrough;

// Stable key-sorted serialization so field reordering isn't reported as a change.
const norm = (o: any) =>
  JSON.stringify(o, Object.keys(o).sort());

type Violation = { kind: string; key: string; detail: string };
const violations: Violation[] = [];

function compare(
  label: string,
  keyOf: (r: any) => string,
  closedOf: (r: any, side: Index) => boolean,
  baseRows: any[],
  currRows: any[],
) {
  const base = new Map<string, any>();
  for (const r of baseRows) if (closedOf(r, baseline)) base.set(keyOf(r), r);
  const curr = new Map<string, any>();
  for (const r of currRows) if (closedOf(r, current)) curr.set(keyOf(r), r);

  for (const [k, b] of base) {
    const c = curr.get(k);
    if (!c) {
      violations.push({ kind: `${label} DELETED`, key: k, detail: norm(b) });
    } else if (norm(b) !== norm(c)) {
      const changed = Object.keys({ ...b, ...c }).filter(
        (f) => JSON.stringify(b[f]) !== JSON.stringify(c[f]),
      );
      violations.push({
        kind: `${label} MODIFIED`,
        key: k,
        detail: changed
          .map((f) => `${f}: ${JSON.stringify(b[f])} -> ${JSON.stringify(c[f])}`)
          .join(', '),
      });
    }
  }
  for (const [k, c] of curr) {
    if (!base.has(k)) violations.push({ kind: `${label} ADDED`, key: k, detail: norm(c) });
  }
  return { base: base.size, curr: curr.size };
}

// closedThrough must not move backwards (that would silently re-open filed periods).
const currClosed = current.config?.closedThrough;
if (!currClosed || currClosed < closedThrough) {
  violations.push({
    kind: 'config.closedThrough MOVED BACK',
    key: 'config.closedThrough',
    detail: `${closedThrough} -> ${currClosed ?? '(missing)'}`,
  });
}

const je = compare(
  'journalEntry',
  (e) => e.id,
  (e) => isClosed(e.date),
  baseline.journalEntries ?? [],
  current.journalEntries ?? [],
);
const tx = compare(
  'transaction',
  (t) => t.ref,
  (t) => isClosed(t.date),
  baseline.transactions ?? [],
  current.transactions ?? [],
);

// A mapping has no date of its own — it is "closed" when the transaction it points at is.
const closedRefs = (idx: Index) =>
  new Set((idx.transactions ?? []).filter((t) => isClosed(t.date)).map((t) => t.ref));
const baseClosedRefs = closedRefs(baseline);
const currClosedRefs = closedRefs(current);
const mp = compare(
  'mapping',
  (m) => `${m.receiptId}|${m.transactionRef}`,
  (m, side) => (side === baseline ? baseClosedRefs : currClosedRefs).has(m.transactionRef),
  baseline.mappings ?? [],
  current.mappings ?? [],
);

console.log(`Closed period: on or before ${closedThrough}  (baseline: ${ref})`);
console.log(`  journal entries : ${je.base} baseline / ${je.curr} current`);
console.log(`  transactions    : ${tx.base} baseline / ${tx.curr} current`);
console.log(`  mappings        : ${mp.base} baseline / ${mp.curr} current`);
console.log('');

if (violations.length === 0) {
  console.log('✓ Closed period intact — no closed-period record added, modified or deleted.');
  process.exit(0);
}

console.error(`✗ ${violations.length} closed-period violation(s):`);
for (const v of violations) console.error(`  ${v.kind}  ${v.key}\n      ${v.detail}`);
console.error(
  '\nCorrections to a closed period must be booked as NEW entries dated in the open period.',
);
process.exit(2);
