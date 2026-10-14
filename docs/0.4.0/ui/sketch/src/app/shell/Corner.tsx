/**
 * Top right: the AI toggle (⌘J) and the one status indicator (views.md "Status, top right").
 * The panel is an Overlay variant ({ kind: 'status' }): it takes keys like any overlay and Esc
 * closes it. The sidebar is NOT an overlay (it must keep the page's keys working).
 *
 *   <Corner aiOpen={ai.open} onAi={ai.toggle} />
 *
 * Reads useAutomation() (src/app/automation/store.ts) only; `corner(snapshot)` decides spinner /
 * amber dot / nothing. The drop dialog's "Import läuft · 62 %" chip is a row of this panel, not a
 * second chip: its run ids are in the snapshot's running list.
 */
export function Corner(_p: { aiOpen: boolean; onAi(): void; onPanel(anchor: HTMLElement): void }): JSX.Element {
  throw new Error('not implemented');
}

export function StatusPanel(_p: { onClose(): void }): JSX.Element {
  // TODO Läuft (bar + step per running run; AI mark) · in der Schlange n · warten auf dich n · zuletzt fertig (3) ·
  //      links Warteschlange (/automation/queue) and Aufgaben (/automation/tasks)
  throw new Error('not implemented');
}
