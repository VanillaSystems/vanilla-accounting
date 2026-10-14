# Getting started

This guide takes you from an empty folder to your first VAT return. It is for the owner of a
small Swiss company who keeps the books alone: technical, but not an accountant.

Vanilla Accounting fits a company that is registered for VAT on the effective method, taxed on the cash
basis (vereinnahmte Entgelte), files quarterly, and keeps a calendar fiscal year. A GmbH or an
AG is fully supported. Read [Limits](#limits) before you start.

## 1. Install

Both ways need **Claude Code** with a Claude subscription (Pro or Max): Vanilla Accounting calls
the `claude` command to read receipts, match them to payments and book them. Install it with
`npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in. Without it,
everything else works.

### The Mac app

Download the `.dmg` from the Releases page of this repository (`arm64` for Apple silicon, `x64`
for an Intel Mac), open it and drag **Vanilla Accounting** into Applications. Until the app is
signed, macOS refuses it the first time: open System Settings › Privacy & Security and choose
**Open Anyway**.

The app starts on a screen with three choices. **Neue Buchhaltung anlegen** asks the questions of
step 2 as a form and creates the workspace folder you choose; **Bestehende Buchhaltung öffnen**
opens a workspace you already have; **Demo ansehen** opens a copy of the demo company. The app
does what this guide does with commands: read on from step 2 for what the questions mean, and
skip the commands. The [desktop guide](desktop.md) explains how the app is built.

### From the source

You need **Node.js 22** or newer (on macOS: `brew install node`). Clone this repository and
install the app:

```sh
cd vanilla-accounting  # the folder you cloned it into
npm install
```

## 2. Set up your books: `npm run init`

In the Mac app: **Neue Buchhaltung anlegen** on the start screen, or File › Neue Buchhaltung…

```sh
npm run init
```

The wizard creates a **workspace**: one folder that holds your company's books, receipts and
statements, kept apart from the app. It is a git repository of its own, so every change to
your books stays traceable. The app's `.env` then points at it, so every command works on
your books.

First, pick the profile that fits best. It fills in the answers below; press Enter to keep
an answer, or type another one.

| Profile | For |
|---|---|
| Consultant / services GmbH | You sell your work: consulting, software, design. The owner is employed by the company. |
| Webshop / goods GmbH | You sell goods, often online, and import some of them. |
| Freelancer, not registered for VAT | Not supported yet. The wizard explains and stops. |
| Custom | You answer every question yourself. |

Then the wizard asks for the company name, the folder for the books, the UID (from
[uid.admin.ch](https://www.uid.admin.ch); the check digit is verified), the owner, and a few
words on what the company does. Then these questions, in this order:

1. **Legal form.** GmbH or AG: fully supported. Einzelfirma: the owner draws no salary, and
   money taken out is booked on 2850 Privat. Day-to-day bookkeeping and VAT work. The year-end
   (AHV on the profit, the tax return) is not covered.
2. **Registered for VAT (MWST)?** Registration is mandatory from CHF 100,000 turnover a year.
   Books without VAT are not supported yet. If you answer no, the wizard stops.
3. **VAT method.** Effective (you pay the VAT you charged minus the input tax on your costs).
   The Saldosteuersatz method is not supported yet. If you choose it, the wizard stops.
4. **VAT basis.** Vereinnahmt (cash): VAT is due when the money moves. Vereinbart (invoice) is
   not supported yet, because Vanilla Accounting books from the bank statement and keeps no open invoices.
5. **VAT reporting period.** Quarterly. Half-yearly and monthly returns are not supported yet.
6. **Fiscal year.** The calendar year. Another fiscal year is not supported yet.
7. **Starting point.** A new company starts with empty books. If you switch from other
   bookkeeping, bring your opening balances of 1 January: `npm run import-opening` reads them
   from a Banana export (Konten XML), or you enter them later.
8. **What you sell.** Services, goods, or both. This picks the accounts of your chart.
9. **Customers abroad?** A service to a customer abroad is usually declared without Swiss VAT.
10. **Do you import goods?** Imports come with customs and import VAT invoices.
11. **Employees.** None, the owner only, or staff. Vanilla Accounting books the salary and the AHV, BVG and
    UVG payments. Your payroll provider or Treuhand does the payroll itself.
12. **Does the owner pay business costs privately?** Then those receipts are booked on a current
    account with the owner (2451 Kontokorrent; 2850 Privat for an Einzelfirma).
13. **Private use of a company car or phone.** The private share takes back part of the input
    tax (Eigenverbrauch, VAT code K81-B).
14. **Do sales reach you as payouts from a webshop or payment provider?** Then a clearing
    account (1093) holds the payout until its sales and fees are booked.

Last, your bank accounts, one at a time: Raiffeisen, UBS, PostFinance, ZKB, another cantonal
or regional bank, Wise (one account per currency), PayPal, or a credit card. The wizard
suggests a ledger account for each: 1020 for CHF, 1021 for EUR, 1022 for USD, then the next
free number; 2101 for a card. It also asks for the account's IBAN. The IBAN is optional: press
Enter to skip it, and `npm run doctor` shows it to you once the first statement is imported.
Last it asks where the books go at year-end, such as Banana or your Treuhand. In the flag form a
bank is `<bank>:<currency>[:<ledger account>[:<IBAN>]]`, for example `--bank "UBS:CHF::<IBAN>"`
(an empty ledger account takes the suggested one).

The folder becomes your company's repository. Its `AGENTS.md` holds notes for Claude about your
company; the books lie in its `vanilla-accounting/` ([ADR 0013](adr/0013-workspace-layout-and-ownership.md)):

| File or folder in `vanilla-accounting/` | Holds |
|---|---|
| `belege.workspace.yaml` | Who the company is, your answers, and which ledger account each bank books on |
| `knowledge/` | What the app learns about your suppliers (`suppliers/`), customers (`customers/`), authorities (`authorities/`) and your own rules (`rules/`); each folder starts with a commented `_example.yaml` |
| `mail.yaml` | Mailboxes to collect receipts from (optional, commented template) |
| `beleg-import/` | Where new receipts arrive |
| `ledger.json` | The books' settings: up to which day they are closed, opening balances, corrections |
| `master-data/accounts.json` | Your chart of accounts, taken from the Swiss KMU chart for your profile |
| `transactional-data/<year>/books/` | The books of the year: transactions, receipts, journal entries, one record per line. Empty at first |
| `transactional-data/<year>/bank-statements/<bank>/` | Your camt.053 statements |
| `transactional-data/<year>/receipts/` | Receipts after they are read and matched |
| `transactional-data/<year>/filings/` | Your VAT returns as filed, and their seals |

Files that are not the app's (notes, scripts, exports of an earlier program) go into `own/` at the
repository's root; `npm run doctor` names every other one.

Every question also has a flag, so `npm run init` runs without questions too:

```sh
npm run init -- --preset consultant --dir ../my-books --name "Beispiel GmbH" \
  --uid <your UID> --owner "Erika Beispiel" --bank UBS:CHF --bank Wise:EUR --yes
```

Run `npm run init` again on the same folder and it changes nothing. If `.env` already points
at other books, the wizard asks before it changes that (`--set-env` replaces it without
asking).

## 3. Check the setup: `npm run doctor`

From the source only. The Mac app opens only a folder that holds `belege.workspace.yaml`.

```sh
npm run doctor
```

It checks the tools (Node.js, the `claude` command and its login) and the workspace
(the manifest, the books, the folders, that every bank account is in the chart, and which
bank account each statement file lands on). Each line starts with ✓ or ✗. A ✗ line says how
to fix it. A ! line is a note that does not stop you.

## 4. Import your first bank statement

Vanilla Accounting reads bank statements in the ISO 20022 format **camt.053**, an XML file that Swiss
banks offer since the switch to ISO 20022 payments. It is the statement
(Kontoauszug), with the bank's opening and closing balance. In your e-banking, look for the
account statement or the account export and choose camt.053. Some banks call it ISO 20022,
XML, or "elektronischer Kontoauszug". Some banks deliver camt.053 only after you switch it on
once in the e-banking settings, sometimes for a fee; if you cannot find it, ask your bank for
"camt.053". At Wise, open the account in each currency, download a statement, and choose the
camt.053 format.

Which banks: the import is tested with Raiffeisen and Wise statements, and with statements in
the shapes UBS, PostFinance and the cantonal banks export (the tests read synthetic ones).
Any other bank's camt.053 reads the same way.

Save each file in `transactional-data/<year>/bank-statements/<bank>/` of your workspace, for example
`transactional-data/2026/bank-statements/UBS/` (or upload it in the app, which files it there). The file name does not matter, and a subfolder is fine. Each statement
lands on a bank account of `belege.workspace.yaml`:

1. The account with the statement's IBAN and currency, when you entered the IBAN. Then the
   folder does not matter.
2. Otherwise, the account whose bank is the folder name, in the statement's currency.

A statement that matches no account stops the import before anything is written, and
`npm run doctor` says which account to add. Two statements of different IBANs in one folder and
currency stop it too: give each account its own bank name and IBAN, for example
`bank: UBS Sparkonto`. The same statement saved twice is read once.

Download camt.053, not camt.054 or camt.052. A camt.054 is a booking notification (Avis) and a
camt.052 an intraday report. Their bookings come again in the camt.053, so the import skips
them, and `npm run doctor` names each skipped file.

After the first import, open Kontoauszüge in the app (`/bank`): each statement shows the bank's
opening and closing balance, whether its payments add up to them, and the books' balance beside
the bank's (`npm run reconcile-balances` checks the same from the command line). You can also add
a statement there: the add button (N), or drop the camt.053 or statement PDF on the page.

An incoming payment that carries the QR or creditor reference of an invoice you issued in the app
is booked by the import itself, from the invoice's lines and VAT rates, with the invoice PDF as its
receipt (see [Invoices](#invoices)).

## 5. Add receipts

Drop receipts (PDF, or photos as JPG, PNG or HEIC) on the app's window, add them with the add
button in Belege, or put them into the workspace's `beleg-import/` folder (from the Finder or
the phone). Every invoice, every till slip, every customs
bill. A receipt is what lets you deduct the VAT you paid.

## 6. Read, match, book

Open the app (from the source: `npm start`, then http://localhost:5173). The app processes the
inbox itself after every drop, add, statement upload or phone scan, and when a file arrives in
`beleg-import/`; a line at the bottom left says what it does. **Eingang verarbeiten** in Belege
(also in ⌘K) starts it by hand. Its steps:

1. Read the statements and the receipts (a photo becomes a PDF, turned upright). A dropped file
   shows as "wird gelesen" until it is read.
2. Read each receipt's VAT facts, with Claude.
3. Link each receipt to its payment and name it, with Claude. Receipts move from
   `beleg-import/` to `transactional-data/<year>/receipts/`.
4. Book each new payment (accounts, VAT code, exchange rate), with Claude.
   **Neu klassifizieren** on an entry in Buchungen books that one payment again.

From the source, `npm run extract`, `npm run extract-vat`, `npm run match` and
`npm run classify` run the same steps one by one; they wait while the app runs a job.

Then check the result in the app. Belege lists first what needs you ("Braucht dich"): a receipt
without a payment (L links one, or books it as paid privately), a payment without a receipt. Add
what is missing.

### Find your way in the app

The page is a list on the left and the selected item on the right; drag the divider to resize
it. The areas sit in the dock at the bottom edge of the window; press `G` and then a letter:

| Key | Area | Link |
|---|---|---|
| `G B` | Belege: the receipts | `/receipts`, `/receipts/<id>` |
| `G I` | Rechnungen: invoices, customers, sent documents | `/invoices`, `/invoices/2026-006` |
| `G K` | Kontoauszüge: the bank statements and their payments | `/bank`, `/bank/1021-2026-09` |
| `G U` | Buchungen: the journal | `/journal`, `/journal/<entry-id>` |
| `G M` | MWST: the VAT return of a quarter, and the VAT codes | `/vat`, `/vat/405`, `/vat/codes/I81` |
| `G R` | Bilanz & ER: Erfolgsrechnung, Bilanz, Saldobilanz and each account's ledger | `/reports/balance/1021` |
| `G A` | Abschluss: the year-end in seven steps | `/close`, `/close/<step>` |
| `G F` | Firma: profile, VAT, banks, chart of accounts, periods, invoice layout, display | `/company/<section>` |

Every page has its own link, so the address bar always names what is on screen; `?period=2026-Q3`
(or `2026`, `2026-09`, `2026-07-01_2026-09-30`) picks the period, and without it a list shows the
open quarter. [urls.md](urls.md) lists every path. The language is no part of a link: choose it
in the top bar, which shows when you move the mouse to the top edge, with search, the period,
the export, zoom and light or dark.

The keys that work everywhere:

| Key | Does |
|---|---|
| `⌘K` | Find a receipt, entry, invoice, account, area or action |
| `↑` `↓` or `J` `K` | Move through the list; `Esc` goes back from the detail to the list |
| `N` | Add: a receipt, a statement, an entry, an invoice, depending on the area |
| `/` | Search the list |
| `⌘Z` | Undo the last change (the toast says what it was) |
| `⇧E` | Export: reports, journal, receipts, a package for your Treuhand |
| `T` | Light or dark |
| `⌘+` `⌘−` `⌘0` | Zoom |
| `?` | Show or hide the key help at the bottom |

The key help lists the keys of the area you are in, such as `L` (link a payment), `Space`
(preview), `D` (download) and `E` (edit) in Belege.

## 7. File the VAT return

Open MWST (`G M`). It shows the return of the quarter: the figures (Ziffern) with the amount to
pay on top, and for each Ziffer the bookings behind it, grouped by VAT code. When they are right:

```sh
npm run vat-xml -- 2026-Q3
```

This writes an eCH-0217 XML. Import it in the ESTV portal ("MWST abrechnen"), check, and
submit. Then copy the XML into `transactional-data/<year>/filings/` and close the quarter (the fourth quarter closes with
the year instead, see [year-end.md](year-end.md)):

```sh
npm run seal -- 2026-Q3 --close
```

This sets `config.closedThrough` in `ledger.json` to the last day of the quarter and seals it.
From then on, that quarter never changes: the app shows it with a lock and refuses every edit
in it. Corrections are booked in the next open quarter (in Buchungen, a filed entry offers
**Korrektur in … erfassen**), and MWST shows them on the Korrekturabrechnung (form 0535, `/vat/0535`); see the
app's `AGENTS.md`, golden rule 1.

## 8. Update the app

The Mac app: download the new `.dmg` and replace the app in Applications. Your books stay where
they are; the app brings them to the new format when it opens them.

From the source:

```sh
npm run update
```

This pulls the newest version, installs changed dependencies, brings your workspace files to
the new format (with a backup in `data/backups/`), and runs `npm run doctor` and
`npm run test:books`. It stops at the first problem and says how to fix it. Read what it prints
from `CHANGELOG.md`: an entry marked **⚠ figures** changes a figure of an open quarter, and one
marked **⚠ action** needs something from you. Commit your workspace afterwards.

## Invoices

The app writes invoices with a Swiss QR-bill. Add the company's address and an `invoicing` block to
`belege.workspace.yaml`:

```yaml
company:
  # name, uid, owner as before
  address: { street: Musterstrasse, number: "1", postcode: "8000", town: Zürich, country: CH }
bankAccounts:
  - { bank: Raiffeisen, currency: CHF, account: "1021", label: Bank Raiffeisen, iban: CH65 8080 8000 0000 0000 1 }
invoicing:
  payTo:
    CHF: { account: "1021", qrIban: CH44 3199 9123 0008 8901 2 }
  revenueAccount: "3400"
  paymentTermsDays: 30
  layout: { logo: invoices/logo.svg, accent: "#141a26" }
```

- `payTo` names, per currency (CHF, EUR), the bank account customers pay to. The account needs its
  IBAN. With a QR-IBAN from your bank, the QR-bill carries a QR reference; without one, a creditor
  reference (RF…). An account outside Switzerland and Liechtenstein prints its IBAN instead of a
  QR-bill.
- `revenueAccount` is where a paid invoice's revenue is booked, unless a line names its own account.
- `layout` and `texts` (the text above and below the table, per language, `{days}` for the payment
  term) are optional.

Write invoices in Rechnungen (`G I`, then `N`). A draft is edited on the A4 sheet itself;
**Ausstellen** numbers it after checking what Art. 26 MWSTG requires, and **Senden** sends it
by e-mail or downloads the PDF, and records the send. Firma › Rechnungslayout sets the font,
colour, logo, texts and the e-mail's subject and text per language.

To send by e-mail, set the company's mailbox in Firma › E-Mail-Versand: SMTP server, port,
encryption, user, sender and reply-to (`outgoingMail` in `belege.workspace.yaml`). The password
is never in the workspace: the Mac app keeps it in the Mac's keychain (enter it in
E-Mail-Versand), and from the source it is `VANILLA_SMTP_PASSWORD` in the app's `.env`
(`.env.example`). The stored PDF goes out byte for byte; a message the server refuses records
nothing.

The Mac app prints invoices itself. From the source, printing needs Google Chrome, Microsoft
Edge, Brave or Chromium on the computer (or `CHROME_PATH` set to one). An issued invoice is stored as `invoices/<number>.pdf` and never printed
again; `invoices.json` holds the customers, the invoices and what was sent.

## Limits

- **VAT:** effective method, cash basis, quarterly returns only. No Saldosteuersatz, no
  vereinbarte Entgelte, no books without VAT, no fiscal year other than the calendar year.
- **Payroll:** Vanilla Accounting books salary and social security payments. It does not calculate
  payroll, the Lohnausweis or the AHV statement.
- **Invoicing:** invoices, credit notes, reminders and cancellations are written in the app and
  sent by e-mail through the company's own SMTP mailbox. A sale is booked when its payment arrives, also for an invoice.
  Invoices still open on 31 December are booked as receivables at the year-end close and reversed
  on 1 January.
- **Banks:** any Swiss bank's camt.053 imports. Real files were tested from Raiffeisen and
  Wise; for another bank, check the first statement's transactions and closing balance. camt.054
  notifications and PayPal and credit card statements are not imported: book those by hand.
- **Year-end:** `npm run year:close` checks the year, books the exchange difference, guides the
  year-end entries and closes the year; `npm run year:open` opens the next one
  ([year-end.md](year-end.md)). Your Treuhand still signs off the annual accounts, and
  Bilanz & ER shows amounts VAT included.
