/**
 * What a message refers to, read when it is sent (docs/0.4.0/views.md: the AI gets references, not
 * copies). A booking, a payment or a receipt as the books hold it now; a run as its steps went; a
 * workflow by where its files lie. A reference that no longer resolves says so.
 */
import { join } from 'node:path';
import { loadBooks } from '../books/store.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { loadRun } from '../workflows/store.js';
import type { ContextRef } from '../types/assistant.js';

const cut = (o: unknown, n = 2500) => { const s = JSON.stringify(o); return s.length > n ? `${s.slice(0, n)}…` : s; };

export function contextText(ws: Workspace, refs: ContextRef[]): string[] {
  const needsBooks = refs.some((r) => r.kind === 'entry' || r.kind === 'payment' || r.kind === 'receipt' || r.kind === 'selection');
  const books = needsBooks ? loadBooks(ws) : undefined;
  return refs.map((r) => {
    const gone = `${r.kind} ${r.id} (${r.label}): not found anymore`;
    switch (r.kind) {
      case 'entry': { const e = books!.journalEntries.find((x) => x.id === r.id); return e ? `Booking ${r.id}: ${cut(e)}` : gone; }
      case 'payment': { const t = books!.transactions.find((x) => x.ref === r.id); return t ? `Payment ${r.id}: ${cut(t)}` : gone; }
      case 'receipt': { const x = books!.receipts.find((y) => y.id === r.id); return x ? `Receipt ${r.id}: ${cut({ ...x, extractedText: undefined })}` : gone; }
      case 'run': {
        const run = loadRun(ws, r.id);
        if (!run) return gone;
        const steps = run.steps.map((s) => ({ step: s.step, input: s.input, outcome: s.outcome, error: s.error, answer: s.answer?.outcome, wrote: s.effects.map((e) => e.wrote) }));
        return `Run ${run.id} of workflow ${run.workflow} on ${run.item.kind} ${run.item.id}, ${run.state.status}: ${cut(steps, 4000)}`;
      }
      case 'workflow': return `Workflow ${r.id} (${r.label}): the app's declaration in ${join(APP_ROOT, 'workflows', r.id)}/, the company's changes in workflows/${r.id}/`;
      case 'file': return `File ${r.id}`;
      case 'selection': return selectionText(books!, r);
    }
  });
}

const SELECTION_CUT = 300;

/**
 * Rows the person picked in a list (#216): each object in one short line, so the answer works on
 * exactly these. «alle ausgewählten», «diese» mean them; a change goes to each of them through the
 * same changes as one object's, and the app shows them as one set the person can take back.
 */
function selectionText(books: ReturnType<typeof loadBooks>, r: Extract<ContextRef, { kind: 'selection' }>): string {
  const linked = (id: string) => books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef);
  const line = (id: string): string => {
    if (r.id === 'receipt') {
      const x = books.receipts.find((y) => y.id === id);
      return x ? cut({ id, filename: x.filename, date: x.date, amount: x.amount, currency: x.currency, description: x.description, kind: x.kind, hasSwissVat: x.hasSwissVat, vatSummary: x.vatSummary, payments: linked(id) }, SELECTION_CUT) : `${id}: not found anymore`;
    }
    if (r.id === 'payment') {
      const x = books.transactions.find((y) => y.ref === id);
      return x ? cut({ ref: id, date: x.date, amount: x.amount, currency: x.currency, direction: x.direction, description: x.description, counterparty: x.counterparty, noReceiptNeeded: x.noReceiptNeeded, entries: books.journalEntries.filter((e) => e.transactionRef === id).map((e) => e.id) }, SELECTION_CUT) : `${id}: not found anymore`;
    }
    const x = books.journalEntries.find((y) => y.id === id);
    return x ? cut({ id, date: x.date, accountDebit: x.accountDebit, accountCredit: x.accountCredit, amount: x.amount, vatCode: x.vatCode, description: x.description, transactionRef: x.transactionRef, origin: x.origin }, SELECTION_CUT) : `${id}: not found anymore`;
  };
  const what = r.id === 'receipt' ? 'receipts' : r.id === 'payment' ? 'payments' : 'bookings';
  return [`Selection: the person picked these ${r.ids.length} ${what} in the list; «alle ausgewählten», «these» and the like mean exactly them, and a change goes to each of them:`, ...r.ids.map(line)].join('\n');
}
