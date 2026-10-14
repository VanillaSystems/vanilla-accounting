/**
 * Automatisierung (screens 1, 2, 3, 5, 9): one area, five views of the same snapshot. The List is
 * the same on every view (the mockup's listHTML): Warteschlange first, then the workflows grouped
 * by phase with their trigger chips, AI mark and open count; the Detail switches on route.view.
 *
 * File map (each a list or detail piece the mockup has a renderer for):
 *   automation.tsx   Area object, List
 *   Detail.tsx       switch(route.view) → WorkflowView | RunView | MapView | QueueView | TasksView
 *   WorkflowView.tsx header (label, folder, RunStrip, StartMenu, «Ändern…»), desc, tabs graph|triggers|runs|files, StepPanel
 *   Graph.tsx        SVG from model.graphOf (+ overlayOf for a run); AI steps in --ai; click → /automation/<wf>/graph/<step>
 *   RunView.tsx      banner by state (waiting/stuck/running/done/replayed), graph with path, timeline of StepRecords
 *   MapView.tsx      model.processMap: phases columns | event graph
 *   QueueView.tsx    Läuft / In der Schlange (reason, ×) / Geparkt / Fertig, Pausieren
 *   TasksView.tsx    tasks by due date; task card (do: open-login | decide | open-item), the part-runs of a for-each step (screen 5 "Quellen")
 *   StartMenu.tsx    Starten ▾: resume open | replay this/last | start for an item (ItemPicker) | start customized (item, version saved|draft, live|dry)
 *   graph.css, automation.css (namespaced: .wf-*, never .status/.pill)
 *
 * Every button here is an automationCommand; nothing in the area computes a run.
 */
import type { Area } from '../index.js';
import type { AutomationRoute } from '../../shell/route.js';

export const automation: Area<AutomationRoute> = {
  id: 'automation',
  label: () => { throw new Error('not implemented'); },               // t('area.automation') "Automatisierung"
  dock: {
    key: 'w',
    icon: null,                                                        // ICONS.flow
    tip: () => { throw new Error('not implemented'); },
    // badge reads the automation store, not the books: openCount(snapshot)
    badge: () => { throw new Error('not implemented'); },
  },
  List: () => { throw new Error('not implemented'); },
  Detail: () => { throw new Error('not implemented'); },
  periodless: true,
  title: () => { throw new Error('not implemented'); },               // "Lauf 1047" / workflow label / "Warteschlange"
  // palette: workflows, open runs, tasks; keys: ↑↓ rows, S = Starten on the selected workflow
};
