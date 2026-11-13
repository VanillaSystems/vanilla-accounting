# Workflows

**Status: proposed.** Builds on `architecture/workflows/*.md` in the research repo. Runs,
replay and resume are the biggest new piece of 0.4.0 and the least settled. Clickable mockup
of the graph, triggers, runs, step details, tasks and changing a workflow: [mockups/workflows.html](mockups/workflows.html).

## From described to executed

Today `processes/<process>.flow.yaml` describes a process: steps, owners, order, gates. The app
draws the graph from the file, but the code does not run it. `uses: npm:fetch-rates` names a
script, and nothing checks that the script does what the step says. The graph drifts from the
code without anything failing.

In 0.4.0 the folder is the program. The runtime executes the declarations, and the graph is
drawn from the same declarations.

```
workflows/booking/
  workflow.yaml            label, triggers, emits, steps
  rates/
    step.yaml              uses: fx.fetch-daily-rates
  facts-present/
    step.yaml              reads, outcomes
    run.ts                 small code of its own
  classify/
    step.yaml              uses: accounting.expenses.classification
  ...
```

```yaml
# workflows/booking/workflow.yaml
label: Book transactions
on:
  event: transaction.settled
  manual: { for: transaction, label: Buchen }
emits: [entry.booked]
steps: [rates, facts-present, classify, vat, check]
guide: booking.guide.yaml      # the rules stay where they are
```

```yaml
# workflows/booking/classify/step.yaml
label: Choose the account and the VAT code
uses: accounting.expenses.classification
reads: [transaction, receipt, counterparty]
emits: [classification]
outcomes:
  decided: vat
  no-rule: new-case            # the new_case exit of today's guides
guide: booking.guide.yaml#classify
knowledge: [suppliers/*]       # the item's own business only
effects: []
```

## What stays

- **The guides.** `<process>.guide.yaml` and the two knowledge layers stay as they are. A step
  points at its guide section with `guide:`, as `with: { guide: … }` does today.
- **Businesses.** `processes/{suppliers,customers,authorities}/<id>.yaml` and
  `knowledge/<role>/<id>.yaml` stay. A step lists the knowledge it reads.
- **`npm run check-processes`** becomes the workflow lint, and it grows the rules below.

## What changes

| Today (`flow.yaml`) | 0.4.0 (`workflow.yaml` + `step.yaml`) |
|---|---|
| one file per process, steps inline | one folder per workflow, one folder per step |
| `needs: [ready]` | `outcomes:` name the next step; edges are outcomes |
| `uses: npm:fetch-rates` | `uses: <action>`, an action from the command registry (ADR 0005) |
| `kind: start` | `on:` triggers: event, manual, schedule, outside |
| `phases: [...]`, `phase` | `phase:` and `cadence:` on each workflow; the process map groups workflows by phase, in the order of the year |
| `duration` | kept as display metadata |
| a process is a file | a process is drawn from the workflows' events; nobody defines it by hand |

## Rules the runtime and the lint enforce

1. A step receives only what it declares in `reads`, and returns only what it declares in `emits`.
2. A step picks its branch by returning one of its `outcomes`. It never calls another step.
3. A step never imports another step. Shared code is an action.
4. A step causes side effects only through the handles of the effects it declares. A booking is
   an effect: `effects: [ledger.book]` gives the step a `LedgerWritePort` with the run as actor.
5. A level shows at most nine nodes. Beyond that, a group folder.

## Runs

A run is one execution for one business item: one transaction, one receipt, one quarter.

- A run that cannot continue is **stuck**, not failed. Stuck runs form the inbox of the
  Abschluss area.
- **Replay** runs a recorded case against a changed workflow with effects muted: the would-be
  booking shows on the graph and is not written.
- **Resume** continues a real stuck run on the new version. Finished steps keep their output.
- A replayed case the person confirms becomes a test case, replayed before every later change.
- Every booking made by a run links back to it: from Buchungen, "why is this booked like
  this?" opens the run and the step that decided it.

### When a run needs a person

