# From the source

This page is for people who run Vanilla Accounting from its source code: developers, people who
want the app in a browser, and people who prefer commands. The app in the browser is the same
app as the Mac app, so [Getting started](getting-started.md) describes every screen. This page
adds what is different: the installation, the commands, and where the files are.

## Install

You need **Node.js 22** or newer (on macOS: `brew install node`). Clone this repository and
install the app:

```sh
cd vanilla-accounting  # the folder you cloned it into
npm install
```

To look around first, open a demo company (a copy outside the repository; `npm run demo:reset`
starts it afresh):

```sh
VANILLA_WORKSPACE=demo npm start             # or VANILLA_WORKSPACE=demo-consulting
```

Open http://localhost:5173.

**The AI.** Reading receipts, matching them to payments and booking call an AI through a program
on your computer: Claude Code (`claude`, with Claude Pro or higher) or Codex (`codex`, with
ChatGPT Plus or higher). Firma › KI in the app shows what it found and sets one up with the
maker's own installer, as [Getting started](getting-started.md#4-the-ai) describes. A program
you installed another way is found on your `PATH`. An API key works too: under `npm start` it is
`VANILLA_ANTHROPIC_API_KEY` or `VANILLA_OPENAI_API_KEY` in the app's `.env` (`.env.example`); the
app never reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Without an AI everything else works.

## Set up your books: `npm run init`

```sh
npm run init
```

The wizard creates a **workspace**: one folder that holds your company's books, receipts and
statements, kept apart from the app. It is a git repository of its own, so every change to
your books stays traceable. The app's `.env` then points at it (`VANILLA_WORKSPACE`), so every
command works on your books.

First, pick the profile that fits best. It fills in the answers below; press Enter to keep
an answer, or type another one.

| Profile | `--preset` | For |
|---|---|---|
| Consultant / services GmbH | `consultant` | You sell your work: consulting, software, design. The owner is employed by the company. |
| Webshop / goods GmbH | `webshop` | You sell goods, often online, and import some of them. |
| Trades / construction GmbH | `trades` | You make things and work on site, with staff and a company car. |
| Freelancer, not registered for VAT | `freelancer` | An Einzelfirma below the registration threshold: purchases and sales booked gross, no VAT codes, no return. |
| Something else | `custom` | You answer every question yourself. |

