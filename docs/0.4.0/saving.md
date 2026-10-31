# Saving, syncing, undo

**Status: built in 0.4.0 (ui/design.md units 6 and 7), amended 14.10.2026.** Clickable mockup:
screen 7 of [mockups/workflows.html](mockups/workflows.html). Builds on ADR 0003 (books in git,
sync, undo as a bookkeeping operation) and ADR 0004.

**The amendment (D3, D11 in [decisions.md](decisions.md)).** The books do not wait for a person:
the app commits them itself, one commit per run when it comes to rest and one per direct edit,
with a short run log beside them. Workflows will also run in the cloud with nobody present, and
their results must still land in git for later review. What waits in Änderungen is only
customizing: rules, workflows, knowledge and settings, changed in the AI's draft
(`data/draft/`) or outside the app. Where this page still speaks of the books waiting to be
saved (the import of 500 receipts, «Den Import verwerfen»), read it as history: such a run is one
entry in Verlauf, and a person who wants to look before booking makes that a step of the workflow.

The workspace is a git repository. A regular user never sees a git word and never does git
work: the AI prepares the saves, the person talks to it and saves. A new area **Änderungen**,
between Automatisierung and Firma, holds this.

## One repository, everything in it

A company has one repository: its workspace. It holds the books (entries, receipts, bank
statements, filings) and every customization (guide rules, workflows, module overlays, the
invoice layout). The app itself is upstream and separate. **Änderungen shows what changed in
the workspace since the last save**, the books included.

Workflows and the AI write into the workspace; they do not save. The person saves. Each prepared
save carries a tag: **Bücher** (an import run, a payment booked, a receipt renamed) or **wie die
App arbeitet** (a rule, a layout, a schedule).

This amends ADR 0003 §4 ("every change is a commit"): see [decisions.md](decisions.md), D11.

### Saved by the action itself

Filing a VAT return, a seal and a year close save at once, as part of the action. They are
deliberate steps with their own confirmation, and they need a fixed save to compute from
(ADR 0003 §6). Before one of them, the app asks to save everything else.

### The price of not saving at once

Unsaved work exists only on this computer: not backed up, not synced, not visible to the
Treuhänder. Hence the dock badge, a reminder when prepared saves wait too long, the rule before
filing, and a setting **automatisch speichern** for a person who does not want to review.

## Preparing on demand, and coming back later

Preparing saves costs a model call, so it happens when the person asks for it.

1. **The page opens without AI.** It lists what changed since the last save: each run with what it
   wrote (a run knows its own writes), and each changed file of the customizations. Free and
   instant.
2. **«Speichern vorbereiten»** asks the AI to group the changes into saves and write their
   messages. The proposal, the conversation and the save buttons appear.
