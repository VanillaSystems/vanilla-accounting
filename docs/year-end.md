# The year-end, step by step

After the fourth quarter (the second half year, for a firm on the Saldosteuersatz) you close the
year and open the next one. This page is for you, the owner. It says when to start, what Vanilla Accounting checks and books for you, what your
Treuhänder (accountant) does, and what goes to an auditor.

The examples close 2026 and open 2027. Put in your own year.

| # | Step | You run | When |
|---|---|---|---|
| 1 | [File the fourth quarter, do not close it](#1-file-the-fourth-quarter-do-not-close-it) | `npm run vat-xml -- 2026-Q4` | by end of February |
| 2 | [Check what is still open](#2-check-what-is-still-open) | `npm run year:close -- 2026 --dry-run` | once the balances of 31.12. are in |
| 3 | [Book the year-end entries](#3-book-the-year-end-entries) | Abschluss (`/close`) | with your Treuhänder |
| 4 | [Close the year](#4-close-the-year) | `npm run year:close -- 2026` | when nothing is open |
| 5 | [Open the new year](#5-open-the-new-year) | `npm run year:open -- 2027` | right after |
| 6 | [Allocate the profit](#6-allocate-the-profit) | Abschluss (`/close`) | after the shareholders decide (GmbH, AG only) |
| 7 | [Hand over to the auditor](#7-hand-over-to-the-auditor) | `npm run build:audit -- <folder>` | when asked |

The steps and the accounts they book on follow the legal form (`byLegalForm` in
`modules/ch/year-end.yaml`): an Einzelfirma has six steps, because its profit is the owner's and
is never allocated.

The same steps for agents: [`year-close.flow.yaml`](../processes/year-close.flow.yaml).

## 1. File the fourth quarter, do not close it

File the return of the fourth quarter as every quarter
([quarter workflow](quarter-workflow.md), steps 1 to 9), and copy the filed XML to
`transactional-data/2026/filings/`.

Do **not** run `npm run seal -- 2026-Q4 --close`. Year-end entries such as the exchange
difference and depreciation are dated 31.12. Once the fourth quarter is closed, nothing can be
dated 31.12. any more. `npm run year:close` closes and seals the fourth quarter itself, after
those entries. `npm run seal` refuses the fourth quarter for this reason (`--force` overrides
it, when the year-end entries are booked already).

The year-end entries carry no VAT, so they do not change the return you filed. One exception:
a private share (Privatanteil) corrects input tax. Book it before you file the fourth quarter.

## 2. Check what is still open

```sh
npm run year:close -- 2026 --dry-run
```

This prints the checklist and writes nothing. Abschluss (`/close`) in the app shows the
same list. Every item is computed from the books:

- **The fourth quarter is filed.** Its XML is in `transactional-data/2026/filings/`.
- **Q1 to Q3 are closed and sealed.** Each closed with `npm run seal -- <quarter> --close`.
- **Bank, cards and cash are confirmed on 31.12.** Each bank and card account needs its
  balance on 31.12. from a document, and that balance must equal the balance of the books, in
  the account's own currency. The document is an imported statement that covers 31.12., or the
  bank's year-end confirmation (Saldobestätigung). Without a statement, enter the balance in
  Abschluss › Prüfungen › Saldi per 31.12. and attach the confirmation, or run
  `npm run year:close -- 2026 --balance 1020=<balance> --document Saldobestaetigung.pdf`.
  Each cash account needs the cash you counted on 31.12. (`--cash 1000=<counted>`). A difference to
  the books is shown and blocks the close: book it dated 31.12. (Kassendifferenz), or count
  again. The app never books it. The owner's and employees' accounts need no confirmation.
- **The statements cover the whole year.** Only on an account with at least one imported
  statement: no month of it is missing. An account you never imported a statement for is not
  asked for one.
- **Every transaction of the year is booked.**
- **`npm run doctor` finds nothing to fix** in the workspace.
- **The exchange difference (Kursdifferenz).** A EUR or USD account is booked at the daily
  rate of each payment, so its CHF value drifts from its value at the year-end rate. The
  native balance on 31.12. times the ESTV rate of 31.12., minus the CHF book value, is the
  exchange difference. If the ESTV has not published the rate of 31.12. yet, the item says so.
  Run `npm run fetch-rates -- --year 2026` once it is out.
- **The VAT check.** Your entries hold VAT gross, with a VAT code. The check posts the tax of
  each code to the VAT account, as Banana does, and compares it with the returns you filed.
  Bilanz & ER show the same postings during the year: their figures are net, and the tax is on
  the VAT account from the day of its entry. The postings are worked out when the reports are
  read and never written to the journal, so the close counts them once, and the result it
  carries into the next year is the one Bilanz & ER show on 31.12.
  What is still owed on 31.12. should be the fourth quarter. A difference means a payment to
  the ESTV is missing or was booked twice, or a correction (form 0535) was not paid in the year.
- **The year-end entries** (step 3).
- **The closing balance sheet.** Aktiven must equal Passiven plus the result. If not, the
  check names the cause: entries with one account only, an account not in your chart, or
  opening balances that did not balance. Fix the cause. Never book the difference away.

## 3. Book the year-end entries

Abschluss (`/close`) lists the entries a year-end may need. Your Treuhänder tells you
which ones apply. For each one, click **Erfassen** to open a prefilled entry form, or mark it
**Nicht nötig** (not needed). Booking one marks it done.

| Entry | Example |
|---|---|
| Depreciation (Abschreibungen) | 6800 / 1520: a third of the notebook bought in 2026 |
| Accrued expenses (2300) | the December invoice you pay in January |
| Prepaid expenses (1300) | the insurance for 2027 you paid in December |
| Accrued income (1301) | December work you invoice in January |
| Deferred income (2301) | a January project the client paid in December |
| Provisions (2330) | the Treuhänder's fee for this year-end |
| Tax provision (8900 / 2208) | the profit and capital tax of 2026 |
| Private use (2451, K81-B) | the private share of the car or the phone |
| Inventory change | stock or work in progress on 31.12. |
| Social insurance (5700 / 2270) | AHV, BVG and UVG final statements against advance payments |
| Doubtful accounts (3805 / 1109) | a client invoice that may not be paid |
| Receivables (1100, Debitoren) | invoices still open on 31.12.: proposed only when there are some, the open amount in CHF prefilled, credited to `invoicing.revenueAccount` without a VAT code (the VAT is declared when the customer pays); reverse it in the new year (ADR 0010) |

`npm run year:close` books the exchange difference itself, on 31.12., to Kursdifferenzen
(6960), with no VAT. Run it again after a change and it replaces its own entry. It never adds a
second one.

From the command line you can mark entries too:

```sh
npm run year:close -- 2026 --done depreciation,provision --na inventoryChange,doubtfulAccounts
```

## 4. Close the year

```sh
npm run year:close -- 2026
```

Or click **Jahr abschliessen** in Abschluss (`/close`). It refuses while anything is open,
and says what. When nothing is open, it:

1. books the exchange difference,
2. sets `config.closedThrough` to 31.12.2026,
3. seals the fourth quarter (`transactional-data/2026/filings/seal-Q4.json`),
4. records the close in `transactional-data/2026/filings/year-close.json`,
5. commits `ledger.json` and `transactional-data/` when the workspace is a git repository.

From then on the app never writes a file of 2026 again: its books, receipts and statements are
read-only, and a receipt of 2026 that arrives later is booked and filed in 2027.

From then on nothing dated 2026 changes. A mistake found later is corrected in 2027, as
every correction is ([quarter workflow](quarter-workflow.md), step 11).

## 5. Open the new year

```sh
npm run year:open -- 2027
```

Or click **Neues Jahr eröffnen** in Abschluss (`/close`). It derives the opening balances
of 2027 from your closed 2026:

- Every balance-sheet account (classes 1 and 2) carries its balance of 31.12.
- The income statement starts at zero.
- The 2026 result is added to Gewinnvortrag (2970). An Einzelfirma has no Gewinnvortrag: its
  result goes to the owner's capital (2800 Eigenkapital), and the private account (2850 Privat)
  closes into it too, so the year's withdrawals lower the capital and the private account starts
  the new year at zero.
- A EUR or USD account opens with its EUR or USD balance, and with its CHF value at the rate of
  31.12. The closing rates become the opening rates.

It checks that Aktiven equal Passiven and refuses to write an opening that does not balance.
Run it again later and it updates the opening balances, listing what changed.

If you closed 2026 in Banana instead, import Banana's balances:
`npm run import-opening -- --file buchhaltung-2026.Konten.xml --year 2027 --write`.

Fetch the rates of the new year when you start booking it:
`npm run fetch-rates -- --year 2027`.

## 6. Allocate the profit

The shareholders' meeting decides what happens with the profit, within six months of the
year-end. After it, use **Gewinnverwendung** in Abschluss (`/close`), dated on the day of
the decision:

- a part to the statutory reserve (2950),
- a dividend. The company owes 35% Verrechnungssteuer (withholding tax) on it (2206) and pays
  that to the ESTV within 30 days. The shareholder is credited 65% (2451).

The app does not decide this for you. A loss stays in Gewinnvortrag. The rows offered are the
accounts the chart has; a missing one is named with «Konto anlegen».

An Einzelfirma has no such step: there is no Generalversammlung, no dividend and no
Verrechnungssteuer. The profit belongs to the owner and is taxed with her income; what she takes
out of the firm are Privatbezüge on 2850.

## 7. Hand over to the auditor

Your Treuhänder needs the balance sheet, the income statement and the account ledgers. An
auditor (ESTV VAT audit, AHV audit) needs the books with every receipt. Give both the audit
export of the year:

```sh
npm run build:audit -- ~/Desktop/audit-2026
```

See [audit-export.md](audit-export.md).

## The balance sheet tab and the year-end

The Bilanz and Erfolgsrechnung tabs show your entries as booked, VAT included, and say so under
the result, with the VAT the shown figures hold (owed, input tax, net); the exported PDFs and
CSVs carry the same line. The year-end close and the opening split the VAT off by code, as Banana does. So for a VAT-registered
company the Bilanz tab on 31.12. differs from the opening balances on 1.1. in the VAT account
(2201), in assets bought with input tax, and in the result. Abschluss's closing
balance sheet is the one that carries over.
