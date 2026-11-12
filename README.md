# Vanilla Accounting

Bookkeeping for a small Swiss company, as a Mac app. You drop in your bank statements and your
receipts. The app reads them, matches each receipt to its payment, books the payments, and
prepares the VAT return as the file the ESTV's "MWST abrechnen" portal imports. It asks you only
what only you can know.

It is for the person who keeps the books of a GmbH, an AG or an Einzelfirma, without accounting
training:

- registered for VAT on the effective method (a return every quarter) or on the Saldosteuersatz
  (a return every half year), on vereinnahmte or vereinbarte Entgelte;
- or not registered for VAT: the app books without VAT and shows the year's turnover against
  the limit for registration.

It also writes your invoices with the Swiss QR-bill, shows Bilanz and Erfolgsrechnung, and leads
through the year-end. [What it does not do yet](docs/getting-started.md#limits).

**[Mission](MISSION.md):** take the bookkeeping off the people who run a small company. Code does
what rules can decide, the AI what needs judgement, the person only what only they can know; and
every person can automate the rest by asking the app's AI in their own words.

> **Free to use, at your own risk.** Vanilla Accounting is provided free of charge under the
> AGPL-3.0, as is, without any warranty. The author takes no responsibility or liability for the
> software, for your books, or for any VAT return or other filing made with it. It is not tax or
> legal advice: check every figure and every return yourself, or have your Treuhänder check it,
> before you file. See [Licence and disclaimer](#licence-and-disclaimer).

## Get started

1. Download the `.dmg` from the
   [Releases page](https://github.com/VanillaSystems/vanilla-accounting/releases): `arm64` for a
   Mac with Apple silicon (M1 and later), `x64` for an Intel Mac.
2. Open it and drag **Vanilla Accounting** into Applications. You need no Node.js, Homebrew or
   terminal.
3. Start it. The app is not signed with an Apple Developer ID yet, so macOS refuses it the first
   time. Open it once and click **Done**, then go to System Settings › Privacy & Security and
   click **Open Anyway** next to "Vanilla Accounting was blocked".

The first screen leads to new books for your company, to books you already have, or to a copy of
the demo company to look around in.

Reading receipts and proposing bookings need an AI, on your own subscription: Claude Code with
Claude Pro, or Codex with ChatGPT Plus, about USD 20 a month each. The app sets it up with you
and never sees your login. It can wait: statements, the journal, invoices, the VAT return and
the reports work without it, and the app says what waits for the AI.

**[Getting started](docs/getting-started.md)** walks through the setup, the first bank
statement, the first receipts, the first VAT return and invoices, and lists the limits.
[The quarter, step by step](docs/quarter-workflow.md) and
[the year-end](docs/year-end.md) come after. To update, download the new `.dmg`;
[CHANGELOG.md](CHANGELOG.md) lists what each version changed.

Developers, and people who want the app in a browser or as commands:
[From the source](docs/from-source.md).

## The app

One window, a list on the left and the selected item on the right. The areas sit in a dock at
the bottom edge (click one, or press `G` and a letter); a bar at the top edge holds search, the
period, the export, zoom, light or dark, and the language (German, French, Italian, English).

The books:

- **Belege**: the receipts, what needs you first. A dropped PDF or photo is read, named, linked
  to its payment and booked by the app itself. A receipt shows its paper, its facts (date,
  amount, Swiss VAT, VAT number) and its payment; `L` links one, or books it as paid privately.
- **Rechnungen**: invoices and credit notes with the Swiss QR-bill, edited on the A4 sheet,
  checked against Art. 26 MWSTG before they are issued, sent by e-mail through the company's own
  mailbox; customers, reminders, every document sent.
- **Kontoauszüge**: each bank account's monthly statements (camt.053, or a PDF, scan or photo of
  any bank), whether their payments add up to the bank's balances, a missing month, and each
  payment with its receipt and booking.
- **Buchungen**: the journal as one grid, edited in place, with corrections of a filed period
  booked in the open one.
- **MWST**: the return of a period with the bookings behind each Ziffer, «Abrechnung erstellen»
  through to «Eingereicht», the Korrekturabrechnung (form 0535), and every VAT code explained.
- **Bilanz & ER**: Erfolgsrechnung, Bilanz and Saldobilanz of any period, each account's ledger,
  and reports you describe yourself.
- **Abschluss**: the year-end, step by step.

How the app works for you:

- **Automatisierung**: what the app does by itself, each run, and the tasks that wait for you.
- **Geschäftspartner**: suppliers, customers and authorities, each with its notes, its rules and
  its bookings.
- **Wissen**: how your company works, as the app has learned it, page by page.
- **Änderungen**: what changed in rules and settings, to save and to look back.
- **Firma**: the company's profile, VAT setup, bank accounts, chart of accounts, rules, periods,
  opening balances, invoice layout, and the AI.

The «KI» column (`⌘J`) takes a wish in your own words («buch Swisscom immer auf Telefon») and
shows what it would change before you keep it. `⌘K` finds anything, `N` adds, `⌘Z` undoes, `⇧E`
exports (a package for your Treuhänder, the audit, the year's archive). Every page has its own
link, such as `/journal/M2026-001` or `/vat/405?period=2026-Q3` ([docs/urls.md](docs/urls.md)).
A filed period shows with a lock, and the app refuses every edit in it.

## Who built this

Vanilla Accounting is built by Ken Steiner, vibe-coded with Claude Code. Ken is a former SAP
staff engineer and holds a Master of Science in Computer Science from Georgia Tech, with a focus
on artificial intelligence. He has run his own company, Vanilla Systems GmbH, since 2018 and has
done its accounting himself from the start. The software runs the real books of Vanilla Systems
GmbH and of the webshop behind it, [bananaoptics.com](https://bananaoptics.com). A professional
Treuhänder (accountant) reviews the books. It has produced the company's VAT returns filed with
the ESTV in 2026, and it prepares the year-end close, updated when the year turns.

## How it is organized

- **The app** is this repository: a React UI, a local API server, the CLI scripts in
  `src/cli/`, and the Mac app around them (`src/desktop/`, [docs/desktop.md](docs/desktop.md)).
- **A workspace** is one company's data, the folder `vanilla-accounting/` of the company's
  repository: `belege.workspace.yaml` (who the company is and which ledger account each bank books
  on), `knowledge/`, `ledger.json`, `master-data/accounts.json`, and per fiscal year
  `transactional-data/<year>/` with the books, receipts, bank statements and filed returns.
  The app never stores company data, and a workspace contains no code. Booking with Claude reads
  the chart from `master-data/accounts.json`, or from the prior year's Banana export in `history/` when there
  is one: `<name>.Konten.txt` (chart of accounts) and `<name>.Buchungen-sample.tsv` (example
  entries); the newest `<name>` wins. A company with little history of its own gets examples
  from the casebook (`examples/cases/`).
- **The processes** in `processes/` say who does what each quarter and which rules decide each
  step. Facts about one business sit in one file each, in the folder of its role:
  `processes/suppliers/`, `processes/customers/` and `processes/authorities/` (ESTV,
  Ausgleichskasse, cantonal tax office, BAZG). A workspace adds its own in `knowledge/`.
  `processes/README.md` explains them.
- **The VAT codes** (V81, I0, B81-1, -I81, …) on every journal entry are Banana's MWST codes.
  [`docs/vat-codes.md`](docs/vat-codes.md) explains each one: what it means, which Ziffern of
  the VAT return it feeds, and when to use it. In the app, hover or click any code, or open
  **Codes erklärt** in MWST (`/vat/codes`).
- **The demos** are complete workspaces of made-up companies. The first two run from January to
  September 2026, with Q1 filed and corrected:
  - `demo/`: Muster Kaffee GmbH, a coffee roaster with a café and a webshop (reduced rates,
    card takings, a Sammelzahlung).
  - `demo-consulting/`: Muster Consulting GmbH, a one-person IT consultancy. The owner pays
    himself a salary, bills Swiss clients (8.1%) and foreign clients (Ziffer 221), gets his
    private outlays back each month, and declares a private share of his phone.
  - `demo-coiffeur/` (an Einzelfirma, not registered for VAT) and `demo-schreinerei/` (a GmbH on
    the Saldosteuersatz, first half year filed): one of each other kind of firm.

  `npm run demo:generate` writes them from `tools/demo/`. Do not edit them by hand.

## Run from the source

You need Node.js 22. To look around, open a demo company:

```sh
npm install
VANILLA_WORKSPACE=demo npm start             # or VANILLA_WORKSPACE=demo-consulting
```

Open http://localhost:5173. To keep your own books:

```sh
npm run init      # asks about your company, creates its workspace, points .env at it
npm run doctor    # checks the tools and the workspace, and says how to fix what is missing
npm start
```

[docs/from-source.md](docs/from-source.md) explains the questions, the files of a workspace and
every command; `npm run update` updates a checkout. `npm run desktop` runs the Mac app from the
checkout, and `npm run desktop:build` builds the two `.dmg` files
([docs/desktop.md](docs/desktop.md)). `npm run desktop:dev` runs the Mac app while you edit: a
change under `src/app` shows in the window at once through Vite, and a change to the main process
or the server restarts Electron. It keeps its own data in
`~/Library/Application Support/vanilla-accounting-dev` and runs beside the installed app
([docs/desktop.md](docs/desktop.md#dev-mode)). [docs/releasing.md](docs/releasing.md) explains
the version numbers and how a release is made.

## Audit export

`npm run build:audit -- <folder>` writes a read-only copy of your books that needs no Node.js
and no API: the app, the books, every receipt and statement PDF, the filed returns and a
`manifest.json` with the SHA-256 of every file. Search, filters and every report work in it.
Zip it and hand it to your Treuhänder or auditor, who serves it with `npx serve <folder>`;
`npm run verify-audit -- <folder>` checks it against its manifest later.

**Real books on a public URL publish them.** Host an export of your books only behind access
protection. The demo exports can be hosted openly. `docs/audit-export.md` explains how to make,
hand over and host an export.

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
