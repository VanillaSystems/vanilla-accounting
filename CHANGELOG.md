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

## [0.3.0] - 2026-10-11

The redesign and the Mac app. The app is one window with nine areas, each page with its own
link. It now comes as a Mac app (a `.dmg` for Apple silicon and Intel) that needs no Node.js,
Homebrew or terminal; `npm start` and the CLI work as before. Invoices are written, issued,
printed with a Swiss QR-bill, sent by e-mail through the company's own mailbox and booked when
they are paid. The app processes the inbox itself: a dropped receipt or photo is read, named,
linked and booked without `npm run extract`. Nothing for you to do: `npm run update` installs
it. Two entries carry **⚠ figures** (the demo's Q3 return, and the opening balance of Saldobilanz
and Kontoauszug for a period after 1 January); no filed figure moves. E-mail sending is optional
and reads its password from `VANILLA_SMTP_PASSWORD` in `.env` (in the Mac app, the keychain).

### Changed

- **The redesign.** The app is one window: a list on the left and the selected item on the right
  with a resizable divider (drag, ←/→, double-click resets; kept per area). Nine areas sit in a
  dock at the bottom edge (`G` + letter), and a bar at the top edge holds search, the period, the
  export, zoom, light/dark/system and the language. ⌘K finds receipts, entries, invoices,
  customers, accounts, areas and actions; `N` (or the add button) adds in every area; a toast
  offers Rückgängig (⌘Z); `?` hides the key help. Every page has its own link
  (`/journal/M2026-001`, `/vat/405?period=2026-Q3`, `/reports/balance/1021`; docs/urls.md).
  The language is no part of a link: it is chosen per viewer, and old `/<lang>/<period>/<tab>`
  links and bookmarks redirect. PDFs dropped on the page go to the inbox. A filed quarter shows
  with a lock and every edit in it is refused. The areas:
  - **Belege** (`/receipts/<id>?filter=offen&q=…`): what needs you comes first ("Braucht dich"),
    then month by month; filters `zugeordnet`, `offen`, `ohne Datum` and a search. A receipt shows
    its paper (each PDF page cut to its ink), one line of facts (date, amount, Swiss VAT, VAT
    number), its payment with links to the statement and the entry, and Zahlung, Angaben and Datei
    in the margin. `L` opens Zahlung verknüpfen with the open payments ranked by amount, date and
    currency, and "privat oder bar bezahlt" books a private outlay; an exact fit is offered as a
    suggestion (↵). A receipt paid privately by mistake is released with **Privat bezahlt
    aufheben**, which deletes its private payment (⌘Z pays it again); a private payment that is
    already booked is not deleted, its entry goes first. Link, unlink, edits and "kein Beleg" take
    effect at once and can be undone; a delete asks first. Space previews, D downloads, E edits. A
    receipt paid in a filed quarter is read only. Dropped files show as "wird gelesen" while
    the inbox processing reads them, then the receipt takes their place.
  - **Kontoauszüge** (`/bank/1021-2026-09`, `/bank/1021-2026-09/<ref>`, `/payments/<ref>`): each
    bank account's monthly statements, grouped by account or by month; a month that ended without
    its statement shows as missing, the running month with its payments. A statement shows the
    bank's opening and closing balance, whether its payments add up to them, and the books' balance
    of the account beside the bank's; its PDF with the chosen payment's line marked; its payments,
    each with its receipt, its entry, a folded Wise fee or "kein Beleg" (mark it "braucht keinen",
    ⌘Z undoes); and for a foreign account the ESTV rates its entries were booked at. A payment's
    note is written in the payment bar (Notiz, ↵ saves, Esc cancels, ⌘Z undoes). The add button,
    a drop on the page or a missing month's field read a camt.053 or a statement PDF into
    `bank-statements/<bank>/` and the books, as `npm run extract` would (`POST /api/statements`);
    a statement wholly inside a filed quarter is refused. The dock counts statements that are
    missing or do not add up.
  - **Buchungen** (`/journal/<id>`, `?vat=<code>`): the period's entries month by month as one grid
    of Datum, Text, Soll, Haben, MWST and amount, the entries of one payment joined; filters
    `ohne Beleg` and `Korrekturen`, and a search over text, accounts, code, ref and amount. An entry
    shows its Buchungssatz with the account names, the FX conversion with the ESTV check, its
    payment, receipt and paper (or the statement's excerpt when it has no receipt). Soll, Haben
    (pick by number or name), MWST, amount and text are edited in place; `N` books a new entry by
    hand (`POST /api/journal-entries`); a filed entry offers a correction in the open quarter,
    pre-filled as its reversal with `corrects`. Edit, new entry, delete and Neu klassifizieren can
    be undone. The histogram shows the period's VAT codes by count or CHF.
  - **MWST** (`/vat/<ziffer>`): one return per page, the Ziffern by part of the form with Zu
    bezahlen or Guthaben on top, and for the selected Ziffer its formula or its entries grouped by
    VAT code. An open quarter shows its due date; a filed one its lock, marks every Ziffer that
    differs from the filed return and why, and ends with the Korrekturabrechnung (form 0535,
    `/vat/0535`) with its correction cases and a print button. A return shows only for a quarter,
    half-year or year; for any other range the page offers the quarters it touches.
  - **MWST-Codes** (`/vat/codes/<code>`, **Codes erklärt** in MWST): every VAT code the app shows
    (Buchungen, a payment's entries, the entries behind a Ziffer, the cases of a
    Korrekturabrechnung) explains itself on hover: what it means, its rate, the Ziffern it feeds and
    when to use it. A click opens the catalogue by family with a search, when to use each code and
    when not, an example from the casebook, and the period's entries that use it. A code the app
    does not declare in any Ziffer (VS, F, Z codes, V81-B) shows in amber. The Ziffern come from the
    engine, so the explanation cannot drift from the return (tests/vat-codes.test.ts).
    `docs/vat-codes.md` is the same catalogue as a document; `npm run vat-codes` regenerates it and
    its data from `reference/MWST-codes.txt` and the casebook.
  - **Bilanz & ER** (`/reports/income|balance|trial[/<account>]`): the Erfolgsrechnung, Bilanz or
    Saldobilanz of any period with the selected account's ledger beside it (opening and closing
    balance, its entries). It finds an account by number ("40" finds 4000 to 4099) or name in
    whichever report holds it, shows all accounts of the chart on request, and names the entries
    booked on one side when Aktiven and Passiven differ. The Bilanz states its date ("per
    30.06.2026"). ⌘K finds every account.
  - **Abschluss** (`/close/<step>`): the year-end in seven steps: Q4, the checks computed from the
    books (with the Kursdifferenz, the VAT reconciliation, open invoices and the closing balance
    sheet), the year-end entries with prefilled forms, closing the year (it books the Kursdifferenz
    first), opening the next year, the profit allocation and the handover, whose cards open the
    export dialog (the journal for Banana, the Prüfung ESTV / AHV preset for the year).
  - **Firma** (`/company/<section>`): the profile, VAT setup, bank accounts with their last
    statement balance, the chart of accounts, periods with their seals, the opening balances,
    Rechnungslayout and Darstellung. The profile, a bank account's label and IBAN, a new bank
    account, and an account's name are changed there (`PATCH /api/workspace`,
    `PUT /api/accounts/<number>`): `belege.workspace.yaml` keeps its comments, layout and every
    field the app does not know, and a change its reader refuses is never written.
  - **Rechnungen** (`/invoices`, `?status=`): the invoices of a period by state (Überfällig first,
    then Offen, Entwürfe, Bezahlt, Gutschriften, Storniert), the open total in CHF, the customers
    (`/invoices/customers`) and every document sent (`/invoices/sent`, the stored PDF as it went
    out). An invoice shows on its A4 sheet, laid out by the same renderer as its PDF; a draft is
    edited on the sheet itself (customer, dates, texts, each line's text, quantity, unit, price and
    VAT rate, the reason for 0 %), with Vorschau, Ausstellen (what Art. 26 MWSTG still needs is
    named), Senden (by e-mail, or the PDF downloaded, and the send recorded), copy, credit note
    (whole or part, refund or set off), cancellation with a notice, reminders written on the sheet
    with a fee, comments, and payment proposals to confirm. The customer form takes addresses of
    any country (postcode, state, house number first, VAT number, language). New invoice with `N`
    or `/invoices/new?customer=<id>`. Firma › Rechnungslayout sets font, colour, logo (uploaded,
    `POST /api/workspace/logo`), envelope window and elements, and the texts above and below the
    table per language, edited on a sample sheet (`PATCH /api/workspace` writes the `invoicing`
    block).
