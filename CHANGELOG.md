# Changelog

What changed in each version of Vanilla Accounting. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers follow
[Semantic Versioning](https://semver.org/) as [`docs/releasing.md`](docs/releasing.md) applies
it to this project. `npm run update` prints the sections between your old version and the new one.

Two markers flag an entry you must read before you update:

- **⚠ figures**: the change alters a computed figure (a VAT Ziffer, a balance, a return) of an
  open period. A filed quarter's figures never change. After the update, `npm run test:books`
  shows the difference; check it, then accept it with `npm run test:books:update`.
- **⚠ action**: you must do something by hand, as the entry says.

## [Unreleased]

### Added

- The new shell (redesign phase 1): the page is a list and a detail with a resizable divider
  (drag, ←/→, double-click resets; kept per area), the areas sit in a dock at the bottom edge
  (`G` + letter), and a bar at the top edge holds search, the period, zoom, light/dark/system and
  the language. ⌘K finds receipts, entries, areas and actions; a toast offers Rückgängig (⌘Z);
  `?` hides the key help. Every page has its own link (`/journal/M2026-001`, `/vat/405`,
  `/reports/balance/1021`, docs/urls.md); old `/<lang>/<period>/<tab>` links and bookmarks
  redirect. The language no longer sits in the link: it is chosen per viewer. PDFs dropped on the
  page or added with the add button (N) go to the inbox. Until each area is rebuilt it shows its
  old tab.
- Belege rebuilt (redesign phase 2): what needs you comes first ("Braucht dich"), then month by
  month; filters `zugeordnet`, `offen`, `ohne Datum` and a search sit in the link
  (`/receipts/<id>?filter=offen&q=…`). A receipt shows its paper (each PDF page cut to its ink),
  one line of facts (date, amount, Swiss VAT, VAT number), its payment with links to the
  statement and the entry, and Zahlung, Angaben and Datei in the margin. L opens Zahlung
  verknüpfen with the open payments ranked by amount, date and currency, and "privat oder bar
  bezahlt" books a private outlay; an exact fit is offered as a suggestion (↵). Link, unlink,
  edits and "kein Beleg" take effect at once and can be undone (⌘Z); a delete asks first.
  Space previews, D downloads, E edits. A receipt paid in a filed quarter is read only. Dropped
  PDFs show as "wird gelesen" until `npm run extract` reads them, then the receipt takes their
  place. Removed with the old tab: batch rename and the manual-transaction batch.
- Invoices (ADR 0010, ADR 0012): customers, invoices and credit notes with VAT per line in CHF or
  EUR and in German, French, Italian or English, numbered when issued (2026-001, never for a
  draft), checked against Art. 26 MWSTG before issue, frozen once issued. A draft is deleted; an
  issued invoice is cancelled (number kept, date and reason, optional notice), and a paid one is
  credited instead. Reminders in levels with an optional fee, in the invoice's language. Internal
  comments. The A4 sheet with the Swiss QR-bill (QR reference with a QR-IBAN, creditor reference
  otherwise) is printed to PDF by the Chrome, Edge, Brave or Chromium on the computer; every sent
  document is stored byte-exact with its SHA-256 and never printed again. Settings: `company.address`
  and an `invoicing` block in `belege.workspace.yaml` (docs/getting-started.md). Data:
  `invoices.json` and `invoices/` in the workspace. Routes under `/api/invoices` and
  `/api/customers`; the PDF as issued at `/invoices/<number>.pdf`.
- Paid invoices booked by their reference: `npm run extract` matches each incoming payment whose
  QR or creditor reference belongs to an issued invoice before anything else books it, marks the
  invoice paid or partly paid, books the revenue from the invoice's lines with their VAT codes
  (V81, V26, V0 for an export, V0-E for a service abroad), and files the invoice PDF as the
  entry's receipt. A payment without the reference is proposed (`GET /api/invoices/payments`) and
  booked when a person confirms it.
- **⚠ figures** (demo only): the demo company Muster Kaffee now writes invoices; two of them are
  paid by QR-bill in Q3, which adds their revenue to the demo's Q3 return. Its bank accounts carry
  valid IBANs, so the camt.053 file names changed.

- VAT codes explained: every VAT code the app shows (Buchungen, a transaction's entries, the
  entries behind a Ziffer, the cases of a Korrekturabrechnung) explains itself on hover: what it
  means, its rate, the Ziffern it feeds and when to use it. A click, or **Codes erklärt** in the
  MWST tab, opens the list of all codes by family with a search, when to use each code and when
  not, an example from the casebook, and the period's entries that use it. A code the app does
  not declare in any Ziffer (VS, F, Z codes, V81-B) shows in amber. The Ziffern come from the
  engine, so the explanation cannot drift from the return (tests/vat-codes.test.ts).
  `docs/vat-codes.md` is the same catalogue as a document; `npm run vat-codes` regenerates it
  and its data from `reference/MWST-codes.txt` and the casebook.
- Year-end close: `npm run year:close -- <year> [--dry-run]` and a Jahresabschluss tab (de, fr,
  it, en). A checklist computed from the books: the fourth quarter filed, Q1 to Q3 sealed, every
  bank account matching its statement on 31.12., the statements covering the year, every
  transaction booked, `npm run doctor` clean. It books the exchange difference (Kursdifferenz)
  of each foreign-currency account on 31.12. at the ESTV rate of that day (rerunning replaces it),
  reconciles the VAT accounts with the year's returns, guides the year-end entries (depreciation,
  accruals and deferrals, provisions, tax provision, private use, inventory, social insurance,
  doubtful accounts) as prefilled entries or "not needed", and shows the closing balance sheet
  with the VAT split off by code. "Jahr abschliessen" closes through 31.12., seals the fourth
  quarter and commits the workspace. See docs/year-end.md.
