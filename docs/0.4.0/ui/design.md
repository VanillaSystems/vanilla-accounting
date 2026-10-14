# Synthesis: three servers, everything else derived (base: candidate opus)

## Problem

The 0.4.0 mockup (`docs/0.4.0/mockups/workflows.html`, 9 screens plus the sidebar, the status corner and the folding bars) must run in the app on the owner's real, migrated books. Today almost none of it has a source. Only the booking pilot runs, from the CLI. A run is saved only when it finishes, has no `running`, `queued` or `retrying` state, and a waiting run has no task. Nine processes exist only as `processes/*.flow.yaml`. Those flows have 11 to 29 steps, backward `needs` edges and no triggers. No server route starts a run. Nothing reads the workspace's git. The year-close commit silently fails since ADR 0013 because it looks for `.git` in the wrong folder. The chat is on unmerged `origin/feat/chat` and floats over the page instead of sitting in a sidebar. The mockup's screens all read a few hand-written fixtures (`WF`, `QUEUE`, `SRC`, `UNSAVED`, `SAVES`, `PREP`, `SESS`). The real question is which few stored things those fixtures become, so that the queue, the tasks, the badge, the corner, the "since the last save" list and the run links cannot disagree with each other.

Constraints carried in: golden rule 1 (writes go only through `update(books, actor, fn)`, and nothing of a filed quarter changes), D3 (runs live outside git), D4a (own runner), D9 (replay uses recorded answers), D11 (workflows and the AI write, a person saves). The repo's own rules apply: i18n in 4 locales, no hard-coded strings, the import-cycle test, and `Overlay` swallows keys. Each step deletes the old path it replaces, and `test:books` never changes.

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
// Änderungen
const view = useChanges();                    // raw changes (no model), proposal (ready | stale), history, sync
await savingCommand({ kind: 'prepare' });     // one model call
await savingCommand({ kind: 'talk', text: 'Das Logo noch nicht' });
await savingCommand({ kind: 'save', sync: true });  // refused with 'stale' if any basis hash moved
```

```sh
npm run workflow -- booking BT-2026-10-14-03   # with the server up: sent to it (one engine); without: runs in-process, holding the lock
```

## Shape

**Stored state is only three things. Everything a screen shows is derived from them.**

1. **Runs** (`src/workflows/store.ts`, D3 local store). A `Run` holds its `RunState`, a discriminated union with one variant per thing the screens tell apart: `queued{at, reason}`, `running{at}`, `retrying{attempt, next}`, `waiting{task}`, `parked{until event|time}`, `stuck{reason}`, `done`, `discarded`. It also holds an append-only `steps: StepRecord[]`, each with its input, outcome, model calls, a person's answer, and effect records that name the record ids they wrote. Several things are pure functions of runs plus declarations (`model.ts`, browser-safe, shared by server and UI): the queue (`scheduler.plan`), tasks (`taskOf` on a waiting run), the corner, the badge, "Geparkt", run strips, progress (`happyPath`) and the entry→run link (`store.runOfEntry`, from effect records, so the books need no schema change). Nothing keeps its own list, per the separate-before-serializing principle and the single-source-of-truth rule.
2. **Declarations** (`workflows/<id>/workflow.yaml + <step>/step.yaml`, app folder overlaid by the company's `workflows/`). `WorkflowDecl` gains what the mockup draws: localized `label`/`desc`/`cadence`, `phase`, `triggers[]` (manual/event/schedule/outside), and a `StepBody` union. A step does exactly one of `uses`, `run.ts`, `by: person + task`, `calls`, `wait`, so it cannot both call and act. The kind is derived from the body and the action, so the bot icon follows from structure (views.md "AI is always marked"). `runnable` is also derived: an action may be declared in `ACTIONS` before it is implemented. That lets all nine workflows load, draw and explain themselves on screens 1 and 2 at once, while each becomes runnable in its own unit. A not-runnable workflow's Start button names the missing step. This is an encoded, visible state, not a compatibility layer.
3. **Git** (only `src/saving/` reads or writes it). What changed is the working tree against HEAD. Who wrote a books line is decided by joining jsonl record ids with the runs' effect records; any line left over is "direkt bearbeitet". History is `git log` with trailers (`Vanilla-Kind`, `Vanilla-Runs`, `Vanilla-Lock`). The AI's proposal is the only extra file (`data/saving/proposal.json`). It stores the blob hash of every path it covers, so "stale" is derived and a stale proposal cannot be saved (saving.md step 3). Saves split **by record, not by file**. `entries.jsonl` gets lines from the import run and from the FedEx run, and the mockup shows them as two saves. `commitExactly` therefore commits, for a shared books file, HEAD's records plus exactly the save's record ids, re-sorted. This is deterministic because the jsonl files are one line per record, sorted by id. Nobody ever stages a hunk, and the AI never splits a line.

**Switched on = approved (D6 a, workflows.md:176-178).** The engine reads declarations and guides from the working tree. A company workflow version runs live only when `workflows/approvals.ts` (app-local, outside the workspace, out of the AI's reach) approves that version; app workflows are approved by definition. An unapproved version runs `dry` or `replay` only (refusal `draft-live`). `classifyDraft` routes a change by kind: applies-now (label, schedule), needs-switch-on (rules, outcomes, effects), needs-maintainer (any `.ts`). Saving (git) and switching on stay two decisions, as the spec has them.

**The engine is one state machine, one step per call.** `advance(run)` runs one step and persists the run, and is the only executor. Running, waiting, retrying, queueing mid-run for an AI slot, resuming, recovery after a crash, `for-each` part-runs and `call` child-runs all use this one path. The existing `execute()` loop is deleted. Effects keep today's idempotency key `${workflow}:${item}:${step}` and go through `update(books, run actor, …)`, so a crash or a resume never writes twice. There is a single writer: the process holding `engine.lock` (the server while it is up). The CLI sends its command to the server in that case, so two processes never write runs. This is the separate-before-serializing principle. Every state change goes through `transition(run, next)` and the `MOVES` table, so an illegal move throws instead of writing a corrupt run file. A record an effect writes carries `run: <id>` (an optional field on entries, mappings and receipts, D3 "the booking links to the run id"); the run's `EffectRecord.wrote` stays the audit and the Änderungen join key.

**One clock.** The snapshot carries `rev`, bumped on any run write, any declaration-folder hash change, and any change of the repository's index or HEAD. One browser store (`src/app/automation/store.ts`) polls `GET /api/automation?since=rev` (2 s while something runs or a panel is open, 10 s when quiet, paused while hidden, at once on focus) and mostly gets `{unchanged:true}`. Änderungen refetches when `rev` moves. SSE (feat/live-reload) can replace the poll behind the same hooks later.

**Interface depth.** Each server module is one object with a read and one `command(union)`. The HTTP layer has four routes for the automation and two for saving, and each is parse→call→answer. The UI gets one store per module, so no area polls on its own, and `watchIntake`/`/api/intake` are deleted when intake becomes runs. Hidden behind `Automation.command`: scheduling, slots, lanes, retries, events, task creation, replay with recorded answers, effect muting, crash recovery and the run actor. Hidden behind `Saving.command`: git, record-level diffs, run attribution, the model call, proposal staleness, exact-path commits, sync and undo through the write door. The public types are domain types (`AutomationSnapshot`, `ChangesView`), never isomorphic-git or claude NDJSON, per boundary-discipline.

**UI shape.** There are two new areas, `automation` (one List for screens 1, 2, 3, 5 and 9, and a Detail that switches on `route.view`) and `changes` (screen 7). The shell gains four pieces:
- `bars.ts`: a pure reducer `new(uses) → auto(tip) ⇄ pinned`. Whether a bar is open is derived from the pointer and focus. This replaces `useEdges` and `.hint`.
- `Corner` plus `StatusPanel`, an `Overlay` variant.
- The assistant sidebar, which is not an overlay. It is a page sibling, and `--aiw` re-centres every fixed element on the page.
- The drop dialog, an overlay with a server-side session in `data/drop/` (nothing written while it is open).

URLs stay English per urls.md rule 3 (`/automation`, `/changes`); the German names are labels, and views.md:141's `/automatisierung` is corrected to match. The graph layout is a pure, separately tested port of the mockup's `layout()` (`app/areas/automation/graph/layout.ts`); schedules use an own 5-field `workflows/cron.ts`, no dependency.

Areas see the automation only through `WorkflowButtons`, `RunLink` and `AskAi`, and never name a workflow (views.md "What a view never does").

Deliberately out of scope: module views (D8), push transport (one polled `rev`), branches as drafts, the "Zwei Versionen" merge dialog (sync refuses a non-fast-forward with `two-versions`), and rendered previews.

## Delivery sequence

Each unit ends verifiable. The global gate of migration.md applies to every one: `npm test`, `npm run test:books` with no golden update, `check-public` 0, `check-processes` green, the i18n, import-cycle and layers tests (`src/saving` and `src/assistant` get `LAYER_OF` entries), and the old path deleted in the same unit.

| # | Unit | Owner can test on his books | Gate (beyond the global one) |
|---|---|---|---|
| 0 | **Subtract and fix git.** `commitExactly` replaces `commitPaths`; year close commits in `ws.paths.repository`. | a year close commits again | a path left staged by a migration is not in the commit; on a nested-repo fixture the year-close commit lands |
| 1 | **Routes and skeletons.** `Route` variants, `AREA_HOME`, `DOCK` (keys w, v), both areas with empty List/Detail, icons, i18n keys in 4 locales, `--ai` token. | two new dock entries | route round-trip tests for every new URL; i18n and import-cycle tests |
| 2 | **Declarations and the read-only area.** `model.ts`, the new `load.ts` (full schema, company overlay, derived kind and `runnable`), declared-unimplemented actions, the nine workflows declared from the flows and the mockup's `WF` in 4 languages; `GET /api/automation` (declarations plus today's CLI run files, no engine yet); screens 1, 2 and 3 read-only with the graph layout. Runner and CLI move to `WorkflowDecl`; the old `Workflow` type is deleted; flow files stay. | **first real check, no write risk:** all nine workflows, the map, his CLI booking runs | every app workflow loads strict; booking runnable, eight name their missing actions; `layout.ts` tests (no overlaps; the mockup's booking gives its layers); booking by run still equals booking by classify |
| 3 | **Bars.** Pill, pin, fold after 3 uses with the tip, Firma › Darstellung on the same state, `--aiw` centring, `pageWidth()`, no-drag corner; `useEdges` and `.hint` deleted. Independent, any time after 1. | both bars on his screen | reducer table tests |
| 4 | **Engine in the server.** Runs persisted per step, `transition`, `engine.lock`, `advance()`, `scheduler.plan` (2 AI / 4 other, lanes, pause), event bus, cron, person steps → `waiting{task}`, recovery, `POST /api/automation`, the CLI sends to the server when it is up; corner, status panel, Warteschlange, Aufgaben; effects write the `run` field. | a booking started from the UI on an open Q4 transaction, the queue, a task answered | crash between steps recovers with no effect twice; 3 AI runs give 2 running and 1 queued (ai-slot); lane order; an answer resumes one part; replay writes nothing; an illegal transition throws |
| 5 | **Triggers in other areas (screen 4).** `WorkflowButtons`, `RunLink`, `AskAi` in bank, journal, vat, receipts; the classify-this-payment route is deleted (one way to book). | «Buchen» on a payment, "Warum so gebucht?" on an entry | removing a manual trigger removes its button; `RunLink` reads the `run` field |
| 6 | **Änderungen, read.** `saving.view()`: changes by run (record ids), direct edits, files, history with trailers, diff and whole-file dialog. No model. | what his runs and edits changed since his last commit | fixture repo: a run writes 3, a person edits 1, a guide changes → byRun 3, direct 1, files 1; `GET /api/changes` under 1 s measured on his repository |
| 7 | **Saving, write.** prepare/talk/refresh (one `ask` each), save by record (`commitExactly`, trailers, basis check), sync through the git binary, undo through `update(PERSON)`, `saveAction` for filing, seal and year close. | save his day's work | a stale proposal is refused; two saves over one `entries.jsonl` give two commits whose union is the tree; undo in a closed period is refused |
| 8 | **AI sidebar and Ablauf ändern.** feat/chat ported as the docked sidebar (persisted conversations, `ContextRef` chips, @, modes, ⌘J); approvals, `classifyDraft` and replay on the draft for screen 6; `PATCH` of a trigger for the direct path. | ask about a stuck run, change a rule, see the replay, switch it on | ask mode has no Edit/Write; change-mode globs reach no `*.ts`, nothing in `transactional-data/`, not the approvals file; an unapproved version never runs live |
| 9 | **Intake as runs.** receipt-intake, bank-import and evidence runnable; the inbox is their outside trigger; `/api/intake`, its job, `watchIntake` and its polls deleted, with their flow files. | drop a receipt and watch per-file runs | the demo intake by runs gives the old job's books; a restart mid-intake resumes |
| 10 | **Drop dialog (screen 8).** Session in `data/drop/`, cheap recognition, tabs, ZIP (zip.js for AES), quarantine, commit → outside triggers. | drop a ZIP and a camt file | zip bomb, depth and 7z refused; no password on disk; a duplicate is not taken |
| 11 | **The rest, one workflow per commit.** new-case, vat-filing, correction, year-close, receipt-collection; each deletes its flow file, the last one quarter-close.flow.yaml. | screen 5's portal login | per workflow, a run equals today's path on the demo |

Units 0 to 2 give the owner a real, read-only Automatisierung on his books before anything writes. Units 4 and 5 let him start and answer runs, 6 and 7 show and commit what they wrote, and the sidebar (8) arrives behind both a save gate and an approval gate.

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

- We accept a second app-local store (approvals) beside git in exchange for saving and switching on staying two decisions, as workflows.md and D6 say; an AI can write a rule into the working tree but cannot switch it on.
- For eight processes, `flow.yaml` and a declared-but-not-runnable workflow folder coexist until each one runs. In exchange, screens 1 and 2 are complete from unit 3, and the migration's "deleted when its workflow runs" rule holds.
- We accept polling one `rev` (2 s busy / 10 s quiet) in exchange for no held connections and no feat/live-reload rewrite yet; an outside change shows within one poll.
- One engine per workspace: the CLI depends on the server when the server is up. In exchange, runs never have two writers.
- We accept one optional books field (`run`) in exchange for a link that travels with the books; no migration, no seal change (closed records never gain it), no golden update.
- Workflow and step labels are localized maps in YAML (four languages for app workflows, checked by the i18n test). In exchange, a company workflow brings its own words and `de.ts` names no workflow.
- Sync shells out to the user's `git` binary (credential helper) while all local git stays in isomorphic-git. In exchange, no token handling in the app.
- The whole snapshot goes over the wire on each change (tens of KB, locally). In exchange, no diff protocol.

## Alternatives considered

- **Render `processes/*.flow.yaml` as the screens' model** (draw today's flows, wire runs later). Shallow: the UI would learn two schemas (flows have 29-step levels, `needs` back edges, no triggers), and the drawn graph would not be the one that runs, which is the drift workflows.md exists to end. Rejected.
- **Port the mockup's fixtures into the app first and wire them later.** The owner wants his real books. A fixture layer is a second source that each screen would have to be unplugged from. Rejected.
- **Separate stores for the queue, tasks and a change log** (written by every writer). Split ownership: the engine, the intake job, UI routes and Claude Code would each have to remember to append. The queue would say one thing while the runs do another. Rejected in favour of deriving from runs and from git.
- **SSE plus fs.watch (feat/live-reload)** as the live channel. It is more capable, but it must be rewritten for the ADR 0013 paths, needs an own-writes registry and per-kind reloads, and none of this candidate's screens need push beyond what one polled `rev` gives. It can come later behind `useAutomation()` without touching a screen.
- **Drafts as hidden git branches** (ADR 0003 §2) instead of working tree = draft. That shape is right for several contributors, but it adds branch switching under a running engine for a single owner. The `DeclarationSource` type leaves room for a `branch` variant later.
- **The AI sidebar as an `Overlay`** (or feat/chat's floating composer). An overlay swallows the page's keys and covers it, against views.md. Rejected.

## Implementation reconciliation

*(empty until implementation)*

## Open questions and risks

- Sync: does the owner's repository have a remote, and is it SSH or HTTPS? Until that is answered, sync stays behind its port and only save is exercised.
- Old CLI booking runs that ended `waiting` without a task: show them as `stuck` (`no-outcome`), or give them a generic "Von Hand buchen" task? Default: stuck.
- May the drop dialog call the model before «Hinzufügen»? Default: no. Recognition is structural, and the AI runs inside the workflow.
- Should «automatisch speichern» commit after every finished live run, with a template message?
- Risk: wrapping the batch intake per item (unit 9) is the largest refactor. Its gate, the same books as the old job on the demo, is the guard.
- Risk: `statusMatrix` over thousands of receipt files on the real repository. Unit 6 measures it.

## Next implementation step

Unit 0: write `commitExactly` with its stray-staged-path test, and point the year-close commit at `ws.paths.repository` with the nested-repository fixture test.