3. **The proposal belongs to the state it was made from** (the hashes of the changed files). The
   person can leave, change more, and come back: the page names what changed since ("Seit dem
   Vorschlag geändert: sheet.html") and which saves it affects, and the save buttons wait.
4. **«Vorschlag aktualisieren»** re-prepares only the affected saves. The other saves, and what the
   person told the AI ("das Logo noch nicht"), stay.

A proposal that no longer matches the files is never saved.

## The AI prepares, the person decides

- **Bereit zum Speichern** lists the saves the AI prepared from the changed files. It groups them
  into coherent saves, keeps together what belongs together (an invoice template and the new
  logo it points to), and writes each save's message and a one-line reason. A save that alters
  figures says so; its replay result is part of the reason.
- **The person talks instead of staging.** "Das Logo noch nicht" holds a save back. "Den
  Treibstoffzuschlag noch nicht" makes the AI rewrite the file without that rule. "Alles in einen
  Speicherstand" merges the saves. There are no checkboxes, no message field, no hunks.
- **Two buttons:** **Speichern** (commit) and **Speichern und synchronisieren** (commit and
  push). A save not yet synced is marked *nicht synchronisiert*, with a **Synchronisieren**
  button.
- **The diff is there for whoever wants it.** Each prepared save has a **Diff** link: a dialog
  with the source diff of each file, and **Ganze Datei** for the whole file with its changed
  lines marked. Rendered previews (an invoice drawn with the old and the new layout, figures
  before and after) are a later option, not part of 0.4.0.

Splitting changes into saves is no longer the user's problem, so it can be done well: the AI
reads what the changes mean, which a checkbox list cannot. When two changes cannot be separated
cleanly, the AI keeps them in one save and says why. It never asks a person to judge half a
hunk.

## One click for a rule

A rule is what the mission promises a person keeps with one click: «the AI turns a wish into a
rule, shows it plainly, and the person keeps it with one click». The app can say a rule itself,
from its structure (src/booking/rules.ts), so a rule needs no AI to prepare its save.

- **What a rule is.** A rule in the step `classify` of `knowledge/rules/booking.guide.yaml`, or in
  a business's file under `steps: booking.guide.yaml#classify`, whose `then` is a map: `{ account,
  vat }` books the payment there (the VAT code's rate only with Swiss VAT on a linked receipt, else
  its zero code), `{ ask, account?, vat? }` asks the person first. `when` takes `counterparty`,
  `text` (a pattern over the payment's text), `direction` (in, out), `amount` (`over`, `under`, in
  the books' currency) and `account` (the bank account that paid); a business's own rule needs no
  `when`. The format and an example are in AGENTS.md, "Rules the app carries out".
- **The app carries it out, in code.** The inbox's booking step decides a payment by its rule
  before any model call; the entry carries the rule's id (`rule`) and says it in its reason. A
  payment a rule asks about is not booked: a task «Frag: …» waits in Automatisierung
  ([workflows.md](workflows.md), "A rule can ask").
- **Behalten.** When the sidebar's answer drafted a rules file, its card lists each rule added,
  changed or removed in one plain line, with **Behalten** (**Ja, entfernen** for a removal) and
  **Verwerfen**. Behalten saves exactly that draft file, as the person saw it, as one save of its
  own; Änderungen shows the same card for a drafted rules file. A removal the person asked for is
  confirmed with that button, never by typing a confirmation.
- **The card shows what it would do.** Under each added or changed rule the card lists, computed
  in code, the payments of the open year it matches (the count, the newest five with the booking
  it would make and their booking today), a changed rule as it was and as it would be, and the
  other rules that hold for the same payments (src/booking/rule-preview.ts). A rule that
  recognises payments only by single words, without a business, payer or amount, is kept only
  with **Trotzdem behalten**; Speichern refuses it. A removal says how many of its questions
  wait; keeping it closes them.
- **Refused when kept.** A rule the app cannot carry out (one written as sentences, an account
  the chart lacks, a VAT code it does not know, a field it does not read) is refused by Behalten
  and by Speichern alike, with the reason, and the file stays as it was. Rules written as
  sentences before this (in business files, by Claude Code) still load: they show as notes for
  the AI and decide nothing.
- **Firma › Regeln** lists every rule of the company in plain words (notes as written), where it
  came from (`source: wish …`, `correction …`, `hand …`, the app, or its source as written), how many
  payments it booked, and how many it held to ask about. **Neue Regel** makes a rule without the
  AI (src/saving/hand-rule.ts): whose payments (a business, a payer's IBAN or name, a text,
  optionally the direction and amount) and the account and VAT code (only the codes the firm's
  form takes; none for a firm not registered). **Vorschau** drafts it into its file and shows the
  same card as the AI's draft, with its payments and «Trotzdem behalten»; a task «Von Hand
  buchen» links to the form, started from its payment. **Ausschalten** (`off: true`) and **Löschen** change the file in place,
  its comments kept, and save at once; the toast's **Rückgängig** puts the file back as it was,
  unless it changed since.

## Large changes, and items that fail

An import of 500 invoices is one run, and one prepared save.

- **Each item is all or nothing.** Every item of a run writes through the write door as one
  transaction (ADR 0003 §7): an invoice is fully booked, or nothing of it is written. A crash in
  the middle leaves complete items and untouched ones, never a half-written one.
- **The save holds what worked.** "Import: 500 Belege, 497 gebucht". The 3 that failed wrote
  nothing; they wait in their workflow (screen 5: waiting for you, or stuck) and become a later
  save once resolved. The save's reason names them, with a link.
- **Discarding the run** ("den Import verwerfen") removes its bookings and mappings, puts the
  receipts back in the inbox, and marks the run as discarded. Nothing was saved, so nothing has
  to be undone.
- **Its detail is grouped by kind with counts** (500 new files in `receipts/2026/`, 512 lines in
  `entries.jsonl`, 497 in `mappings.jsonl`), not 500 diffs. In *Verlauf* the run is one entry,
  and undo takes the whole run.

## Telling the AI

Here, the conversation is part of the Änderungen page. Everywhere else the AI is a sidebar on the
right, opened with ⌘J, the bot button at the top right, or **«Mit KI ändern…»** on the object in
view, which becomes its context ([views.md](views.md), "The AI, as a sidebar"). The AI changes
only workspace files; what it changes is prepared here for saving.

## The words

| git | in the app |
|---|---|
| working tree | Bereit zum Speichern (prepared by the AI) |
| add, stage | the AI prepares; the person says what to hold back |
| commit message | the AI writes |
| commit | Speichern |
| push, pull | Synchronisieren (also part of «Speichern und synchronisieren») |
| log | Verlauf |
| diff | Diff, per file; Ganze Datei |
| revert | Rückgängig |
| merge conflict | Zwei Versionen: both side by side; the person picks, or the AI proposes a merge |
| branch | hidden: AI drafts and each contributor's work (ADR 0003 §2) |
| reset, force push, rebase | none: history is never rewritten |

## Undo

- Undo never erases. «Rückgängig» on a save in *Verlauf* writes the inverse into the files; the
  AI prepares it as a save like any other.
- A booking in an open period is undone by reversing it (ADR 0003 §4). In a period closed since,
  the correction workflow books a correction in the open period instead.
- A filing, a seal and a year close cannot be undone. *Verlauf* shows them with a lock.

## Open

- Whether a single user wants sync at all, or only a backup.
- How long prepared saves may wait before the app reminds the user.
