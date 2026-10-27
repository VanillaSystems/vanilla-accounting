# Processes

The business processes of this repository, written as files. One file per
process, YAML, in the flow format. The drawing is generated from the file and
is read-only. No coordinates are ever stored here, so editing a step's text is
safe for anyone.

| File | What it covers |
|---|---|
| `quarter-close.flow.yaml` | The whole quarter, at the altitude you think about it. The middle steps name the files below. |
| `receipt-collection.flow.yaml` | Email, vendor portals and paper, through to a receipt staged in `beleg-import/` |
| `receipt-intake.flow.yaml` | Staged file → text, VAT facts, its kind, archived under its year's `receipts/` |
| `bank-import.flow.yaml` | camt053 and statement PDFs in, every month end reconciled to the cent |
| `evidence.flow.yaml` | Receipts ↔ transactions, re-runnable: rules, then AI, then the Offen tab, until every transaction is settled |
| `booking.flow.yaml` | Settled transactions → journal entries, splits, VAT codes, FX at payment date; stale entries rebooked |
| `vat-filing.flow.yaml` | MWST-Abrechnung → eCH-0217 XML → ESTV → `filings/` → period lock |
| `year-close.flow.yaml` | Year-end revaluation, sign-off, and next year's opening balances |
| `new-case.flow.yaml` | What happens when no rule covers a case: decide it once, write the decision down, never ask again |
| `correction.flow.yaml` | A change that touches a closed period: a new entry in the open period, never an edit |

## Three kinds of file, and why

Every process has two files, and every business with particulars has one:

- **`<process>.flow.yaml`** is the shape: the steps, who does each one, the
  order, and the gates. It changes only when the *process* changes. A new
  vendor, a new VAT case or a new exemption never adds a step.
- **`<process>.guide.yaml`** is the knowledge: for each step that needs
  judgment, the rules that decide it, in order, and what the human has already
  decided. It changes every time we learn something. That is what it is for.

- **`<role>/<id>.yaml`** holds everything true about one business and
  nobody else, such as Coop Pronto, FedEx, Shopify or the ESTV. `<role>` is
  the folder of its main role: `suppliers/` (Lieferanten: vendors, Shopify,
  Stripe, banks, payment services), `customers/` (Kunden) or `authorities/`
  (Behörden: ESTV, Ausgleichskasse, cantonal tax office, BAZG, the BVG
  foundation, the UVG insurer). A business with a second role lists it under
  `roles:` (e.g. `roles: [customer]`); it still has one file. The app's files
  are in `processes/<role>/`, the company's part in `knowledge/<role>/` (see the
  two layers below). A file covers how to recognise the business (`match:`),
  whether it bundles invoices into one payment (`grouped:`), a UID it prints
  that others print too and that therefore names nobody (`sharedUid:`, e.g. a
  courier's, also on the customs office's assessments), which accounts it
  books to (`accounts:`), and its rules for each step it touches. Each step's
  rules sit under the step's exact address:
  `steps: { "booking.guide.yaml#classify": { rules: [...] } }`. An authority's
  file also lists `facts:` of the law (periods, deadlines, forms), each with
  its `source:`. A flow step names the facts it depends on as
  `facts: [ estv#payment-deadline ]` instead of repeating them: the flow keeps
  the how and the order, the authority's file the facts, and the lint
  checks that every named fact exists.

## Two layers: the app and the company

The app is meant to be public; the books are one company's. So the knowledge
lives in two layers, merged once when it is read (`src/knowledge/layers.ts`):

| Layer | File | Holds |
|---|---|---|
| App | `processes/<process>.guide.yaml` | rules true for any Swiss company |
| App | `processes/<role>/<id>.yaml` | facts of one business true for every company: `name`, `match`, `grouped`, documents, `facts`, rules |
| Company | `knowledge/rules/<process>.guide.yaml` | this company's rules and precedents for a step |
| Company | `knowledge/<role>/<id>.yaml` | the binding of an app file: `accounts`, company rules, precedents, extra signals, `grouped` when the app file does not say it; or a whole private business |

A business has one file per layer, in the same `<role>` folder in both
(the loader refuses an id in two folders). A file whose name starts with `_`
is a template (`npm run init` writes `_example.yaml` into each folder) and is
never read. A workspace from before this layout (`counterparties/`,
`policy/`) is refused until `npm run migrate-workspace` has moved it.

