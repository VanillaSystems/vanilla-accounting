/**
 * Screen 4: the buttons workflows declare, and the link back from a record to its run. Areas
 * render these two components and nothing else of the automation; they never name a workflow.
 *
 *   // bank/Detail.tsx, on a payment:
 *   <WorkflowButtons item={{ kind: 'transaction', id: tx.ref }} />
 *   // → «Buchen» (bot icon: the booking workflow has an AI step), «Beleg zuordnen»;
 *   //   a run open for this item shows "Ein Lauf wartet für diese Bewegung · Lauf öffnen" instead of a second start.
 *
 *   // journal/Detail.tsx, on an entry:
 *   <RunLink entry={entry.id} />
 *   // → "von KI gebucht · Warum so gebucht? Lauf 1046 · Schritt «Konto und MWST-Code wählen»"
 *   //   (GET /api/automation/runs?entry=<id>; nothing when no run booked it)
 *
 *   // vat/…, on an ended open period: <WorkflowButtons item={{ kind: 'period', id: '2026-Q3' }} />
 *
 * Removing a workflow removes its button: the list comes from model.buttonsFor(snapshot.workflows, kind).
 * A not-runnable workflow's button is shown disabled with its reason ("noch nicht ausführbar").
 * Starting = automationCommand start + a toast with «Lauf öffnen».
 */
import type { ItemRef } from '../../workflows/model.js';

export function WorkflowButtons(_p: { item: ItemRef; primary?: boolean }): JSX.Element | null {
  throw new Error('not implemented');
}

export function RunLink(_p: { entry: string }): JSX.Element | null {
  throw new Error('not implemented');
}

/** «Mit KI ändern…» on any object: opens the sidebar with that object as context (views.md). */
export function AskAi(_p: { context: import('../../types/assistant.js').ContextRef }): JSX.Element {
  throw new Error('not implemented');
}
