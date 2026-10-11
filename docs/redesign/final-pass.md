# Redesign: final pass against the mockup

Phase 10 part 2 (2026-10-11). Every screenshot of the mockup (`planning/ui-mockup/shots/` in the
private workspace, 95 files) was compared with the same screen of the app, reached through the user's
path (dock keys `G` + letter, row keys, clicks, the period picker, `N`, `⇧E`, `/`, hover), at the
shot's pixel size. The app ran in the verify sandbox on the demo workspace, so names and figures
differ. The comparison covers layout, type, spacing, colour, states and behaviour. The mockup page
changed after many of its shots were taken (the dock lost its Heute entry and gained Rechnungen, the
top bar lost its add button, the journal gained a MWST column, VAT codes became links). Where a shot
and the final mockup page disagree, the app follows the page.

The driver is `.verify/p10/drive.mjs` with one recipe file per area (`r-belege.mjs`, `r-bank.mjs`,
`r-journal.mjs`, `r-vat.mjs`, `r-close.mjs`, `r-inv.mjs`): puppeteer on the installed Chrome,
viewport 1440 × 900 unless the shot is smaller, console errors collected. Like the evidence, the
driver is local (`.verify/` is not in git); a rerun writes every screenshot again. Screenshots are in `.verify/evidence/redesign/phase-10/` (not in git). The last
run of all 95 shots logged no console error, no page error and no alert.

Verdicts: **matches**, **on purpose** (the app differs by a recorded decision, see
[progress.md](progress.md) "Decisions and defaults"), **fixed** (fixed in this pass; the commit
subject is quoted), **open**.

