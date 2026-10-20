# Knowledge (Wissen)

**Status: proposed.** Clickable in design B of the switch:
[onboarding-chat/prototype.html](mockups/onboarding-chat/prototype.html) (after «Los geht's», the
dock icons Geschäftspartner and Wissen; «Wissen nach Q3» in the bar shows a quarter later). Design A's
first take, one structured page per partner, is in [11-partner.html](mockups/onboarding/11-partner.html).

## The problem

Firma › Regeln shows one kind of knowledge: rules about booking. A workspace knows much more.
It knows how to recognise a business partner, where its receipt arrives, which of its
documents counts as proof, how its payments line up with its invoices, what the person
decided in a past case, and what is still open.

A study of one real workspace after three quarters found this:

- Almost all knowledge is about one business partner. 23 of its 28 knowledge files are partner
  files.
- Most of it is not about booking. About 40 % says how to get the receipt (mailbox, portal,
  login, paper), about 30 % says which document proves what and how payments match invoices.
  About a quarter is about accounts and VAT.
- None of it is a rule the app carries out. Every item is a note for the AI, and most are
  proposals of the AI that wait for the person.
- One partner is described in up to four places: the app's partner file, the app's runbook,
  the company's partner file, and a company runbook section. Identity and contract facts sit
  in YAML comments, where no code and no view reads them.
- Company facts are stored as precedents of a step. «The delivery van is a company car» is a
  precedent of `booking#private`, so the AI sees it only in that step.

So the name «Regeln» hides most of what the app knows, and the storage scatters it.

## What the knowledge base is

Four parts, in two areas of the dock.

| Part | Where | What it holds |
|---|---|---|
| **Geschäftspartner** | own area, `/partners`, `/partners/<id>` | One page per partner: its notes, what the app does by itself for it, and everything in the books linked to it |
| **Arbeitsweise** | area Wissen, `/knowledge/<topic>` | How the company works, one prose page per topic: «Fahrzeug und Privatanteil», «Privates, Spesen und Bargeld», «Belege sammeln», «MWST-Abrechnung», and any page the person adds |
| **Lücken** | area Wissen, `/knowledge/gaps` | Where the app could not go on alone, per step and per partner, each with the one answer or rule that closes it, and the batch of questions before the VAT return |
| **Von der App** | area Wissen, `/knowledge/app` | The public layer (`processes/`): what the app knows about well-known partners, authorities and the law. Read-only |

Firma keeps the master data: name, UID, VAT setup, bank accounts, chart of accounts, sources,
periods. Its list loses «Regeln» and points to the two areas. There is no rules page of its own: a
rule lives on the page whose notes it carries out, and the partner list filters «Offen».

**Why two areas.** The study above found two kinds of knowledge. Almost all of it is about one
partner, and a person looks it up from a payment, a receipt or an entry: «what do we do with Coop?».
That is a list of partners with a page each, beside their entries, receipts and payments. The rest is
how the company works across partners: the van, private purchases, cash, the VAT return. Those
were stored as precedents of a step, where no one finds them. They get prose pages of their own,
next to the gaps, because both answer «how do we work, and where does the app still need us?».

## A page is prose first

Design A showed a partner as ten sections of items, each with a source badge and its buttons. It
read like a rules database. The owner's verdict: «these look like rules». So a page leads with prose
and keeps the machine parts small or folded.

1. **Open questions** as cards, if any: «Röstkurs für Mitarbeitende: auf welches Konto?».
2. **Notizen.** One readable page, written by the AI and the person together, in du-style German:
   who the partner is, how its receipt comes, how we book it, what is not a receipt. «Bearbeiten»
   opens a plain text field, «Speichern» keeps it. Provenance is one quiet line under it: «zuletzt
   geändert von Anna Muster am 14.08.2026 · Verlauf». The history comes from git.