Then the wizard asks for the company name, the folder for the books, the UID (from
[uid.admin.ch](https://www.uid.admin.ch); the check digit is verified), the owner, a few
words on what the company does, and the language of the app. Then these questions, in this
order:

1. **Legal form.** GmbH or AG: fully supported. Einzelfirma: the owner draws no salary, and
   money taken out is booked on 2850 Privat. Day-to-day bookkeeping and VAT work. The year-end
   (AHV on the profit, the tax return) is not covered.
2. **Registered for VAT (MWST)?** Registration is mandatory from CHF 100,000 turnover a year.
   If you answer no, the next three questions are skipped: every purchase and sale is booked
   gross without VAT codes, there is no return, and the MWST page watches the calendar year's
   turnover against the threshold.
3. **VAT method.** Effective (you pay the VAT you charged minus the input tax on your costs), or
   Saldosteuersatz (a flat rate the ESTV approved for you on your gross turnover, no input tax).
   On the Saldosteuersatz the wizard then asks for the approved rate(s), one or two
   (`--net-rate 4.5:Schreinerei`, or with the ESTV's five-character activity code
   `--net-rate 4.5:Schreinerei:41050`). The code can be added later under Firma › MWST; the
   electronic return needs it.
4. **VAT basis.** Vereinbart (the law's default, MWSTG Art. 39): VAT is due when you send the
   invoice, input tax when you receive the bill. Vereinnahmt (cash, on request to the ESTV): VAT
   is due when the money moves. Both are supported (`--basis agreed` or `--basis received`).
5. **VAT reporting period.** Quarterly (the effective method's default) or half-yearly (the
   Saldosteuersatz's). Monthly returns are not supported yet. The method, the basis, the period
   and the rate hold for whole years: a change is possible in a year without entries.
6. **Fiscal year.** The calendar year. Another fiscal year is not supported yet.
7. **Starting point.** A new company starts with empty books. If you switch from other
   bookkeeping, bring your opening balances of 1 January: `npm run import-opening` reads them
   from a Banana export (Konten XML), or you enter them in Firma › Eröffnung. A prior year's
   Banana export in the workspace's `history/` folder (`<name>.Konten.txt`,
   `<name>.Buchungen-sample.tsv`) gives the AI its chart and example entries for booking. The first
   statement of a bank account offers its starting balance as the opening balance.
8. **What you sell.** Any combination of products you make yourself, goods you buy and resell
   (trade), and services (`--sells made,services`). This picks the accounts of your chart and
   the default accounts the app books with: material for your own products on 4000, goods for
   resale on 4200; sales of own products on 3000, traded goods on 3200, services on 3400. A
   supplier or customer can differ by a rule of its own.
9. **Customers abroad?** A service to a customer abroad is usually declared without Swiss VAT.
10. **Do you import goods?** Imports come with customs and import VAT invoices.
11. **Employees.** None, the owner only, or staff. Vanilla Accounting books the salary and the
    AHV, BVG and UVG payments. Your payroll provider or Treuhand does the payroll itself.
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

Every question also has a flag, so `npm run init` runs without questions too:

```sh
npm run init -- --preset consultant --dir ../my-books --name "Beispiel GmbH" \
  --uid <your UID> --owner "Erika Beispiel" --bank UBS:CHF --bank Wise:EUR --yes
```

Run `npm run init` again on the same folder and it changes nothing. If `.env` already points
at other books, the wizard asks before it changes that (`--set-env` replaces it without
asking). An answer the app does not support yet ends the wizard with exit code 2.

## Where the files are

The folder becomes your company's repository. Its `AGENTS.md` holds notes for the AI about your
company; the books lie in its `vanilla-accounting/`
([ADR 0013](adr/0013-workspace-layout-and-ownership.md)):

| File or folder in `vanilla-accounting/` | Holds |
|---|---|
| `belege.workspace.yaml` | Who the company is, your answers, and which ledger account each bank books on |
| `knowledge/` | What the app learns about your suppliers (`suppliers/`), customers (`customers/`), authorities (`authorities/`) and your own rules (`rules/`); each folder starts with a commented `_example.yaml`. Saved reports are `knowledge/reports/<name>.report.yaml` |
| `sources/` | Places to collect receipts from: one folder per mailbox, portal or API (see sources/README.md) |
| `beleg-import/` | Where new receipts arrive |
| `ledger.json` | The books' settings: up to which day they are closed, opening balances, corrections |
| `master-data/accounts.json` | Your chart of accounts, taken from the Swiss KMU chart for your profile |
| `transactional-data/<year>/books/` | The books of the year: transactions, receipts, journal entries, one record per line. Empty at first |
| `transactional-data/<year>/bank-statements/<bank>/` | Your bank statements |
| `transactional-data/<year>/receipts/` | Receipts after they are read and matched |
| `transactional-data/<year>/filings/` | Your VAT returns as filed, and their seals |
| `transactional-data/<year>/invoices/` | The PDFs of the invoices you issued (`<number>.pdf`) and of what was sent |
| `invoices.json` | The customers, the invoices and what was sent |

Files that are not the app's (notes, scripts, exports of an earlier program) go into `own/` at the
repository's root; `npm run doctor` names every other one.

## Check the setup: `npm run doctor`

```sh
npm run doctor
```

It checks the tools (Node.js, the `claude` command and its login) and the workspace
(the manifest, the books, the folders, that every bank account is in the chart, and which
bank account each statement file lands on). Each line starts with ✓ or ✗. A ✗ line says how
to fix it. A ! line is a note that does not stop you.

## Start the app

```sh
npm start
```

Open http://localhost:5173. From here on the app is the one
[Getting started](getting-started.md#5-read-in-your-first-bank-statement) describes. The terminal
prints a pairing link for the phone at every start.

`npm run desktop` runs the Mac app from the checkout, `npm run desktop:dev` runs it while you
edit, and `npm run desktop:build` builds the two `.dmg` files ([desktop.md](desktop.md)).

## Statements and receipts as files

Instead of dropping a file on the app you can put it into the workspace.

**Statements.** Save each camt.053 in `transactional-data/<year>/bank-statements/<bank>/`, for
example `transactional-data/2026/bank-statements/UBS/`. The file name does not matter, and a
subfolder is fine. Each statement lands on a bank account of `belege.workspace.yaml`:

1. The account with the statement's IBAN and currency, when you entered the IBAN. Then the
   folder does not matter.
2. Otherwise, the account whose bank is the folder name, in the statement's currency.

A statement that matches no account stops the import before anything is written, and
`npm run doctor` says which account to add. Two statements of different IBANs in one folder and
currency stop it too: give each account its own bank name and IBAN, for example
`bank: UBS Sparkonto`. The same statement saved twice is read once. A camt.054 (a booking
notification) and a camt.052 (an intraday report) are skipped, because their bookings come again
in the camt.053; `npm run doctor` names each skipped file.

Which banks: the import is tested with Raiffeisen and Wise statements, and with statements in
the shapes UBS, PostFinance and the cantonal banks export (the tests read synthetic ones). Any
other bank's camt.053 reads the same way. `npm run reconcile-balances` compares each account's
balance in the books with the bank's closing balance.

**Receipts.** Put PDFs and photos into `beleg-import/` of the workspace. The running app
processes them when they arrive.

## The steps as commands

The app processes the inbox itself after every drop and when a file arrives in `beleg-import/`.
The same steps run one by one from the command line; they wait while the app runs a job:

| Command | Does |
|---|---|
| `npm run extract` | Reads new statements and the text of new receipts |
| `npm run extract-vat` | Reads each receipt's VAT facts, with the AI |
| `npm run match` | Links each receipt to its payment and names it, with the AI; moves it from `beleg-import/` to `transactional-data/<year>/receipts/` |
| `npm run evidence -- <period> --apply` | Links what fixed rules can prove (the same amount, a payment reference, the parts of a batch payment) |
| `npm run classify` | Books each new payment of the open period, with the AI |
| `npm run board -- <period>` | Shows what the period is still missing |
| `npm run gaps -- <period>` | Lists the payments no supplier, customer or authority file claims |
| `npm run pull -- <source>` | Fetches one source (a mailbox) by hand ([mail-setup.md](mail-setup.md)) |

[The quarter, step by step](quarter-workflow.md) walks through a quarter with these commands.

## The VAT return as commands

The app prepares, checks and seals a return itself
([Getting started](getting-started.md#8-file-the-vat-return)). The commands do the same steps:

```sh
npm run vat-report -- 2026-Q3 --detail         # the Ziffern, with the entries behind each
npm run vat-report-html -- q3.html 2026-Q3     # a printable summary
npm run vat-xml -- 2026-Q3 q3.xml              # the eCH-0217 XML for the ESTV's "MWST abrechnen"
```

A firm on the Saldosteuersatz files half years: `2026-H1`. `npm run vat-xml` refuses a period
that is filed. After you filed at the ESTV, copy the XML you filed into
`transactional-data/<year>/filings/` and close the period:

```sh
npm run seal -- 2026-Q3 --close
```

This sets `closedThrough` in `ledger.json` to the last day of the period and writes its seal
(`filings/seal-Q3.json`). From then on that period never changes: the app, the commands and the
AI refuse every edit in it. Corrections are booked in the next open period and declared on the
Korrekturabrechnung (form 0535); see [`AGENTS.md`](../AGENTS.md), golden rule 1.
`npm run check-closed` proves that nothing in the closed period differs from the committed
state. The last period of the year closes with the year instead: `npm run year:close`, then
`npm run year:open` ([year-end.md](year-end.md)).

## Invoices in the manifest

Firma › Rechnungslayout and Firma › E-Mail-Versand write these settings; you can also edit
`belege.workspace.yaml` yourself:

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
- `revenueAccount` is where an invoice's revenue is booked, unless a line names its own account.
- `layout` and `texts` (the text above and below the table, per language, `{days}` for the payment
  term) are optional.
- `outgoingMail` holds the SMTP server, port, encryption, user, sender and reply-to. The password
  is never in the workspace: under `npm start` it is `VANILLA_SMTP_PASSWORD` in the app's `.env`
  (`.env.example`); the Mac app keeps it in the Mac's keychain.

The Mac app prints invoices itself. From the source, printing needs Google Chrome, Microsoft
Edge, Brave or Chromium on the computer (or `CHROME_PATH` set to one). An issued invoice is
stored as a PDF and never printed again; the stored PDF goes out byte for byte, and a message
the server refuses records nothing.

## Update

```sh
npm run update
```

This pulls the newest version, installs changed dependencies, brings your workspace files to
the new format (with a backup in `data/backups/`), and runs `npm run doctor` and
`npm run test:books`. It stops at the first problem and says how to fix it. Read what it prints
from `CHANGELOG.md`: an entry marked **⚠ figures** changes a figure of an open period, and one
marked **⚠ action** needs something from you. Commit your workspace afterwards.

## Links

Every page has its own link, so the address bar always names what is on screen, such as
`/journal/<entry-id>` or `/vat/405?period=2026-Q3`. `?period=` takes `2026-Q3`, `2026`,
`2026-09` or `2026-07-01_2026-09-30`; without it a list shows the open period.
[urls.md](urls.md) lists every path. The language is no part of a link.
