# Redesign: progress

The run of the redesign plan (private workspace `planning/implementation-plan.md`) on branch
`redesign`. This file is the run's memory: what is done, what is next, and every default chosen
with its reason. Architecture: [architecture.md](architecture.md).

Checks at every commit: `npx tsc --noEmit`, `npm test`, `npm run test:books`, `npm run check-public`.
Browser proof: `.claude/skills/verify/` sandbox on `demo`, evidence in `.verify/evidence/`.

## Phases

- [x] 0. Setup: branch, docs read, checks green, API inventory, architecture, this file.
- [x] 1. Shell: tokens, fonts, theme, zoom, dock, top bar, list/detail with divider, keys, ⌘K, toast with undo, URL sync, add button with N.
- [x] 2. Belege.
- [ ] 3. Kontoauszüge.
- [ ] 4. Buchungen and MWST-Codes.
- [x] 5. MWST and Bilanz & ER.
- [ ] 6. Export.
- [ ] 7. Abschluss and Firma.
- [x] 8. Invoices: data and documents.
- [ ] 9. Invoices: UI.
- [ ] 10. Clean up and final pass.

## Decisions and defaults

| Date | Decision | Why |
|---|---|---|
| 2026-10-11 | `tests/update.test.ts` accepts the spec reporter's `ℹ pass N` besides TAP's `# pass N`. | Node 24 prints the spec format in the nested run; the test failed on main before any redesign change. |
| 2026-10-11 | The language leaves the URL; it is a per-viewer preference. Old `/<lang>/<period>/<tab>` links redirect. | urls.md rule 3: links do not change with the UI language. |
| 2026-10-11 | Plain CSS with the mockup's class names, one file per area; Tailwind only in old components until phase 10. | Plan, architecture decision 1. |
| 2026-10-11 | The UI keeps computing from `books.json` with `src/accounting` functions. | Same code as CLI and golden master; the mockup's `appcalc` proved the figures match. |
| 2026-10-11 | `/receipts/<file>.pdf` is a file, `/receipts/<id>` the app: the server tells them apart by extension. | urls.md paths collide with the data paths the UI already fetches. |
| 2026-10-11 | Until its phase, each area shows the old tab(s) through one adapter (`src/app/areas/legacy.tsx` + `legacy-tabs.tsx`, the old App.tsx minus header, tab bar and URL state), full width under the new heading. An area with several old tabs lists them as heading tabs. | The app stays usable at every commit; the old tabs have their own list/detail split. Deleted in phase 10. |
| 2026-10-11 | The old tabs' selection keys (je=, account=, ziffer=, view=codes&code=) are held in memory by `lib/location.ts`, seeded from the route and written back as route changes; the old link helpers (`entryHref`, `txHref`, …) build the new paths. | One parser for the URL; old components keep working unchanged. |
| 2026-10-11 | Bank area's old tabs: Kontoauszüge, Transaktionen, Kontenabgleich; reports: Erfolgsrechnung, Bilanz, Saldobilanz, Kontoauszug; `/payments/<ref>` shows the payment in Transaktionen; an old `account-ledger?account=` link opens `/reports/trial/<account>`. | Every old view stays reachable from the dock. |
| 2026-10-11 | Absent `?period=` means the open quarter: the quarter after `closedThrough` (`openQuarter`, periods.ts), today's quarter when nothing is filed. A link with the open period leaves it out. | urls.md: "left out when it is the open period"; the mockup's OPEN_PERIOD. Old links without a period meant "all" and now open the open quarter. |
| 2026-10-11 | urls.md's range spelling `2026-07-01_2026-09-30` is written; `..` (periods.ts, old links) is read too. | URL per urls.md, CLI tokens unchanged. |
| 2026-10-11 | Zoom is CSS zoom on `<html>` with `--z`, as in the mockup (not on `<main>`): steps 80–160 %, stored per viewer; an old percent value is converted. | The mockup's CSS (`main { height: calc(100vh / var(--z)) }`, menu positions divided by the zoom) assumes the root; the top bar and dock scale too (shot 19). |
| 2026-10-11 | Theme keeps the `dark` class for the old Tailwind components beside `data-theme`; stored under `theme`, applied before the first paint by index.html. | Old tabs follow the theme until phase 10. |
| 2026-10-11 | Language: top bar menu (de, fr, it, en), stored per viewer; an old `/fr/…` link does not change it. | urls.md rule 3. |
| 2026-10-11 | Fonts: Hanken Grotesk, Instrument Sans, Geist Mono via @fontsource; Figtree, Roboto Condensed, JetBrains Mono and the unused Radix packages removed; Tailwind's `font-mono` is Geist Mono. | One type system; old tabs read in the new fonts. |
| 2026-10-11 | The key legend shows as in the mockup (quiet, bottom right); `?` hides and shows it (remembered). | Architecture names `?` for the legend; the mockup always shows it. |
| 2026-10-11 | ⇧E (export) not bound yet. | The export dialog is phase 6. |
| 2026-10-11 | The theme toast from the top bar's ◐ carries an undo (⌘Z). | The only undoable action in phase 1; proves the toast's undo end to end. |
| 2026-10-11 | Add button and N on Belege, and a drop on any page: PDFs go to the inbox through `POST /api/upload` (same-second files no longer overwrite each other), toast; other files are named as skipped. | A real intake now; phase 2 builds reading and matching on top. |
| 2026-10-11 | Firma is a real list/detail area now (sections of urls.md, J/K, Enter, Esc, divider); Darstellung works (theme, language, zoom), the other sections say "im Bau". Rechnungen says so too. | The shell's list/detail, divider and row keys need one real area to work on; the brief's placeholder for company. |
| 2026-10-11 | Tab title "<object> · <area>" without the product name. | urls.md rule 6's example. |
| 2026-10-11 | The audit bar is a fixed amber strip over the page top. | `main` is exactly one screen high (mockup CSS); a bar in the flow would push it off. |
| 2026-10-11 | Express serves a built app (`dist/`, or `APP_DIST`) with the same app-path rule as Vite (`src/server/app-paths.ts`); the sandbox's Vite config imports it. | One rule for "file or app path" in three places. |
| 2026-10-11 | A receipt is locked (read only) when it is linked to a payment or entry of a filed quarter, as the API's `receiptDates` rule; an unlinked receipt dated in a filed quarter stays editable and linkable to open payments. | Cash basis: an invoice of June paid in July is booked in July; the mockup's lock by the receipt's own date would block that. |
| 2026-10-11 | A receipt's date for the list is its date, else the `YYYYMMDD-` its file name starts with; undated ones count in the period they were read (`indexedAt`). Vendor and description come from splitting the description at the first `, ` / ` — ` / ` - `. | As the mockup's generator did without its model-written titles. |
| 2026-10-11 | "Not a receipt" is the existing rule (`isNonReceipt`: kinds supporting/statement/noise/duplicate, or 0 without VAT and link); statements are left out of the hidden list. `Kein Beleg` sets `kind: noise`, `Ist doch ein Beleg` sets `kind: invoice`, both `kindBy: human`. No schema step: `kind` exists. | The Receipt type already models it. |
| 2026-10-11 | `PATCH /api/receipts/:id` takes `kind` and `null` for date, amount and kind. Undo of a kind restores the value but marks it as a person's. | An undo must put back "no date" or "no kind"; an exact kindBy restore is not worth a second field. |
| 2026-10-11 | Payments are ranked in `model.ts` (the mockup's score: amount in CHF, days, currency) with the ESTV rate of the payment day; fees and filed-quarter payments are left out; a payment that already has a receipt ranks lower instead of being hidden. No function in src/booking or src/reconcile ranked candidates (match.ts asks the model). | Grouped payments (AliExpress, FedEx, Amazon) hold several receipts; ADR 0001 rates. |
| 2026-10-11 | The suggestion (↵ Zuordnen) is computed, not a model's: the only open payment of exactly the amount in the same currency, within 31 days, without a receipt. No confidence percent, no "privat bezahlt" suggestion. | Nothing stores the matcher's suggestions; a missing payment may only mean a statement is not imported yet. |
| 2026-10-11 | "Privat oder bar bezahlt" creates a manual payment (`POST /api/transactions/manual`) on the receipt's date and amount and links it; undo deletes the payment and its link. The option shows the workspace's `manual` account number. | The app's existing private-outlay model (classify books it on the owner's account). |
| 2026-10-11 | Delete asks first (palette-style dialog) and has no undo. | The delete removes the file from disk; the mockup's undo cannot be real. |
| 2026-10-11 | The paper is pdf.js (`pdfjs-dist`, bundled, worker via Vite `?url`) with the mockup's trim of each page to its ink; it falls back to an iframe. | The mockup's rendered paper; no CDN (offline audit export). |
| 2026-10-11 | Dropped PDFs show from `GET /api/inbox` (inbox files not in the books, with the id their receipt will get) as rows being read; the page polls every 3 s and reloads the books when one leaves the inbox. The app does not run extract itself. Intake moved from the shell to `areas/receipts/intake.ts`; no undo for an upload. | Reading is `npm run extract` (and its model fallback); running it from the server is a later decision. |
| 2026-10-11 | The detail's shared CSS (paper, margin sections, forms, status, link dialog, preview, downloads) is `src/app/styles/detail.css`, not `receipts.css`. | Bank and journal details (phases 3 and 4) reuse the same classes. |
| 2026-10-11 | Removed with the old receipts tab: batch rename, the manual-transaction batch, the duplicate approval and their client calls (the API routes stay until phase 10 decides). | Not in the mockup; the CLI covers rename. |
| 2026-10-11 | The shell's `nav.go` leaves the open period out of the link; the legacy bank page takes the route's payment as its first selection. | urls.md; under StrictMode the old restore effect lost `/payments/<ref>`. |
| 2026-10-11 | Invoices live in `invoices.json` (customers, invoices, sent documents) beside books.json; an issued invoice's PDF in `invoices/<number>.pdf`, a reminder's or cancellation notice's in `invoices/sent/<id>.pdf`. invoices.json has its own `schema` (INVOICES_SCHEMA 1 in src/workspace/schema.ts). | ADR 0004 envelope per record; one file is enough until the year split; a new file starts at its own version. |
| 2026-10-11 | No BOOKS_SCHEMA or WORKSPACE_SCHEMA bump: the manifest gains optional `company.address` and `invoicing`, entries gain `origin: 'invoice'`. | An older app ignores both safely: it never writes the manifest, and treats an unknown origin as "another writer", which `classify --force` keeps. |
| 2026-10-11 | The address field is `postcode` (not `zip`). | The company's own manifest already names it so; no migration. |
| 2026-10-11 | No 5-Rappen rounding: line net to the Rappen, VAT per rate on its net, total = net + VAT. | A QR-bill is paid by transfer to the Rappen; 5 Rappen are for cash, and a rounding line would need its own booking. |
| 2026-10-11 | The invoice PDF is printed once, at issue; "send" records a sent document for that same file (a resend is the same bytes); reminders and cancellation notices are printed when sent. | ADR 0010: a sent document is never rendered again; the PDF is also the receipt of the paid entry. |
| 2026-10-11 | A credit note is an invoice record of kind `credit-note` with negative quantities, in the same number sequence; a part credit can be limited to one VAT rate. | As the mockup prints it (75); the sequence is the one customers see. |
| 2026-10-11 | The supply date is the invoice date unless a line says otherwise; Art. 26 check: sender name, address, UID; customer name and address; date; each line's text, quantity, rate; a reason (export or abroad) for 0 %. | Art. 26 Abs. 2 MWSTG; a period field can come with recorded hours. |
| 2026-10-11 | 0 % lines: `exemption: export` books V0 (Ziffer 220), `abroad` books V0-E (221), each with its printed note. | The two exempt cases a small company invoices. |
| 2026-10-11 | Payment matching: a credit note counts against a payment only if dated by the payment; more than open plus reminder fees is reported, never booked; reminder fees are booked without VAT to `invoicing.feeAccount` (else the revenue account). | A credit written after payment is a refund, not an overpayment; a fee is damages, not a supply. |
| 2026-10-11 | Payments without a reference are proposals computed on read (`GET /api/invoices/payments`, same currency and open amount, on or after the invoice date, payer name compared); confirming replaces only the classifier's entries. | Nothing to store or keep in sync; a hand booking is a person's decision. |
| 2026-10-11 | An account outside CH/LI (the demo's Wise EUR, BE IBAN) prints IBAN and RF reference instead of a QR-bill. | The QR-bill standard accepts only CH and LI IBANs. |
| 2026-10-11 | Invoice refusals carry `invoiceRefusal` (and `missing`) beside the German `error`, not a new ApiRefusal code. | Keeps src/app untouched in phase 8; phase 9 translates them. |
| 2026-10-11 | Invoice fonts: Inter and Arimo (as Liberation Sans for the QR-bill) from @fontsource, Latin subsets inlined; layout fonts are Inter and Helvetica (Arimo) for now. | ADR 0012: the same pages on every machine; phase 9 can add fonts to INVOICE_FONTS. |
| 2026-10-11 | The demo's IBANs are valid (CH65 8080 …, BE29 9670 …) and the QR-IBAN is SIX's example; its PDFs are printed by the generator, so `demo:generate` is byte-stable per machine and browser. | The manifest refuses an IBAN with wrong check digits; a PDF depends on the Chromium build (ADR 0012). |
| 2026-10-11 | Not built in phase 8: e-mail sending, the git finalization at issue (ADR 0010 rule D), open invoices in the year-end checklist, the chrome-headless-shell download, agent tools. | Each needs a part that does not exist yet (mail settings, sync, the phase 9 UI, the registry). |
| 2026-10-11 | MWST shows the return of the period's ESTV period (quarter, half, year); any other period (a month, a range) shows the open quarter, as the mockup's `vatKey`. A half year or year is "Zusammenzug, nur zur Übersicht"; due date (end + 60 days) only for a quarter. | A return exists only for an ESTV period; the old tab's quarter chooser is one click more for the same result. |
| 2026-10-11 | The Korrekturabrechnung is the pseudo-Ziffer `0535` (`/vat/0535?period=<filed quarter>`), the last row of a filed quarter's list: the form (bisher eingereicht, korrigiert, Differenz; a line selects its Ziffer), the reconciliation and the correction cases as `<details>`, and Drucken (print CSS shows only the form and every case). A Ziffer's filed-difference notice links to it. | The mockup has no place for the 0535 beyond the notice; a list row keeps it one ↓ away, linkable, and keeps the list/detail model. |
| 2026-10-11 | No correction booking form in MWST: a correction stays a journal entry with `corrects:` in the open quarter (Buchungen, phase 4, or the CLI). | The old tab had no booking form either (its "CorrectionForm" was the 0535 view); the mockup has no place for one; a manual entry is phase 4's. |
| 2026-10-11 | A filed quarter says "eingereicht" without a date. | The eCH-0217 XML the app files carries only its generation time, not the filing date; adding it to the parsed return would change the golden of the filed returns. |
| 2026-10-11 | A filed difference is marked when today's figure differs by a Rappen or more from the filed XML; rate rows compare their turnover (gross for supplies, net for Bezugsteuer), as the XML holds it. | The mockup compared Bezugsteuer's tax with the filed turnover and marked 383 on every filed quarter. |
| 2026-10-11 | The Ziffer list's labels are short names (`vat.n<ziffer>`), the detail's explanation the ESTV form's long wording (`vat.z<ziffer>`) or the mockup's sentence for sums. | As the mockup: short in the list, the meaning on the right. |
| 2026-10-11 | Reports: the report is in the path (`/reports/income|balance|trial`); "Nur mit Betrag / Alle Konten" and the collapsed groups are per viewer (localStorage). The search (`?q=`) shows every matching account and switches between Bilanz and Erfolgsrechnung by replacing the route. | urls.md: the report is a place, the toggle a view preference. |
| 2026-10-11 | Entries booked on one side (an `M81-2` code) are the account `none` in links (`/reports/trial/none`), shown as "Ohne Gegenkonto · nur MWST-Betrag". | urls.md has no empty segment; account numbers are digits, so `none` cannot collide. |
| 2026-10-11 | A link to a known account without an amount keeps it selected (the ledger shows) though the list hides its row; an unknown account selects the first row. | ⌘K offers every account of the chart; replacing the link's account would make those entries dead ends. |
| 2026-10-11 | Ledger rows are links to the entry (`/journal/<id>`); VAT codes in MWST link to `/vat/codes/<code>` (minus sign dropped) with a plain title "<code> · <kind>". The shared hover card is phase 4's. | Brief; urls.md names codes without the sign. |
| 2026-10-11 | Export and Herunterladen in Bilanz & ER are left to phase 6 (export dialog). | The mockup's buttons open the export dialog of phase 6. |
| 2026-10-11 | Removed: vat-report-tab, vat-correction-form, vat-correction-cases, income-statement-tab, balance-sheet-tab, trial-balance-tab, account-ledger-tab, account-panel, and 40 i18n keys only they used (common.* and col.* kept). Kept for phase 4: vat-codes-view, vat-entry-table, vat-code (the codes area renders VatCodesView through the legacy adapter's `vat-codes` tab). | Migrate callers, then delete; the codes area is phase 4's. |

## API inventory against the mockup

Reads: the UI loads `/books.json`, `/api/accounts`, `/api/config`, `/api/vat/filed`,
`/api/fx-rates`, `/api/workspace`, `/api/status`, `/api/year-close/:year`. Writes that exist:
receipts (patch, delete, upload, vision extract, suggest date, rename), transactions (manual,
patch, delete), mappings (add, remove, approve duplicate), journal entries (patch, delete,
classify), year close (revaluation, templates, entries, close, open).

Missing for the mockup, to add in their phase:

- Belege: done in phase 2 (receipt PATCH `kind` and nulls, `GET /api/inbox`).
- Kontoauszüge: statement import (camt.053 and PDF upload) from the UI; today it is a CLI step.
- Buchungen: new manual entry (route exists only through year-close entries).
- Export: the export bundle (CSV, XLSX, JSON, PDF, ZIP with LIESMICH and SHA-256 sums).
- Firma: write company profile, banks, periods, display and invoice layout to `belege.workspace.yaml`.
- Rechnungen: everything (phase 8).

## Log

- 2026-10-11 phase 0: branch `redesign` from `main` (c73209e). Baseline: tsc ok, `npm test` 295/296
  (update test, fixed), `test:books` 15/15, check-public 0 findings.
- 2026-10-11 phase 1: shell. route.ts (one parser, old links redirect, 5 tests), app paths in Vite/sandbox/Express,
  tokens.css + shell.css from the mockup, self-hosted fonts, theme/zoom/language, dock, top bar, list/detail with
  divider, keyboard model, ⌘K palette, toast with undo, period picker restyled as the mockup's, drop zone + intake,
  add button with N, tab titles; every old tab inside its area through the legacy adapter; Firma list/detail with
  Darstellung. Evidence and mockup comparison: .verify/evidence/redesign/phase-1/NOTES.md. Differs from the mockup:
  old tab bodies (phases 2–9), theme toast has an undo, no ⇧E yet, Firma sections other than Darstellung pending.
  Commits: route.ts, app paths, upload, then the shell. Left: bank badge (needs
  the statement check, phase 3), objects in ⌘K for the other areas as they are built.
- 2026-10-11 phase 2: Belege. `src/app/areas/receipts/` (model.ts pure order and ranking with tests, list with groups,
  filters, search, collapse; detail with the pdf.js paper, facts, status, suggestion, Zahlung/Angaben/Datei; link dialog
  with private outlay; kind, edit, delete with confirm; undo through the toast for link, unlink, private outlay, edit and
  kind; Space preview, D download; ⌘K objects; dock badge; intake with reading rows from `GET /api/inbox`). API: receipt
  PATCH takes `kind` and nulls; inbox read routes. Old receipts tab, receipts-table, receipt-edit-form, assign-panel and
  manual-batch-modal deleted. Evidence and mockup comparison: .verify/evidence/redesign/phase-2/NOTES.md. Differs from
  the mockup: lock by payment quarter, computed suggestion without percent, delete asks first, the payment link lands in
  the old Transaktionen tab, reading waits for `npm run extract`. Left: the demo's `npm run extract` refuses its own
  closed transactions (seen while proving intake, not changed here); API routes rename/suggest-date/approve-duplicate
  have no UI caller now.
- 2026-10-11 phase 8 (branch `redesign-invoices`): src/invoices/ (records, rules, QRR/SCOR, the A4
  sheet, PDF via puppeteer-core and the installed Chrome, store, service, payment matching), the
  manifest's address and invoicing block, extract matches invoice payments first, routes under
  /api/invoices and /api/customers, the demo writes invoices. ADR 0012 accepted. Commits 25f6f79,
  8750dcf and the docs commit. Evidence: .verify/evidence/redesign/phase-8/ (PNG pages of every
  demo document, QR codes decoded, an extract run on a demo copy booking both paid invoices).
  Differs from the mockup: two-rate invoices with texts take two sheets with its geometry; the demo
  uses QRR (QR-IBAN) where the mockup shows RF; the EUR invoice to a BE IBAN has no QR-bill.
  Found and fixed: `npm run extract` failed on both demos (filed transactions generated with parts
  and reference). Left for phase 9: every screen; later: e-mail, finalization at issue, year-end list.
- 2026-10-11 phase 5 (branch `redesign-p5`): MWST and Bilanz & ER. `src/app/areas/vat/` (model.ts: the return, its state, the entries per Ziffer, shown Ziffern, filed differences; form0535.ts; list with parts, result box, filed marks, 0535 row; detail with formula or entries by code, notices, the 0535 with cases and print) and `src/app/areas/reports/` (model.ts: the three reports from the app's functions, search, one-sided gap, ledger; list with tabs, all accounts, search, groups; ledger detail). Tests: tests/vat-reports-area.test.ts. Old VAT and report tabs deleted, legacy adapter keeps only the codes tab. Evidence and mockup comparison: .verify/evidence/redesign/phase-5/NOTES.md. Differs from the mockup: the 0535 is a list row with its own detail (the mockup had only the notice), no filing date, no Export/Herunterladen (phase 6), Bezugsteuer compared on its turnover. Left: phase 4 wires the VAT code hover card onto `a.vlink`; the codes area still renders the old VatCodesView.
