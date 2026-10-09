# What a Treuhänder corrects

This is the list of corrections a Treuhänder (the accountant who reviews the books) makes when
he reviews a quarter or closes a year of a Swiss GmbH that keeps its books here: effective VAT
method, cash basis (vereinnahmte Entgelte), the owner as the only employee. It is the
specification of the review package (`npm run review`, docs/accountant-review.md). Every row
marked v1 must work in the review package, and its acceptance test is how it is checked.

The rows come from two sources:

- Swiss SME practice. A Treuhänder reviews the quarter before the VAT return is filed, and the
  year before he signs the annual accounts. Most of his work at quarter end is accounts and VAT
  codes. Most of his work at year end is new entries that only he knows to book: accruals,
  depreciation, provisions, the salary and AHV difference, the private shares.
- The cases this app already knows: the casebook (`examples/cases/`), the rules and precedents
  in `processes/*.guide.yaml` (booking, correction, quarter close, year close), and the
  correction cases of the demo workspaces (a filed quarter corrected with a Storno and a new
  entry with `corrects`).

## How a correction reaches the books

The Treuhänder never writes the books. He works in a copy in his browser, and every change he
makes there is recorded as one correction: what he changed (the record before and after), and
his reason. He sends the list back as one file. The owner imports it as a git branch with one
commit per correction (author: the Treuhänder, message: his reason) and merges it like a pull
request. A correction of a filed quarter is never an edit: the review package turns it into a
correction entry in the open period with `corrects` (golden rule 1, AGENTS.md), with the same
code the owner's app uses.

Each correction has a kind. The kinds are the column "Kind" below:

| Kind | What it records |
| --- | --- |
| `editEntry` | One journal entry before and after: any of date, Soll, Haben, amount, VAT code, description, exchange rate. |
| `splitEntry` | One entry replaced by several that sum to the same amount. |
| `addEntry` | One or more new entries, not tied to a bank transaction. |
| `reverseEntry` | An entry removed (open period), or reversed by a Storno with `corrects` (filed period). |
| `linkReceipt`, `unlinkReceipt` | A receipt linked to or unlinked from a bank transaction. |
| `editTransaction` | A bank transaction's flag "kein Beleg nötig", its note or its description. |
| comment | A remark or a question on an entry, a receipt, a transaction or the review as a whole. Not a change to the books. |
| sign-off | "Quarter (or year) reviewed", with a statement. Not a change to the books. |

## The corrections

Frequency is how often a Treuhänder makes this correction in a typical quarter or year of a
small GmbH: often (most reviews), sometimes (a few reviews a year), rare (once in years).

