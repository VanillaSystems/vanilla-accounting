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
bot button at the top right, or ⌘J, opens and closes it; while the sidebar is open that button
shows an arrow to the right («KI-Spalte schliessen»), since the sidebar's own title carries the
bot. ⌘K stays search only.

On a narrow window (issue #34) the page gives way in order: the list narrows to its compact
280 px while the detail keeps at least 420 px, then the sidebar narrows to 320 px (520 px for the
setup conversation, which yields earlier: it leaves the page 820 px before it goes below its
wanted width, #342). With still less room the sidebar lies over the page's right edge instead,
with a shadow, and the page keeps the window with its list compact; ⌘J closes it. Selecting a row
never moves the layout (src/app/shell/look.ts `sidebarFit`). While the sidebar is open the top bar
starts at the page's left edge instead of its middle, so it never lies under the corner's buttons.

**«Was ist noch offen?»** (#342). Before the first message of an ordinary conversation the sidebar
shows a card drawn by code, with or without an AI: the oldest period not filed, when its return is
due, the payments without a booking (and how many of them wait for their receipt), the open
questions, the bookings against their receipts, the receipts without a payment and the workflows'
tasks, each line a link to the first object of it (src/app/assistant/OpenPeriodCard.tsx). The
state is one function over what the review's «Noch offen» list, the receipt wait and the tasks
already hold (src/app/areas/automation/open-period.ts). Every message of a conversation that is
not the setup carries the same state for the model (src/server/open-work.ts `periodNote`), and an
answer to «was muss ich noch machen?» adds the change `openPeriod`, which shows the card under it.

- **Header:** "KI", «Verlauf» (a clock), «Neu» (+), close.
- **A status line** under the header: "2 laufen · 4 in der Schlange · 3 warten auf dich"; a click
  opens the status panel.
- **Verlauf:** the list «Vergangene Gespräche», each with its title, time and context; a click
  continues one, «Verlauf» again goes back to the open conversation.
- **The composer**, at the bottom, one bordered field as VS Code's chat input: the context as
  chips, the text, and a bar with «+» and the round send arrow. «+» opens a search over what can
  go with the message: this page's item (on or off), a receipt, a booking or a payment of the
  books, a workflow or a run (what @ offers too); arrows, Enter and Escape work in it. No mode to choose: the
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
- **«Mit KI …»** on any object adds it to the open conversation as one more chip; with the
  sidebar closed, it opens a new conversation about that object.
- **One conversation goes on** across pages and a reload of the window: the open one's id is
  remembered in the browser and its turns read again at start (src/app/assistant/thread.ts). A
  new one starts only on **Neu**, or from «Mit KI …» with the sidebar closed (wishes test 3: «und
  auch bei den nächsten Rechnungen» after a look at Bilanz & ER landed in a new conversation that
  did not know what «auch» meant).

**What it knows.** The prompt carries a map of the app (src/server/app-map.ts, given to the prompt by the route): every area,
every section of Firma and the export dialog, by the names on screen in the person's language,
what a person does there and which changes the sidebar makes there. It names no web address
(wishes test 3: «unter MWST (/vat)»), and gives the app's own word for a filed quarter
(«eingereicht», not «gefiltert»); the prompt forbids inner names such as `closedThrough`, field
names of the change list and file paths, and the export card names the file, not its path. The map is
keyed by the app's own lists (the areas, `COMPANY_SECTIONS`, the export presets), so a new area or
section does not compile without its line, and tests/assistant-app-map.test.ts checks every area
folder is one of them (wishes test 2026-10-15: the sidebar said the app writes no invoices, has no
payment term and no export package, while Rechnungen, Firma › Rechnungslayout and Exportieren
exist). It never points to a place outside the map. Each message also tells it what waits for
the person now (src/server/open-work.ts): the open questions, the workflows' tasks, the payments
without a booking, the bookings whose VAT code contradicts their receipts, the receipts that may
be a copy of another, and the bookings of the period filed last that contradicted their receipts
and were not settled before filing (they wait for a correction in the open period; Aufgaben lists
them too). Persona round 5, w08: «nichts sonst offen» while «M81 ohne Beleg» was open.

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
  customer who had the old one (as the field there does by hand), and per language the greeting
  line («Anrede», none by default), the texts above and below the table and of the e-mail. Made
  at once, no detour through Änderungen: the owner wants one click, and the card shows each text
  before → after. A greeting («Grüezi») goes into the Anrede above the text before the table and
  never replaces that text; the AI changes a text only as far as asked, from the current one
  (wishes test 3: «Grüezi» replaced the whole thank-you sentence, and the answer said it replaced
  «Sehr geehrte …», which the invoices never had).
- **An invoice draft** (Rechnungen): for a customer, or for a new one added with it. The person
  issues and sends it; the AI never does. Rückgängig deletes the draft and a customer added with it.
- **An export** (a preset of the export dialog, e.g. the Treuhänder-Paket of a quarter): packed
  into data/exports/, the card names the file and downloads it. Nothing to undo.
- **Booking again** («buch alles neu»): the inbox run books every open payment without a booking,
  as it does on its own; the AI never relinks by hand for that. Nothing to undo.

**A fix is made, a rebooking waits for «Übernehmen».** Before the app makes an answer's changes
to the books it tries them on a copy and compares the bookings (src/assistant/held.ts). A fix of one
payment's bookings, its split parts included, is made at once, each change with its Rückgängig.
An answer is held instead, and nothing of it is made, when it

- changes the bookings of several payments that are booked on different accounts today, or of
  more than three payments;
- deletes more than one booking;
- sets a VAT rate code (M81, I81) on a booking whose payment has no receipt that shows Swiss VAT.

It then shows as one card: why («Bucht 6 Zahlungen um, die heute verschieden gebucht sind»), each
booking as it is → as it would be (accounts, code, amount), «kein Beleg mit MWST: Vorsteuer ohne
Nachweis» on a booking that would claim input tax without proof, the answer's other changes (an
account to add), and **Übernehmen** and **Verwerfen**. «Übernehmen» makes them all as one answer,
refused as any answer is; their cards follow with their Rückgängig, and «Alle rückgängig» takes
them all back. «Verwerfen» makes none. The card stays as it was settled, with the conversation;
the next message tells the model whether the person took the changes or not. Persona round 5,
x02: «alles wo karte 5412 steht ist geschäftlich material, immer auf 4000» had moved seven
bookings of four kinds (a ladder booked as an asset, a restaurant meal, two fuel payments, a
purchase without a receipt now on M81) before the person saw any of them.

A direct change that leaves a booking with a rate code and no receipt showing Swiss VAT says so on
its card too.

**Who changed it.** A booking the sidebar changes or adds records the AI as its author (`by:
{ kind: "assistant", conversation, was }`): Buchungen › Herkunft says «KI», «Erfasst: von der KI
geändert am …, auf deinen Wunsch» with «Gespräch öffnen», and «Warum» lists what it changed; a
person's later edit makes the booking hers again. Änderungen lists these bookings beside the
person's own («von der KI geändert»). When the AI changes a booking it changed before, `was` keeps
the fields as first decided.

**A rule card judges on the decisions, not on the AI's moves.** A rule the same answer drafted
is checked for width (src/booking/rule-preview.ts) against each booking as it was before the AI
changed it (its `was`); the card shows «vor der KI: 6200» beside «heute: 4000», so a wish that
first rebooks the payments cannot make its own rule look narrow.

**«Rückgängig» takes back what the change answered.** A change of a sale's VAT code answers the
app's question about that payment (src/server/questions.ts learnFromCorrection); its undo opens the
question again and drops the payer's rule it kept.

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

**What it says is what happened.** All of an answer's changes are made, or none. When the app
refuses them, the answer's own text said they were made («Ich habe die Anrede auf «Grüezi»
gesetzt», wishes test 3), so that text goes: the model, in the same session, gets the refusal and
writes one or two sentences in its place, saying what is not done, why, and what the person can
do. One short call more, and only on a refusal; the conversation then knows it too. The stored
turn keeps the first text as `withdrawn`, the refusal and the new text; the next message tells
the model again that nothing of that answer was changed. Without a model answer (an error, a
stop) the text stays empty and the app's own line «Nicht geändert: …» says why. Marking the claim
in the text was the other way: the app cannot tell which sentence is the claim, so it would have
to strike all of it and the model would still believe it worked. While an answer streams, its
words are grey until the app has applied what it asks for.

A purchase code follows the account a booking lands on (`codeOnAccount` in
src/accounting/vat-codes.ts, rule pv-prefix-from-account): moved to material or goods it takes M,
to operating costs or an investment I, with its rate and sign; the card says «MWST-Code folgt dem
Konto: I81 → M81» (wishes test w02 put M81 on 6100 Unterhalt).

A person's own edits in Buchungen keep their freedom: a split by hand is two edits with a gap
between them, and a correction may hang on a payment with a date of its own. **Rückgängig** on
one booking of a payment takes back the answer's other changes on that payment with it, so its
bookings add up again. A vague wish («mach alles richtig») gets a short question back with what
the AI would do; it never takes back an earlier change or a person's own correction without
naming it. A booking changed by an answer or by hand loses the classifier's reason once its
accounts, code or amount change: the reason named the booking as it was («auf 4400, M81»);
Rückgängig puts it back. A change to how the app works (rules, workflows, knowledge) lands under Änderungen,
unsaved ([saving.md](saving.md)). A rule is the exception that makes the mission's «keeps it
with one click» true: when the answer drafted a rule, its card shows the rule in one plain line
(«Swisscom → Konto 6510 Telefon, MWST I81»), with **Behalten** and **Verwerfen** (a removal:
**Ja, entfernen**). Behalten saves that one draft at once, without the AI step «Speichern
vorbereiten»; a rule the app cannot carry out is named with its reason and cannot be kept
([saving.md](saving.md), "One click for a rule"). **Firma › Regeln** lists every rule of the
company, linked from Automatisierung. The prompt and the map say so: a drafted rule's one click
is «Behalten» on its card, never «Speichern» under Änderungen, and until then the answer says it
is drafted, not set (tests/assistant-app-map.test.ts; wishes test 3 told the person to press
«Speichern»).

### At a limit: «Im Terminal öffnen» (issue #146)

The sidebar's AI reads the folder, writes its block and drafts; it runs no program (Bash is
disallowed). A wish that needs more (one PDF of a quarter's receipts, a converted file, a
script) is never refused: the answer ends with a `vanilla-terminal` block, the request written
out, and its card offers **Im Terminal öffnen**. The button opens Terminal in the books folder
with Claude Code or Codex started on the request (passed through a file as one argument, never
as shell code), offers the other CLI as «oder mit …» when both are installed (the one chosen in
Firma › KI first, Claude without a choice), says first when the CLI will ask to sign in (Codex:
`codex login status`; Claude: the app's own last call answered), shows the command to copy, and
with neither installed links the vendors' installation pages (src/platform/terminal.ts,
src/platform/terminal-open.ts, src/app/assistant/TerminalCard.tsx). The app never checks a plan
and never reads a CLI's login.

