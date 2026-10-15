# Views

**Status: proposed.** Clickable mockup: [mockups/workflows.html](mockups/workflows.html). The 0.3.0 redesign (`docs/redesign/architecture.md`) already gives the
UI its shape: areas registered in `src/app/areas/index.ts`, one route parser, list + detail.
0.4.0 keeps all of that and changes what a view may know.

## What a view does

- **Reads** through queries: the books, the resolved modules (`/modules.json`), runs.
- **Writes** by direct edit through the write door, as today's routes do through `withBooks`
  and `assertOpen`. A direct edit runs no workflow; it emits an event, and a workflow may
  listen.
- **Shows the buttons workflows declare.** A `workflow.yaml` with `manual: { for: invoice,
  label: Bezahlen }` puts a button on every invoice detail. Remove the workflow, and the button
  goes with it.
- **Shows runs.** A record a run produced links to the run; the run opens on its graph.

## What a view never does

- Name a jurisdiction. The VAT area renders the boxes `return.yaml` defines, with the labels
  from `texts/`. Today `src/app/areas/vat/` knows the Ziffern; in 0.4.0 it knows "a return with
  boxes and sums".
- Hold a process. "Book this transaction" is a workflow's button, not a view's code path.
- Compute a rule the server computes differently. Figures come from engines, which run in the
  browser and the server from the same data.

## AI is always marked

Wherever AI decides or acts, the view shows the Lucide `bot` icon. The rule is structural, not
a judgment per screen: a step with `kind: agent` (or `by: ai`) in its `step.yaml` is an AI step,
and the icon follows from that.

- **AI steps** in the graph carry the icon and their own colour (a token, `--ai`, light and dark).
- **A workflow that contains an AI step** carries it in the list of the Automatisierung area and on the process map.
- **Every trigger that starts such a workflow** carries it: the button in an area (Buchen, Beleg
  zuordnen), the trigger card, a scheduled or event trigger.
- **Every record an AI step wrote** carries it: a journal entry booked by `classify` shows
  "von KI gebucht" next to its link to the run.
- **A run** names the step in which AI decided.