Every field has one owner. A company file adds signals, documents and rules
after the app's; it never redeclares `name` and never replaces a rule. It says
`grouped: true` only for a business whose app file does not say `grouped`: the
company learned from its own payments that the business is paid for several
receipts at once (the «Immer so?» after two such links, issue #190). The lint keeps the app layer generic: no `accounts`, no precedents, a
source that names a law, a document or a dated decision, no bank ref, date,
long number or amount to the cent, and no name of a private supplier.

A flow step points at its guide section with
`with: { guide: <process>.guide.yaml#<step-id>, model, batch }`. An agent
working one item of a step reads the step's section in both layers, the
section of **that item's** business for the same address in both layers,
and nothing else. A FedEx batch never carries Coop Pronto's rules.

**Where does a new rule go?** Ask: *would it still be true for a company we
have never seen?* If yes, it goes in the step's guide. If it is true for every
company dealing with one business, it goes in that business's file. If it is
true for us only, it goes in `knowledge/<role>/<id>.yaml` or
`knowledge/rules/<process>.guide.yaml`,
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

## A rule code carries out

A business's facts that decide a code without judgment are carried out by code,
not left to a model that may miss them (src/booking/purchase-vat.ts). A rule of
a business file under `booking.guide.yaml#purchase_vat` states it as `apply:`
beside its prose:

- `apply: { inputTax: none, direction: in }`, in the app layer only: the
  business's purchase lines on such a payment claim no input tax (a platform's
  payout, whose fees a monthly bill proves). A fact true for every company.
- `apply: { unreadReceipt: 8.1 }`, in the company layer only
  (`knowledge/<role>/<id>.yaml`): the business's receipt that could not be read
  counts as showing Swiss VAT at that rate on its whole amount. That is a risk
  the company chooses to take, not a fact of the business, so no shipped file
  states it; without it an unread receipt decides nothing.

An account is one company's chart, so `apply:` never books one. A rule that
leaves a choice («CHE number → I81, none → B81-1») has no `apply:` and stays
the model's. The company's word goes first: a business whose file in
`knowledge/` has rules of its own for the step keeps the model's codes (unless
that file has an `apply:` of its own), and a company's executable booking rule
books before any of this. `npm run check-processes` checks every `apply:` and
refuses each form in the other layer.

## A payment provider

A shop platform or a card terminal collects the company's sales and pays them
out less its fees. Its business file says so with a `provider:` section
(src/knowledge/provider.ts), and code takes it from there (#203):

```yaml
# processes/suppliers/shopify.yaml: the app layer, true for every company
provider:
  reports:
    sales: { order: Name, date: Paid at, shipTo: Shipping Country, gross: Total, tax: Taxes, refunded: Refunded Amount, gateway: Payment Method }
    fees: { date: Transaction Date, fee: Fee, order: Order }
  gateways: [ "Shopify Payments" ]
  processors: [ "stripe" ]
  payoutDays: 7
# knowledge/suppliers/shopify.yaml: the company layer, its chart
provider:
  clearing: "1093"
  since: 2026-10-01
  revenue: "3200"
  fees: { account: "6580", vat: I0 }
  account: "1020"   # optional: the bank account it pays into
```

- `since` is the company's cut-over day. From it on the provider's payouts,
  sales, refunds and fees go over the clearing account; whatever is dated before
  it stays exactly as it was booked, and is booked like any other payment if it
  is not booked yet. The app never books an existing entry again to switch a
  provider over. The drop asks for it with the clearing account, proposing the
  first day of the open period; it must lie in the open period.
- Its payout from `since` on is a settlement, not a sale: code books it bank /
  `clearing` without VAT. Until the company's file names `clearing` and `since`
  it waits for the person; neither a rule nor the model books it. It needs no
  receipt and is never matched to one (no receipt set, no pair, no model match,
  no order link). A payout is the provider's by its `match` like any payment,
  or, when the payer is no business of the books, by a `match.tx` word that
  begins its reference («Received money from Stripe Payments UK Ltd with
  reference Shopify …»), and then only when the bank names no payer or one of
  the app file's `processors` (Shopify's: `stripe`): a customer's own transfer
  «Shopify Bestellung 1001» is no payout. When the bank's payments of a report's
  days (from its first order the provider collected, plus `payoutDays`) are in
  the books and none is recognised as its payout, the report books nothing and
  its drop row says why and which accounts it looked at; «Trotzdem übernehmen»
  books it (the clearing check shows a difference if a payout was booked as
  sales), and the payout's name belongs into the company's `match.tx` by hand.
  With `account: "<ledger account>"` the company's file names the bank account
  the provider pays into, the only one that check then looks at. A payout before `since` within `payoutDays` of it, beside sales a
  report booked before its day, waits for the person: booked as sales they would
  count twice. The payment says why it waits.
