# Processes

The business processes of this repository, written as files. One file per
process, YAML, in the flow format. The drawing is generated from the file and
is read-only. No coordinates are ever stored here, so editing a step's text is
safe for anyone.

| File | What it covers |
|---|---|
| `quarter-close.flow.yaml` | The whole quarter, at the altitude you think about it. The middle steps name the files below. |
| `receipt-collection.flow.yaml` | Email, vendor portals and paper, through to a receipt staged in `beleg-import/` |
| `receipt-intake.flow.yaml` | Staged file → text, VAT facts, its kind, archived under `receipts/` |
| `bank-import.flow.yaml` | camt053 and statement PDFs in, every month end reconciled to the cent |
| `evidence.flow.yaml` | Receipts ↔ transactions, re-runnable: rules, then AI, then the Offen tab, until every transaction is settled |
| `booking.flow.yaml` | Settled transactions → journal entries, splits, VAT codes, FX at payment date; stale entries rebooked |
| `vat-filing.flow.yaml` | MWST-Abrechnung → eCH-0217 XML → ESTV → `filings/` → period lock |
| `year-close.flow.yaml` | Year-end revaluation, sign-off, and next year's opening balances |
| `new-case.flow.yaml` | What happens when no rule covers a case: decide it once, write the decision down, never ask again |
| `correction.flow.yaml` | A change that touches a closed period: a new entry in the open period, never an edit |

## Three kinds of file, and why

Every process has two files, and every counterparty with particulars has one:

- **`<process>.flow.yaml`** is the shape: the steps, who does each one, the
  order, and the gates. It changes only when the *process* changes. A new
  vendor, a new VAT case or a new exemption never adds a step.
- **`<process>.guide.yaml`** is the knowledge: for each step that needs
  judgment, the rules that decide it, in order, and what the human has already
  decided. It changes every time we learn something. That is what it is for.

