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

**Way in.** In the Mac app, «Neue Buchhaltung anlegen» is the setup (#139): the start screen asks
the folder and the books' language, and the setup conversation runs before the books exist, in a
wide panel of the start screen (src/app/onboarding/DraftConversation.tsx). It asks what
`createWorkspace` needs: the firm (name, UID, owner), the preset, every VAT question (a preset only
suggests them), the net tax rates when they apply, the other questions of src/workspace/setup.ts
unless the preset answers them, and the bank accounts. Each answer is checked as createWorkspace
checks it and kept in a draft in the folder (`vanilla-accounting/setup-draft.json`,
src/onboarding/draft.ts and draft-store.ts); the manifest is written only when the draft is complete,
so a folder holds a draft or books, never half a manifest. «Buchhaltung anlegen» creates the books
through createWorkspace, removes the draft before the first commit and records the conversation's
first answers (company, VAT, what the firm sells) in `onboarding.json` with `created`; the
conversation goes on in the books at the next question. Such books open into the setup until
«Los geht's» sets `ready`. A folder with a draft opens into the draft's conversation at the step it
stopped, from the folder dialog, the recent list or at the next start.

**Typed words before the books exist** (#145, src/onboarding/draft-talk.ts). Below the conversation
is a field for the person's own words. The AI (step `setup-conversation` of src/llm/steps.ts, the
provider and model the person set for it) reads them with the draft, the step waiting, every value
of src/workspace/setup.ts and the turns typed before, and answers one JSON object: `say` (an answer
to a question, then one short question back) and the answers the words state (`firm`, `preset`,
`answers`, `netRates`, `banks`). Code is the authority: each answer goes through `checkPatch` and
`withPatch`, the click's path; a UID or an IBAN is taken only when it stands in the person's words;
an answer refused is not saved and the reply says why; the AI's words are left out beside a refusal,
because it wrote them before the check. Non-VAT answers without a preset make it
«custom», so a preset picked later cannot replace them. Answers taken from the words are kept in the
draft's `fromText` and carry «aus deiner Nachricht» until the person changes them, in the
conversation and on the last card. A firm without its UID is not saved; its card starts with what was
said. A model that answers no JSON, or none, changes nothing. The call is ledgered in the folder's
`data/llm-ledger.jsonl`, which becomes the books' own.

Without an AI provider on the
computer, «Neue Buchhaltung anlegen» opens the form with the reason; «Ohne KI einrichten» opens it
too. The form and `npm run init` stay the way by hand and write the same manifest.

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
`null`), `POST /api/desktop/setup/talk { root, text, history }` (typed words: `{ view, reply }`),
`POST /api/desktop/setup/create { root }`.

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
