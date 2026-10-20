/**
 * The ways receipts come in (docs/0.4.0/mockups/receipt-inflow), as facts the strip above Belege
 * shows: the phone's access, the last «Belege holen» with each source's run, the sources and which
 * of them needs a person, and how many of the period's payments have their receipt. Pure: the
 * strip reads the automation view, the sources and the books, and draws what this says.
 */
import type { BankTransaction, Index } from '../../../types/index.js';
import type { PhoneInfo } from '../../../types/desktop.js';
import type { RunStatus, RunSummary } from '../../../workflows/model.js';
import type { Cadence, SourcesView } from '../../../platform/sources/model.js';
import type { Period } from '../../../accounting/periods.js';
import { needsReceipt } from '../journal/model.js';

/** The workflow behind «Belege holen» (workflows/collection) and the one it starts per source (workflows/collect). */
export const COLLECTION = 'collection';
export const COLLECT = 'collect';

/**
 * The phone's way in. `browser`: no Mac app (npm start, the scan page under the server's own
 * address); `never`: the access was never switched on; `off`: switched on once, now off, so a
 * paired phone reaches nothing; `on`: it takes receipts.
 */
export type PhoneWay = 'loading' | 'browser' | 'never' | 'off' | 'on';

export function phoneWayOf(info: PhoneInfo | undefined, inDesktop: boolean): PhoneWay {
  if (!inDesktop) return 'browser';
  if (!info) return 'loading';
  return info.on ? 'on' : info.port ? 'off' : 'never';
}

/** The last «Belege holen»: never, under way, or at rest with how many of its sources failed. */
export type CollectRun =
  | { kind: 'never' }
  | { kind: 'running'; run: string }
  | { kind: 'done'; run: string; at: string; failed: number; of: number };

const OPEN: ReadonlySet<RunStatus> = new Set(['queued', 'running']);
/** A run that stopped before its end: it waits for a person (a login, a password) or is stuck. */
const FAILED: ReadonlySet<RunStatus> = new Set(['waiting', 'parked', 'stuck']);

const childrenOf = (runs: readonly RunSummary[], id: string) =>
  runs.filter((r) => r.workflow === COLLECT && r.startedBy.kind === 'parent' && r.startedBy.run === id);

/** A collection that ended finding no source due fetched nothing: it is no run for the person (the engine keeps no scheduled one, src/workflows/engine.ts idle). */
const fetchedNothing = (runs: readonly RunSummary[], r: RunSummary) => r.status === 'done' && !childrenOf(runs, r.id).length;

export function collectRunOf(runs: readonly RunSummary[]): CollectRun {
  const last = runs.filter((r) => r.workflow === COLLECTION && r.status !== 'discarded' && !fetchedNothing(runs, r)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!last) return { kind: 'never' };
  const children = childrenOf(runs, last.id);
  if (OPEN.has(last.status) || children.some((c) => OPEN.has(c.status))) return { kind: 'running', run: last.id };
  const at = [last.finishedAt ?? last.startedAt, ...children.map((c) => c.finishedAt ?? c.startedAt)].sort().at(-1)!;
  if (!children.length) return { kind: 'done', run: last.id, at, failed: FAILED.has(last.status) ? 1 : 0, of: 1 };
  return { kind: 'done', run: last.id, at, failed: children.filter((c) => FAILED.has(c.status)).length, of: children.length };
}

/**
 * A source as a chip: `ok`, or `warn` with why a person is needed: its password is not set
 * (`login`), its last run stopped (`failed`), its version is not switched on (`pending`), or its
 * folder has errors (`invalid`). `run` is its last run, to open, and `last` when it ended;
 * `every`: how often its feeds fetch (a mailbox: daily), each once.
 */
export interface SourceChip { id: string; label: string; every: Cadence[]; warn?: 'login' | 'failed' | 'pending' | 'invalid'; run?: string; last?: string }

export function sourceChips(view: SourcesView, runs: readonly RunSummary[], lang: string): SourceChip[] {
  return view.rows.map(({ verdict, secrets }) => {
    const id = verdict.kind === 'invalid' ? verdict.id : verdict.decl.id;
    const label = verdict.kind === 'invalid' ? id : verdict.decl.label[lang] ?? verdict.decl.label.en ?? id;
    const last = runs.filter((r) => r.workflow === COLLECT && r.item.kind === 'source' && r.item.id === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const warn = verdict.kind === 'invalid' ? 'invalid' as const
      : verdict.kind === 'pending' ? 'pending' as const
        : secrets.some((s) => !s.present) ? 'login' as const
          : last && FAILED.has(last.status) ? 'failed' as const
            : undefined;
    const every = verdict.kind === 'invalid' ? [] : [...new Set(verdict.decl.feeds.map((f) => f.every))];
    return { id, label, every, ...(warn ? { warn } : {}), ...(last ? { run: last.id, ...(last.finishedAt ? { last: last.finishedAt } : {}) } : {}) };
  });
}

/** The period's payments that need a receipt (not a fee, not 0, not marked as needing none), and how many have one linked. */
export function coverageOf(books: Pick<Index, 'transactions' | 'mappings'>, period: Pick<Period, 'from' | 'to'>): { covered: number; total: number } {
  const linked = new Set(books.mappings.map((m) => m.transactionRef));
  const inPeriod = (t: BankTransaction) => t.date >= period.from && t.date <= period.to;
  const needing = books.transactions.filter((t) => inPeriod(t) && needsReceipt(t, 0));
  return { covered: needing.filter((t) => linked.has(t.ref)).length, total: needing.length };
}

/** Where the person reads the mail of the address they name in «Weg hinzufügen». */
export const MAIL_CLIENTS = ['apple', 'outlook', 'browser', 'phone'] as const;
export type MailClient = typeof MAIL_CLIENTS[number];

/**
 * A way to have a mailbox's receipts collected: the app reads the mailbox (IMAP, Firma › Quellen),
 * a filter forwards the receipts to an address of their own that the app reads, or the mail program
 * on this Mac is read (`client`, not built yet: shown as «später», never proposed first).
 */
export type MailWay = 'imap' | 'forward' | 'client';

/**
 * The ways for a mailbox, the proposal first: the business mailbox is read whole. Reading the mail
 * program on this Mac comes after them while it does not exist.
 */
export function mailWays(client: MailClient): MailWay[] {
  const local = client === 'apple' || client === 'outlook';
  return ['imap', 'forward', ...(local ? ['client'] as const : [])];
}
