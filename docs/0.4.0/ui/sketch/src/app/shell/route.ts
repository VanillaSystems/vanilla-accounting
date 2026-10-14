/**
 * Additions to src/app/shell/route.ts (the only URL parser). English segments like every other
 * area (urls.md); the German "Automatisierung" is the label, not the path.
 *
 *   /automation                         → list, first workflow selected by the List
 *   /automation/<wf>                    → workflow, tab graph
 *   /automation/<wf>/<tab>              → triggers | runs | files
 *   /automation/<wf>/graph/<step>       → graph with the step panel open
 *   /automation/runs/<run>              → screen 3 (the run names its workflow)
 *   /automation/map[/events]            → screen 2
 *   /automation/queue                   → screen 9 (first row of the list)
 *   /automation/tasks[/<run>]           → screen 5 (a task is a waiting run)
 *   /changes                            → screen 7, unsaved
 *   /changes/<commit>                   → a save in Verlauf
 */
export const AUTOMATION_TABS = ['graph', 'triggers', 'runs', 'files'] as const;
export type AutomationTab = typeof AUTOMATION_TABS[number];

export type AutomationRoute =
  | { area: 'automation'; view: 'workflow'; workflow?: string; tab: AutomationTab; step?: string }
  | { area: 'automation'; view: 'run'; run: string }
  | { area: 'automation'; view: 'map'; map: 'phases' | 'events' }
  | { area: 'automation'; view: 'queue' }
  | { area: 'automation'; view: 'tasks'; run?: string };

export type ChangesRoute = { area: 'changes'; commit?: string };

// Route gains `| AutomationRoute | ChangesRoute`; AREA_HOME, segmentsOf, routeOf gain a case each
// (the exhaustive switch makes the compiler list them). DOCK becomes
//   [[receipts, invoices, bank, journal, vat, reports, close], [automation, changes, company]]
// with dock keys w (Abläufe/workflows) and v (Verlauf): both free today.
