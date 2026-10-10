# Redesign: progress

The run of the redesign plan (private workspace `planning/implementation-plan.md`) on branch
`redesign`. This file is the run's memory: what is done, what is next, and every default chosen
with its reason. Architecture: [architecture.md](architecture.md).

Checks at every commit: `npx tsc --noEmit`, `npm test`, `npm run test:books`, `npm run check-public`.
Browser proof: `.claude/skills/verify/` sandbox on `demo`, evidence in `.verify/evidence/`.

## Phases

- [x] 0. Setup: branch, docs read, checks green, API inventory, architecture, this file.
- [ ] 1. Shell: tokens, fonts, theme, zoom, dock, top bar, list/detail with divider, keys, ⌘K, toast with undo, URL sync, add button with N.
- [ ] 2. Belege.
- [ ] 3. Kontoauszüge.
- [ ] 4. Buchungen and MWST-Codes.
- [ ] 5. MWST and Bilanz & ER.
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

## API inventory against the mockup

Reads: the UI loads `/books.json`, `/api/accounts`, `/api/config`, `/api/vat/filed`,
`/api/fx-rates`, `/api/workspace`, `/api/status`, `/api/year-close/:year`. Writes that exist:
receipts (patch, delete, upload, vision extract, suggest date, rename), transactions (manual,
patch, delete), mappings (add, remove, approve duplicate), journal entries (patch, delete,
classify), year close (revaluation, templates, entries, close, open).

Missing for the mockup, to add in their phase:

- Belege: mark a receipt "kein Beleg nötig" / private outlay kinds (check `ReceiptPatch`), undo of a
  link (remove exists).
- Kontoauszüge: statement import (camt.053 and PDF upload) from the UI; today it is a CLI step.
- Buchungen: new manual entry (route exists only through year-close entries).
- Export: the export bundle (CSV, XLSX, JSON, PDF, ZIP with LIESMICH and SHA-256 sums).
- Firma: write company profile, banks, periods, display and invoice layout to `belege.workspace.yaml`.
- Rechnungen: everything (phase 8).

## Log

- 2026-10-11 phase 0: branch `redesign` from `main` (c73209e). Baseline: tsc ok, `npm test` 295/296
  (update test, fixed), `test:books` 15/15, check-public 0 findings.
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
