# Vanilla Accounting

Bookkeeping for a Swiss GmbH on cash-basis VAT (effective method). Vanilla Accounting imports
bank statements, collects receipts, matches each receipt to its bank transaction, books the
journal entries with Claude, and writes the quarterly VAT return as the eCH-0217 XML that the
ESTV "MWST abrechnen" portal imports.

## Who built this

Vanilla Accounting is built by Ken Steiner, vibe-coded with Claude Code. Ken is a former SAP
staff engineer and holds a Master of Science in Computer Science from Georgia Tech, with a focus
on artificial intelligence. He has run his own company, Vanilla Systems GmbH, since 2018 and has
done its accounting himself from the start. The software runs the real books of Vanilla Systems
GmbH and of the webshop behind it, [bananaoptics.com](https://bananaoptics.com). A professional
Treuhänder (accountant) reviews the books. It has produced the company's VAT returns filed with
the ESTV in 2026, and it prepares the year-end close, updated when the year turns.

> **Free to use, at your own risk.** Vanilla Accounting is provided free of charge under the
> AGPL-3.0, as is, without any warranty. The author takes no responsibility or liability for the
> software, for your books, or for any VAT return or other filing made with it. It is not tax or
> legal advice: check every figure and every return yourself, or have your Treuhänder check it,
> before you file. See [Licence and disclaimer](#licence-and-disclaimer).

## How it is organized

- **The app** is this repository: a React UI, a local API server, and the CLI scripts in
  `src/cli/`.
- **A workspace** is one company's data: `belege.workspace.yaml` (who the company is and which
  ledger account each bank books on), `books.json`, `receipts/`, `bank-statements/`, `filings/`.
  The app never stores company data, and a workspace contains no code. Booking with Claude reads
  the chart from `accounts.json`, or from the prior year's Banana export in `history/` when there
  is one: `<name>.Konten.txt` (chart of accounts) and `<name>.Buchungen-sample.tsv` (example
  entries); the newest `<name>` wins. A company with little history of its own gets examples
  from the casebook (`examples/cases/`).
- **The processes** in `processes/` say who does what each quarter and which rules decide each
  step. Facts about one business sit in one file each, in the folder of its role:
  `processes/suppliers/`, `processes/customers/` and `processes/authorities/` (ESTV,
  Ausgleichskasse, cantonal tax office, BAZG). A workspace adds its own in `knowledge/`.
  `processes/README.md` explains them.
- **The demos** are complete workspaces of made-up companies, January to September 2026, with
  Q1 filed and corrected:
  - `demo/`: Muster Kaffee GmbH, a coffee roaster with a café and a webshop (reduced rates,
    card takings, a Sammelzahlung).
  - `demo-consulting/`: Muster Consulting GmbH, a one-person IT consultancy. The owner pays
    himself a salary, bills Swiss clients (8.1%) and foreign clients (Ziffer 221), gets his
    private outlays back each month, and declares a private share of his phone.

  `npm run demo:generate` writes both from `tools/demo/`. Do not edit them by hand.

## Quick start

You need Node.js 22, `pdftotext` (poppler) and Claude Code with a Claude subscription: reading,
matching and booking receipts call Claude through the `claude` command.

To look around first, open the demo company:

```sh
npm install
VANILLA_WORKSPACE=demo npm start             # or VANILLA_WORKSPACE=demo-consulting
```

Open http://localhost:5173.

To keep your own books:

```sh
npm run init      # asks about your company, creates its workspace, points .env at it
npm run doctor    # checks the tools and the workspace, and says how to fix what is missing
npm start
```

`docs/getting-started.md` walks through the questions, the first bank statement, the first
receipts and the first VAT return, and lists what Vanilla Accounting does not do yet.

To update, run `npm run update`. `CHANGELOG.md` lists what each version changed, and
`docs/releasing.md` explains the version numbers.

## Rules that never bend

A filed quarter never changes. Corrections are booked in the next open quarter and declared on
a Korrekturabrechnung (ESTV form 0535). `AGENTS.md` lists this rule and the others that every
person and every agent follows.

## Tests

```sh
npm test
```

`npm test` type-checks the code, runs the golden master of the VAT figures on each demo
workspace, and runs the structural half of the leak guard.

## Leak guard

`public-files.txt` lists what this repository may contain. `npm run check-public` scans those
files for anything that identifies a company: with a workspace it derives that company's
secrets (identity, bank ids, item numbers, amounts) from the workspace itself, so they are never
written here. To run it before every push:

```sh
git config core.hooksPath tools/hooks
```

## Licence and disclaimer

GNU Affero General Public License v3.0. See `LICENSE`.

You may use, change and share Vanilla Accounting under the terms of that licence. It is provided
for free and **as is, without warranty of any kind** (AGPL-3.0, sections 15 and 16). You use it at
your own risk. The author accepts no responsibility or liability for any damage, loss, wrong
booking, tax assessment, penalty or late payment that results from using it. You remain
responsible for your books and for every filing with the ESTV or any other authority.

*Deutsch:* Vanilla Accounting ist kostenlos und wird ohne jede Gewährleistung zur Verfügung
gestellt („as is“, AGPL-3.0). Die Nutzung erfolgt auf eigenes Risiko. Der Autor übernimmt keine
Verantwortung und keine Haftung für die Software, für Ihre Buchhaltung oder für Abrechnungen und
Eingaben, die damit erstellt werden. Prüfen Sie jede Abrechnung selbst oder durch Ihren
Treuhänder, bevor Sie sie einreichen.
