# Onboarding as a conversation

The owner chose design B (docs/0.4.0/mockups/onboarding-chat/): a new workspace is set up in one
conversation with a Vanilla Accounting setup specialist, in a chat about twice as wide as the AI
column. Design A (docs/0.4.0/mockups/onboarding/) stays the reference for what each step asks.

## Decisions

**Where it lives.** The setup is the AI sidebar in a wide setup mode, not a window of its own and
not a modal that blocks the page. A conversation with the purpose `onboarding` widens the sidebar
(src/app/shell/look.ts `sidebarWidths`); the page narrows beside it and stays usable, so a
person can open Firma › MWST from the rail and save a setting by hand while the conversation waits.
The setup yields to the page first: it is wider than its least (520 px) only with what the page
does not need to be read (`PAGE_BESIDE_SETUP`, 820 px), so on the Mac app's 1440 px window the
page keeps 820 px and the setup 568 px (#342).

**When it ends.** «Los geht's» ends the setup mode too: the sidebar starts an ordinary
conversation at its ordinary width, also after the window is loaded again, and shows where the
open period stands (views.md, «Was ist noch offen?»). Only Firma › «Einrichtung …» (or the
conversation picked from «Verlauf») opens the setup conversation again; the sidebar then says so
with each message (`setup: true`), and the conversation is answered as the setup, with its
checklist and its open question. Without that wish a setup conversation of a finished setup gets
no checklist: its messages carry the books' state like any other (src/server/open-work.ts
`purposeNow`).

**Code draws the conversation, the AI answers in it.** MISSION puts code first. Every step of the
prototype that the app can know or ask with buttons is drawn by code: `setupThread(progress, facts)`
(src/onboarding/conversation.ts) returns the steps so far, each with the specialist's words (i18n
keys under `onboarding.`), a card, the answers to click and the reply to the answer given. The
steps stop at the first question not answered yet. The first turn therefore shows at once, without
an AI call, and the conversation stands where it stood after any restart.

| Part | Who | Why |
|---|---|---|
| Greeting, every question and its answers | code | the same for every firm; no judgement |
| Company card (name, UID, legal form, owner, address, VAT setup, what the firm sells) | code, from the settings | the app knows it: shown once, not asked |
| VAT change card with «Übernehmen» / «Rückgängig» | code, saved by `PATCH /api/workspace` | a setting the person keeps, through the Firma page's own checks |
| Opening, bank accounts, sources | code, from the books and the settings | the app knows it; each card links to its place by hand |
| Partner bins (Eindeutig, Uneinheitlich, Selten) | code, `partnerBins` (src/onboarding/facts.ts) | counting bookings per account is a rule |
| A rule from a clear partner | code drafts (`POST /api/rules/hand`), the person keeps it on the rule card | the same path as Firma › Regeln › «Neue Regel» |
| Closing summary and what is still open | code | the app knows what it knows and where from |
| Words the person types | the AI, unless they name exactly one answer | judgement; `typedChoice` picks an answer by its words first |
| Recording a typed answer | the AI, with a `setupAnswer` change | reading «wir rechnen mit Saldosteuersatz ab» is judgement |

