/**
 * A payment provider's payouts without a booking, by provider (#404): what each waits for, and the
 * booking of those code books now. A payout settles the provider's clearing account (#203,
 * src/booking/classify.ts providerPayout); until the company's file names the clearing account and
 * the cut-over day it waits for the person (PayoutWait), who answers in the drop row of the
 * provider's report. Her answer is her switching on (keepSwitchedOn): what it decides is booked then,
 * in code through the write door (bookByRules, as a rule kept books its payments, #383), and the row
 * says how many. «Einschalten» of the booking books the payouts code decides then (bookWhatWaited).
 * While the booking waits for «Einschalten» nothing is booked, and that is said.
 */
import { readBooks, WS } from './books.js';
import { BOOKING, INTAKE, engine } from './routes/automation.js';
import { bookingWaits } from './booking-waits.js';
import { unbooked } from '../workflows/actions.js';
import { bookByRules } from '../workflows/book-by-rules.js';
import { chartOf, loadClassifyContext, mappedReceipts } from '../booking/classify.js';
import { fromClearing, payoutWaitOf, providerOfMoneyIn, type Provider } from '../booking/providers.js';
import { periodLock } from '../books/store.js';
import { chartNames } from '../booking/rule-book.js';
import { keepSwitchedOn } from '../workflows/switch-on.js';
import { loadWorkflows } from '../workflows/load.js';
import { APP_ROOT } from '../workspace/workspace.js';
import type { PayoutGroup, PayoutsBooked } from '../types/drop.js';

/**
 * The provider's payouts of the open period without a booking, grouped by provider and by what
 * they wait for: `ready` (code books them now, bank / `account` without VAT), `clearing` or `since`
 * (the company's file lacks it: the provider's report asks), `gap` (before the cut-over day beside
 * sales a report booked: hers to decide). One before the cut-over day otherwise is a payment like any
 * other (a rule or the model may book it): it is in no group.
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
    if (!wait && since && tx.date < since) continue;
    const why: PayoutGroup['why'] = wait ? wait.why : clearing && chart.has(clearing) ? 'ready' : 'clearing';
    const key = `${p.id} ${why}`;
    const g = groups.get(key) ?? { provider: p.id, name: p.name, why, refs: [], sales: !!p.provider.reports.sales, ...(clearing ? { account: clearing } : {}), ...(since ? { since } : {}) };
    g.refs.push(tx.ref);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The payouts code books now, of one provider or of all. */
export const readyPayouts = (provider?: string): string[] => payoutGroups().filter((g) => g.why === 'ready' && (!provider || g.provider === provider)).flatMap((g) => g.refs);

/**
 * Books the payouts code books now (`refs`), in code through the write door, no model (bookByRules):
 * how many were booked from the clearing account, of how many. While the booking workflow waits for
 * «Einschalten» (a change it has not been switched on for) nothing is booked: `waits` says so.
 */
export async function bookPayouts(refs: readonly string[]): Promise<PayoutsBooked> {
  const of = refs.length;
  const files = bookingWaits();
  if (files) return { booked: 0, of, waits: 'switchOn', files };
  await bookByRules(WS, refs);
  const books = readBooks();
  const counterparties = loadClassifyContext(WS).counterparties ?? [];
  const booked = refs.filter((ref) => {
    const tx = books.transactions.find((t) => t.ref === ref);
    const clearing = tx && providerOfMoneyIn(tx, mappedReceipts(books, tx), counterparties)?.provider.clearing;
    return !!clearing && fromClearing(books.journalEntries.filter((e) => e.transactionRef === ref), clearing);
  }).length;
  return { booked, of };
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
 * «Einschalten» of the booking books what waited (#404, #413): the provider payouts code decides,
 * in code (bookPayouts), said with the switching on; and, when payments are still open, an inbox run
 * books them by rule or model, as the drop or the mail that came while the booking waited would
 * have (its book step booked nothing then). Undefined for another workflow or when no payout is ready.
 */
export async function bookWhatWaited(workflow: string): Promise<PayoutsBooked | undefined> {
  if (workflow !== BOOKING) return undefined;
  const refs = readyPayouts();
  const payouts = refs.length ? await bookPayouts(refs) : undefined;
  if (unbooked(readBooks()).some((x) => x.kind === 'transactions')) {
    const r = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'manual' }, 'live');
    if (!r.ok && r.refusal !== 'not-runnable') console.error(`${INTAKE}: ${r.refusal} ${r.detail ?? ''}`);
  }
  return payouts;
}
