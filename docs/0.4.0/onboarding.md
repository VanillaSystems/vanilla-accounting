# Onboarding as a conversation

The owner chose design B (docs/0.4.0/mockups/onboarding-chat/): a new workspace is set up in one
conversation with a Vanilla Accounting setup specialist, in a chat about twice as wide as the AI
column. Design A (docs/0.4.0/mockups/onboarding/) stays the reference for what each step asks.

## Decisions

**Where it lives.** The setup is the AI sidebar in a wide setup mode, not a window of its own and
not a modal that blocks the page. A conversation with the purpose `onboarding` widens the sidebar
to `SETUP_WIDTH` (src/app/assistant/store.ts); the page narrows beside it and stays usable, so a
person can open Firma › MWST from the rail and save a setting by hand while the conversation waits.

**Code draws the conversation, the AI answers in it.** MISSION puts code first. Every step of the
prototype that the app can know or ask with buttons is drawn by code: `setupThread(progress, facts)`
(src/onboarding/conversation.ts) returns the steps so far, each with the specialist's words (i18n
keys under `onboarding.`), a card, the answers to click and the reply to the answer given. The
steps stop at the first question not answered yet. The first turn therefore shows at once, without
an AI call, and the conversation stands where it stood after any restart.

| Part | Who | Why |
|---|---|---|
| Greeting, every question and its answers | code | the same for every firm; no judgement |
| Company card (name, UID, legal form, owner, address, VAT setup) | code, from the settings | the app knows it |
| VAT change card with «Übernehmen» / «Rückgängig» | code, saved by `PATCH /api/workspace` | a setting the person keeps, through the Firma page's own checks |
| «Was der Umzug braucht» list | code, from the answers | follows from program, bookkeeping, access, start and filed returns |
| Opening, bank accounts, sources | code, from the books and the settings | the app knows it; each card links to its place by hand |
| Partner bins (Eindeutig, Uneinheitlich, Selten) | code, `partnerBins` (src/onboarding/facts.ts) | counting bookings per account is a rule |
| A rule from a clear partner | code drafts (`POST /api/rules/hand`), the person keeps it on the rule card | the same path as Firma › Regeln › «Neue Regel» |
| Closing summary and what is still open | code | the app knows what it knows and where from |
| Words the person types | the AI, unless they name exactly one answer | judgement; `typedChoice` picks an answer by its words first |
| Recording a typed answer | the AI, with a `setupAnswer` change | reading «wir rechnen mit Saldosteuersatz ab» is judgement |

**Order of the topics.** `SETUP_TOPICS` (src/onboarding/model.ts): firm, periods, history,
opening, bank, receipts, knowledge. The old program comes before the opening, because its balance
sheet holds the opening balances. The steps within them follow the prototype:

| Step (question id) | Topic | Asks | Card |
|---|---|---|---|
| `company` | firm | «Stimmt so» / «Etwas stimmt nicht» | company |
| `vat` | firm | not registered, effective quarterly, net tax rate half-yearly, «Weiss nicht» | after the answer: the VAT change, if it differs |
| `start` | periods | from 1 January, or during the year from the period today is in | |
| `filed` | periods | none, Q1, Q1 und Q2, … (only a registered firm, only the periods already over) | |
| `program` | history | Bexio, Abacus, Banana, a spreadsheet, the accountant, a new firm | |
| `entry` | history | double entry, income and expenses only, «Weiss nicht» (not for a new firm) | |
| `access` | history | me, my accountant, both (not when the accountant keeps the books) | |
| `needs` | history | «Verstanden, weiter» | what the switch needs and from whom; the import is a later step |
| `opening` | opening | «Weiter» / «Später» | the opening balances, if entered |
| `bank` | bank | «Weiter» / «Später» | the bank accounts, IBAN or not, «Bankkonto erfassen» |
| `receipts` | receipts | «Weiter» / «Später» | the sources switched on, «Mit mir einrichten» (an AI turn), «Quellen ansehen» |
| `partners` | knowledge | «Weiter» | the partner bins, a rule draft per clear partner |
| summary | | «Los geht's» | what the app knows and where from, what is open with its place by hand |

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
firm done when the company was answered and the VAT answer matches the settings (or was «Weiss
nicht»); periods done when the start is answered and no filed return waits for its comparison
(none filed, or sealed through the last filed one), skipped while one waits; history done for a new
firm, skipped once the needs were read (the import is a later step); opening done with opening
balances for the open year; bank done with a bank account that has an IBAN; receipts done with a
source switched on; knowledge done once the partners were seen. «Später» skips a topic. A topic the
AI or a person marked keeps its mark unless the app sees it done. The rail shows these states and
the count of topics done; a click on a topic opens its place by hand.

**History has no place in the app yet.** Importing the old program's chart, journal and balances
does not exist. The conversation says so on the needs card, and the AI's prompt says so too: the
person enters the opening by hand, an export they attach is read as examples, and nothing is
imported. A quarter filed before the switch is not sealed by the setup: comparing it with the
return needs the old journal, so the reply says the comparison comes with the import and the
periods topic stays skipped.

**What the AI does not write.** The company's settings (profile, VAT setup, bank accounts, closed
periods, opening balances) are saved by the person: the VAT setup on the conversation's card, the
rest in their place, through the app's validated paths. Receipt collection the AI sets up with the
person as before (mailbox, source).

**By hand.** Each topic's place is `TOPIC_HAND` (src/onboarding/hand.ts); every card with a place
shows «Von Hand: Firma › …». The old program's history has no place of its own: what it becomes
(rules, opening balances) has.

**Way in.** The first start of an empty workspace (no payments, receipts or bookings, and no
`onboarding.json` yet) opens the setup once by itself, on its first step. Firma has «Einrichtung
öffnen» / «Einrichtung fortsetzen» at the top of its list. The setup form of `npm run init` and the
desktop stays the by-hand way to create the workspace; the conversation starts from what it saved.

## API

```
GET  /api/onboarding                     { progress, firstStart, facts, states }
POST /api/onboarding/start               the setup opened; the first start does not open it again
PUT  /api/onboarding/topics/:topic       { state: open | done | skipped }
PUT  /api/onboarding/answers/:question   { value: <one of its answers> | null, kept?: <VAT setup before> | null }
```

`facts` (src/onboarding/facts.ts) is read fresh on every call: today and the open year, the company,
the bank accounts, the sources switched on, the open year's opening balances, `closedThrough`, the
books' counts, the partner bins and the number of rules. `kept` belongs to the VAT question only.

## Still missing

- The UID lookup in the public register: the company card shows what the setup form saved.
- The import of the old program (Bexio, Banana, Abacus, a spreadsheet, an accountant's export) as
  evidence and opening balances, with its place by hand; with it, the quarter comparison before
  sealing a quarter filed before the switch, and «So nicht übernehmen» for patterns of the history
  the app's rules forbid.
- The prototype's per-partner questions for the mixed bin («Wofür kaufst du bei …?»): the bin
  shows them, and the app asks at the next payment.
- An approved rate the person typed to the AI is not carried to the VAT card; the person enters it there.