| Shot | Screen | App screenshot | Verdict |
|---|---|---|---|
| 01-q3 | Belege, 1280 × 720 | 01-q3.png | matches |
| 02-q2-coop-dark | Belege of a filed quarter, a receipt selected, dark | 02-q2-coop-dark.png | fixed: "Belege, Kontoauszüge and Buchungen: choosing another period opens the new list at its first row …" (the detail kept the open quarter's receipt after Q1 was chosen) |
| 03-q3-light | Belege, light | 03-q3-light.png | matches |
| 04-tooltip | search field tooltip | 04-tooltip.png | matches (the final page shows `/`, the shot `⇧7`) |
| 05-keys | heading, counts, search key | 05-keys.png | matches |
| 06-dates | list dates, one per day | 06-dates.png | matches |
| 07-wide | list widened with the divider | 07-wide.png | matches (keyboard on the divider, ←/→) |
| 08-date-soft | soft repeated dates | 08-date-soft.png | matches |
| 09-zoom125 | zoom 125 % | 09-zoom125.png | matches |
| 10-zoom140-bottom | zoom 140 %, list scrolled to the end | 10-zoom140-bottom.png | matches |
| 11-quiet | mouse in the list, detail margin quiet | 11-quiet.png | matches |
| 12-margin-hover | margin section hover | 12-margin-hover.png | matches |
| 13-link-dialog | link dialog (`L`) | 13-link-dialog.png | matches |
| 14-compact | compact detail head | 14-compact.png | matches |
| 15-collapse | a month group collapsed | 15-collapse.png | matches (the selection moves to the first shown row, see 28) |
| 16-period-picker | period picker | 16-period-picker.png | fixed: "Period picker: the submenus read Bis heute and Letzte as in the mockup …" |
| 17-aligned | heading and detail aligned | 17-aligned.png | matches |
| 18-dock | dock, light | 18-dock.png | matches the final dock (Rechnungen, no Heute) |
| 18-dock-dark | dock, dark | 18-dock-dark.png | matches the final dock |
| 19-lang-menu-zoom140 | top bar language menu at 140 % | 19-lang-menu-zoom140.png | matches the final top bar (no add button there) |
| 20-verkauf-detail | a sales receipt booked without payment | 20-verkauf-detail.png | matches (the demo has no webshop order receipt; the same detail with its payment) |
| 21-bank-wise-eur | Wise statement, payment line marked | 21-bank-wise-eur.png | fixed: "Kontoauszüge: a Wise payment printed as one text row … is marked alone, not with the four lines above it" |
| 22-from-receipt-to-statement | receipt → its statement line | 22-from-receipt-to-statement.png | fixed: same commit as 21 |
| 23-bank-raiffeisen | bank statement, payment selected | 23-bank-raiffeisen.png | matches |
| 24-bank-statement-check | statement with its balance check | 24-bank-statement-check.png | on purpose: the books' balance beside the bank's close (decision "The check is the mockup's … plus the books' balance") |
| 25-bank-dark | statement, dark, line marked | 25-bank-dark.png | fixed: same commit as 21 |
| 26-dock-kontoauszuege | dock on Kontoauszüge | 26-dock-kontoauszuege.png | matches |
| 27-journal | Buchungen | 27-journal.png | matches |
| 28-journal-no-receipt | filter "ohne Beleg", entry with statement strip | 28-journal-no-receipt.png | fixed: "Belege, Kontoauszüge and Buchungen: a filter, a search or a collapsed group that hides the selected row selects the first row it shows …" |
| 29-statements | statements by account | 29-statements.png | matches |
| 30-statement-payment | payment bar and marked line | 30-statement-payment.png | matches |
| 31-statement-missing | a missing statement | 31-statement-missing.png | matches (one statement removed from a sandbox copy to show the state) |
| 32-journal-grid | journal grid, narrow list | 32-journal-grid.png | matches the final page (MWST column, as shot 34) |
| 32-journal-grid-dark | same, dark | 32-journal-grid-dark.png | matches the final page |
| 33-journal-grid-wide | wide list with a search | 33-journal-grid-wide.png | fixed: same commit as 28 (the search hid the selected entry, the detail still showed it) |
| 34-journal-vat | MWST column | 34-journal-vat.png | matches |
| 35-vat-card | VAT code hover card | 35-vat-card.png | matches |
| 36-vat-histogram | VAT code distribution | 36-vat-histogram.png | matches the final page (codes are links) |
| 37-statements-by-month | statements by month | 37-statements-by-month.png | matches |
| 38-vat-code-doc | MWST-Codes, one code | 38-vat-code-doc.png | matches |
| 39-download-receipt | download button on the paper | 39-download-receipt.png | matches |
| 40-download-statement | statement download | 40-download-statement.png | matches |
| 41-vat-underline | code underline on hover | 41-vat-underline.png | matches |
| 42-vat-q3 | MWST of the open quarter | 42-vat-q3.png | matches |
| 43-vat-405 | one Ziffer with its entries | 43-vat-405.png | matches |
| 44-vat-q2-filed | a filed quarter with a difference | 44-vat-q2-filed.png | matches (plus the 0535 row: decision "The Korrekturabrechnung is the pseudo-Ziffer 0535") |
| 45-reports-er | Erfolgsrechnung and ledger | 45-reports-er.png | matches |
| 46-reports-bilanz | Bilanz | 46-reports-bilanz.png | matches |
| 47-reports-saldobilanz | Saldobilanz | 47-reports-saldobilanz.png | matches |
| 48-reports-all-accounts | all accounts | 48-reports-all-accounts.png | matches |
| 49-dock-bilanz-er | dock on Bilanz & ER | 49-dock-bilanz-er.png | matches the final dock |
| 50-reports-search | account search switching report | 50-reports-search.png | matches |
| 51-export-menu | the reports' old Export menu | 51-export-menu.png | on purpose: the final page replaced it with the export dialog and the ledger's Herunterladen menu (decisions on phase 6, "The download popover is the mockup's") |
| 52-export-dialog | export dialog | 52-export-dialog.png | matches |
| 52-export-dialog-dark | export dialog, dark | 52-export-dialog-dark.png | matches |
| 53-download-popover | ledger download menu (`D`) | 53-download-popover.png | matches |
| 54-abschluss-checks | Abschluss, checks | 54-abschluss-checks.png | matches (the reconciliation table under the checks: decision "The VAT reconciliation table sits under the checks") |
| 55-abschluss-gewinn | profit allocation | 55-abschluss-gewinn.png | on purpose: a real form with the resolution date (phase 7 log) |
| 56-firma | Firma › Firma | 56-firma.png | fixed: "Firma: the key legend names ↑↓ and ⌘K as in the mockup, not / …" |
| 57-firma-perioden | periods and seals | 57-firma-perioden.png | fixed: same commit as 56 |
| 58-export-period-picker | period picker inside the export dialog | 58-export-period-picker.png | fixed: same commit as 16 |
| 59-firma-banken | bank accounts | 59-firma-banken.png | fixed: same commit as 56 |
| 60-theme-system | Darstellung, theme System | 60-theme-system.png | fixed: same commit as 56 |
| 61-invoices-overdue | Rechnungen, overdue invoice | 61-invoices-overdue.png | fixed: "Rechnungen: the add button reads Rechnung like the other areas' nouns …"; on purpose: the view switch wraps under the counts (phase 9 log) |
| 62-invoices-paid | paid invoice | 62-invoices-paid.png | fixed: same commit as 61 |
| 63-invoices-customers | Kunden | 63-invoices-customers.png | fixed: "Rechnungen › Kunden: the add button says Neuer Kunde … replaces the second Neuer Kunde link …" and "Rechnungen › Kunden: the add button reads Kunde, as in the mockup" |
| 64-invoices-dark | Rechnungen, dark | 64-invoices-dark.png | matches |
| 65-invoice-qrbill | invoice with its QR-bill | 65-invoice-qrbill.png | matches |
| 66-invoice-with-address | invoice abroad, IBAN instead of QR-bill | 66-invoice-with-address.png | on purpose: decision "An account outside CH/LI … prints IBAN and RF reference instead of a QR-bill" |
| 67-invoice-a4 | A4 sheet, 1280 × 720 | 67-invoice-a4.png | matches |
| 68-invoice-page2 | a draft running onto page 2 | 68-invoice-page2.png | matches |
| 69-invoice-fr-draft | a French draft | 69-invoice-fr-draft.png | matches |
| 70-firma-rechnungslayout | Firma › Rechnungslayout | 70-firma-rechnungslayout.png | fixed: same commit as 56; on purpose: the sample sheet keeps the QR-bill's place (decision "the sample is the newest issued invoice laid out as a draft"); open: the demo's wide logo pushes "entfernen" to a second line |
| 71-new-invoice-customer | new invoice: choose the customer | 71-new-invoice-customer.png | matches |
| 72-draft-editor | a new draft for a customer abroad | 72-draft-editor.png | fixed: "Invoice sheet: a draft paid to an account outside CH and LI … keeps no place for a QR-bill …" |
| 73-credit-dialog | credit note dialog | 73-credit-dialog.png | on purpose: no "Bezahlt?" question (decision "The credit dialog asks no Bezahlt?") |
| 74-credit-draft | credit note draft | 74-credit-draft.png | matches |
| 75-credit-note | issued credit note | 75-credit-note.png | matches |
| 76-draft-wysiwyg | draft edited on the sheet | 76-draft-wysiwyg.png | on purpose: title, labels, sender and footer are not editable (decision "Editable on the sheet: …") |
| 77-draft-preview | draft preview (`V`) | 77-draft-preview.png | matches |
| 78-layout-editable | layout: logo place changed | 78-layout-editable.png | fixed: same commit as 56 |
| 79-qr-dark-hover | QR-bill in dark mode | 79-qr-dark-hover.png | matches (the sheet stays paper-white) |
| 80-cancel-dialog | cancel dialog | 80-cancel-dialog.png | matches |
| 81-cancelled-invoice | cancelled invoice | 81-cancelled-invoice.png | matches |
| 82-comments | comments | 82-comments.png | matches |
| 83-add-belege | add button on Belege | 83-add-belege.png | matches |
| 84-add-rechnung | add button on Rechnungen | 84-add-rechnung.png | fixed: same commit as 61 |
| 85-reminder-draft | reminder written on the sheet | 85-reminder-draft.png | matches |
| 86-sent-doc-viewer | a sent document as sent | 86-sent-doc-viewer.png | matches (shown as its PDF: decision "Sent documents open as their stored PDF") |
| 87-versand | Versand log | 87-versand.png | matches |
| 88-customer-form | customer form, Switzerland | 88-customer-form.png | fixed: "Rechnungen: the customer form's fields carry keys, so React no longer warns in the console …" |
| 89-invoice-new-customer | create customer and invoice | 89-invoice-new-customer.png | fixed: "Rechnungen: a new draft with a taxed line and no price yet says MWST 0.00, not MWST 0 % …" |
| 90-customer-form-intl | customer form, Netherlands | 90-customer-form-intl.png | fixed: same commit as 88 |
| 90-customer-form-us | customer form, United States | 90-customer-form-us.png | fixed: same commit as 88 |
| 91-invoice-us-address | draft with a US address | 91-invoice-us-address.png | matches |

Counts: 66 match, 6 differ on purpose only, 23 had something fixed in this pass (61 and 70 also
carry an on-purpose note, 70 an open one). No shot is open as a whole; two open items remain (see
"What is left").

## Checks beyond the shots

- **Back and forward across areas.** Belege → Buchungen → MWST with `G` keys, then back, back,
  forward: each step lands on the area and the row it left (`n1-back-forward.png`).
- **An old link.** `/de/2026-Q1/journal-entries?je=<id>` redirects to `/journal/<id>?period=2026-Q1`
  with that entry selected and the filed-quarter notice.
- **A link to something that does not exist (urls.md rule 5).** Receipt, invoice, customer, sent
  document, statement and payment show their list with "… gibt es nicht". A journal entry did not:
  it silently selected the first row. Fixed: "Buchungen: a link to an entry that does not exist
  keeps its place and the detail says so …". A VAT code says "unbekannt" in the detail. Open: an
  unknown Ziffer, Abschluss step or Firma section opens the first one without a notice (see below);
  an unknown account opens the first account by decision ("A link to a known account without an
  amount keeps it selected …").
- **Undo of a delete.** Deleting the demo's hand-booked entry without an origin and pressing ⌘Z put
  it back marked `manual`. Fixed: "Buchungen: undoing the delete of an entry without an origin puts
  it back without one …"; `$S diff` after delete and undo is empty.
- **Audit mode (READONLY=1).** All nine areas show the amber bar and no add button, no edit action,
  no editable field. Two leaks: Abschluss › Gewinn verwenden had editable date and amount fields, and
  Rechnungslayout offered "zurücksetzen". Fixed: "Audit mode: Abschluss › Gewinn verwenden shows its
  date and amounts read only …".
- **Static audit export.** `npm run build:audit` into a temporary folder served under a sub-path by
  `tests/support/static-server.ts`: every area opens, the audit bar carries the snapshot line,
  Rechnungen says it lives only in the app, no request leaves the sub-path. The test server served
  pdf.js's `.mjs` worker as `application/octet-stream`, so the browser refused it. Fixed: "Test
  static server serves .mjs as JavaScript …". Any real static server (nginx, `npx serve`) already
  sends `.mjs` as JavaScript.

## What is left

- **Open from this pass.** An unknown Ziffer (`/vat/777`), Abschluss step or Firma section opens the
  first one without the rule-5 notice. These ids come from fixed lists that nothing deletes, so a
  stale link is unlikely. Rechnungslayout's logo row wraps "entfernen" with a wide logo.
- **E-mail sending.** "Senden" downloads the PDF and records the send as `download`. Real e-mail
  needs mail settings (SMTP or a provider) per company. Recording an e-mail never sent would be
  false (decision "Senden downloads the issued PDF …").
- **Number finalization through git (ADR 0010 rule D).** Issuing an invoice writes its number and
  PDF but does not commit them, so two machines could still issue the same number before a sync.
- **Agent tools.** The command registry for CLI and MCP (ADR 0005) is not built; agents cannot yet
  create drafts or return links.
- **Year-end checklist.** The open-invoices row links to the list, not to each invoice. Closing a
  year was proven in tests only; the demo cannot close a year in the browser.
- **Reading statements again.** The demo's statement PDFs give no closing balance when read again
  (the generator's text); a real bank's PDF does.
- **Running extract from the server.** Dropped PDFs wait for `npm run extract`; the app does not
  start it (decision "Dropped PDFs show from GET /api/inbox …").
- **PDF printing needs a local Chromium.** The chrome-headless-shell download is not built; the app
  asks for an installed Chrome, Edge, Brave or Chromium.
- **The Treuhänder's review loop** from the mockup's "Next": questions on items, proposed
  corrections, review status per quarter.
