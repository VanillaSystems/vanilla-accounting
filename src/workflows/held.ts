/**
 * The payments the company's rules hold (workflows/ask): which rule asked, and closing the
 * questions whose reason is gone (wishes3-7). A question stays open only while a rule still holds
 * its payment: when the person removes or switches off an ask rule, or links the payout report a
 * payout rule waited for (r5h-12), its question closes and the next inbox run books the payment.
 */
import { loadFxResolver } from '../accounting/fx-rates.js';
import { hasBooks, loadBooks } from '../books/store.js';
import { classifyTransactions, loadClassifyContext } from '../booking/classify.js';
import type { Workspace } from '../workspace/workspace.js';
import type { Engine } from './engine.js';
import { UNSTATED_SPLIT } from '../booking/unstated-split.js';
import type { Run } from './model.js';

export const ASK_WORKFLOW = 'ask';

/** The rule that held this run's payment, as its first step recorded it. */
export const askedBy = (r: Run): string | undefined => {
  const rule = r.steps.find((s) => s.step === 'propose')?.output?.rule;
  return typeof rule === 'string' ? rule : undefined;
};

/** The live questions of the ask rules: every one (waiting, answered or done), not those discarded. */
export const askRuns = (engine: Pick<Engine, 'runs'>): Run[] =>
  engine.runs().filter((r) => r.workflow === ASK_WORKFLOW && r.mode === 'live' && r.state.status !== 'discarded');

export const CLOSED_REASON = 'Keine Regel hält diese Zahlung mehr zurück (die Regel ist weg, oder der Bericht ist da): der nächste Lauf bucht sie.';

/** Closes each waiting question whose payment no rule holds any more. Returns the runs it closed. */
export async function closeAsksWithoutRule(engine: Pick<Engine, 'runs' | 'command'>, ws: Workspace): Promise<string[]> {
  // A split the app's own check holds (src/booking/unstated-split.ts) is no rule's: removing a rule never answers it.
  const waiting = askRuns(engine).filter((r) => r.state.status === 'waiting' && r.item.kind === 'transaction' && askedBy(r) !== undefined && askedBy(r) !== UNSTATED_SPLIT);
  if (!waiting.length || !hasBooks(ws)) return [];
  const books = loadBooks(ws);
  const context = loadClassifyContext(ws);
  const fx = loadFxResolver();
  const closed: string[] = [];
  for (const r of waiting) {
    const tx = books.transactions.find((t) => t.ref === r.item.id);
    if (!tx) continue;
    const { asked } = await classifyTransactions(structuredClone(books), [tx], { fx, context, proposeAsked: false });
    if (asked.length) continue;
    const out = await engine.command({ kind: 'discard', run: r.id, reason: CLOSED_REASON });
    if (out.ok) closed.push(r.id);
  }
  return closed;
}