- Periods: the period button opens a picker with presets (today, yesterday, last 7/30/90/365
  days, last week/month/quarter/12 months/year, week/month/quarter/year to date), the quarters and
  years of the books (filed ones with a lock), and a two-month calendar with typed start and end
  dates. A month (`2026-09`) and any date range (`2026-07-01_2026-09-30`) work like a quarter.
  Relative presets stay relative in a bookmark: "quarter to date" is always the current quarter.
- Exchange rates: every foreign amount explains itself on hover as "EUR amount × rate = CHF amount ·
  ESTV Devisenkurs Verkauf <date>", and Buchungen spells it out. An entry whose rate is not the
  ESTV sell rate of its payment date (a stale or flat rate) gets a warning naming the right rate;
  `npm run restamp-fx` sets it. Each foreign statement lists the rates its entries used. The audit
  export carries the rate table (`data/fx-rates.json`).
- **No program outside Node (ADR 0006 section 2).** The app reads a PDF's text with pdf.js in
  the three shapes the parsers expect (`src/parsers/pdf-text.ts`: reading order for receipts,
  content-stream order for the Wise transfer references, physical layout for statement closing
  balances), wraps a dropped photo into a PDF with pdf-lib, and does its own git with
  isomorphic-git (the repository `npm run init` makes, the commits of a year close and of the
  opening, the moves of `npm run migrate-workspace`). A scanned PDF without text goes to the
  model's vision as before. `npm run doctor` no longer asks for pdftotext or ImageMagick and
  names git as optional (`npm run update`, `npm run check-closed`). `extractionMethod:
  'pdftotext'` stays the value of a PDF's own text, so existing books load unchanged. Proven
  against the parsed results of every PDF of both demos and of a real workspace
  (`tools/pdf-text/compare.ts` reruns the comparison against an installed pdftotext).
