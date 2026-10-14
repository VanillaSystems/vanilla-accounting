# The quarter, step by step

A Swiss company registered for VAT files a VAT return every quarter. So you keep the books
every quarter too: after a quarter ends, you bring in what happened, book it, check it, and
file the return. This page walks through one quarter in Vanilla Accounting, in order.

It is for you, the owner. For each step it says what to run or click, and what to check
before you go on. The same steps are written for Claude, in more detail, in the
`processes/*.flow.yaml` files. Each step links to its flow, so you can see what an agent
does there.

The examples use the third quarter, `2026-Q3`. Put in your own quarter.

| # | Step | You run | Typical time |
|---|---|---|---|
| 1 | [Import the bank statements](#1-import-the-bank-statements) | `npm run extract` | 30 minutes |
| 2 | [Collect the receipts](#2-collect-the-receipts) | the mail sources (daily), the phone, the import folder | 1 to 3 days |
| 3 | [Read the receipts](#3-read-the-receipts) | `npm run extract`, `npm run extract-vat` | minutes |
| 4 | [Match receipts to payments](#4-match-receipts-to-payments) | `npm run match`, `npm run evidence` | hours |
| 5 | [Book](#5-book) | `npm run classify` | hours |
| 6 | [Review the open cases](#6-review-the-open-cases) | the app, `npm run gaps` | hours, less every quarter |
| 7 | [Reconcile and balance](#7-reconcile-and-balance) | `npm run reconcile-balances` | 30 minutes |
| 8 | [Check the VAT report](#8-check-the-vat-report) | the MWST tab | 30 minutes |
| 9 | [File with the ESTV](#9-file-with-the-estv) | `npm run vat-xml` | 15 minutes |
| 10 | [Close the period](#10-close-the-period) | `npm run seal -- 2026-Q3 --close` | 5 minutes |
| 11 | [Corrections later](#11-corrections-later) | a correction entry, form 0535 | when needed |

At any time, `npm run board -- 2026-Q3` shows what the quarter is still missing, and
`npm run doctor` checks the setup. The whole loop for agents:
[`quarter-close.flow.yaml`](../processes/quarter-close.flow.yaml).

## 1. Import the bank statements

Start with the bank. The statements list every payment of the quarter, so they tell you which
receipts you need. Without them you cannot know what is missing.

1. In the e-banking of every bank account, download the statement for exactly the quarter, in
   the format **camt.053**. Every Swiss bank offers it. At Wise, download it once per currency.
   [Getting started](getting-started.md#4-import-your-first-bank-statement) says where to find it.
2. Save each file in `transactional-data/<year>/bank-statements/<bank>/` of your workspace (an
   upload in the app files it there).
3. Run `npm run extract`. It reads the new statements into the books.

**Check.** The Kontoauszüge tab shows the statements, the Transaktionen tab the payments.
`npm run doctor` names a statement that belongs to no bank account.

For agents: [`bank-import.flow.yaml`](../processes/bank-import.flow.yaml), steps
`download_camt` and `import_camt`.

## 2. Collect the receipts

You need a receipt for every payment on the statements, and also for what you or your
employees paid in cash or with a private card. A receipt is what lets you deduct the VAT you
paid. Collecting is usually the most tedious part of the quarter. There are three ways in, and
all three end in the same folder, `beleg-import/` of your workspace:

- **Mailbox.** Each mailbox is a source: the workflow «Belege und Daten holen» takes the PDF
  attachments of new mail every day, and `npm run pull -- <source>` does it by hand. Set it up
  once: [Set up a mailbox](mail-setup.md).
- **Phone.** Photograph paper receipts with the phone app and import them to the laptop.
- **Folder.** Drag and drop PDFs into `beleg-import/`: downloads from vendor portals, scans,
  anything else.

Some vendors send no attachment: a link, or the invoice only in their portal. The
[receipt collection runbook](runbooks/receipt-collection.md) says what to do per vendor. Check
the artifact, not only that a PDF exists. An order summary is not an invoice and does not
prove the VAT.

**Check.** `npm run board -- 2026-Q3` counts the payments still without a receipt.

For agents: [`receipt-collection.flow.yaml`](../processes/receipt-collection.flow.yaml).

## 3. Read the receipts

```sh
npm run extract
npm run extract-vat
```

`extract` reads the text of each new receipt in `beleg-import/` (pdf.js, or the model's vision for
a scan). `extract-vat` then reads the VAT facts printed on it: the UID, whether Swiss MWST was
charged, the amounts per rate. Both skip what they have already read.

**Check.** In the Belege tab, open a few new receipts. A receipt with no text gets the
**KI-Texterkennung** button: it sends the image to Claude.

For agents: [`receipt-intake.flow.yaml`](../processes/receipt-intake.flow.yaml), steps
`extract` and `vat_facts`.

## 4. Match receipts to payments

```sh
npm run match
npm run evidence -- 2026-Q3 --apply
```

`match` asks Claude for each new receipt which payment it belongs to, gives the file a clear
name, and moves it to `receipts/` of its year (`transactional-data/<year>/receipts/`: the year of
the payment that books it). `evidence` links what fixed rules can prove: the same
amount, a payment reference printed on the receipt, the parts of a batch payment. Without
`--apply` it only shows what it would link. Run it again whenever new receipts or statements
arrive. It changes nothing in a closed period.

**Check.** The header shows how many receipts are **nicht zugeordnet** (not matched). In the
Belege tab, filter on them. For each one, link it in the app, or find the missing payment
(a different bank account, a private card).

For agents: [`evidence.flow.yaml`](../processes/evidence.flow.yaml).

## 5. Book

```sh
npm run classify
```

Claude books each payment of the open period: the accounts, the VAT code, the exchange rate
of the payment date for a foreign currency. It reads the payment, its receipts, your chart of
accounts, and the knowledge base: the generic rules of the app, and your own files on your
suppliers, customers and authorities (see step 6). The better the knowledge base, the more of
the first pass is right.

**Check.** The Buchungen tab shows every entry. A VAT code with a rate (I81, M81, V81) needs a
receipt that shows Swiss MWST. No receipt, no input tax: the code is then I0, M0 or V0.

For agents: [`booking.flow.yaml`](../processes/booking.flow.yaml), step `classify`.

## 6. Review the open cases

The first pass of a new company gets many payments wrong or leaves them open. This step is
where you teach Vanilla Accounting how your company books. It is the part the AI cannot do for
you, and it is what makes the next quarter go faster.

1. Go through the Transaktionen and Buchungen tabs. Fix what is wrong, link what is missing.
2. Each time you decide how a case is booked, write the answer down, so it is never asked
   again. Answers go into the knowledge base in your workspace:
   - `knowledge/suppliers/<id>.yaml`: one file per supplier. How to recognise it (its UID, its
     text on the bank statement), which accounts it books to, and its habits. Example: a
     courier sends one invoice every two weeks for several shipments, so one payment has
     several receipts.
   - `knowledge/customers/<id>.yaml`: one file per customer. Example: a customer abroad gets
     no Swiss VAT on a service.
   - `knowledge/authorities/<id>.yaml`: the ESTV, the AHV office, the tax office.
   - `knowledge/rules/`: your company's rules that are not about one partner. Example: the
     owner's phone is 30% private.
   Claude writes these files when you answer its question in a session. You can also edit them
   yourself.
3. Run `npm run gaps -- 2026-Q3`. It lists the payments that no supplier, customer or
   authority file claims, grouped by the text on the bank statement, most frequent first.
   A name that comes back every month deserves a file.
4. Run `npm run check-processes`. It checks the knowledge files and lists the rules Claude
   proposed that you have not confirmed yet. Confirm or replace each one that touched this
   quarter, before you file.

**Check.** No payment without an entry, no entry without its receipt (or a reason), no
proposed rule left open for this quarter.

For agents: [`new-case.flow.yaml`](../processes/new-case.flow.yaml) (deciding a case once and
writing it down), and [`quarter-close.flow.yaml`](../processes/quarter-close.flow.yaml), step
`review_rules`.

## 7. Reconcile and balance

```sh
npm run reconcile-balances
```

This compares each bank account's balance in the books with the closing balance on the bank's
statement, in the account's own currency. A difference means a payment is missing or
booked twice.

**Check.**

- `reconcile-balances` shows no difference for any account at the quarter end. The
  Kontenabgleich tab shows the same per month.
- The Saldobilanz tab: debit and credit add up to the same total. If they do not, find the
  entry that causes it and fix it before you go on.

For agents: [`bank-import.flow.yaml`](../processes/bank-import.flow.yaml), step `reconcile`,
and [`booking.flow.yaml`](../processes/booking.flow.yaml), steps `balances` and
`find_imbalance`.

## 8. Check the VAT report

Open the **MWST** tab and choose the quarter. It shows the figures (Ziffern) of the ESTV form
and, for each, the entries behind it. The same figures on the command line:

```sh
npm run vat-report -- 2026-Q3 --detail
npm run vat-report-html -- q3.html 2026-Q3     # a printable summary, for your Treuhand
```

**Check.** The turnover (Ziffer 200) matches your sales of the quarter. Every input tax
(Ziffern 400 and 405) has a receipt with Swiss MWST. A large or surprising figure: open its
entries and check them.

For agents: [`vat-filing.flow.yaml`](../processes/vat-filing.flow.yaml), steps `figures`,
`summary` and `drill`.

## 9. File with the ESTV

```sh
npm run vat-xml -- 2026-Q3 q3.xml
```

This writes the return as an eCH-0217 XML file, checked against the official schema.

1. Log in to the ESTV portal (ePortal), open **MWST abrechnen** for the quarter, and import
   the XML.
2. Compare the figures the portal shows with the MWST tab. Then submit.
3. Pay the amount due. The return and the payment are due 60 days after the quarter ends.

For agents: [`vat-filing.flow.yaml`](../processes/vat-filing.flow.yaml), steps `xml`,
`submit` and `pay`.

## 10. Close the period

Once the return is filed, the quarter never changes again. This is the first rule of the app
(see [`AGENTS.md`](../AGENTS.md), golden rule 1).

1. Copy the XML you filed into `transactional-data/<year>/filings/` of the workspace. Never generate a filed
   return again.
2. Close and seal the quarter:

   ```sh
   npm run seal -- 2026-Q3 --close
   ```

   This sets `config.closedThrough` in `ledger.json` to the last day of the quarter
   (`2026-09-30`). From then on, the app, the commands and Claude refuse to change any entry
   dated on or before that day. It also writes `transactional-data/2026/filings/seal-Q3.json`, a fingerprint of
   every entry, transaction and receipt link of the closed period. Each time the books load,
   the app checks the fingerprint. If anything sealed has changed, even by a hand edit, the
   books open read-only and `npm run doctor` says so.
3. Commit the workspace (`git commit`), so the filed state is on record.
4. Run `npm run check-closed`. It proves that nothing in the closed period differs from the
   committed state.

The fourth quarter is the exception: it closes with the year (`npm run year:close`, see
[year-end.md](year-end.md)), so the year-end entries can still be dated 31.12.

A quarter you closed before seals existed: `npm run seal -- 2026-Q2` seals it as it is now.
`npm run doctor` lists the closed quarters that have no seal yet.

For agents: [`vat-filing.flow.yaml`](../processes/vat-filing.flow.yaml), steps `archive`,
`lock` and `prove`.

## 11. Corrections later

You may find a mistake in a quarter you have already filed. You do not change that quarter.
You correct it in the quarter that is still open:

- **The books were wrong** (a missing invoice, a wrong VAT code): book a correction entry dated
  in the open quarter. It names the original entry and the quarter it corrects. It is declared
  on a correction form (Korrekturabrechnung, ESTV form 0535) for that quarter, not in the open
  quarter's return.
- **The books were right, but the filed return was wrong:** book nothing. The MWST tab
  recomputes the filed quarter from the books and shows the difference for form 0535.

The MWST tab shows, for every filed quarter, what was filed, what it is now, and the
difference.

For agents: [`correction.flow.yaml`](../processes/correction.flow.yaml).

## After the fourth quarter

The year-end comes on top of the fourth quarter: the revaluation of foreign currency accounts,
the year-end entries, the closing, the opening balances of the new year. File the fourth
quarter as usual, but do not close it with `npm run seal`: `npm run year:close` closes and
seals it after the year-end entries. See [year-end.md](year-end.md).