- Opening the next year: `npm run year:open -- <year>` and a button after the close. Opening
  balances from the app's own closed books: balance-sheet accounts carried, the result to 2970,
  foreign accounts at their native balance and the 31.12. rate. Rerunning updates them.
  `npm run import-opening` stays the way to open from Banana.
- Profit allocation after the shareholders' resolution: reserve and dividend with 35%
  Verrechnungssteuer, as guided entries in the new year.
- `npm run fetch-rates -- --year <year>`: one ESTV rate file per year
  (`reference/estv-daily-rates-<year>.json`); every year's file is read.

- Exchange rates: every foreign amount (Buchungen, MWST Ziffer detail, Kontoauszug, the account
  panel, a transaction's entries) explains itself on hover as "EUR amount × rate = CHF amount ·
  ESTV Devisenkurs Verkauf <date>", and the Buchungen and transaction details spell it out.
  An entry whose rate is not the ESTV sell rate of its payment date (a stale or flat rate) gets a
  warning naming the right rate; `npm run restamp-fx` sets it. Kontenabgleich lists the rates the
  period used per currency (validity date, rate, entries, ESTV publication), each opening its
  entries, and the 31.12. rate for the Kursdifferenz once the ESTV has published it. The audit
  export carries the rate table (`data/fx-rates.json`).
- Periods: the header's period button opens a picker with presets (today, yesterday, last 7/30/90/365
  days, last week/month/quarter/12 months/year, week/month/quarter/year to date), the quarters and
  years of the books (filed ones with a lock), and a two-month calendar with typed start and end
  dates. A month (`2026-09`) and any date range (`2026-10-01..2026-10-09`) work like a quarter.
  Relative presets stay relative in a bookmark: "quarter to date" is always the current quarter.
  The MWST tab shows a return only for a quarter, half-year or year; for any other range it offers
  the quarters the range touches. The Bilanz states its date ("per 30.06.2026"), the
  Kontenabgleich lists the month ends inside the range.
- The language is part of every link: `/fr/2026-Q3/vat-report`, and `#/fr/2026-Q3/vat-report` in
  an audit export. A shared link opens in its language; old links without one still work.
- Bilanz, Erfolgsrechnung and Saldobilanz: a click on an account opens its entries beside the
  statement, with opening and closing balance and a link to the full Kontoauszug. The account is
  in the link (`?account=1020`).
- Every entry, transaction and receipt listed in a side panel links to its own view: the MWST
  Ziffer list, the Korrekturabrechnung and its correction cases, the Kontoauszug, the transaction
  detail (now with its journal entries) and each month of the Kontenabgleich.
- Kontoauszug: the account field is a search box. Type a number ("40" finds 4000 to 4099) or part
  of the name ("büro", "mwst"); a tick shows the chart's accounts without entries too.

- Audit export: `npm run build:audit -- <folder>` writes a read-only copy of the books that
  runs from any static file server, without Node.js or the API. Search, filters, every report
  and the receipt PDFs work in it; the audit bar names the snapshot's date, books schema and app
  version. Its `manifest.json` holds the SHA-256 of every file and the seals of the filed
  quarters, and `npm run verify-audit -- <folder>` checks it later. Real books on a public URL
  publish them: `docs/audit-export.md` says how to hand an export over or host it behind access
  protection.
