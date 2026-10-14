# Synthesis: three servers, everything else derived (base: candidate opus)

## Problem

The 0.4.0 mockup (`docs/0.4.0/mockups/workflows.html`, 9 screens plus the sidebar, the status corner and the folding bars) must run in the app on the owner's real, migrated books. Today almost none of it has a source. Only the booking pilot runs, from the CLI. A run is saved only when it finishes, has no `running`, `queued` or `retrying` state, and a waiting run has no task. Nine processes exist only as `processes/*.flow.yaml`. Those flows have 11 to 29 steps, backward `needs` edges and no triggers. No server route starts a run. Nothing reads the workspace's git. The year-close commit silently fails since ADR 0013 because it looks for `.git` in the wrong folder. The chat is on unmerged `origin/feat/chat` and floats over the page instead of sitting in a sidebar. The mockup's screens all read a few hand-written fixtures (`WF`, `QUEUE`, `SRC`, `UNSAVED`, `SAVES`, `PREP`, `SESS`). The real question is which few stored things those fixtures become, so that the queue, the tasks, the badge, the corner, the "since the last save" list and the run links cannot disagree with each other.

Constraints carried in: golden rule 1 (writes go only through `update(books, actor, fn)`, and nothing of a filed quarter changes), D4a (own runner), D9 (replay uses recorded answers). The repo's own rules apply: i18n in 4 locales, no hard-coded strings, the import-cycle test, and `Overlay` swallows keys. Each step deletes the old path it replaces, and `test:books` never changes.

The design follows the architecture research in the Vanilla Machines architecture research (llm-open-architecture) (the folder is the graph, stuck not failed, replay versus resume, declared effects, approvals out of the AI's reach, structure decides a change's risk). On 14 October 2026 the owner adopted its G6 direction for where the books and the runs live, because workflows will also run in the cloud with nobody present and their results must still be committed for later review. That amends two 0.4.0 decisions, which decisions.md must record:

- **D3 (runs outside git)** becomes: a run's detail stays outside git, with retention; a short run log goes into git with the records the run wrote.
- **D11 (a person saves)** becomes: the app commits the books (one commit per run, one per direct edit); a person saves only customizing, which the AI prepares on a draft branch.

## Usage (caller's view)

Three server modules, each with one read and one command surface, one route file and one browser store:

```ts
// src/server/books.ts, at boot: one instance each per server process
export const SAVING = openSaving(WS, { automation: () => AUTOMATION, ask });
export const AUTOMATION = openAutomation(WS, { ask, sources: SAVING.sources, notify: desktopNotify });
export const ASSISTANT = openAssistant(WS, { automation: AUTOMATION });
```

```ts
// any area, screen 4: the buttons workflows declare, and the link back from a record
<WorkflowButtons item={{ kind: 'transaction', id: tx.ref }} />   // «Buchen» with bot icon, or "Lauf 1047 wartet · öffnen"
<RunLink entry={entry.id} />                                      // "von KI gebucht · Warum so gebucht? Lauf 1046"
<AskAi context={{ kind: 'entry', id: entry.id }} />               // «Mit KI ändern…»
```

```ts
// the automation area, the corner, the dock badge, the drop dialog: one store
const snap = useAutomation();                 // AutomationSnapshot: workflows, run strips, running, queue (with reasons), tasks, parked, stuck, finished
corner(snap);                                 // { kind: 'running', count } | { kind: 'needs-you', count } | { kind: 'quiet' }
await automationCommand({ kind: 'start', workflow: 'booking' as WorkflowId, item: { kind: 'transaction', id: ref } });
await automationCommand({ kind: 'answer', run, step: 'manual' as StepId, outcome: 'done', output: { entries } });
await automationCommand({ kind: 'replay', run, source: 'draft' });   // screen 3 «Mit Änderung abspielen»
```

```ts
// the books: committed by the app, never waiting for a person
await RECORDS.commitRun(run.id, newLogLines);       // once, when the run comes to rest; null when it wrote and logged nothing
await RECORDS.commitEdit('Beleg R-7F3A umbenannt', paths);   // a person's direct edit in the UI
```

