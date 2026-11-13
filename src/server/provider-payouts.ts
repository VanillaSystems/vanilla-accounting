/**
 * A payment provider's payouts without a booking, by provider (#404): what each waits for, and the
 * booking of those code books now. A payout settles the provider's clearing account (#203,
 * src/booking/classify.ts providerPayout); until the company's file names the clearing account and
 * the cut-over day it waits for the person (PayoutWait), who answers in the drop row of the
 * provider's report. Her answer is her switching on (keepSwitchedOn): what it decides is booked then,
 * each payout by a booking run of its own (as a rule kept books its payments, #383), and the row says
 * how many. A switching on by «Einschalten» books what waited too (bookWhatWaited).
 */
import { readBooks, WS } from './books.js';
import { BOOKING, INTAKE, engine } from './routes/automation.js';
import { chartOf, loadClassifyContext, mappedReceipts } from '../booking/classify.js';
import { fromClearing, payoutWaitOf, providerOfMoneyIn, type Provider } from '../booking/providers.js';
import { periodLock } from '../books/store.js';
import { chartNames } from '../booking/rule-book.js';
import { keepSwitchedOn } from '../workflows/switch-on.js';
import { loadWorkflows } from '../workflows/load.js';
import { APP_ROOT } from '../workspace/workspace.js';
import type { PayoutGroup } from '../types/drop.js';

/** How long a request waits for the payouts' runs; runs still going then finish on their own. */
const WAIT_MS = 30_000;
const RESTING = new Set(['done', 'waiting', 'stuck', 'parked', 'discarded']);

/**
 * The provider's payouts of the open period without a booking, grouped by provider and by what
 * they wait for: `ready` (code books them now, bank / `account` without VAT), `clearing` or `since`
 * (the company's file lacks it: the provider's report asks), `gap` (before the cut-over day beside
 * sales a report booked: hers to decide), `before` (before the cut-over day: a payment like any
 * other, booked as the payouts before it were).
 */
export function payoutGroups(): PayoutGroup[] {
  const books = readBooks();
  const lock = periodLock(books);
  const counterparties = loadClassifyContext(WS).counterparties ?? [];
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const chart = chartNames(chartOf(WS));
  const groups = new Map<string, PayoutGroup>();
  for (const tx of books.transactions) {
    if (booked.has(tx.ref) || lock.isClosed(tx.date) || lock.beforeBooks(tx.date) || tx.waitsForPerson) continue;
    const linked = mappedReceipts(books, tx);
    const p: Provider | undefined = providerOfMoneyIn(tx, linked, counterparties);
    if (!p) continue;
    const wait = payoutWaitOf(tx, linked, counterparties, books.journalEntries);
    const { clearing, since } = p.provider;
    const why: PayoutGroup['why'] = wait ? wait.why : since && tx.date < since ? 'before' : clearing && chart.has(clearing) ? 'ready' : 'clearing';
    const key = `${p.id} ${why}`;
    const g = groups.get(key) ?? { provider: p.id, name: p.name, why, refs: [], ...(clearing ? { account: clearing } : {}), ...(since ? { since } : {}) };
    g.refs.push(tx.ref);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The payouts code books now, of one provider or of all. */
export const readyPayouts = (provider?: string): string[] => payoutGroups().filter((g) => g.why === 'ready' && (!provider || g.provider === provider)).flatMap((g) => g.refs);

const restsNow = (id: string) => RESTING.has(engine().run(id)?.state.status ?? 'done');

/**
 * A booking run for each payout code books now (`refs`), awaited a while: how many are booked from
 * the clearing account then, and how many runs still go (they finish on their own).
 */
export async function bookPayouts(refs: readonly string[]): Promise<{ booked: number; running: number }> {
  const runs: string[] = [];
  for (const id of refs) {
    const r = await engine().start(BOOKING, { kind: 'transaction', id }, { kind: 'manual' }, 'live');
    if (r.ok && r.run) runs.push(r.run);
  }
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until && !runs.every(restsNow)) await new Promise((r) => setTimeout(r, 100));
  const books = readBooks();
  const counterparties = loadClassifyContext(WS).counterparties ?? [];
  const booked = refs.filter((ref) => {
    const tx = books.transactions.find((t) => t.ref === ref);
    const clearing = tx && providerOfMoneyIn(tx, mappedReceipts(books, tx), counterparties)?.provider.clearing;
    return !!clearing && fromClearing(books.journalEntries.filter((e) => e.transactionRef === ref), clearing);
  }).length;
  return { booked, running: runs.filter((id) => !restsNow(id)).length };
}

/**
 * A change the person makes through the app's own controls (her answer in a drop row) is her
 * switching on (docs/0.4.0/workflows.md "Changing a workflow"): every workflow that ran as switched
 * on before it runs switched on after it, in the same step. A change that arrives any other way (a
 * file edited by hand, the AI's draft before it is kept, git) still waits for «Einschalten».
 */
export function asHerAct<T>(change: () => T): T {
  const switchedOn = keepSwitchedOn(WS, () => loadWorkflows(APP_ROOT, WS.paths.root).workflows);
  const out = change();
  switchedOn();
  return out;
}

/**
 * What waited while a workflow was not switched on is booked once it is («Einschalten»): one run of
 * the inbox, whose book step books the payments without a booking.
 */
export async function bookWhatWaited(workflow: string): Promise<void> {
  if (workflow !== BOOKING && workflow !== INTAKE) return;
  const r = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'manual' }, 'live');
  if (!r.ok && r.refusal !== 'not-runnable') console.error(`${INTAKE}: ${r.refusal} ${r.detail ?? ''}`);
}
