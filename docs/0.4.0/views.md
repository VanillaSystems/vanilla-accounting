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

**What it knows.** The prompt carries a map of the app (src/server/app-map.ts, given to the prompt by the route): every area,
every section of Firma and the export dialog, by the names on screen in the person's language,
with its path, what a person does there and which changes the sidebar makes there. The map is
keyed by the app's own lists (the areas, `COMPANY_SECTIONS`, the export presets), so a new area or
section does not compile without its line, and tests/assistant-app-map.test.ts checks every area
folder is one of them (wishes test 2026-10-15: the sidebar said the app writes no invoices, has no
payment term and no export package, while Rechnungen, Firma › Rechnungslayout and Exportieren
exist). It never points to a place outside the map.

**What it changes.** The AI never writes these files: it names the changes at the end of its
answer, and the app checks them and makes them all, or none and says why in the person's language
(src/assistant/changes.ts; `applyAnswer` in src/server/edits.ts for the books,
src/server/workspace-edits.ts for the rest, src/server/routes/assistant.ts in between). Each shows
in the answer as a card with **Zeigen** (it opens what changed) and **Rückgängig**:

- **The books:** a receipt's date, amount, currency, description or VAT; a link between a receipt
  and a payment; a receipt's kind (a duplicate or no receipt at all: its links go and its
  payments are booked again, as «ist dasselbe» does; Rückgängig links it again); a booking's
  accounts, VAT code, amount, date or text; a new booking on a payment; a booking deleted.
- **The chart:** an account added or renamed (Firma › Kontenplan). It is made before the bookings
  of the same answer, so a booking may go on it; Rückgängig of an account the answer added takes
  the answer's bookings on it back too. The chart is never drafted (wishes test w12: bookings
  pointed at an account that existed only in a draft).
- **The invoicing settings** (Firma › Rechnungslayout): the payment term, which also goes to every
  customer who had the old one (as the field there does by hand), and per language the texts above
  and below the table and of the e-mail. Made at once, no detour through Änderungen: the owner
  wants one click, and the card says plainly what is set now.
- **An invoice draft** (Rechnungen): for a customer, or for a new one added with it. The person
  issues and sends it; the AI never does. Rückgängig deletes the draft and a customer added with it.
- **An export** (a preset of the export dialog, e.g. the Treuhänder-Paket of a quarter): packed
  into data/exports/, the card downloads it and names where it lies. Nothing to undo.
- **Booking again** («buch alles neu»): the inbox run books every open payment without a booking,
  as it does on its own; the AI never relinks by hand for that. Nothing to undo.

It refuses an answer that

- touches a filed quarter, as any edit does;
- dates a payment's booking off the payment's date: the VAT is reported on payments received, so
  a booking of a payment carries its date and its quarter, also when the invoice is older (only
  bookings on the payout clearing account take the order's date, as classify books them;
  src/accounting/payment-entries.ts);
- changes what a payment's bookings move on its bank account and leaves them not adding up to
  what the bank paid. A private share is a split: the business part changed and the private part
  added on the owner's account (the Kontokorrent of a GmbH or AG, the Privatkonto of an
  Einzelfirma), without a VAT code, in one answer;
- books on an account the chart does not have (unless the same answer adds it);
- takes back a change an earlier answer of the conversation made: that change's own Rückgängig
  does it (wishes test w06 relinked a photo the person had asked to remove);
- links a receipt a person set aside as a duplicate or no receipt.

A purchase code follows the account a booking lands on (`codeOnAccount` in
src/accounting/vat-codes.ts, rule pv-prefix-from-account): moved to material or goods it takes M,
to operating costs or an investment I, with its rate and sign; the card says «MWST-Code folgt dem
Konto: I81 → M81» (wishes test w02 put M81 on 6100 Unterhalt).

A person's own edits in Buchungen keep their freedom: a split by hand is two edits with a gap
between them, and a correction may hang on a payment with a date of its own. **Rückgängig** on
one booking of a payment takes back the answer's other changes on that payment with it, so its
bookings add up again. A vague wish («mach alles richtig») gets a short question back with what
the AI would do; it never takes back an earlier change or a person's own correction without
naming it. A change to how the app works (rules, workflows, knowledge) lands under Änderungen,
unsaved ([saving.md](saving.md)). A rule is the exception that makes the mission's «keeps it
with one click» true: when the answer drafted a rule, its card shows the rule in one plain line
(«Swisscom → Konto 6510 Telefon, MWST I81»), with **Behalten** and **Verwerfen** (a removal:
**Ja, entfernen**). Behalten saves that one draft at once, without the AI step «Speichern
vorbereiten»; a rule the app cannot carry out is named with its reason and cannot be kept
([saving.md](saving.md), "One click for a rule"). **Firma › Regeln** lists every rule of the
company, linked from Automatisierung.

## Questions between the people who keep the books

The accountant and the owner ask each other what only the other knows, on the item itself:
«Wofür ist dieser Beleg?», «Privat oder geschäftlich?», «Welches Projekt?». There is no server
and no e-mail; the questions travel with the books folder (git, a shared folder), so each sees
the other's when they next open the books.