- Its report (the CSV it exports) is recognised in the drop by the columns of
  `reports`: each a header or a list of headers. Code books each order onto the
  clearing account with its code (delivered in the VAT territory: the sale code
  at the rate its tax column shows, normal or reduced; abroad: V0; a refund with
  the minus, on its own day `refundedAt`) and each fee at `fees.vat`, in a
  foreign currency at the ESTV daily sell rate of the tax point. With
  `gateways`, only the orders whose `gateway` column names one of them are the
  provider's; the others (PayPal, bank transfer, a gift card, a test gateway)
  are counted, never booked onto the clearing account. A domestic order without
  tax or at no rate the firm books, Swiss VAT on an export, and a refund without
  its own day wait for the person. An order of a filed period is not booked; its
  refund paid in the open period is.
- The report reaches back to `since` less the payout days (`payoutDays`, the
  company's file may set its own): a sale collected then may be paid out after
  `since`, from the clearing account, so the report books it, dated by its own
  tax point, when that day is open and on or after the books' start (on the
  agreed basis the order's day dates it; the reach goes by the day collected). Before
  `since` it books only what no payout before `since` can have paid the old way:
  a row waits when the clearing account carries it already (the old way, per
  order: by its ref or its day and amount) or when a payout of the provider
  dated before `since` and after the row's day is not booked bank / clearing
  account (booked as sales, or not booked yet). An order, refund or fee dated
  earlier is counted and named («vor dem …»), never booked; the drop row says
  that a longer `payoutDays` reaches further. So the clearing check comes
  out even after the cut-over.
- What the books carry from elsewhere holds what it may be, so nothing counts
  twice: a sale on the clearing account no report booked (an
  older booking per order such as `SHOPIFY-<n>`, a person's own) that names an
  order by its ref or text with the order's amount books it (known, never held
  again); with another amount, or matched by day and amount only, it holds the
  order; one on or after `since` that names
  none holds every order up to its day; a payout of the provider booked otherwise than from the
  clearing account (as sales, by a person) on or after `since` holds every
  order, refund and fee up to its day. Held rows wait for the person, named in the drop row and kept on
  the report's receipt (`report.held`, the latest taking's, at most 200 named).
  «Rückgängig» takes only the report's own entries and links.
- One source of sales per provider: a provider with `reports.sales` takes none
  from a payout report (a card terminal's PDF), whose sales book only with its
  payout booked from the clearing account.
- The accounts are one company's chart: only the company's file names them,
  and the drop asks for a missing one once and keeps the answer there.
  `revenue` falls back to the account of what the firm sells. `payoutDays` and
  `gateways` may be said in the company's file too: its payout days win, its
  gateways are added.
- Order documents prove the delivery: code links them to their order's sale,
  never to the payout.
- At a period's close, the review shows the clearing account's balance, its
  month ends, and what the provider paid out within `payoutDays` after the end:
  that holds sales after the end too, so it is the most the balance may be; a
  balance above it, or below zero, is a difference. A clearing account in a
  foreign currency carries exchange differences until the year end revalues it.
  The clearing account must be a balance-sheet account (an asset or a
  liability) that no other provider's file names.

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
| A rule or fact true for one business | `processes/<role>/<id>.yaml`, or `knowledge/<role>/<id>.yaml` when it is about our books |
| A period, deadline or form of an authority | `processes/authorities/<id>.yaml` under `facts:` |
| A rule or decision true for this company only | `knowledge/rules/<process>.guide.yaml` |
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
