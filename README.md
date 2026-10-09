# Belege

Bookkeeping for a Swiss GmbH on cash-basis VAT (effective method). Belege imports bank
statements, collects receipts, matches each receipt to its bank transaction, books the journal
entries with Claude, and writes the quarterly VAT return as the eCH-0217 XML that the ESTV
"MWST abrechnen" portal imports.

Belege runs the books of Vanilla Systems GmbH, and is built by Ken Steiner.

## How it is organized

- **The app** is this repository: a React UI, a local API server, and the CLI scripts in
  `src/cli/`.
- **A workspace** is one company's data: `belege.workspace.yaml` (who the company is and which
  ledger account each bank books on), `books.json`, `receipts/`, `bank-statements/`, `filings/`.
  The app never stores company data, and a workspace contains no code. Booking with Claude also
  reads the prior year's Banana export from `history/`: `<name>.Konten.txt` (chart of accounts)
  and `<name>.Buchungen-sample.tsv` (example entries); the newest `<name>` wins.
- **The processes** in `processes/` say who does what each quarter and which rules decide each
  step. `processes/README.md` explains them.
- **The demo** in `demo/` is a complete workspace of a made-up company, Muster Kaffee GmbH.

## Quick start

You need Node.js 22 and `pdftotext` (poppler). Booking and matching call Claude through the
Claude Code CLI (`claude`).

```sh
npm install
BELEGE_WORKSPACE=demo npm start
```

Open http://localhost:5173. To work on your own books, set `BELEGE_WORKSPACE` in `.env` (or the environment) to a directory
that holds a `belege.workspace.yaml` (copy `demo/belege.workspace.yaml` and change it).

## Rules that never bend

A filed quarter never changes. Corrections are booked in the next open quarter and declared on
a Korrekturabrechnung (ESTV form 0535). `AGENTS.md` lists this rule and the others that every
person and every agent follows.

## Tests

```sh
npm test
```

`npm test` type-checks the code, runs the golden master of the VAT figures on the demo
workspace, and runs the structural half of the leak guard.

## Leak guard

`public-files.txt` lists what this repository may contain. `npm run check-public` scans those
files for anything that identifies a company: with a workspace it derives that company's
secrets (identity, bank ids, item numbers, amounts) from the workspace itself, so they are never
written here. To run it before every push:

```sh
git config core.hooksPath tools/hooks
```

## Licence

GNU Affero General Public License v3.0. See `LICENSE`.