A workflow without an AI step shows no icon (the VAT filing's «Abrechnung erstellen»). The icon
says "an AI is involved", never "this is uncertain": confidence is a separate signal.

## Both bars: collapsed, never hidden, each with its own pin

The app has two bars that fold away: the **top bar** (company, search ⌘K, period, zoom, export,
theme, language; as in 0.3) and the **dock** at the bottom (the areas). Both behave the same way,
and each has its own pin, because they are used differently: the dock all the time, the top bar
now and then. A person may pin one and not the other.

- **Folded, a bar is a small pill**, never nothing: the top bar shows "Beispiel GmbH · 2026-Q4 ▾"
  (so the period stays visible), the dock shows the current area and the open count. Hover, a
  click or keyboard focus opens it.
- **New users see both open** until they have used each three times; then that bar folds once,
  with a tip that points at its pin.
- **The pin** at the right end of each bar: a checkbox and a pin icon. Ticked: the bar stays
  open. Unticked: it folds when the mouse leaves. Hovering or focusing it shows a tooltip that
  explains both states, the current one emphasized.
- Both bars belong to the page and stay centred on it when the AI sidebar is open.

## Navigation at the bottom

- **Collapsed, never hidden.** When the dock is folded, a small pill stays at the bottom centre:
  the current area ("▴ Automatisierung") and the count of open items. Hover or a click opens the
  full dock; a click works without a mouse, and keyboard focus opens it too.
- **New users see it open.** The dock stays open until the person has used it three times. Then
  it folds once, with a tip: "Die Leiste klappt sich ab jetzt ein. Fahr mit der Maus nach unten
  oder klick auf sie", and «Immer zeigen» / «Verstanden».
- **The pin at its right end keeps it open** (see above); the same choice is in Firma ›
  Darstellung.
- **It belongs to the page.** With the AI sidebar open, the dock stays centred on the page, not
  on the window, so it never covers the AI's composer. The sidebar is drawn as a separate card
  with a gap, so the page and its dock read as one surface and the sidebar as another.

## The AI, as a sidebar

The AI lives in a sidebar on the right, docked: the page gets narrower, nothing is covered. The
bot button at the top right, or ⌘J, opens and closes it. ⌘K stays search only.

- **Header:** "KI", a new conversation (+), more (⋯), close.
- **A status line** under the header: "2 laufen · 4 in der Schlange · 3 warten auf dich"; a click
  opens the status panel.
- **Gespräche:** past conversations with their title, time and context; a click continues one.
- **The composer**, at the bottom: a tip ("mit @ erwähnst du eine Buchung, einen Beleg oder einen
  Ablauf"), the context as chips, the text, the model (**Auto**), send. No mode to choose: the
  AI does what the person asks (usability test 2026-10-15: an owner asked it to fix a receipt and
  was told to switch modes and save drafts). No dictation in 0.4.0: speech to text would need a
  large local library. Underneath: where it runs ("Lokal · Claude").
- **The composer shows its state:** empty, the send arrow is grey; with text, it turns blue, and
  the frame is blue while it has focus. After sending, the field empties, the arrow goes grey,
  the tip line hides, the frame's border rotates in a gradient while the AI works, and a small
  spinner shows at the end of the footer. With reduced motion, the border stays a still blue.
- **Context is a reference, not a screenshot.** The AI receives *what* the person is looking at
  (a run, a booking, a workflow, a period) and reads the real record itself through the
  command registry's read commands (ADR 0005); it reads nothing else unless it looks it up, and
  every lookup is listed under a small **Details** toggle above its answer, closed by default (a
  person who keeps books does not know what a Glob is; usability test 2026-10-15, Malerei Huber).
  Three ways to give it:
  1. **The view, automatically:** a dashed chip "Ansicht: Lauf 1047" follows navigation until
     the first message, then stays with the conversation. × sends without it ("ohne Kontext").
  2. **@ in the text:** a list of runs, bookings, receipts, workflows, files and periods,
     filtered as the person types; a pick becomes a chip.
  3. **The + menu:** this view, the selected rows, search, a file attached for this
     conversation only.
- **«Mit KI ändern…»** on any object opens the sidebar with that object as context.

**What it changes.** A change to the books (a receipt's date, amount, currency, description or
VAT; a link between a receipt and a payment; a booking's accounts, VAT code, amount, date or
text; a new booking on a payment; a booking deleted) is made at once and shows in the answer as a
card with **Rückgängig**. The AI never writes the books' files: it names the changes at the end
of its answer, and the app checks them and makes them all in one write, or none and says why in
the person's language (src/assistant/changes.ts, `applyAnswer` in src/server/edits.ts). It
refuses an answer that

- touches a filed quarter, as any edit does;
- dates a payment's booking off the payment's date: the VAT is reported on payments received, so
  a booking of a payment carries its date and its quarter, also when the invoice is older (only
  bookings on the payout clearing account take the order's date, as classify books them;
  src/accounting/payment-entries.ts);
- changes what a payment's bookings move on its bank account and leaves them not adding up to
  what the bank paid. A private share is a split: the business part changed and the private part
  added on the owner's account (the Kontokorrent of a GmbH or AG, the Privatkonto of an
  Einzelfirma), without a VAT code, in one answer.

A person's own edits in Buchungen keep their freedom: a split by hand is two edits with a gap
between them, and a correction may hang on a payment with a date of its own. **Rückgängig** on
one booking of a payment takes back the answer's other changes on that payment with it, so its
bookings add up again. A vague wish («mach alles richtig») gets a short question back with what
the AI would do; it never takes back an earlier change of its own without saying so, and never
points to a button it has not seen. A change to how the app works (rules, workflows, knowledge,
settings) lands under Änderungen, unsaved ([saving.md](saving.md)).

The app window does not scroll as a page: the list, the detail and the sidebar each scroll on
their own, so the composer and the dock stay in place.

## Status, top right

There is no title bar (as in the 0.3 Mac app). The top-right corner holds the AI toggle (⌘J) and one status
indicator for all workflows; search is in the top bar (⌘K):

| State | Shows |
|---|---|
| something runs | a spinner and "2 laufen" |
| nothing runs, something waits for a person | an amber dot and "3 für dich" |
| all quiet | nothing |

A click opens a panel below it that updates while it is open: each running run with its bar and
step, how many are queued, how many wait for a person, the last finished runs, and links to
**Warteschlange** and **Aufgaben**. A click elsewhere or Esc closes it. A finished import still
sends its notification when the person is elsewhere.

## Areas and modules

| Area | Reads from modules | Contributed by workflows |
|---|---|---|
| Belege | receipt kinds, VAT facts | intake runs, the new-case inbox |
| Kontoauszüge | bank kinds (providers) | import and evidence runs |
| Buchungen | tax codes by meaning, chart | "why booked like this" → run |
| MWST | `return.yaml`, form 0535 | the filing workflow's button |
| MWST-Codes | `tax-codes.yaml`, `rates.yaml` | — |
| Bilanz & ER | `chart.yaml`, `statements.yaml` | — |
| Abschluss | `periods.yaml`, `year-end.yaml` | stuck runs, close workflows |
| Firma › Module | every module, overlay state, notices | switch-on approvals |
| Rechnungen | `invoicing.yaml`, layout module | send, remind, book on payment |

**Automatisierung** is a new area in the dock: every workflow with its triggers, its graph,
its runs and the stuck ones. URL `/automatisierung/<workflow>`. Its items are called Abläufe.

**Firma › Module** is the other new page: which modules run, which keys the company overlays, the
notices an upgrade raised ("the app changed a file you replaced": show difference, keep, adopt),
and the changes waiting to be switched on.

## Can a module add a view?

Not in 0.4.0. A module contributes data that existing areas render, and a workflow contributes
buttons and runs. A module that needs its own screen is a later question: it would put module
code in the browser, which the data/code rule keeps out ([decisions.md](decisions.md), D8).