- A Wise transfer reference on a page's last line ends at the page end; before, the page footer
  was glued to it.
- A Swiss UID wrapped after `CHE-` on an invoice is found by the knowledge routing too (the
  intake's check already allowed the break).

### Added

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
- Export: one dialog for every export, from the top bar's export chip, ⇧E or ⌘K. Presets
  Treuhänder-Paket (the open quarter: reports as PDF, the journal for Banana and as CSV, payments,
  every original), Prüfung ESTV / AHV and Jahresarchiv (the year, with SHA-256 checksums and the
  filed returns and seals), Excel-Rohdaten (one workbook); save your own preset (kept in your
  browser, also in ⌘K). Choose the period (a quarter, the year, any range), the parts
  (Erfolgsrechnung, Bilanz, Saldobilanz, MWST-Abrechnungen, Kontoblatt, all Kontoblätter, journal,
  payments, receipt list, chart of accounts, the receipts, statements and filed returns as
  originals) and the formats (PDF, CSV, Excel, JSON, Banana). The app builds the files
  (`POST /api/export`): one ZIP with folders, a LIESMICH in your language, and on request
  SHA256SUMS.txt and manifest.json (`shasum -a 256 -c SHA256SUMS.txt` checks them); a single file
  is downloaded as it is. PDFs need Chrome, Edge, Brave or Chromium, as invoices do. The export
  only reads the books and works in audit mode (`npm run start:audit`). A ledger's `Herunterladen`
  (D) gives it as CSV, Excel or PDF in one click. `npm run export` writes the same Banana file;
  it now also lists entries without a bank payment (private outlays, Eigenverbrauch).
- Audit export: `npm run build:audit -- <folder>` writes a read-only copy of the books that
  runs from any static file server, without Node.js or the API. Search, filters, every report
  and the receipt PDFs work in it; the audit bar names the snapshot's date, books schema and app
  version. Its `manifest.json` holds the SHA-256 of every file and the seals of the filed
  quarters, and `npm run verify-audit -- <folder>` checks it later. Real books on a public URL
  publish them: `docs/audit-export.md` says how to hand an export over or host it behind access
  protection. Links into an export keep the path after `#`.
- Year-end close: `npm run year:close -- <year> [--dry-run]` and the Abschluss area (de, fr, it,
  en). A checklist computed from the books: the fourth quarter filed, Q1 to Q3 sealed, every bank
  account matching its statement on 31.12., the statements covering the year, every transaction
  booked, `npm run doctor` clean. It books the exchange difference (Kursdifferenz) of each
  foreign-currency account on 31.12. at the ESTV rate of that day (rerunning replaces it),
  reconciles the VAT accounts with the year's returns, guides the year-end entries (depreciation,
  accruals and deferrals, provisions, tax provision, private use, inventory, social insurance,
  doubtful accounts) as prefilled entries or "not needed", and shows the closing balance sheet
  with the VAT split off by code. Invoices still open on 31.12. are proposed as a receivables
  entry (1100 against the revenue account, no VAT code) to book or mark not needed (ADR 0010).
  "Jahr abschliessen" closes through 31.12., seals the fourth quarter and commits the workspace.
  See docs/year-end.md.
- Opening the next year: `npm run year:open -- <year>` and a step after the close. Opening
  balances from the app's own closed books: balance-sheet accounts carried, the result to 2970,
  foreign accounts at their native balance and the 31.12. rate. It reverses the receivables entry
  of 31.12. on 1.1. (revenue against 1100), so an invoice's revenue counts in the year it is paid,
  with its VAT. Rerunning updates the balances and keeps one reversal. `npm run import-opening`
  stays the way to open from Banana.
- Profit allocation after the shareholders' resolution: reserve and dividend with 35%
  Verrechnungssteuer, as guided entries in the new year.