```ts
// Änderungen: customizing on the draft branch, and edits made outside the app
const view = useChanges();                    // draft vs main (no model), proposal (ready | stale), Verlauf, sync
await savingCommand({ kind: 'prepare' });     // one model call
await savingCommand({ kind: 'talk', text: 'Das Logo noch nicht' });
await savingCommand({ kind: 'save', sync: true });  // merges the prepared saves into main; refused with 'stale' if any basis hash moved
```

```sh
npm run workflow -- booking BT-2026-10-14-03   # with the server up: sent to it (one engine); without: runs in-process, holding the lock
```

## Shape

**Stored state is only three things. Everything a screen shows is derived from them.**

1. **Runs**, in two tiers. The **detail** lives in the run store (`src/workflows/store.ts`, outside git, per machine, kept for `RETENTION`: 90 days and at least until the year closes): inputs, prompts, model answers, receipt text, everything replay and debugging need. The **run log** (`src/workflows/runlog.ts`) is the short, shared history in git: `transactional-data/<year>/runs.jsonl`, one line per event (started, stuck, waiting, answered, resumed, done, discarded), with the record ids the run wrote. It keeps the failure history (what got stuck where, why, how it was fixed) and travels with the repository to the cloud. Three rules keep it small: only runs that wrote something, got stuck, waited for a person or were discarded leave lines; lines are appended, never rewritten; no detail goes into it. A run that changed nothing and needed nobody stays in the local store only. `runs.jsonl` joins the year's names in `LAYOUT` (owner `app`). A `Run` holds its `RunState`, a discriminated union with one variant per thing the screens tell apart: `queued{at, reason}`, `running{at}`, `retrying{attempt, next}`, `waiting{task}`, `parked{until event|time}`, `stuck{reason}`, `done`, `discarded`. It also holds an append-only `steps: StepRecord[]`, each with its input, outcome, model calls, a person's answer, and effect records that name the record ids they wrote. Several things are pure functions of runs plus declarations (`model.ts`, browser-safe, shared by server and UI): the queue (`scheduler.plan`), tasks (`taskOf` on a waiting run), the corner, the badge, "Geparkt", run strips, progress (`happyPath`) and the entry→run link (the record's `run` field, with the run log as its history when the detail has expired). Nothing keeps its own list, per the separate-before-serializing principle and the single-source-of-truth rule.
2. **Declarations** (`workflows/<id>/workflow.yaml + <step>/step.yaml`, app folder overlaid by the company's `workflows/`). `WorkflowDecl` gains what the mockup draws: localized `label`/`desc`/`cadence`, `phase`, `triggers[]` (manual/event/schedule/outside), and a `StepBody` union. A step does exactly one of `uses`, `run.ts`, `by: person + task`, `calls`, `wait`, so it cannot both call and act. The kind is derived from the body and the action, so the bot icon follows from structure (views.md "AI is always marked"). `runnable` is also derived: an action may be declared in `ACTIONS` before it is implemented. That lets all nine workflows load, draw and explain themselves on screens 1 and 2 at once, while each becomes runnable in its own unit. A not-runnable workflow's Start button names the missing step. This is an encoded, visible state, not a compatibility layer.
3. **Git**, read and written only by `src/saving/`, along **two paths** that never share a commit:
   - **Records** (`saving/records.ts`). The app commits the books itself, on the main line, never on a branch. A run commits once when it comes to rest (done, or every part done, waiting or stuck): the records it wrote since its last commit plus its new run-log lines. An import of 500 receipts is one commit. A stuck item wrote nothing, so it adds only its log line. A person's direct edit in the UI is one commit. Commits carry trailers (`Vanilla-Kind: books`, `Vanilla-Run` or `Vanilla-Person`), and Verlauf groups them by day and run, so the person never sees a commit list. Crash safety comes from the `run` field: the write door writes, then the run commits; records whose run has no commit yet are committed under it at startup. A booking and its run line always land together (the architecture's G3).
   - **Customizing** (`saving/saving.ts`). Rules, workflows, knowledge and settings that the app's AI writes go to a draft branch, checked out as a second worktree under `data/draft/` (outside the books' working tree). The assistant's working directory is that worktree, so its edits can never mix with records (the architecture's C3). Claude Code started by hand edits wherever it runs; what it changes in the main tree shows in Änderungen as edited outside the app. Änderungen shows the draft against main, plus those outside edits. The AI's proposal (`data/saving/proposal.json`) stores the blob hash of every path it covers, so "stale" is derived and a stale proposal cannot be saved. «Speichern» merges the prepared saves into main with `commitExactly`; a change that needs switching on (below) is saved and then approved.

