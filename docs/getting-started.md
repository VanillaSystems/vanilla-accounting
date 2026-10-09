# Getting started

This guide takes you from an empty folder to your first VAT return. It is for the owner of a
small Swiss company who keeps the books alone: technical, but not an accountant.

Belege fits a company that is registered for VAT on the effective method, taxed on the cash
basis (vereinnahmte Entgelte), files quarterly, and keeps a calendar fiscal year. A GmbH or an
AG is fully supported. Read [Limits](#limits) before you start.

## 1. Install

You need:

- **Node.js 22** or newer. On macOS: `brew install node`.
- **pdftotext**, from poppler. It reads the text of your receipts. On macOS:
  `brew install poppler`. On Linux: `apt install poppler-utils`.
- **Claude Code** with a Claude subscription (Pro or Max). Belege calls the `claude` command to
  read receipts, match them to payments and book them. Install it with
  `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in.

Then clone this repository and install the app:

```sh
cd belege       # the folder you cloned it into
npm install
```

## 2. Set up your books: `npm run init`

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
   not supported yet, because Belege books from the bank statement and keeps no open invoices.
5. **VAT reporting period.** Quarterly. Half-yearly and monthly returns are not supported yet.
6. **Fiscal year.** The calendar year. Another fiscal year is not supported yet.
7. **Starting point.** A new company starts with empty books. If you switch from other
   bookkeeping, bring your opening balances of 1 January: `npm run import-opening` reads them
   from a Banana export (Konten XML), or you enter them later.
8. **What you sell.** Services, goods, or both. This picks the accounts of your chart.
9. **Customers abroad?** A service to a customer abroad is usually declared without Swiss VAT.
10. **Do you import goods?** Imports come with customs and import VAT invoices.
11. **Employees.** None, the owner only, or staff. Belege books the salary and the AHV, BVG and
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

The workspace gets:

| File or folder | Holds |
|---|---|
| `belege.workspace.yaml` | Who the company is, your answers, and which ledger account each bank books on |
| `accounts.json` | Your chart of accounts, taken from the Swiss KMU chart for your profile |
| `books.json` | The books: transactions, receipts, journal entries. Empty at first |
| `bank-statements/<bank>/` | Your camt.053 statements |
| `beleg-import/` | Where new receipts arrive |
| `receipts/` | Receipts after they are read and matched |
| `filings/` | Your VAT returns as filed |
| `counterparties/`, `policy/` | What Belege learns about your suppliers and your decisions |
| `mail.yaml` | Mailboxes to collect receipts from (optional, commented template) |
| `AGENTS.md` | Notes for Claude about your company |

Every question also has a flag, so `npm run init` runs without questions too:

```sh
npm run init -- --preset consultant --dir ../my-books --name "Beispiel GmbH" \
  --uid <your UID> --owner "Erika Beispiel" --bank UBS:CHF --bank Wise:EUR --yes
```

Run `npm run init` again on the same folder and it changes nothing. If `.env` already points
at other books, the wizard asks before it changes that (`--set-env` replaces it without
asking).

## 3. Check the setup: `npm run doctor`

```sh
npm run doctor
```

It checks the tools (Node.js, pdftotext, the `claude` command and its login) and the workspace
(the manifest, `books.json`, the folders, that every bank account is in the chart, and which
bank account each statement file lands on). Each line starts with ✓ or ✗. A ✗ line says how
to fix it. A ! line is a note that does not stop you.

## 4. Import your first bank statement

Belege reads bank statements in the ISO 20022 format **camt.053**, an XML file that Swiss
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

Save each file in `bank-statements/<bank>/` of your workspace, for example
`bank-statements/UBS/`. The file name does not matter, and a subfolder is fine. Each statement
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

After the first import, check the Bank tab: the transactions, and that the closing balance
matches your bank (`npm run reconcile-balances`).

## 5. Add receipts

Put receipts (PDF; photos as PNG or JPG need ImageMagick: `brew install imagemagick`) into
`beleg-import/`. Every invoice, every till
slip, every customs bill. A receipt is what lets you deduct the VAT you paid.

## 6. Read, match, book

Start the app:

```sh
npm start
```

Open http://localhost:5173. The buttons in the app run the same steps as these commands:

1. `npm run extract`: reads the statements and the receipts.
2. `npm run match`: links each receipt to its payment, with Claude. Receipts move from
   `beleg-import/` to `receipts/`.
3. `npm run classify`: books each payment (accounts, VAT code, exchange rate), with Claude.

Check the payments without a receipt in the app, and add what is missing.

## 7. File the VAT return

Open the MWST tab. It shows the figures (Ziffern) of each quarter and the bookings behind
them. When they are right:

```sh
npm run vat-xml -- 2026-Q3
```

This writes an eCH-0217 XML. Import it in the ESTV portal ("MWST abrechnen"), check, and
submit. Then copy the XML into `filings/<year>/` and set `config.closedThrough` in
`books.json` to the last day of the quarter. From then on, that quarter never changes:
corrections are booked in the next open quarter (see the app's `AGENTS.md`, golden rule 1).

## Limits

- **VAT:** effective method, cash basis, quarterly returns only. No Saldosteuersatz, no
  vereinbarte Entgelte, no books without VAT, no fiscal year other than the calendar year.
- **Payroll:** Belege books salary and social security payments. It does not calculate
  payroll, the Lohnausweis or the AHV statement.
- **Invoicing:** Belege does not write invoices or track open ones. A sale is booked when its
  payment arrives.
- **Banks:** any Swiss bank's camt.053 imports. Real files were tested from Raiffeisen and
  Wise; for another bank, check the first statement's transactions and closing balance. camt.054
  notifications and PayPal and credit card statements are not imported: book those by hand.
- **Year-end:** the closing, the revaluation of foreign currency accounts and the annual
  report are guided (processes/year-close.flow.yaml), but your Treuhand or your accounting
  software does the annual accounts.