The terminal AI reads `vanilla-accounting/AGENTS.md` (Claude Code through `CLAUDE.md`), whose
marked section the app writes on create, on `npm run update` and before each opening
(src/workspace/terminal-agents.ts): read freely, write what it makes into `output/` (ignored by
git), never edit the books, and change them only by a proposal in `data/terminal/<name>.json`
(`{ title, summary, changes }`, the sidebar's change format). The app takes each proposal into
the sidebar as a conversation whose changes wait for **Übernehmen** whatever they change (hold
reason `terminal`, src/assistant/terminal-drafts.ts), and makes them through the sidebar's own
door: the period lock, the seals, the person as author.

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
- **The app asks too: a customer payment without an invoice.** For VAT-registered books, the
  classifier books an incoming payment of the open period with no receipt and no invoice of the
  app with the app's proposal, in code (src/accounting/sales-without-vat.ts `saleCodeOf`), never at
  a zero code for want of a paper. The booking step (`intake.book`, after classify) asks the owner
  about each one once (src/intake/sale-questions.ts; origin `booking`,
  topic `saleVat`, «die App» as the asker). The card says who paid what on which day and offers
  «mit MWST (8.1 %)», «ohne MWST (Ausland)» and «keine MWST darauf (kein Umsatz: Darlehen,
  Rückzahlung …)». The app's proposal is the highlighted button, marked «Vorschlag», with its
  reason: the books' currency from an IBAN of the VAT territory (`invoicing.yaml` `territory`,
  CH and LI) proposes the normal rate; a foreign currency or a foreign IBAN proposes the export
  code. The rate and the codes come from the jurisdiction (`saleAt`, `deductedIn` of the
  export box). The answer, through the edits and the period lock: the sale's revenue entries get
  the normal-rate or the export code and become the person's (origin `manual`); «kein Umsatz»
  moves them to the owner's account without a code (the money leaves the turnover; the owner sets
  a loan's or a repayment's account in the booking) and marks the payment as needing no receipt. The answer is kept as a rule of
  the step `classify` in `knowledge/rules/booking.guide.yaml`, `when: { payer, direction: in }`
  (the payer's IBAN, else its bank counterparty text) and `then: { account, vat }`, so the
  classifier books that payer's next payment by the rule, without a question (Firma › Regeln
  lists it). A payer the bank names only by a generic text («Gutschrift») gets no rule: the next
  such payment is asked again. A payment with a receipt or booked from an invoice, or one of a
  filed quarter, is never changed: the answer is refused and says why. The card says how the
  payment is booked while it waits («Bis zu deiner Antwort ist sie mit V81 gebucht»). The warning
  on the payment, in MWST and in Automatisierung (a sale still at a zero code) stays until the
  question is answered. «Zurücknehmen» takes the booking, the mark and the rule back. A person's
  correction answers the question too: when she sets the code of such a sale by hand or by a wish,
  the app answers its question with her code (asking it first if it had not) and keeps the rule,
  so «Neu klassifizieren» › «Trotzdem neu buchen» books what she set (src/server/questions.ts
  `learnFromCorrection`; the card says «aus deiner Korrektur der Buchung»). Its «Zurücknehmen»
  drops the rule and keeps her booking.

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
