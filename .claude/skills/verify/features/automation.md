# Automatisierung

Automatisierung (`/automation…`) shows what the app does on its own: an overview of the period's receipts from collected to filed with what waits for the owner and what runs (the «Leitstand»; its visible title is `Übersicht`), the runs, each workflow as a graph with its triggers, runs and files, the process map, the queue and the tasks. Workflows come from the app's `workflows/<id>/workflow.yaml`; runs are kept outside the workspace in `VANILLA_RUNS_DIR` (the sandbox's `$SB.runs`, empty at `up`).

## Sub-features

- `au-list`: `.rows[role=listbox] .row.wfrow` (`.sel`): Übersicht, Läufe, Prozesskarte, Warteschlange, Aufgaben, then a plain `.row[data-to=rules]` `Regeln →`, then workflow groups (`.group`) with `.ahdot.<ok|off|run…>` per workflow.
- `au-home`: `/automation` (`?period=`): `[data-testid=automation-home]`, the hero `[data-testid=home-hero]`, the five stages `[data-testid=home-stages] .stage` (Gesammelt, Gelesen, Zugeordnet, Gebucht, Abgerechnet; `Abgeschlossen` for a firm without VAT) linking to Belege (`?f=state_…`), Buchungen, MWST; `Wartet auf dich` (`[data-testid=home-task]`, `home-stuck`, question cards), `Läuft gerade`, `Als Nächstes`. Empty: `[data-testid=home-empty]`.
- `au-unbooked-fact` (#341): where nothing is the person's task but payments of a period not filed are not booked, the hero, «Wartet auf dich», Aufgaben and the dock's card say `[data-testid=unbooked-fact]` (`Keine Aufgabe wartet auf dich. 19 Zahlungen noch nicht gebucht (16 davon warten auf ihren Beleg). In Q3 2026 ansehen` → `/vat/open?period=`), never `Nichts wartet auf dich.` A workflow's graph labels its edges with the outcome's words. **Driven on 2026-11-12.**
- `au-runs`: `/automation/runs`: `.runshome`, filter tabs `.rfilters button[role=tab]`, `table.rtable tr.rrun`; empty `p.rempty` (`Noch keine Läufe. …`). `/automation/runs/<id>`: `[data-testid=run-why]`, `ol.wfsteps`, `Weiter` (stuck or parked) / `Nochmals abspielen` (done or stuck).
- `au-graph`: `/automation/<wf>` (tabs `.wftabs button[role=tab]`: Ablauf, Auslöser, Läufe, Dateien → `/automation/<wf>/triggers|runs|files`). The graph sits in the scroll frame `.wfscroll[data-more=l|r|lr]` > `.wfpan` (the element that scrolls horizontally; edge fades by `data-more`) > `.wfgraph`. Steps are `button.wfnode.k-<kind>`; a click selects it (`.sel`), the URL becomes `/automation/<wf>/graph/<step>` and `.wfstep` shows below. Edges `svg g.wfedge`.
- `au-map`: `/automation/map` (Phasen: `.wfmap section.col`, cards `button.wfcard` → `/automation/<id>`) and `/automation/map/events` (`ul.wfarrows li`).
- `au-queue`, `au-tasks`: `/automation/queue` (`.qpage`, sections Läuft / In der Schlange / Geparkt / Fertig, `❚❚ Pausieren`), `/automation/tasks[/<run>]` (`.wftasks .wftask`, `[data-testid=unbooked-payments|threshold-tasks|evidence-tasks|filed-evidence|twin-tasks]`). An open quarter's return review shows `[data-testid=proposal|xml-file|period-issues]`.

## How to get to it (user POV)

- Dock `Automatisierung` (`G W`; the dock widget below the dock shows gelesen / gebucht / für dich, and «für dich» counts open tasks and questions), or ⌘K.
- From the drop dialog's `In den Läufen ansehen →`, from a run link in the AI sidebar.

## Driving it with browse + sandbox.sh

Preconditions: a fresh demo sandbox. Real workflow ids: `ask`, `bank-import`, `booking`, `collect`, `collection`, `correction`, `evidence`, `new-case`, `receipt-intake`, `vat-filing`, `year-close`.

- **Home.** `$B goto "$UI/automation"`: `[data-testid=automation-home]` present, `$B js "document.querySelectorAll('[data-testid=home-stages] .stage').length"` is 5, the hero reads `n Belege gesammelt, n gebucht. Nichts wartet auf dich.` on the demo (it names the period only when nothing was collected; the period is in `.kicker select`).
- **Runs.** `$B goto "$UI/automation/runs"`: on a fresh sandbox `p.rempty` (`Noch keine Läufe`). A camt.053 drop (features/drop.md) makes a `bank-import` run that shows here.
- **Graph and scroll frame.** `$B goto "$UI/automation/vat-filing"`: five `button.wfnode` (Ziffern berechnen … Archivieren und sperren), `.wfscroll` has `data-more=r` (the graph, about 1300 px, is wider than the frame). Scroll: `$B js "const p=document.querySelector('.wfpan'); p.scrollLeft=p.scrollWidth; p.dispatchEvent(new Event('scroll'))"`, then in a second call `$B js "document.querySelector('.wfscroll').dataset.more"` reads `l` (React applies it after the first call returns). `$B click 'button.wfnode:nth-of-type(2)'`: the URL is `/automation/vat-filing/graph/review`, the node has `.sel`, `.wfstep` shows below.
- **Map.** `$B goto "$UI/automation/map"`: 4 `.wfmap section.col`, 11 `button.wfcard`; `$B js "document.querySelector('button.wfcard').click()"` opens `/automation/bank-import` (`$B click 'button.wfcard'` matches several and refuses). `/automation/map/events` lists 5 `ul.wfarrows li`.
- **Queue, tasks.** `/automation/queue` shows the four sections (`Leer.` when empty); `/automation/tasks` lists `.wftask` rows (none on a fresh demo).

## Gotchas

- Starting, resuming, replaying or `Fälle prüfen` a workflow whose step reads or classifies calls a model: in the sandbox that step fails with `claude exited 1: verify sandbox: no model calls`. A camt.053 import (`bank-import`) needs none.
- `$SB.approvals` is empty at `up`, so the first start approves every workflow as it is (`.wfpending` never shows on a fresh sandbox).
- `/automation/workflows` without an id shows only a hint; an unknown id says `Den Ablauf «<id>» gibt es nicht.`
- docs/urls.md lists only `/automation` and `/automation/runs`; the other paths are in `src/app/shell/route.ts` (`automationRoute`).