| # | Correction | What he changes | Why (typical reason) | Frequency | Kind | v1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Change the Soll or Haben account | `accountDebit`, `accountCredit` of one entry | The expense is in the wrong account (software on 6500 instead of 6570), an item worth keeping was expensed (or the other way round), a private payment was booked as business expense (→ 2451 or the owner's current account). | often | `editEntry` | yes |
| 2 | Change the VAT code, I81 ↔ I0 | `vatCode` | The receipt shows no Swiss MWST, or shows it after all (AGENTS.md: the receipt decides). No receipt: no deduction. | often | `editEntry` | yes |
| 3 | Change the VAT code, letter or kind | `vatCode` (M81 ↔ I81, V81 ↔ V0-E, add B81-1) | Goods versus operating cost (M versus I). A service to a client abroad is Ziffer 221 (V0-E), not 8.1%. A foreign service without Swiss MWST owes Bezugsteuer (B81-1, rule pv-bezugsteuer). | often | `editEntry` | yes |
| 4 | Private share of a mixed-use expense | a new entry `D 2451 / C <expense>`, `K81-B` (Ziffer 415) | Phone, laptop, car used privately too: the input tax on the private share goes back (case private-share, rule eig-entry). | often (quarterly or yearly) | `addEntry` | yes |
| 5 | Change the description | `description` | The text does not say what was bought or for whom; an auditor must understand an entry from its text. | often | `editEntry` | yes |
| 6 | Link a receipt to a transaction, or unlink a wrong one | a mapping | The matcher linked the wrong receipt, or a receipt the owner filed was not linked. No linked receipt, no input tax. | often | `linkReceipt`, `unlinkReceipt` | yes |
| 7 | Comment or ask a question | nothing in the books | "Beleg fehlt", "Was ist das?", "Privat?" The owner answers, and a changed figure becomes a correction (rule yc-answer-with-entries). | often | comment | yes |
| 8 | Sign off a quarter or the year | nothing in the books | The quarter can be filed, or the annual accounts are approved (year-close.flow.yaml step signoff). | often (each review) | sign-off | yes |
| 9 | Change the amount | `amount` | A typo in a hand booking, a fee booked gross instead of net, a refund booked with the full amount instead of the refunded part. | sometimes | `editEntry` | yes |
| 10 | Split one entry into several | one entry → several with the same transaction | One receipt with two VAT rates (8.1% and 2.6%, case mixed-rate-receipt), a business and a private part of one purchase, one payment for several invoices (case sammelzahlung). | sometimes | `splitEntry` | yes |
| 11 | Change the date (period shift) | `date` | On cash basis the date is the payment date; an entry dated on the invoice date lands in the wrong quarter. | sometimes | `editEntry` | yes |
| 12 | Reverse or delete a duplicate or wrong entry | open period: the entry removed; filed period: a Storno with `corrects` | A transaction booked twice (rule imb-duplicates), an entry that should not exist. A filed entry is never deleted: a Storno in the open period with `corrects: "YYYY-Qn"` declares the difference on form 0535 (case correction-private-purchase, rules cor-shape, cor-korrekturabrechnung). | sometimes | `reverseEntry` | yes |
| 13 | Correct an entry of a filed quarter | a Storno of the filed entry and the right entry, both dated in the open period with `corrects` | Any of rows 1 to 11 on an entry of a filed quarter. The review package converts the edit itself; the Treuhänder edits the entry as if it were open. | sometimes | `editEntry` (converted) | yes |
| 14 | Mark a transaction "kein Beleg nötig" | `noReceiptNeeded` on the transaction | Bank fees, salary, AHV payments, transfers between own accounts: no receipt is expected. The flag clears it from the missing-receipt list. | sometimes | `editTransaction` | yes |
| 15 | Accrued expense or deferred income (transitorische Passiven) | a new entry, for example `D 6xxx / C 2300` | Year end: the Treuhänder's own fee for the year, an electricity bill for December paid in January. On cash basis this changes only the annual accounts, not the VAT. | often (year end) | `addEntry` | yes |
| 16 | Prepaid expense or accrued income (transitorische Aktiven) | a new entry, for example `D 1300 / C 6xxx`, `D 1301 / C 3400` | Year end: insurance paid for next year, work done in December and billed in January. | often (year end) | `addEntry` | yes |
| 17 | Depreciation | a new entry `D 6800 / C 15xx` | Year end: the laptop and the furniture lose value at the rates the tax office accepts. | often (year end) | `addEntry` | yes |
| 18 | Provision, including the tax provision | a new entry, for example `D 8900 / C 2330` | Year end: the profit tax of the year, a known risk. | often (year end) | `addEntry` | yes |
| 19 | Salary and AHV year-end difference | a new entry, for example `D 5700 / C 2270` | Year end: the Ausgleichskasse's final invoice differs from the advances (case ahv-akonto). | often (year end) | `addEntry` | yes |
| 20 | Exchange difference (Kursdifferenz) | a new entry `D 1021 / C 6960` or the reverse | Year end: the EUR and USD accounts revalued at the 31.12 ESTV rate (year-close.guide.yaml#revalue). | often (year end, with foreign accounts) | `addEntry` | yes |
| 21 | Privatanteile (car, rent at home) | a new entry, for example `D 2850 / C 6200` with `K81-B` where input tax was deducted | Year end: the private share of the company car (0.9% per month of the price) or of the home office, as the ESTV flat rates say. | sometimes (year end) | `addEntry` | yes |
| 22 | Correct the exchange rate | `exchangeRate` (and with it the CHF amount) | The entry used a flat rate or the rate of the wrong day; the rule is the ESTV sell rate on the payment date (ADR 0001). `npm run restamp-fx` fixes most cases on the owner's side. | rare | `editEntry` | yes (it is a field of the entry form) |
| 23 | Delkredere | a new entry `D 3xxx / C 1109` | Year end: a doubtful receivable. A one-person consultancy on cash basis rarely has one, because receivables are not booked. | rare | `addEntry` | yes (a new entry like rows 15 to 21) |
| 24 | Inventory change (Bestandesänderung) | a new entry `D 1200 / C 4xxx` or the reverse | Year end: goods in stock counted. Only for a company that sells goods. | sometimes (goods only) | `addEntry` | yes (a new entry like rows 15 to 21) |
| 25 | Add an account to the chart | `accounts.json` | An account the chart of the workspace lacks. The entry form already offers every account of the Swiss SME chart (`reference/charts/ch-kmu.yaml`); a booking on one adds nothing else to change. | rare | none | no, later |
| 26 | Fix an opening balance | `config.openingBalances` | The carried-forward balance of an account differs from the prior year's closed accounts. `npm run import-opening` derives them from the prior year's Banana export; a fix is the owner's rerun. | rare | none | no, later |
| 27 | Closing entries (profit to Gewinnvortrag, dividend) | entries after the year's result | The year's result moves to the equity accounts. Done in Banana Accounting today (year-close.flow.yaml step banana_close). | once a year | `addEntry` | no, later (possible as a new entry, not designed for) |
| 28 | Close a quarter (move the period lock) | `config.closedThrough`, a seal | The quarter is filed. Only the owner files and closes (`npm run seal -- <quarter> --close`); the Treuhänder signs off (row 8). | each quarter | none | no, never in a review |

## What v1 must do

All the "often" rows and everything a year-end close needs are v1: rows 1 to 24. They need
seven kinds of change plus comments and sign-off. Rows 25 to 28 wait: the chart and the opening
balances are rare and the owner fixes them with a command, closing entries are made in Banana
today, and closing a quarter stays the owner's act.

## Acceptance tests

Each v1 row is accepted when all of these hold for it in the review package of
`demo-consulting` (Q1 filed, Q2 and Q3 open), driven in a browser:

| # | Acceptance test |
| --- | --- |
| 1 | Double-click Soll on an open entry, pick another account. The row shows it, the Saldobilanz moves the amount between the two accounts, the correction list shows "Soll 6570 → 6500" with the reason typed. After import, the branch commit changes `accountDebit` of that entry and nothing else. |
| 2 | Change I81 to I0 on an open entry with Swiss VAT. The MWST tab of its quarter drops Ziffer 405 by the tax, and the entry form's preview showed the same Ziffer change before saving. |
| 3 | Change a code to B81-1 on a foreign service. The quarter's Ziffer 383 rises by the net amount and Ziffer 405 by the tax (net 0). |
| 4 | Book a new entry `D 2451 / C 6510 K81-B` in Q3. Ziffer 415 of Q3 rises by the tax; the entry has a new id and an `M<year>-<n>` reference. |
| 5 | Edit a description. The commit message is the reason; the commit's diff is the description. |
| 6 | Unlink a receipt from a transaction and link another. Two corrections, each one mapping removed or added. A link to a transaction of a filed quarter is refused with the closed-period message. |
| 7 | Comment on an entry and on a receipt. The review file holds both with their targets; the owner's PR view shows them under the review. |
| 8 | Sign off Q3 with a statement. The review file holds the sign-off; the owner's PR view shows it. |
| 9 | Change an entry's amount in the entry form. The ledger and the VAT figures recompute; the commit changes `amount` only. |
| 10 | Split an entry with two lines that sum to its amount (8.1% and 2.6%). The form refuses lines that do not sum. The commit changes the original entry and adds one; the VAT preview shows Ziffer 303 and 313 moving. |
| 11 | Change an open entry's date from Q3 to Q2. Its VAT moves from Q3's return to Q2's. A new date inside a filed quarter is refused. |
| 12 | Delete an open duplicate: the entry is removed. Reverse a Q1 entry: a Storno dated in the open period with `corrects: "2026-Q1"` and "Korrektur zu <id>" appears, Q1's Korrekturabrechnung shows the difference, and Q1's own entries are unchanged. |
| 13 | Change the VAT code of a Q1 entry. The review package books a Storno and the corrected entry, both with `corrects: "2026-Q1"`, dated in the open period; Q1's entries stay as filed (`mutateJournal` accepts the result). |
| 14 | Tick "kein Beleg nötig" on an open transaction. The commit sets `noReceiptNeeded` on that transaction only. |
| 15 to 24 | Book each as a new entry with the entry form (account combobox, VAT code picker, live VAT preview). The Bilanz and Erfolgsrechnung recompute. One sample of the group is enough to accept the form; row 4 and row 17 are the samples. |
| all | The owner imports the file: one commit per correction, author the Treuhänder, message his reason. The PR view lists each with its before and after, its VAT effect per quarter, and its status against today's books (applicable, already so, conflict, closed period). Merging applies the accepted ones through `mutateJournal`, records a merge commit, and the VAT figures of each quarter change exactly as the review package previewed. Importing the same file again changes nothing. |

## Checked

Filled in with the evidence when the review package is verified (`.verify/evidence/review/`).

| # | Checked | Evidence |
| --- | --- | --- |