- **Two clones, one file.** The repository's `.gitattributes` (written by `npm run init`, and in
  the demos) says `vanilla-accounting/transactional-data/*/questions.jsonl merge=union`: when the
  accountant and the owner both asked or answered before they synced, git keeps both sides'
  lines instead of a conflict, and the fold puts them in order. A repository set up before this
  needs the line added once.
- **Where they are kept.** `transactional-data/<year>/questions.jsonl` (`LAYOUT`), one event per
  line, appended and never rewritten: `asked` (on a payment, receipt or booking, by whom, to whom,
  the text, the choices `private` / `business`, or for the app's own question its `topic` and
  `proposal`), `answered` (a choice or a few words, with what
  the app did), `undone` (the answer's bookings taken back, open again), `closed` (`done` by the
  asker, or `withdrawn`). A question is the fold of its lines (src/questions/model.ts); a line
  goes to the year it is written in, or the first open year after it. API: `GET /api/questions`,
  `POST /api/questions`, `…/:id/answer`, `…/:id/undo`, `…/:id/close`.
- **Asking.** «Frage stellen» on a payment (Kontoauszüge), a receipt (Belege) and a booking
  (Buchungen): «Ich bin» (the viewer's name, kept in this browser; the owner's by default),
  «An» (a name from the books' people or a new one), the question, and whether the answer is
  «privat» or «geschäftlich». A booking also shows the questions on its payment and receipts, a
  payment those on its receipts and bookings.
- **Where the other person looks.** Automatisierung › Aufgaben lists «Fragen an dich» (open
  questions put to the viewer, or put to nobody and asked by someone else) and «Deine offenen
  Fragen» (the viewer's own until they mark them «Erledigt»). The dock's badge, the Aufgaben row
  and the status corner count the questions waiting for the viewer.
- **Answering.** One click for «privat» or «geschäftlich», or a few words and ↵. The asker sees
  «beantwortet» with the answer and what the app did.
- **An answer that decides acts, code first.** «privat» on a payment books it on the owner's
  account without a VAT code, as the sidebar and the booking by hand do: an unbooked payment gets
  one booking against its bank, a booked one has its expense side moved and its code removed (a
  booking that is not bank against expense is not guessed at). «privat» or «geschäftlich» is kept
  as a precedent of the booking guide's `private` step in `knowledge/rules/booking.guide.yaml`,
  with `match` and `choice`; the next such question about the same counterparty is answered by it
  at once, and booked. A wrong auto-answer is worse than a question, so `match` names one
  counterparty for certain (src/knowledge/precedents.ts `precedentKey`): the receipts' one VAT
  number (`uid`), else their one vendor (`vendor`), else the bank's counterparty text (`tx`) when
  it is not generic. A text of nothing but ways to pay and numbers («Karte 5412 Einkauf»,
  «Kartenzahlung», «TWINT Zahlung …») names nobody: the answer books, but is kept as no
  precedent, and the next such payment is asked again. A filed quarter, a receipt with no or several
  payments, an answer in words: the app books nothing and the asker decides. «Zurücknehmen» takes
  the bookings and the precedent back and opens the question again.
- **The AI asks too.** A change `question` of the sidebar's block puts a question to the owner
  (or the person it names) when the AI cannot decide; its card's «Rückgängig» withdraws it.
- **The app asks too: a customer payment without an invoice.** For VAT-registered books, an
  incoming payment of the open period with no receipt and no invoice of the app, booked as revenue
  at a zero code, would be declared as an export. The booking step (`intake.book`, after
  classify) asks the owner about each one once (src/intake/sale-questions.ts; origin `booking`,
  topic `saleVat`, «die App» as the asker). The card says who paid what on which day and offers
  «mit MWST (8.1 %)», «ohne MWST (Ausland)» and «keine MWST darauf (kein Umsatz: Darlehen,
  Rückzahlung …)». The app's proposal is the highlighted button, marked «Vorschlag», with its
  reason: the books' currency from an IBAN of the VAT territory (`invoicing.yaml` `territory`,
  CH and LI) proposes the normal rate; a foreign currency or a foreign IBAN proposes the export
  code. The rate and the codes come from the jurisdiction (`saleAt`, `deductedIn` of the
  export box). The answer, through the edits and the period lock: the sale's revenue entries get
  the normal-rate or the export code and become the person's (origin `manual`); «kein Umsatz»
  marks the payment as needing no receipt and keeps its booking. The answer is kept as a rule of
  the step `classify` in `knowledge/rules/booking.guide.yaml`, `when: { payer, direction: in }`
  (the payer's IBAN, else its bank counterparty text) and `then: { account, vat }`, so the
  classifier books that payer's next payment by the rule, without a question (Firma › Regeln
  lists it). A payer the bank names only by a generic text («Gutschrift») gets no rule: the next
  such payment is asked again. A payment with a receipt or booked from an invoice, or one of a
  filed quarter, is never changed: the answer is refused and says why. The warning on the payment,
  in MWST and in Automatisierung stays until the question is answered. «Zurücknehmen» takes the
  booking, the mark and the rule back.

## Status, top right

There is no title bar (as in the 0.3 Mac app). The top-right corner holds the AI toggle (⌘J) and one status
indicator for all workflows; search is in the top bar (⌘K):

| State | Shows |
|---|---|
| something runs | a spinner and "2 laufen" |
| nothing runs, something waits for a person (a task or a question to the viewer) | an amber dot and "3 für dich" |
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