3. **Das macht die App selbst.** Only the executable rules, one line each with how often they
   applied: «Rohkaffee → 4000, MWST M26 · 19× dieses Jahr», with «Ausschalten». When the AI reads
   a sentence in the notes that a rule could carry out («Jutesäcke und Verpackung auf 4210 mit
   8.1 %», «zur Hälfte privat»), it offers the rule here: «Aus den Notizen: … als Regel?
   Behalten». Keeping it goes through the rule card as today (preview, refusals).
4. **Vorschläge der KI (n)**, one folded batch: sentences the AI drew from payments and receipts,
   with what it read them from. «In die Notizen übernehmen» merges the sentence into the prose;
   «Verwerfen» drops it. Proposals never become separate items.
5. **Verknüpft.** Buchungen, Belege, Zahlungen, Rechnungen of this partner, counts and the newest
   rows, each a link to its detail (AGENTS.md, UI links).
6. **Details für die App**, folded, closed by default: how the app recognises the partner
   (payment text, IBAN, UID), the decided cases, the public layer in grey, and the examples from
   the imported history.

A page of Arbeitsweise has the same shape without the partner's links: questions, notes, its rules
with their step, proposals, linked entries where they exist (the quarterly private share of the
van), and details (the step and its files, the decided cases).

## Files

The notes are the source of the knowledge. Executable rules are what the app can carry out from
them. The structured fields stay in the file for code, and the page shows them only folded.

| On the page | In the workspace |
|---|---|
| Partner notes | `knowledge/<role>/<id>.md`, beside the partner file (new) |
| Rules, recognition, document kinds, cases | `knowledge/<role>/<id>.yaml` as today: `match`, `documents`, `steps:` with `then` maps, `precedents` |
| Company page | `knowledge/company/<topic>.md` (new), one per topic |
| Its rules and cases | `knowledge/rules/<process>.guide.yaml` as today |
| Lücken, shares per step | computed from the index and the runs, no file |
| Von der App | `processes/<role>/<id>.yaml` and `processes/*.guide.yaml`, read-only |

What changes in the files:

1. A Markdown file per partner and per company topic. The AI reads the partner's `.md` with the
   partner's `.yaml` section of the step; a company page is read when its step names it. A step
   address in its front matter says when (`steps: [booking#private]`).
2. Notes replace the YAML comments that hold identity and contract facts, and the vendor
   sections of the company runbook. `npm run migrate-knowledge` drafts each `.md` from them, and
   the person reviews the draft on the page.
3. Sentences in the notes are prose for the AI and people. The lint checks the shape of the YAML
   (`id`, `source`, a step that exists) and that each `.md` has a partner or a topic. It does not
   check meaning.
4. `source:` keeps one grammar: `wish`, `correction`, `hand`, `answer`, `history <year>`, `notes`
   (a rule kept from a sentence in the notes), then the date.

## What stays code-checked

- `match` routes a payment, receipt or mail to a partner, by code.
- A rule with a `then` map books a payment. Preview, refusals and «Behalten» are as today
  (src/booking/rule-preview.ts, src/saving/rules.ts).
- `documents` patterns set a document's kind.

Everything else is prose. A sentence the app could carry out is offered as a rule beside the notes
(MISSION.md: code first); the sentence stays, so a person reads why the rule exists.

## How the switch fills it

- The setup drafts the notes of every partner it keeps and four company pages, from the 2025
  journal and the answers. «Fertig» says so, and offers «Geschäftspartner ansehen» and «Wissen
  ansehen». Both dock icons fill when chapter 5 keeps its first rule; they never count or remind.
- **History is evidence.** The imported journal shows as examples under the details. The AI quotes
  it («wie 2025 gebucht»). It is never a rule by itself.
- **A rule needs a confirmation.** A rule from the history exists once the person keeps it
  (`history 2025, confirmed <date>`).
- **An answer goes where it belongs.** An answer that a map can express becomes a rule; the rest
  becomes a sentence in the notes.