**Only what the app cannot know is asked** (#345). The settings hold what the form or the conversation
before the books asked a minute ago; the first bank statement says from when the books run
(`booksOpenPeriod`: the filing period of the first payment). So the conversation in the books asks
nothing of the firm, no start day, no filed returns and nothing about the old program, whose data
the app cannot import: it shows the firm once and goes on to what is left.

**Order of the topics.** `SETUP_TOPICS` (src/onboarding/model.ts): firm, opening, bank, receipts,
knowledge.

| Step (question id) | Topic | Asks | Card |
|---|---|---|---|
| `company` | firm | nothing: shown. «Etwas ändern» (`fix`) on the card opens `vat` and `sells` | company, with the VAT setup and what the firm sells |
| `vat` | firm | only after «Etwas ändern», or once the AI recorded an answer from typed words: «Wir rechnen keine MWST ab» (not registered, with the line that it is only for a firm outside the VAT register and that a registered one asks its Treuhand), effective quarterly, net tax rate half-yearly; no «Weiss nicht» (#347; an older stored «Weiss nicht» keeps its words) | after the answer: the VAT change, if it differs |
| `sells` | firm | only after «Etwas ändern»: the three kinds as toggles | the default accounts |
| `startingPoint` | firm | no step and no buttons: the AI records it when her words correct «Ausgangslage» («d Firma isch nöd neu», «wir wechseln von der Treuhand»; #496). It writes the profile's `start` (its undo puts the one before back), shows in the summary as her answer and no longer «angenommen». After «Etwas ändern» it is the change she meant: `vat` and `sells` are not asked again | none; the opening's words follow it |
| `opening` | opening | «Weiter» / «Später»; «Später» says what it means (the balance differs from the bank's by the opening until it is entered) and where it comes back («Eröffnung erfassen» at the first statement, Firma › Eröffnung) | the opening balances, if entered |
| `bank` | bank | only while the app knows no bank account (an IBAN is never required, #496): «Weiter» / «Später» | the bank accounts, «Bankkonto erfassen» |
| `receipts` | receipts | «Weiter» / «Später» | the sources switched on, «Mit mir einrichten» (an AI turn) while an AI answers, otherwise a line that it needs one and «KI einrichten»; «Quellen ansehen» |
| `partners` | knowledge | only in books that hold bookings: «Weiter» | the partner bins, a rule draft per clear partner |
| summary | | «Kontoauszug einlesen» (ends the setup and opens Kontoauszüge), «Erst umsehen» | first the first step, one sentence with its buttons and the rest behind «Mehr dazu»; then what the app knows and where from, what is open with its place by hand |

The greeting names no one: who sits there need not be the owner. Without an AI on this Mac (none
answers, or the column's CLI is signed out) the greeting and the receipts step say only what works
there (a line's `noAi` words, #364): «Du antwortest mit einem Klick», no «in deinen Worten». The rail
counts the topics the conversation took up that are done or left for later, of those it took up
(`setupCount`, `topicsTaken`): «Partner und Wissen» on books without bookings is not taken up, so it
is neither asked nor counted, and the summary lists it as «kommt mit den ersten Buchungen» while there
are no partners (`shownState`). The
count moves with every answer; a topic left with «Später» reads «später», never «übersprungen».
After an answer the newest question scrolls into sight, and the summary to its top, so the first
step and its button show after the last answer (also when the setup opens on it again); smooth only
without prefers-reduced-motion. The summary then holds the scroll (`setupHoldsScroll`): until she
scrolls, presses a key or clicks in the conversation, a streamed AI answer or turns that load after a
reopen put its top back in sight instead of the sidebar following its end.

**Answers.** A click stores the answer in the workspace's `onboarding.json` (`answers`, beside the
topics), with when it was given. «Ändern» beside an answer takes it back; the steps after it wait
until it is answered again, and their own answers come back with it. Typed words that name exactly
one of the open question's answers answer it as a click does; anything else goes to the AI, whose
message carries the answers given and the question on screen (`setupNote`, src/onboarding/prompt.ts).
When the person's words answer that question, the AI records it with
`{"kind":"setupAnswer","question":"vat","value":"net-rate"}` (src/assistant/changes.ts), which the
app checks against the question's answers and applies with an undo (src/server/workspace-edits.ts).

**The VAT change.** A VAT answer that differs from the setup the app has shows a card: as it is →
as it would be, the approved rate when it is the net tax rate, «Übernehmen». Taking it calls
`PATCH /api/workspace { vat }`, the Firma page's own path, which refuses a change of method in a
year that holds entries (`vatMethodHeld`); the refusal shows on the card. Kept, the answer records
the setup before (`kept.before`), so the card's «Rückgängig» puts it back through the same path.
Neither the AI nor the answer writes the setting.

**Topics marked by what the app sees.** `topicStates(progress, facts)` derives each topic's state:
firm done unless a change is under way (after «Etwas ändern», until the VAT answer matches the
settings or was «Weiss nicht», and the sales answer is what the profile keeps); opening done with
opening balances for the open year; bank done with a bank account, with or without an IBAN; receipts done
with a source switched on; knowledge done once the partners were seen, left for later while there
are none or once the setup ended, so the count never goes backwards.
«Später» leaves a topic for later. A topic the AI or a person marked keeps its mark unless the app
sees it done. The rail shows these states; a click on a topic opens its place by hand.

**Where the books begin.** The books' first day is 1 January of the year of the first payment or
opening balance (`booksOpen`, src/books/store.ts); the first period worked on is the one of the
first payment (`booksOpenPeriod`). The summary says so as the first step: read in the statement from
the first quarter (half year) not filed yet; what was before stays in the old program. MWST calls a
period that ended before anything in the books is dated what the books hold, «Keine Zahlungen oder
Buchungen in dieser Periode · die Bücher beginnen am …», not «fällig seit»; its return can still be
prepared, since a firm whose first payment came in April owes a nil return for Q1 (`before` on the
open `ReturnState`, src/app/areas/vat/model.ts). The opening is always per 1 January, from last
year's balance sheet, the bank balance too; the summary says that a firm beginning mid-year sees
only the quarters in these books in the year's reports. With that opening and a first statement of a
later month, a bank account differs from the bank by what was paid before it, until those payments
are in the books or the difference is explained (`startGaps`, src/accounting/opening-balance.ts). The
AI is given these facts in both setup conversations (`OPENING_FACTS`, src/onboarding/prompt.ts),
and code holds its words to them (#496, src/onboarding/opening-claim.ts). A sentence that ties the
opening to another day than 1 January or 31 December («Eröffnungssalden per 1. Juli», «per Ende
Juni»), takes an interim balance sheet as its source, or calls the year-end balance sheet not needed
is taken out, and the app's sentence (`onboarding.openingFact`) stands in place of the first. The
reply's other sentences stay, and what the model said is kept as `withdrawn`. A statement date beside
the opening, a negated interim balance sheet, an account opened at a bank and a due date are not
caught. Books that begin on a chosen
day of the year, with the quarters before held as filed elsewhere, do not exist: that needs a field
in the books' format (see «Still missing»).

**What the AI does not write.** The company's settings (profile, VAT setup, bank accounts, closed
periods, opening balances) are saved by the person: the VAT setup on the conversation's card, the
rest in their place, through the app's validated paths. Receipt collection the AI sets up with the
person as before (mailbox, source).

**By hand.** Each topic's place is `TOPIC_HAND` (src/onboarding/hand.ts); every card with a place
shows «Von Hand: Firma › …».

**Way in.** A fresh install opens «Einrichtung» (src/app/ai/FirstRun.tsx; ai-setup.md, decision 1 as
changed on 12.11.2026, #343): what the app is in two sentences, then what the person wants: new
books, open existing ones, come from another program, the demo. The look at this Mac's AI runs in
the background and decides only what «Neue Buchhaltung erstellen» does: with an AI ready, the
system's save panel asks where the books go and the setup conversation below runs; without one the
form opens at once, and a line under the choices offers «KI einrichten». «Von anderer Software
übernehmen» creates new books too and says what happens today: the setup asks for the old program
and what the move needs, and nothing is imported by itself yet.

In the Mac app, «Neue Buchhaltung anlegen» is the setup (#139): the setup conversation runs before
the books exist, in a wide panel of the start screen (src/app/onboarding/DraftConversation.tsx). It asks what
`createWorkspace` needs: the firm (name, owner; no UID, #452), the preset, every VAT question (a preset only
suggests them), the net tax rates when they apply, the other questions of src/workspace/setup.ts
the setup asks (`SETUP_QUESTIONS`: legal form, what it sells, imports, staff) unless the preset answers
them, and the bank accounts. The questions it does not ask (fiscal year, start, customers abroad, the
owner paying privately, private use, payouts) take the preset's answer, else their `later` one, which
books nothing differently, and the books mark them as assumed. The UID is entered under Firma › Firma;
an invoice with VAT and the VAT return's XML ask for it (the review task withholds «Freigegeben», the
XML step refuses with `uidMissing`, `npm run vat-xml` names the place). Each answer is checked as createWorkspace
checks it and kept in a draft in the folder (`vanilla-accounting/setup-draft.json`,
src/onboarding/draft.ts and draft-store.ts); the manifest is written only when the draft is complete,
so a folder holds a draft or books, never half a manifest. «Buchhaltung anlegen» creates the books
through createWorkspace, removes the draft before the first commit and marks the books in
`onboarding.json` with `created`; the conversation goes on in the books with what the settings do
not answer. The header shows how far the person is in four parts, the same for every firm (Firma, Art
der Firma, MWST, Bank; «n von 4 erledigt», `draftProgress`): how many questions a part holds depends on
the answers, so a count of questions jumped («0 von 14», «1 von 4», «4 von 8»), a count of parts does
not (#364). «MWST-Methode», «Abrechnungsart» and «Ausgangslage» carry a line for a person who does not
know (`where` in src/workspace/setup.ts, shown by the form, this conversation and `npm run init`):
where she finds the answer herself (the ESTV portal, «Neue Geschäfte», her firm, the card «Abrechnungsmodalitäten» and its button «Anpassen», where she sees the current method and basis and changes nothing, #423; the setup's AI is handed both lines at every step and names no other path), the facts the repo confirms (the Saldosteuersatz is a rate the ESTV approved on the firm's application, filed on form 0553), that the Treuhand knows when she has no access to the portal, and what a wrong pick costs. The basis's line names no basis as the one that applies (not the law's default either): the setup's AI is given that line in her language (`buttonsNote`), so it does not say one either. Neither of these two is answered for her: no preset answers them and no answer is drawn as the proposal, in this conversation and on the form, which asks for both before it creates the books (`UNSTEERED`). Beside them stands a third answer, «Wir rechnen keine MWST ab» (#347), for the person who sees there that the firm files no VAT at all: it is «nein» to «Im MWST-Register eingetragen?», given through `notRegistered` (src/workspace/setup.ts) in the form, this conversation and `npm run init` (`--vat-method no-vat`), so the method, the basis, the period and the net rates go; a line under it says it is only for a firm not in the VAT register (registration required from the turnover of modules/ch/registration.yaml) and that a registered firm that does not know its method asks its Treuhand. The review then says «Die Firma rechnet keine MWST ab: …» with «Ändern», and the summary in the books the same. The AI of the typed setup never gives «not registered»: code refuses `vatRegistered: no` (and the third answer on the method or basis) from the words with a reply that it is her click (`noVat`), and once the firm is not registered drops any method, basis, period or rate the words gave, with their marks, so a later «ja» asks them again. The review and the summary also say that the app's invoices carry no VAT, and the summary that it changes under Firma › MWST while the year has no entries; Firma › MWST says the same beside «nein», and an invoice draft of such a firm says «Firma nicht im MWST-Register: Rechnung ohne MWST» with a link there (Firma › MWST changes it while the
year has no entries, `vatMethodHeld`). The review marks an answer the kind of firm gave and the person
never said «angenommen» (`assumed` in the draft, `assumedOf`) until she answers it herself; the line
above the card says why, naming the kind of firm that assumed it (`assumedBy`), also once the preset
became «Etwas anderes». The form does the same (#385): an answer its kind of firm gave carries
«angenommen» where it stands, under one line why, until she touches it. Both ways keep what is still
assumed when the books are created, in `onboarding.json` (`assumed`: each answer as given and the kind
of firm; `seedCreated` from the draft, `seedAssumed` from the form's request, which sets no `started`,
so the first start still opens the setup). The file is not one of the formats the schema ladder of
src/workspace/schema.ts covers: an older app reading it leaves the field out. In the books the
firm's card and the summary list each answer the firm still has as assumed (`stillAssumed`: an answer
changed since is not), «angenommen», with «stimmt» (her click confirms it, `confirmAssumed`, and the
mark goes) and a link where the app can change it (`ANSWER_HAND` in src/onboarding/hand.ts): «Ändern»
to the VAT setup, or the consequence the answer set up, named («Konto des Inhabers unter Firma ›
Geldkonten»); no link for the legal form and the fiscal year, which nothing changes later, nor where
the answer set nothing up; an assumed «Was verkauft ihr?» is never
shown as «deine Antwort». The opening's words follow «Ausgangslage» (`start` in the facts). Such books open into the setup until
«Los geht's» sets `ready`. A folder with a draft opens into the draft's conversation at the step it
stopped, from the folder dialog, the recent list or at the next start.

**Typed words before the books exist** (#145, src/onboarding/draft-talk.ts). Below the conversation
is a field for the person's own words. The AI (step `setup-conversation` of src/llm/steps.ts, the
provider and model the person set for it) reads them with the draft, the step waiting, every value
of src/workspace/setup.ts and the turns typed before (kept in the server's memory per folder,
never taken from the screen), and answers one JSON object: `say` (an answer
to a question, then one short question back) and the answers the words state (`firm`, `preset`,
`answers`, `netRates`, `banks`). The prompt names the answered set and the open one (`draftMarks`),
and the model is told not to ask the next question: code shows the step waiting, with its buttons,
below its words. Code is the authority: each answer goes through `checkPatch` and
`withPatch`, the click's path; a UID or an IBAN is taken only when it stands in the person's words as the server received them,
or, for an IBAN, when the form holds it for that same account. Words add to the form's bank accounts and never remove one
(#496): an account is matched by its IBAN first, then by bank and currency. An IBAN is never required, and an
account without one matches by bank and currency. One more account of a bank in a currency the list holds is refused
(`bankTwice`, as the form refuses it, since the books keep one per bank and currency), and the rest of the list is saved;
an answer refused is not saved and the reply says why; the AI's words are left out beside a refusal,
because it wrote them before the check. Answers without a preset leave the kind of firm
open for its buttons; whichever is picked keeps what the words said (`withPatch`), and the prompt
names a trade as the preset `trades` and material charged with the work as `made`. A filing period
granted only on request (half-yearly on the effective method, quarterly on the net tax rate,
`unusualPeriod` in src/workspace/setup.ts) is not taken from loose words: the reply says what is
usual and the question keeps its buttons; chosen by click it stands, with the same remark. Answers taken from the words are kept in the
draft's `fromText` and carry «aus deiner Nachricht» until the person changes them, in the
conversation and on the last card. A firm is saved with its name and its owner; one given without the other is kept in the draft
(`said`), so the other alone completes it and the card asks only for what is empty. A UID her words
give is kept when it is one; it is never asked. A model that answers no JSON, or none, changes nothing. The call is ledgered in the folder's
`data/llm-ledger.jsonl`, which becomes the books' own.

Without an AI on the computer, «Neue Buchhaltung erstellen» opens the form; with one, «Ohne KI
einrichten» under the choices opens it too. The form and `npm run init` stay the way by hand and
write the same manifest.

The first start of an empty workspace set up by the form (no payments, receipts or bookings, and no
`onboarding.json` yet) opens the setup once by itself, on its first step. Firma has «Einrichtung
öffnen» / «Einrichtung fortsetzen» at the top of its list.

## API

```
GET  /api/onboarding                     { progress, opensItself, facts, states }
POST /api/onboarding/start               the setup opened; the first start does not open it again
POST /api/onboarding/ready               «Los geht's»: books the conversation created no longer open it by themselves
PUT  /api/onboarding/topics/:topic       { state: open | done | skipped }
PUT  /api/onboarding/answers/:question   { value: <one of its answers> | null, kept?: <VAT setup before> | null }
```

The desktop server adds the setup before the books exist: `GET /api/desktop/ai` (whether an AI
answers), `GET /api/desktop/setup?root=`, `POST /api/desktop/setup { root, language }` (start or
continue; a folder with books opens them), `PUT /api/desktop/setup { root, patch }` (one answer or
`null`), `POST /api/desktop/setup/talk { root, text }` (typed words: `{ view, reply }`),
`POST /api/desktop/setup/create { root }`.

`facts` (src/onboarding/facts.ts) is read fresh on every call: today and the open year, the company,
the bank accounts, the sources switched on, the open year's opening balances, `closedThrough`, the
books' counts, the partner bins and the number of rules. `kept` belongs to the VAT question only.

## Still missing

- The UID lookup in the public register: the company card shows what the setup form saved.
- The import of the old program (Bexio, Banana, Abacus, a spreadsheet, an accountant's export) as
  evidence and opening balances, with its place by hand; with it, the quarter comparison before
  sealing a quarter filed before the switch, and «So nicht übernehmen» for patterns of the history
  the app's rules forbid. Until it exists the setup asks nothing about the old program.
- Books that begin on a chosen first day of a quarter («ab 1. Juli»), with the quarters before
  known as filed elsewhere: today the first statement decides, and the year's opening balances are
  those of 1 January. It needs a first day in the books' format (ledger.json), opening balances on
  that day, and reports and the year close that know the year is not whole: the owner's decision.
- The prototype's per-partner questions for the mixed bin («Wofür kaufst du bei …?»): the bin
  shows them, and the app asks at the next payment.
- An approved rate the person typed to the AI is not carried to the VAT card; the person enters it there.