- Kontoauszüge rebuilt (redesign phase 3): each bank account's monthly statements, grouped by
  account or by month; a month that ended without its statement shows as missing, the running
  month with its payments. A statement shows the bank's opening and closing balance, whether its
  payments add up to them, and the books' balance of the account beside the bank's; its PDF with
  the chosen payment's line marked; its payments, each with its receipt, its entry, a folded Wise
  fee or "kein Beleg" (mark it "braucht keinen", ⌘Z undoes); and for a foreign account the ESTV
  rates its entries were booked at. Links: `/bank/1021-2026-09`, `/bank/1021-2026-09/<ref>`,
  `/payments/<ref>`. The add button (N), a drop on the page or a missing month's field read a
  camt.053 or a statement PDF into `bank-statements/<bank>/` and the books, as `npm run extract`
  would; a statement wholly inside a filed quarter is refused. The dock counts statements that
  are missing or do not add up. Removed with the old tabs: Transaktionen (editing a payment's text
  or note, the manual-transaction form) and Kontenabgleich, whose checks and rates live in each
  statement now.

### Fixed

- **⚠ figures** Saldobilanz and Kontoauszug of a period that starts after 1 January (a quarter,
  the last 30 days) open with the balance on the period's first day, not with the 1 January
  opening balance. Only these two views change; VAT figures, returns and `test:books` do not.

## [0.2.0] - 2026-10-09

### Added

- `books.json` and `belege.workspace.yaml` name their format version (`schema`). The app reads
  older files and migrates them in memory; it refuses a file from a newer version and says to
  update. `npm run update` writes the migrated files, with a backup in `data/backups/`.
- Seals of filed quarters: `npm run seal -- <YYYY-Qn> --close` closes a filed quarter and writes
  `filings/<year>/seal-<Qn>.json`, a hash of every entry, transaction and mapping up to its last
  day. Every load checks the seals. Books whose sealed part changed open read-only.
  `npm run doctor` reports the seals.
- `npm run update`: pulls the newest version, installs changed dependencies, migrates the
  workspace, then runs `doctor` and `test:books`. It stops at the first failure with the fix.
- `npm run init` sets up a company's workspace from 14 questions. `npm run doctor` checks the
  tools, the workspace and the mailboxes. A getting-started guide, a mailbox setup guide and a
  step-by-step quarter workflow.
- A second demo company, a one-person consultancy (`demo-consulting/`), with salaries and a
  correction (0535) paid.
- A casebook of 32 invented Swiss booking cases, checked against the VAT engine, which booking
  uses as examples when a company has little history of its own. `npm run mine-cases`.
- Bank statements (camt.053) of any Swiss bank. A statement lands on the bank account of its
  IBAN, else of its folder; nothing falls back silently.
- `npm run gaps`: the open transactions that no supplier, customer or authority file covers.
- Knowledge by role: the app ships supplier, customer and authority files (ESTV,
  Ausgleichskasse, cantonal tax office, BAZG); a workspace adds its own under `knowledge/`.
- Generic booking rules for payroll, social insurance, the VAT payment, the owner's account,
  direct taxes, refunds of sales and services abroad.

### Changed

- **⚠ action** `npm run seal -- <year>-Q4 --close` refuses: the fourth quarter closes with the
  year (`npm run year:close`), so the year-end entries can still be dated 31.12. `--force`
  closes it anyway.
- The app is called Vanilla Accounting. The workspace variable is `VANILLA_WORKSPACE`;
  `BELEGE_WORKSPACE` still works and prints a note.
- **⚠ action**: a workspace's `counterparties/` and `policy/` folders moved to
  `knowledge/{suppliers,customers,authorities,rules}/`. Run `npm run migrate-workspace` once and
  commit the workspace.
- One chart of accounts (Swiss KMU) for new workspaces. Booking works without a prior-year
  export.
- A manifest without `schema` reads as schema 1. Before, it was refused.

### Fixed

- An I-code on an investment account (1500 to 1799) is valid.
- An IMAP fetch closes the connection after a refused login.
- `doctor` treats a missing `beleg-import/` as a note: git does not keep the empty folder.

## [0.1.0] - 2026-10-09

### Added

- The first public version. Bookkeeping for a Swiss GmbH with VAT by the effective method on
  cash basis: camt.053 import (with grouped payments), receipt collection by mail, receipt
  matching and booking with Claude, the ESTV daily rate at the payment date for foreign
  currencies, the VAT Ziffern per quarter, the eCH-0217 XML for the ESTV portal, the
  Korrekturabrechnung (0535) of a filed quarter, and the period lock (`config.closedThrough`).
- A React UI with a local API server, the CLI scripts, a demo workspace, the processes in
  `processes/`, the golden master of the VAT figures, and the leak guard (`npm run check-public`).