- **A pattern the app will not learn** (input tax without a receipt, a missing Bezugsteuer) is a
  decided case with its reason, so the AI does not propose it again.
- Before any payment is booked, Lücken shows how far the knowledge reaches, recomputed on the 2025
  payments: «55 % der Zahlungen hätte die App selbst gebucht».

## How the knowledge grows

The app can import, match, book and file without a person only as far as its knowledge
reaches. So the knowledge has to grow from the work itself, at the moment a person steps in.

**What exists today:**

- A wish in the sidebar («buch Swisscom immer auf Telefon») becomes a rule on its card.
- A person's correction or split offers «Immer so?», which drafts the rule (src/saving/share-rule.ts).
- Firma › Regeln has «Neue Regel» for a rule made by hand (src/saving/hand-rule.ts).
- A case no rule covers becomes a question under Aufgaben. Its answer goes back into the guide
  as a rule or a precedent in the same session (processes/new-case.flow.yaml).
- `review_rules` in quarter-close.flow.yaml confirms or replaces every proposed rule before filing.

**What is missing, and proposed:**

1. **Measure where automation stopped.** Each run records who decided an item: a rule, a
   case, a note, the AI from an example, or the person. Lücken shows the share per step
   (import, receipts, booking, VAT return) as a fact: «87 % der Zahlungen selbst gebucht».
   It states the figure and never reminds.
2. **Wissenslücken.** The places where a person stepped in, ranked by how often and by the
   amount, per step and per partner. Each gap comes with the one answer or rule proposal that
   closes it: «Coop Pronto: 12× gefragt in Q3. Deine Antworten: über CHF 40 immer Benzin.»
3. **Agreeing cases become one rule.** When several cases of one partner decide the same way,
   the app drafts the executable rule and shows it on its card with the cases behind it.
4. **Notes move toward code.** A sentence whose meaning a `then` map can express is offered as
   a rule beside the notes, with the bookings it would have made. The sentence stays.
5. **Stale and contradicting rules.** A rule that stopped matching (a new payment text, a new
   IBAN) or that a newer decision contradicts is shown for review, as it is and as it would be.
6. **One batch at the natural moment.** Before a VAT return or a quarter close, the AI checks
   the quarter against the knowledge: every entry without a rule, case or note, every receipt
   without valid VAT proof. It asks the open items in one batch, then and there, not spread
   over the quarter.

Every new item keeps its source. A proposal binds the app only after the person keeps it. The
imported history and the AI's conclusions are evidence until then. The figures are computed
from the index and the runs; they add no file to the workspace.

## Rules that hold

- Knowledge never changes the books. A changed rule acts from the next payment. A filed
  quarter stays as filed (AGENTS.md, golden rule 1).
- The app ships the two areas, the page shape and the empty states. What one company knows grows
  in its workspace. No branch for one vendor in the app (ADR 0015).
- What the AI does on a page, a person can do by hand: «Bearbeiten» on every page, «Neue Seite» in
  Wissen, «Ausschalten» on every rule.

## Decisions for the owner

1. **Dock order and shortcuts.** The prototype puts Geschäftspartner (G P) and Wissen (G E) below
   the divider, above Änderungen and Firma. They could sit with the work areas instead.
2. **Partners and customers.** Rechnungen has its own customer list (`/invoices/customers`). One
   list of partners with a «Kunden» filter could replace it, or link to it.
3. **Where the rail step leads.** The setup's step «Wissen» opens Geschäftspartner; Wissen is one
   dock click away. It could open Wissen › Lücken instead.
4. **Notes and the private workspace.** The `.md` files hold names and terms of private suppliers,
   so the leak guard must cover them, as it covers the YAML.
5. **Where a run records who decided.** The figures in Lücken need it per item. The index records
   an entry's origin today, not why the AI asked.
6. **Thresholds for a proposal.** «3 cases decided alike» and «9 of 12 answers» are guesses.