A run that cannot go on by itself is in one of three states, and each has its own owner:

| State | Cause | Declared by | Who acts |
|---|---|---|---|
| **retrying** | network, timeout, a site that is down | `retry: { on, times, backoff }` on the step | nobody; it shows, and turns into *stuck* when the retries run out |
| **waiting for you** | a login with a code, a decision, a missing receipt | an outcome that leads to a `by: person` step with a `task:` | the person the task names |
| **stuck** | something unexpected: a bug in the workflow | no outcome matched | whoever maintains the workflow, with the run to replay |

- **Granular.** A step with `for-each: <item>` runs once per item (a mailbox, a portal, a
  transaction). One item waiting holds no other item up, and resuming it reruns nothing that
  finished.
- **The task says what to do.** `task:` declares the title, the reason, the action (for a login:
  a window that belongs to the person; the AI sees neither password nor code), the deadline and
  the reminders (`notification`, `morning-summary`). Tasks from every workflow gather in one list,
  and the dock badge counts them.
- **Continuing is an outcome.** The person step ends with `done`, `skip` or `pause`, and the run
  goes on from there for that item only.
- **Before it breaks.** A source can report when its session expires; a task appears days
  before the login fails.
- **A rule can ask.** A company rule whose `then` is `{ ask: "…" }` (src/booking/rules.ts) holds a
  matching payment: the inbox run does not book it and starts the workflow `ask` for it
  (workflows/ask/, through the effect `runs.start`, one open question per payment). Its task is
  «Frag: <the rule's question>» with the booking the app would make (the rule's own, else the
  model's); **Übernehmen** books it, **Selbst buchen** closes the task for a booking by hand. The
  workflow reads no guide, so it needs no switching on. Without a model, the inbox run holds
  every open payment no rule decides the same way; its task is «Zahlung von Hand buchen» with the
  payment it is about (who, how much, when: the server reads it off the books, so the corner names
  it too) and its booking form, and **Gebucht** closes it. From three such tasks on the corner shows
  them as one line, «11 Zahlungen von Hand buchen» (the step's `task.many`), Aufgaben lists them.
- **A question is not a task.** What one person asks another about an item (views.md,
  "Questions between the people who keep the books") waits in Aufgaben beside the tasks, but no
  run waits for it. Planned: the person step «Bewegung von Hand buchen» carries such a question,
  so the booking that cannot decide asks the owner instead of guessing.
- **The booking asks about sales without an invoice.** The step `intake.book` (classifyStep)
  ends by asking the owner once about each customer payment it booked as revenue with no receipt
  and no invoice (at the app's proposal: the normal rate from the VAT territory, the export code
  from abroad) (src/intake/sale-questions.ts, the note `saleAsked`): with
  VAT, abroad, or no sale, with the app's proposal. The answer rebooks the payment and keeps a rule
  keyed by the payer (`when: { payer, direction: in }`), which the next run of the step carries
  out in code before any model call; views.md, "The app asks too".

Mockup: screen 5 of [mockups/workflows.html](mockups/workflows.html).

### Seeing and starting runs

Each workflow shows its last runs as a strip of status icons, oldest left, as CI tools such as
Bamboo do: finished, waiting for you, stuck, running. A click opens the run. The Start button
offers four ways:

| Start | What it does |
|---|---|
| **Resume only the open items** | waiting and stuck items continue from their step; finished items do not run again |
| **Replay this run** | the recorded case runs on today's workflow with effects muted, and shows what it would book |
| **Start** | one new run for one item, the same as the workflow's button in its area |
| **Start customized** | choose the item, the version (current, or a draft not yet switched on), and a dry run |

Nothing is booked twice: an effect a run already had is recorded with its idempotency key and
skipped on any rerun. A draft version only runs as a dry run until it is switched on.

### Matching is started by a person, per period

A booking is made from the bank transaction (cash basis); the receipt decides the VAT. Either can
arrive first. Matching each receipt the moment it arrives would mostly find nothing and run the
model for nothing. So collecting runs on its own, and **Zuordnen und buchen** is started by a
person for a month or a quarter. Before it starts, it shows whether the period is complete: each
bank account's statement up to which date, how many receipts, which statement is missing. A
transaction that has its receipt then goes on to *Buchen* by itself.

The automatic triggers stay in `workflow.yaml`, switched off (`off: true`); a company whose
receipts and statements arrive continuously switches them on, which is a change saved like any
other.

### The queue

**Warteschlange**, the first entry of Automatisierung, shows across all workflows what runs,
what is queued and why, what is parked, and what finished:

- **Läuft:** each run with its step and progress.
- **In der Schlange,** in order, each with its reason: a free AI slot (at most two AI steps at a
  time, for cost and rate limits), one account's transactions in date order, a schedule. An item
  can be taken out; its file stays in the inbox.
- **Geparkt** is not the queue: runs waiting for a person or for an event, linked.
- **Fertig:** recent runs with the run-strip icons, time and duration.
- **Pausieren** lets running work finish and starts nothing new; schedules catch up afterwards.

### Changing a workflow

Changing a workflow needs no tool beside the app. There are three ways, and all of them go
through the same check and switch-on (`docs/0.4.0/modules.md`, "Checks before a module counts"):

1. **With the AI in the app.** «Ändern…» on a workflow, a step or a run opens a conversation with
   that context. The AI edits only workspace files (workflows, guides, knowledge) through the
   command registry (ADR 0005). It shows a draft: the diff, every saved case replayed, and the
   kind of change.
2. **Directly, without AI.** Schedule, pause, and the text of a guide rule are edited in place.
3. **With Claude Code or Codex.** A technical user edits the same files in the workspace. The
   app notices and shows the change as a draft from outside.

The route follows the kind of change: a label or a schedule applies at once; a rule, a rate or an
account that changes figures waits for a person to switch it on; new code goes to whoever
maintains the workflow. The approval is stored outside the workspace, so an AI editing the
workspace cannot approve its own change (decisions.md, D6). A rule kept with **Behalten** in the
sidebar or switched off or deleted in Firma › Regeln is a person's click: a workflow that ran
switched on before it runs switched on after it (src/server/routes/rules.ts). So is an answer to
the app's own question in a drop row (a payment provider's clearing account, cut-over day, revenue
or fee account, src/server/provider-payouts.ts `asHerAct`): the workflow's approved state moves with
it, in the same write, and the payouts it decides are booked at once, each by a booking run of its
own. The same file changed by hand, by the AI's draft before it is kept, or by git still waits.
Whatever is switched on with «Einschalten», what waited for it is booked then: an inbox run books
the payments without a booking (`bookWhatWaited`).