**Switched on = approved (D6 a, workflows.md:176-178).** The engine reads declarations and guides from main. A company workflow version runs live only when `workflows/approvals.ts` (app-local, outside the workspace, out of the AI's reach) approves that version; app workflows are approved by definition. An unapproved version runs `dry` or `replay` only (refusal `draft-live`). `classifyDraft` routes a change by kind: applies-now (label, schedule), needs-switch-on (rules, outcomes, effects, and any knowledge file an AI step cites, since for that step it is part of the prompt; the architecture's G9), needs-maintainer (any `.ts`). The structure decides the class; an AI may raise it, never lower it (the architecture's C4). Saving (git) and switching on stay two decisions, as the spec has them. Before a change is switched on, the workflow's saved cases replay against it.

**Company changes to an app workflow, per step (the architecture's G5).** The company's `workflows/<id>/` holds only the steps and fields it changes, for example `classify/step.yaml` with one new outcome. `load.ts` merges it onto the app's declaration per step and per field; a lock records the app version each override was written against. When an app update changes a field the company overrode, the workflow shows a notice (keep or adopt), and the company's saved cases replay before the new version runs live. A whole-folder copy is the fork, the exception.

**A booking in replay is a dry run, not a muted effect (the architecture's G3).** `ledger.book` is a command to the write door, not an outside effect. In replay and dry runs it runs `update()` against a copy of the books that is never saved, so a closed period, an unbalanced entry or an ownership refusal shows up in the replay, with the entries it would book. Outside effects (mail, a carrier label) stay muted with a recording.

**Deadlines.** `workflow.yaml` may name a deadline per item (`deadline: P5D`, from the item's date or arrival). A run stuck or waiting past it is overdue: the corner and the task list show it first, and a notification goes out once. Escalation to a second person is left to the platform; with one owner, overdue is the escalation.

**The nine-step cap is a readability rule, not a law.** The architecture proposes a cap per level so a graph stays readable at a glance; nine is a starting value, not evidence. The lint warns above the cap and suggests a group folder (a step that opens into its own level); the cap is a setting, and the graph-readability test of the architecture sets its real value. Today's `checkWorkflow` refuses more than nine steps; unit 2 turns that into the warning.

**The engine is one state machine, one step per call.** `advance(run)` runs one step and persists the run, and is the only executor. Running, waiting, retrying, queueing mid-run for an AI slot, resuming, recovery after a crash, `for-each` part-runs and `call` child-runs all use this one path. The existing `execute()` loop is deleted. Effects keep today's idempotency key `${workflow}:${item}:${step}` and go through `update(books, run actor, …)`, so a crash or a resume never writes twice. There is a single writer: the process holding `engine.lock` (the server while it is up). The CLI sends its command to the server in that case, so two processes never write runs. This is the separate-before-serializing principle. Every state change goes through `transition(run, next)` and the `MOVES` table, so an illegal move throws instead of writing a corrupt run file. A record an effect writes carries `run: <id>` (an optional field on entries, mappings and receipts, D3 "the booking links to the run id"); the run's `EffectRecord.wrote` stays the audit and the Änderungen join key.

**One clock.** The snapshot carries `rev`, bumped on any run write, any declaration-folder hash change, and any change of the repository's index or HEAD. One browser store (`src/app/automation/store.ts`) polls `GET /api/automation?since=rev` (2 s while something runs or a panel is open, 10 s when quiet, paused while hidden, at once on focus) and mostly gets `{unchanged:true}`. Änderungen refetches when `rev` moves. SSE (feat/live-reload) can replace the poll behind the same hooks later.

**Interface depth.** Each server module is one object with a read and one `command(union)`. The HTTP layer has four routes for the automation and two for saving, and each is parse→call→answer. The UI gets one store per module, so no area polls on its own, and `watchIntake`/`/api/intake` are deleted when intake becomes runs. Hidden behind `Automation.command`: scheduling, slots, lanes, retries, events, task creation, replay with recorded answers, effect muting, crash recovery and the run actor. Hidden behind `Saving.command` and the records committer: git, the draft worktree, the run log, crash recovery of uncommitted records, the model call, proposal staleness, exact-path commits, sync and undo (a reversing booking through the write door). The public types are domain types (`AutomationSnapshot`, `ChangesView`), never isomorphic-git or claude NDJSON, per boundary-discipline.

**UI shape.** There are two new areas, `automation` (one List for screens 1, 2, 3, 5 and 9, and a Detail that switches on `route.view`) and `changes` (screen 7). The shell gains four pieces:
- `bars.ts`: a pure reducer `new(uses) → auto(tip) ⇄ pinned`. Whether a bar is open is derived from the pointer and focus. This replaces `useEdges` and `.hint`.
- `Corner` plus `StatusPanel`, an `Overlay` variant.
- The assistant sidebar, which is not an overlay. It is a page sibling, and `--aiw` re-centres every fixed element on the page.
- The drop dialog, an overlay with a server-side session in `data/drop/` (nothing written while it is open).

URLs stay English per urls.md rule 3 (`/automation`, `/changes`); the German names are labels, and views.md:141's `/automatisierung` is corrected to match. The graph layout is a pure, separately tested port of the mockup's `layout()` (`app/areas/automation/graph/layout.ts`); schedules use an own 5-field `workflows/cron.ts`, no dependency.

Areas see the automation only through `WorkflowButtons`, `RunLink` and `AskAi`, and never name a workflow (views.md "What a view never does").

Deliberately out of scope: module views (D8), push transport (one polled `rev`), a branch per contributor (one draft branch for the single owner is enough for 0.4.0), the "Zwei Versionen" merge dialog (sync refuses a non-fast-forward with `two-versions`), and rendered previews.

## Delivery sequence

Each unit ends verifiable. The global gate of migration.md applies to every one: `npm test`, `npm run test:books` with no golden update, `check-public` 0, `check-processes` green, the i18n, import-cycle and layers tests (`src/saving` and `src/assistant` get `LAYER_OF` entries), and the old path deleted in the same unit.

| # | Unit | Owner can test on his books | Gate (beyond the global one) |
|---|---|---|---|
| 0 | **Subtract and fix git.** `commitExactly` replaces `commitPaths`; year close commits in `ws.paths.repository`. | a year close commits again | a path left staged by a migration is not in the commit; on a nested-repo fixture the year-close commit lands |
| 1 | **Routes and skeletons.** `Route` variants, `AREA_HOME`, `DOCK` (keys w, v), both areas with empty List/Detail, icons, i18n keys in 4 locales, `--ai` token. | two new dock entries | route round-trip tests for every new URL; i18n and import-cycle tests |
| 2 | **Declarations and the read-only area.** `model.ts`, the new `load.ts` (full schema, per-step company overlay with its lock, derived kind and `runnable`, the step cap as a warning), declared-unimplemented actions, the nine workflows declared from the flows and the mockup's `WF` in 4 languages; `GET /api/automation` (declarations plus today's CLI run files, no engine yet); screens 1, 2 and 3 read-only with the graph layout. Runner and CLI move to `WorkflowDecl`; the old `Workflow` type is deleted; flow files stay. | **first real check, no write risk:** all nine workflows, the map, his CLI booking runs | every app workflow loads strict; booking runnable, eight name their missing actions; a one-field overlay changes only that field; `layout.ts` tests (no overlaps; the mockup's booking gives its layers); booking by run still equals booking by classify |
| 3 | **Bars.** Pill, pin, fold after 3 uses with the tip, Firma › Darstellung on the same state, `--aiw` centring, `pageWidth()`, no-drag corner; `useEdges` and `.hint` deleted. Independent, any time after 1. | both bars on his screen | reducer table tests |
| 4 | **Engine in the server, records committed.** Run detail persisted per step with retention, `transition`, `engine.lock`, `advance()`, `scheduler.plan` (2 AI / 4 other, lanes, pause), event bus, cron, deadlines, person steps → `waiting{task}`, recovery, `POST /api/automation`, the CLI sends to the server when it is up; the run log and `RecordsCommitter` (one commit per run at rest, one per direct edit, crash recovery); replay books as a dry run through the write door; corner, status panel, Warteschlange, Aufgaben; effects write the `run` field. | a booking started from the UI on an open Q4 transaction, committed with its run line; the queue; a task answered | a crash between the write and the commit ends in exactly one commit holding both; a 500-item fixture import is one commit; a run that changed nothing leaves no line in git; a stuck item adds its line and no record; replay into a closed period shows the refusal; 3 AI runs give 2 running and 1 queued (ai-slot); lane order; an illegal transition throws |
| 5 | **Triggers in other areas (screen 4).** `WorkflowButtons`, `RunLink`, `AskAi` in bank, journal, vat, receipts; the classify-this-payment route is deleted (one way to book). | «Buchen» on a payment, "Warum so gebucht?" on an entry | removing a manual trigger removes its button; `RunLink` reads the `run` field |
| 6 | **Änderungen, read.** The draft worktree, `saving.view()`: the draft against main by file, edits made outside the app in the main tree, Verlauf from `git log` grouped by day and run, diff and whole-file dialog. No model. | what the AI or he changed in rules and settings; his day in Verlauf | fixture repo: a guide change on the draft shows, a run's bookings never do; an outside edit of a books file shows as one outside save; `GET /api/changes` under 1 s measured on his repository |
| 7 | **Saving, write.** prepare/talk/refresh (one `ask` each), save = merge the prepared saves from the draft into main (`commitExactly`, trailers, basis check), sync through the git binary (pull before taking the engine lock, push after a commit), undo as a reversing commit through `update(PERSON)`. | save a rule change; sync | a stale proposal is refused; a save never contains a books file; undo in a closed period is refused |
| 8 | **AI sidebar and Ablauf ändern.** feat/chat ported as the docked sidebar (persisted conversations, `ContextRef` chips, @, modes, ⌘J), its working directory the draft worktree; approvals, `classifyDraft` (knowledge cited by AI steps counts as a rule) and replay of saved cases on the draft for screen 6; `PATCH` of a trigger for the direct path. | ask about a stuck run, change a rule, see the replay, switch it on | ask mode has no Edit/Write; change mode writes only in the draft worktree, never `transactional-data/` or the approvals file; an unapproved version never runs live; a cited knowledge edit is needs-switch-on |
| 9 | **Intake as runs.** receipt-intake, bank-import and evidence runnable; the inbox is their outside trigger; `/api/intake`, its job, `watchIntake` and its polls deleted, with their flow files. | drop a receipt and watch per-file runs | the demo intake by runs gives the old job's books; a restart mid-intake resumes |
| 10 | **Drop dialog (screen 8).** Session in `data/drop/`, cheap recognition, tabs, ZIP (zip.js for AES), quarantine, commit → outside triggers. | drop a ZIP and a camt file | zip bomb, depth and 7z refused; no password on disk; a duplicate is not taken |
| 11 | **The rest, one workflow per commit.** new-case, vat-filing, correction, year-close, receipt-collection; each deletes its flow file, the last one quarter-close.flow.yaml. | screen 5's portal login | per workflow, a run equals today's path on the demo |

Units 0 to 2 give the owner a real, read-only Automatisierung on his books before anything writes. Unit 4 lets runs book and commit on their own, as a cloud instance later will; unit 5 puts the buttons into the other areas. Units 6 and 7 are only for customizing, and the sidebar (8) arrives behind both a save gate and an approval gate.

## Synthesis decision

Three runners (opus, fable, sonnet) and one read-only cross-judge (fable, candidates anonymised) scored on six criteria, 30 points. Opus 27, sonnet 22, fable 22. Base: **opus**, picked by the judge and by the orchestrator independently. It stores three things and derives every screen from them, has the smallest API (a read and a `command(union)` per server), makes `runnable` a structural state so all nine workflows load honestly now, keeps one writer of runs, respects migration step 12, and saves by record as saving.md asks.

Convergence, a strong signal that needed no graft: all three keep runs outside git with tasks and the queue derived from runs, read the workspace's git at `ws.paths.repository`, put the AI sidebar beside the page instead of in an Overlay, fix the year-close commit first, and reject both a fixture port of the mockup and SSE for now.

Grafted:
- From sonnet: app-local, version-pinned approvals with `classifyDraft`. This replaces the base's "saved = switched on", which contradicted workflows.md:176-178 and D6.
- From sonnet: one cheap poll of one `rev`, replacing the base's 25 s long-poll. It also wakes Änderungen on Claude Code edits.
- From sonnet: a read-only Automatisierung before the engine (unit 2), so the owner's first build carries no write risk.
- From fable: `transition` with the `MOVES` table.
- From fable: the optional `run` field on records (D3).
- From fable: the route skeleton as its own unit, the browser store in `src/app/automation/`, the pure `graph/layout.ts`, the own `cron.ts`, and the direct `PATCH` of a trigger.
- Fixes the judge found: one home for `ContextRef` (`src/types/assistant.ts`), `LAYER_OF` entries for the new folders, English URLs per urls.md rule 3.

Rejected: sonnet's file-level saves (saving.md:60 and :76 ask for no hunks and one save per run), its snapshot copies of AI context (views.md:95-97 asks for references), and its four-source attribution; fable's run index file and stored queue (two places say what is queued), its mutable exported engine, and deleting flow files before their workflows run.

Verification: the red-flag screen was re-run on the merged sketch, and the claim the judge found false (the flows do use `kind: agent`, 20 times) is corrected. No dropouts.

## Tradeoffs accepted

- We accept that the books are committed without a person looking first, in exchange for runs that can work unattended in the cloud and a history where a booking and its run always land together. Where a person must check before booking, that is a step of the workflow (a task), not git staging.
- We accept a few thousand small commits a year (one per run at rest and per direct edit), in exchange for crash safety and sync between the Mac and the cloud. Git handles that easily; the person sees Verlauf by day and run, never the commit list.
- We accept that undo of a booking is a visible reversing commit, in exchange for a history that is never rewritten, which bookkeeping wants anyway.
- We accept a second worktree for the draft branch, in exchange for the AI's edits never mixing with the books.
- We accept a second app-local store (approvals) beside git in exchange for saving and switching on staying two decisions, as workflows.md and D6 say; an AI can write a rule on the draft branch but cannot switch it on.
- For eight processes, `flow.yaml` and a declared-but-not-runnable workflow folder coexist until each one runs. In exchange, screens 1 and 2 are complete from unit 2, and the migration's "deleted when its workflow runs" rule holds.
- We accept polling one `rev` (2 s busy / 10 s quiet) in exchange for no held connections and no feat/live-reload rewrite yet; an outside change shows within one poll.
- One engine per workspace: the CLI depends on the server when the server is up, and a cloud instance and the Mac take turns through sync. In exchange, runs and records never have two writers.
- We accept that a run's detail expires (90 days, at least until the year closes) in exchange for keeping private inputs out of history; the run log in git keeps what happened for good.
- We accept one optional books field (`run`) in exchange for a link that travels with the books; no migration, no seal change (closed records never gain it), no golden update.
- Workflow and step labels are localized maps in YAML (four languages for app workflows, checked by the i18n test). In exchange, a company workflow brings its own words and `de.ts` names no workflow.
- Sync shells out to the user's `git` binary (credential helper) while all local git stays in isomorphic-git. In exchange, no token handling in the app.
- The whole snapshot goes over the wire on each change (tens of KB, locally). In exchange, no diff protocol.

## Alternatives considered

- **Render `processes/*.flow.yaml` as the screens' model** (draw today's flows, wire runs later). Shallow: the UI would learn two schemas (flows have 29-step levels, `needs` back edges, no triggers), and the drawn graph would not be the one that runs, which is the drift workflows.md exists to end. Rejected.
- **Port the mockup's fixtures into the app first and wire them later.** The owner wants his real books. A fixture layer is a second source that each screen would have to be unplugged from. Rejected.
- **Separate stores for the queue, tasks and a change log** (written by every writer). Split ownership: the engine, the intake job, UI routes and Claude Code would each have to remember to append. The queue would say one thing while the runs do another. Rejected in favour of deriving from runs and from git.
- **SSE plus fs.watch (feat/live-reload)** as the live channel. It is more capable, but it must be rewritten for the ADR 0013 paths, needs an own-writes registry and per-kind reloads, and none of this candidate's screens need push beyond what one polled `rev` gives. It can come later behind `useAutomation()` without touching a screen.
- **The person saves the books** (D11 as first written: bookings wait in the working tree until «Speichern»). Rejected on 14 October 2026: a cloud run has nobody to press the button, unsaved work exists on one machine only (saving.md admits it), and the AI's edits and the bookings would share one working tree (the architecture's C3).
- **One commit per booking.** Atomic, but an import of 500 receipts would be 500 commits. One commit per run at rest keeps the atomicity that matters (a run's records with its run line) at a fraction of the commits.
- **Runs fully in git** (every input, prompt and answer). The CI-log trap: the repository grows with private detail that can never be removed from history. Only the run log goes in.
- **Runs only outside git** (D3 as first written). The failure history would live on one machine and never reach the cloud, and a booking could not explain itself once the detail expired.
- **Customizing edited in the main working tree** (the first synthesis). Simpler, but the AI's edits and the app's bookings would meet in one tree. The draft branch in its own worktree separates them at no cost to the person.
- **The AI sidebar as an `Overlay`** (or feat/chat's floating composer). An overlay swallows the page's keys and covers it, against views.md. Rejected.

## Implementation reconciliation

- 2026-10-14, owner (conversation of the same day): adopt the architecture's G6 direction. The books are committed by the app, one commit per run at rest and per direct edit; a run log with failures goes into git under three rules (only runs that did something or needed someone, append-only, no detail); the detail stays outside git with retention; customizing is prepared on a draft branch. Also accepted with it: replay books as a dry run (G3), per-step overlays (G5), deadlines, knowledge cited by AI steps as needs-switch-on (G9), the step cap as a warning. Amends D3 and D11; decisions.md and saving.md follow before unit 4.
- Unit 0 built as designed (`ceb19be`).
- Units 1 to 3 built as designed (`5cacd91`, `93c1b53`, `f6ce9b2`).
- Unit 4 (`6113b0d`, `bfc7bd1`). Records are committed per file (every changed records file), not per record line: direct edits commit at once and runs at rest, so the working tree holds nobody else's records changes in the normal case. Record-level commits stay a later refinement; the contract (a run's records and its log line in one commit) holds.
- Unit 5 (`09a29e9`). The classify-this-payment route stays: it re-books payments that are already booked, which the booking workflow skips. A workflow button is hidden, not disabled, while its workflow is not runnable. Accepted by the implementer; the design still holds (one way to book an unbooked payment).
- Unit 6 (`e34f5c9`). The draft is a folder, `data/draft/`, holding copies of the changed files, not a git worktree: isomorphic-git has no worktree. It keeps the property that matters (the AI's edits never touch the books' working tree); a save copies the files over and commits them. The books-unsaved check reads only the books' own files (ledger, invoices, each year's books and run log), since hashing every receipt made the view slow (about 450 ms cold on the owner's repository now).
- Unit 7. Talk regroups, holds, merges and renames saves; it does not rewrite files (the mockup's «Den Treibstoffzuschlag noch nicht»), which is the sidebar's job in the draft (unit 8). Rückgängig of a customizing save puts the files as they were into the draft, to be saved like any change; of a run, it books a reversal (`storno-<id>`, Soll and Haben swapped, the VAT code's sign turned) dated like each entry, so the write door refuses it in a closed period and the correction workflow takes over. Year-close commits now carry `Vanilla-Kind: books` and `Vanilla-Lock: year-close`, so Verlauf shows them locked and offers no undo. No save action was needed for filing: there is no filing route yet, and year close commits itself. Sync is `git pull --ff-only` then `git push` through the user's git program; a pull that cannot fast-forward is refused as two versions.
- Unit 8a, the sidebar. Ported from `origin/feat/chat`: the stream-json call, its parser, the resumed session, NDJSON over HTTP, the stub's streaming. Left out: the "/" menu of jobs (it read `processes/*.flow.yaml`, which the workflows replace) and attachments (the drop dialog, unit 10, takes files). Changed: no Bash and no `npm run` commands, since the AI never writes the books (a workflow does, started by a person); no settings are loaded (`--setting-sources ''`), because a workspace's or the person's settings could allow more than the two modes do; Ändern writes copy-on-write into `data/draft/<customizing>/` and nowhere else, which the live check against the real CLI confirmed (a write at the top was refused, nothing written). The sidebar runs on Sonnet. Conversations are stored in `data/assistant/` (outside git). feat/chat's Claude setup (Firma › Claude einrichten) is not part of this unit.
- Unit 8b, Ablauf ändern. Switched on = approved, in `src/workflows/switch-on.ts`. What needs switching on is the company's part of a workflow: its overlay without the fields that apply at once (label, desc, cadence, triggers; a step's label), and the guides and knowledge its AI steps cite (`suppliers/*` cites the folder). A hash per file is stored with the approval, so the page names what changed. Approvals lie outside the workspace (`VANILLA_APPROVALS_DIR`, else `~/.vanilla-accounting/approvals/`). The first time a workspace is seen, what it runs counts as switched on (the baseline); without it the owner's booking would stop on the first start. Deviation: "replay of saved cases" became **dry runs of the latest finished case per item** (up to 10, by a person's click). A replay answers with the recorded model answers (D9), so it cannot show what a changed rule does to an AI step. A check sees the books without what its case booked and mapped, and compares steps, outcomes and bookings (accounts, amount, VAT code). It costs one model call per case. The CLI's engine honours approvals too. The direct path is the schedule (PATCH, written into the company overlay, applies at once, waits in Änderungen). A pause per workflow is not built; the engine pauses as a whole. How a waiting change takes effect is shown in Änderungen per file; the join lives in the route, since `src/saving` may not import workflows.

## Open questions and risks

- Sync: does the owner's repository have a remote, and is it SSH or HTTPS? Until that is answered, sync stays behind its port and the app commits locally.
- The handover between the Mac and a cloud instance: a lock in the repository (a file the holder commits), or the platform's lease? 0.4.0 has one writer and needs neither; the cloud needs one.
- Retention of run detail: is 90 days, and at least until the year closes, right? An auditor may ask why a booking was made years later; the run log answers what, not how.
- Old CLI booking runs that ended `waiting` without a task: show them as `stuck` (`no-outcome`), or give them a generic "Von Hand buchen" task? Default: stuck.
- May the drop dialog call the model before «Hinzufügen»? Default: no. Recognition is structural, and the AI runs inside the workflow.
- Risk: wrapping the batch intake per item (unit 9) is the largest refactor. Its gate, the same books as the old job on the demo, is the guard.
- Risk: `statusMatrix` over thousands of receipt files on the real repository. Unit 6 measures it.

## Next implementation step

Unit 8: the AI sidebar (feat/chat ported as a docked sidebar, its working directory the draft) and Ablauf ändern (approvals, `classifyDraft`, replay of saved cases).