- **`counterparties/<id>.yaml`** (vendor facts in `processes/counterparties/`,
  the company's part in `counterparties/`, see the two layers below) holds
  everything true about one counterparty and nobody else, such as Coop Pronto, FedEx or Shopify. That covers how to
  recognise it (`match:`), whether it bundles invoices into one payment
  (`grouped:`), which accounts it books to (`accounts:`), and its rules for
  each step it touches. Each step's rules sit under the step's exact address:
  `steps: { "booking.guide.yaml#classify": { rules: [...] } }`.

## Two layers: the app and the company

The app is meant to be public; the books are one company's. So the knowledge
lives in two layers, merged once when it is read (`src/knowledge/layers.ts`):

| Layer | File | Holds |
|---|---|---|
| App | `processes/<process>.guide.yaml` | rules true for any Swiss company |
| App | `processes/counterparties/<id>.yaml` | vendor facts true for every customer: `name`, `match`, `grouped`, documents, vendor rules |
| Company | `policy/<process>.guide.yaml` | this company's rules and precedents for a step |
| Company | `counterparties/<id>.yaml` | the binding of a vendor: `accounts`, company rules, precedents, extra signals; or a whole private supplier |

Every field has one owner. A company file adds signals, documents and rules
after the app's; it never redeclares `name` or `grouped` and never replaces a
rule. The lint keeps the app layer generic: no `accounts`, no precedents, a
source that names a law, a document or a dated decision, no bank ref, date,
long number or amount to the cent, and no name of a private supplier.

A flow step points at its guide section with
`with: { guide: <process>.guide.yaml#<step-id>, model, batch }`. An agent
working one item of a step reads the step's section in both layers, the
section of **that item's** counterparty for the same address in both layers,
and nothing else. A FedEx batch never carries Coop Pronto's rules.

**Where does a new rule go?** Ask: *would it still be true for a company we
have never seen?* If yes, it goes in the step's guide. If it is true for every
customer of one vendor, it goes in the vendor's file. If it is true for us
only, it goes in `counterparties/<id>.yaml` or `policy/<process>.guide.yaml`,
and so does every precedent. The lint enforces this: a guide rule whose `when`
or `then` names a registered counterparty is an error, and the error names the
file to move it to.

## How an item finds its counterparty

Code routes items, never a model. The signals are tried from strongest to
weakest: Swiss UID, sender email domain, the merchant part of the bank text,
the archived filename. The first signal type that matches anything decides:

- **Exactly one file matches:** that counterparty's rules apply.
- **Two files match at the same strength:** ambiguous. The item goes to
  `new_case`, and the answer tightens one `match:` block.
- **Nothing matches:** the item gets the generic rules only, never a guessed
  vendor. If those don't decide it, `new_case` creates the counterparty's
  file.

A UID may only be listed when the index shows it on that company's receipts
alone. Coop's group UID is also printed on other Coop group retailers' receipts, and
the lint refuses it. `npm run check-processes -- --unknown` lists the merchants no file claims
yet, most frequent first. That list is the backlog for new files.

The reason for the split: before, a rule found in Q3 (Shopify orders fall into
three tax regimes, not two) went into the runbook. Meanwhile the flow still
said "Swiss or export", and the next quarter would have had to rediscover the
gap. With one home per rule, the flow can't contradict the knowledge, because
the flow doesn't hold any.

## How a step decides, so nobody gets asked twice

An agent working a step that has a guide section goes through these checks in
order:

0. **Gates.** These hold for every counterparty and run first, such as the
   closed period, an unsettled transaction, or no receipt. A gate with a
   `test:` is checked by code (`src/knowledge/gates.ts`) before any model
   sees the item.
1. **Rules.** The counterparty's rules come first, then the generic rules. The first rule whose `when` matches decides. The agent records
   which rule it used, by `id`, next to its output, such as a mapping, an entry
   or a flag.
2. **Precedents.** No rule matches, but a recorded human decision covers the
   same kind of case. The agent follows it and records the precedent `id`.
3. **`ask_human_when`.** Some cases always go to a person, even when a rule
   seems to fit. Example: anything that would change a filed figure.
4. **Otherwise it's a new case.** The agent does not guess and does not apply
   a default. The item takes the step's `new_case` exit into
   `new-case.flow.yaml`. Only that item stops; the rest of the quarter goes on.

`new-case.flow.yaml` ends by **writing the human's answer into the guide**. It
writes a new rule when the answer generalizes, otherwise a precedent. It does
that in the same session, before the item is resumed. That write-back is the
whole mechanism. It is why the next quarter is quieter than this one.

## A rule's status

- **No status:** settled. Apply it.
- **`status: proposed`:** a rule an agent wrote, or one nobody has confirmed
  yet. Agents apply it. `review_rules` in `quarter-close` confirms or replaces
  every proposed rule before the quarter is filed.
- **`status: open`:** a question waiting for an answer, often from the tax
  advisor. An item it matches is parked in `new-case`, not decided. Asking
  again does not help.

## The contract

`npm run check-processes` enforces rules 1–3 and the graph's wiring, and prints
how many rules are proposed or open. Every message names its own fix. Rules 4–7
are checked by hand in `review_rules`.

1. **Every decision is total.** A decision made by an agent has a `new_case`
   outcome that leads into `new-case.flow.yaml`. A decision with no
   way to say "I don't know" forces a guess, and guesses are what get redone
   next quarter.
2. **Every judgment step has knowledge.** Every agent step, and every decision
   made by a person, points at a guide section that exists. The section says what the step must
   achieve, what it reads, its rules, and when to ask.
3. **Every rule says where it came from.** Each rule has `id`, `when`, `then`,
   `why` and `source`. The source is a law, a document, or a dated human
   decision. A rule nobody can trace gets deleted, not followed.
4. **Every human step leaves a record.** It names what it `produces`, so its
   answer survives the session. Chat history is not a record.
5. **Every process can be resumed.** It starts from what the index and the disk
   say, not from what the last session remembers. Its done-gate is a command
   (`uses:`) that exits 0 only when the discharge holds.
6. **A filed quarter is set in stone** (AGENTS.md golden rule 1). Corrections only go through `correction.flow.yaml` into the next open quarter: as a correction entry when the books were wrong, or as a `vatAdjustments` declaration when only the filed return was wrong.
7. **No quarter-specific facts in steps.** Counts, dates and examples from one
   quarter go in comments as history, or in a guide as precedents.

`uses:` names the npm script that performs a step, so a process file can be
checked against `package.json`. A script that no process mentions is either a
library or a leftover.

## Where else knowledge lives

| Kind of knowledge | Home |
|---|---|
| A rule that decides a step, true for any company | `<process>.guide.yaml` |
| A rule or fact true for one vendor | `processes/counterparties/<id>.yaml`, or `counterparties/<id>.yaml` when it is about our books |
| A rule or decision true for this company only | `policy/<process>.guide.yaml` |
| How to click through a vendor portal | `docs/runbooks/receipt-collection.md` (private suppliers and our mailboxes: `docs/company/receipt-collection.md`), linked from a rule's `procedure:` |
| What a term means | `CONTEXT.md` |
| A decision with long-lived consequences | `docs/adr/` |
| A per-item answer (this receipt is noise) | the index, set via the Offen tab |

`AGENTS.md` keeps the short safety rules that every session must see, such as
the period lock and "the receipt decides the VAT code". It points here for
everything else.

## Calls stay small

Every model call is built from the three files above and nothing else. The
`claude` CLI runs with its own short system prompt, no tools, no settings and
an empty working directory (`src/llm/ask.ts`). Measured: about 630 tokens of
overhead instead of about 36,000 when it runs from the repo with CLAUDE.md,
memory, hooks and skills. On the same real prompts, that is 84% fewer input
tokens. Every call is logged; `npm run llm-usage` shows the real numbers per step. The choices are in `docs/adr/0002-counterparty-knowledge-and-lean-calls.md`.

## Not built yet

`npm:archive` is named by the flows but is not in `package.json` yet;
`npm run evidence` covers the rules stage of evidence.flow.yaml, and `npm:match`
still does the renaming. The
scripts don't read the counterparty files yet either: `decide()` and the lean
caller are the next implementation step (ADR 0002). Until then the lint lists
every file under `src/` (except `src/knowledge/`) whose code names a
counterparty as a whole word. Comments don't count.