- `npm run fetch-rates -- --year <year>`: one ESTV rate file per year
  (`reference/estv-daily-rates-<year>.json`); every year's file is read.
- **The app processes the inbox itself.** A dropped or added receipt, a statement upload and a
  scan from the phone start reading, the VAT facts, naming and linking, and booking the new
  payments (`POST /api/intake`, one job at a time); a line at the bottom left says what it does,
  and Belege has **Eingang verarbeiten** (also in ⌘K). A second run changes nothing. Without a
  working `claude` CLI the text is read, statements are imported and invoice payments matched by
  reference; the rest waits and the app says so. `npm run extract`, `extract-vat`, `match` and
  `classify` run the same steps (src/intake/) and wait for each other and for the app.
- **Invoices by e-mail** through the company's own mailbox. Firma › E-Mail-Versand holds the
  SMTP server, port, encryption, user, sender and reply-to (`outgoingMail` in
  belege.workspace.yaml); the password is not in the workspace: `VANILLA_SMTP_PASSWORD` in .env
  (.env.example). Senden, a reminder and a cancellation notice open a dialog with recipient,
  subject and text (defaults per language in Rechnungslayout); the stored PDF goes out byte for
  byte and the sent log records channel, recipient, time and Message-ID. A message the server
  refuses records nothing. PDF herunterladen stays.
- **The Mac app** (docs/desktop.md). `npm run desktop:build` makes a `.dmg` each for Apple
  silicon and Intel; the app needs no Node.js, Homebrew or terminal. It starts on a start screen:
  open existing books, set up new ones with the questions of `npm run init` as a form (it refuses
  what the wizard refuses), or look at a copy of the demo. The last books open at the next start;
  File opens others, sets up new ones, opens the demo and lists the recent ones; the window keeps
  its place. Invoice PDFs are printed by the app's own Chromium, so no browser has to be
  installed. The `claude` CLI is found through the login shell; without it, reading receipts and
  booking suggestions say what to install and everything else works. The SMTP password is saved
  in Firma › E-Mail-Versand into the Mac's keychain (sealed by the system, per books); new books
  are committed to a git repository as `npm run init` does. The release build is fused (no Node
  mode, no NODE_OPTIONS, no inspector, its code checked at start). Signing, notarization and
  updates from GitHub releases are configured and stay off until their variables are set.
- Belege takes photos: JPG, PNG and HEIC (iPhone) from the drop and the add button go into the
  inbox and become PDFs as they are read, turned upright by the photo's orientation. A photo
  put into the inbox from the Finder or the phone starts the processing as a PDF does.
- Without the `claude` CLI, a model feature (Neu lesen, Klassifizieren) answers with what to
  install instead of a failed process, also under `npm start`.
- `npm run release:github`: the GitHub release of the version in `package.json`, with that
  version's changelog section as its text and the Mac app's two `.dmg` files (and the update
  feed's files when built) as downloads, each with its SHA-256. Without `--publish` it shows the
  release and changes nothing; it refuses to publish unless the clean, tagged commit is on
  `origin/main` (docs/releasing.md).

### Removed

- The old tabs and what only they used: Transaktionen (its manual-transaction form; a payment's
  text and note are edited in Kontoauszüge), Kontenabgleich (its checks and rates live in each
  statement), the Jahresabschluss tab and its account combobox, batch rename and the
  manual-transaction batch.
- API routes no screen and no CLI calls: batch rename and rename suggest (`npm run match` names
  the files), a receipt's date suggestion and the Auslage suggestion (Belege reads both from the
  receipt), and the duplicate approval.
- Tailwind and its helpers (clsx, tailwind-merge, class-variance-authority, lucide-react): the
  styles are `tokens.css` and plain CSS per area.
- `src/parsers/pdf.ts` (pdftotext, pdftoppm and tesseract behind `extractText`): nothing called
  it. The OCR fallback is the model's vision, in `npm run extract` and in Belege.

### Fixed

- A short invoice prints on one page with its QR-bill: the sheet that carries the QR-bill has no
  footer (the QR-bill names the account, the header the VAT number), and the text starts at
  88 mm, 7 mm below the envelope window. A two-line invoice at two VAT rates took two pages.
- **⚠ figures** Saldobilanz and Kontoauszug of a period that starts after 1 January (a quarter,
  the last 30 days) open with the balance on the period's first day, not with the 1 January
  opening balance. Only these two views change; VAT figures, returns and `test:books` do not.
- `npm run extract` read a PDF under 1 KB as an iCloud placeholder and dropped it from the books
  (eight demo receipts); a file is skipped now only when it is no PDF yet. The books keep their
  receipt order, so a second run writes the same file.
- A link to an unknown Ziffer, Abschluss step or Firma section keeps its place and says it does
  not exist (urls.md rule 5); Rechnungslayout keeps logo, upload and remove on one row.

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