Where runs are stored (Git, beside the books, or a local store outside the workspace) is open:
[decisions.md](decisions.md), D3.

## Today's processes, mapped

| `processes/` | Becomes | First trigger |
|---|---|---|
| `receipt-collection.flow.yaml` | `workflows/receipt-collection/` | schedule; manual |
| `receipt-intake.flow.yaml` | `workflows/receipt-intake/` | outside: a file in the inbox (ADR 0008) |
| `bank-import.flow.yaml` | `workflows/bank-import/` | outside: a statement file |
| `evidence.flow.yaml` | `workflows/evidence/` | manual, on a period («Zuordnen und buchen»); the events `transaction.imported` and `receipt.archived` are declared but off by default |
| `booking.flow.yaml` | `workflows/booking/` | event: `transaction.settled` |
| `vat-filing.flow.yaml` | `workflows/vat-filing/` | manual, on a period |
| `quarter-close.flow.yaml` | not a workflow: the process map of the five above | — |
| `year-close.flow.yaml` | `workflows/year-close/` | manual, on a year |
| `new-case.flow.yaml` | `workflows/new-case/`, called by any step's `no-rule` outcome | event |
| `correction.flow.yaml` | `workflows/correction/` | manual, on a closed entry |

`booking` is the pilot (migration step 9): its graph is the clearest, and the `stale` decision
that today is a human's becomes a real outcome once `evidenceKey` exists.
