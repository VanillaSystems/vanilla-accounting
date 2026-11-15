# Spec: invoicing for the personas

Status: decided (2026-11-14), on `0.4.2`; amended 2026-11-15. The owner accepted all twelve
recommendations of the draft of 2026-11-13, and on 2026-11-15 the patterns of a market review and
the rule «warn, then the person decides»; section 7 records both. Values that change over time
(4.12) were added the same day. Asked: «can we on the start speccing out the
invoicing for the personas in question? I want a fully fledged invoicing tool». A clickable
prototype of phases 1 to 3 is in [mockups/invoicing/](mockups/invoicing/index.html).

This spec builds on [ADR 0010](../adr/0010-invoicing.md) (invoicing in the same app, paid
invoices matched by their reference) and [ADR 0012](../adr/0012-invoice-pdfs.md) (PDFs). It
follows [MISSION.md](../../MISSION.md) for who does the work and
[ADR 0015](../adr/0015-base-cases-in-the-app-long-tail-in-the-workspace.md) for what is in the app
and what is in the workspace. Sections 1 to 3 report what exists and what applies. Sections 4 to 6
set out the work. Section 7 records what the owner decided.

---

## 1. What exists today

Invoicing is not a stub. Drafts, issuing, the QR-bill, e-mail, reminders, credit notes,
cancellations, payment matching and the agreed-basis events all work end to end, and 16 test
files cover them. What is missing is the work before and around the invoice: quotes,
partial invoices, recurring invoices, an article list, time and expenses, write-offs, the dunning
run, eBill, and a list of open items.

### 1.1 Inventory

| Capability | Where | State |
|---|---|---|
| Data: customers, invoices (drafts and issued), credit notes, reminders, sent documents, comments, each with the ADR 0004 envelope | `src/invoices/model.ts`, `invoices.json` (owner: `src/invoices/store.ts`; ladder `INVOICES_SCHEMA = 2` in `src/workspace/schema.ts:72`) | done |
| Settings: `payTo` per currency (ledger account, IBAN, optional QR-IBAN), revenue account, fee account, payment term, layout, texts per language | `InvoicingSettings` in `model.ts:239`, parsed in `src/workspace/manifest.ts:152-163` (`belege.workspace.yaml` `invoicing:`) | done |
| Outgoing mail through the firm's own mailbox (SMTP, password in the secret store) | `src/invoices/mail.ts`, `OutgoingMail` in `model.ts:262`, Firma › E-Mail-Versand (`src/app/areas/company/MailSection.tsx`) | done |
| Customers: name, attn, structured address in any country, language, VAT number (CHE UIDs checked by check digit), e-mail, payment term | `CustomerFields` `model.ts:48`, `parseCustomer` `service.ts`, address forms per country `src/app/areas/invoices/address.ts` | done; no customer number, no contact people, no default currency or default revenue account, no import |
| Lines: text, quantity, unit, price, VAT rate, «VAT included» flag, revenue account per line | `InvoiceLine` `model.ts:61`, totals per rate to the Rappen `rules.ts totals` | done; units are only `h, day, pcs, flat, km` (`model.ts:18`); no title or subtotal lines, no per-line discount, no article list |
| Currencies | `INVOICE_CURRENCIES = ['CHF', 'EUR']` `model.ts:12` | CHF and EUR only (the QR-bill's two); a USD or GBP client cannot be invoiced |
| Languages of the document | `de, fr, it, en` `model.ts:8`, texts `src/invoices/texts.ts` | done |
| Check before issue: what MWSTG Art. 26 asks, plus an account to pay to | `missingForIssue` `rules.ts`; the UI names each gap and links to where it is fixed (`tests/invoices-fixes.test.ts`) | done |
| Issue: number `YYYY-NNN` (next of the invoice year, cancelled ones count, shared by invoices and credit notes), due date, payment reference, frozen copy of customer, sender and layout, PDF printed once with SHA-256 | `issue`, `nextNumber` `rules.ts`; `issueInvoice` `service.ts` (one printing change at a time per process, `serial`) | done; the number format is fixed; ADR 0010's «issuing pulls main and pushes» is not built (only one process is safe) |
| QR-bill: QRR with a QR-IBAN, SCOR otherwise; payment part and receipt on the last sheet or on a sheet of its own; only for a CH or LI IBAN | `src/providers/qr-bill/reference.ts`, `sheet.ts payment / hasQrBill`, library `swissqrbill` ^4.4.2 | done; see finding F1 |
| PDF and sheet: A4, C5 window left or right, logo, accent colour, two fonts, elements on or off, pagination with a repeated table header | `src/invoices/sheet.ts`, `pdf.ts` (puppeteer-core, or the desktop app's own Chromium), Firma › Rechnungslayout (`src/app/areas/company/InvoiceLayout.tsx`) | done |
| Draft edited on the A4 sheet itself | `src/app/areas/invoices/Sheet.tsx`, `edit.ts` | done |
| Sending: by e-mail (the PDF byte for byte), or as a download to send another way; every sent document kept with checksum, time, recipient and Message-ID | `recordSend`, `printOwnDocument` `service.ts`; `SentDocument` `model.ts:176` | done |
| Reminders: levels 1 to 3, due in 10 days, optional fee (no VAT), texts editable on the sheet before sending, in the invoice's language | `reminderDraft` `rules.ts`, `sendReminder` `service.ts` | done, by hand only; no dunning run over all overdue invoices, no default interest (Verzugszins), no per-customer stop |
| Credit notes: whole invoice or an amount (gross, split over the rates or at one rate), refund or set off against the next invoice; never more than the invoice | `creditNoteDraft`, `refundDue` `rules.ts` | done; «set off» is a flag only: nothing deducts it from the next invoice |
| Cancellation (Storno) with date and reason, optional notice to the customer; refused on a paid invoice | `cancel` `rules.ts`, `cancelInvoice` `service.ts` | done |
| Internal comments | `addComment` `service.ts` | done |
| Payment matching on import: by QR or SCOR reference, else by the number in the text when the amount is what is open; a credit note's refund by its number; anything less sure is proposed; «Lösen» undoes a link | `src/invoices/payments.ts` (`matchPayments`, `paymentProposals`, `confirmPayment`, `releasePayment`) | done |
| Booking on the cash basis: a payment books revenue from the invoice's lines and codes (V81, V0-E for `abroad`, V0 for `export`, F1 on the net tax rate method, none when not registered), the invoice PDF as its receipt | `bookPayment`, `revenueSplit`, `revenueVatCode` `rules.ts` | done |
| Booking on the agreed basis: issue books `RE-<number>` (1100 / revenue with the sale codes), a credit note `GS-<number>`, a cancellation `RE-<number>-storno`; payments settle 1100 and book the exchange difference on 6960; a payment before the invoice date is a prepayment taxed on its own day (MWSTG Art. 40 Abs. 1 lit. c) | `src/invoices/events.ts`, `src/books/refs.ts`, `src/accounting/tax-point.ts` | done |
| Foreign currency: the ESTV daily sell rate of the tax point (payment day on the cash basis, invoice day on the agreed basis) | `ctx.fx.daily` in `events.ts` and `payments.ts`, `src/accounting/fx-rates.ts` | done |
| Firm not registered: the only rate is 0, no exemption asked, no «MWST» after the UID, no VAT column | `chargesVat`, `invoiceRates` `src/engines/index.ts:71-83`, `tests/firms-invoices.test.ts` | done |
| Net tax rate method: invoices show the statutory rates, revenue booked with F1 | `revenueVatCode` `rules.ts`, `tests/firms-invoices.test.ts:61` | partly; see finding F3 |
| Year end: invoices open on 31.12. proposed as receivables (1100) | `openOn` `rules.ts`, [year-end.md](../year-end.md) line 104 | done; no open-items list (Debitorenliste) of its own |
| AI: drafts an invoice (also for a new customer) and changes the invoicing settings from the sidebar | `invoiceDraft`, `invoicing` changes in `src/assistant/changes.ts`, prompt in `src/assistant/claude.ts:122-148` | done; the AI cannot issue, send or remind (by design: a person issues) |
| The firm's own invoices made in another tool, dropped as PDFs: read as sales documents and paired with the money in that names them | CHANGELOG #365, #382; `src/accounting/sale-document.ts` | done; they never become records in `invoices.json`, so they are not in the open-items list or the dunning |
| UI: Rechnungen with list (overdue first), customers and sent log; detail with the A4 sheet, state, actions and margin; dialogs for new invoice, customer, send, cancel, credit | `src/app/areas/invoices/*`, routes `/invoices`, `/invoices/<number>`, `/invoices/draft-<id>` (docs/urls.md lines 48-50) | done |
| API | `src/server/routes/invoices.ts` (24 routes: customers, drafts, issue, send, cancel, credit-note, reminders, comments, payments, PDFs) | done |
| Demos | `demo/` only (`tools/demo/invoices.ts`: 4 customers, 9 invoices incl. a credit note, a draft and one in EUR); golden `tests/golden/demo/books.json` holds 4 entries of origin `invoice` | `demo-consulting/`, `demo-coiffeur/`, `demo-schreinerei/` have no `invoicing:` section and no invoices |
| Tests | `tests/invoices.test.ts`, `invoice-payments.test.ts`, `invoices-fixes.test.ts`, `firms-invoices.test.ts`, `invoices-api.test.ts`, `invoices-area.test.ts`, `invoice-pdf.test.ts`, `invoice-mail.test.ts`, `invoice-sheet-edit.test.ts`, `invoices-manifest.test.ts`, `reconcile-invoices.test.ts`, `payments-invoice-intake.test.ts`, `customs-invoice.test.ts`, `e2e-invoices.test.ts`, `e2e-invoice-sheet-typing.test.ts`, `invoice-print-failed.test.ts` | broad |

### 1.2 Findings to fix regardless of new features

- **F1 QR-bill v2.4: QR-IBAN and QR reference are for CHF only.** SIX Implementation Guidelines
  for the QR-bill, version 2.4 of 24.02.2026, introduced with the SIC release of 13 November 2026,
  say: «For invoicing in euros (EUR), only the combination IBAN/SCOR reference and
  IBAN/unstructured message is possible». The change log names chapters 2.8, 2.10, 2.12, 4.2.2 and
  4.3.2. Version 2.3 remains valid until November 2027. Today `manifest.ts:161` accepts a `qrIban`
  under `payTo.EUR` without a word, and `referenceFor` (`reference.ts`) then gives a QRR reference
  to a EUR invoice. Fix: a `qrIban` under any currency but CHF brings a warning (4.11): what is
  off, the rule (v2.4, chapters above; v2.3 valid until November 2027) and what follows (banks
  accept such a EUR QR-bill until November 2027, then refuse it). The person keeps it with
  «Trotzdem speichern»; without it, a EUR invoice uses the plain IBAN and SCOR. An issued invoice
  keeps what it printed. Also check that `swissqrbill` ^4.4.2 writes only
  structured addresses (type S). Combined addresses were removed in v2.3 (chapter 4.2.2).
- **F2 Citation.** The code says the supply date is Art. 26 Abs. 2 lit. d MWSTG
  (`model.ts:89`). The law has it under lit. c; lit. d is «Art, Gegenstand und Umfang der
  Leistung». This is a comment fix.
- **F3 Two net tax rates.** `revenueVatCode` falls back to `netRateCode(1)` for every rate
  (`rules.ts`). A firm approved for two net rates (say Schreinerei 4.5 % and Handel 1.3 %) books
  every invoice line on F1. The line needs the activity it belongs to. This needs a line field
  (see 4.3).
- **F4 Paid less, forever open.** A customer who takes 2 % Skonto, or whose foreign bank keeps a
  fee, leaves the rest open with no way to close it. Bad debts cannot be written off either.
  On the agreed basis this leaves the VAT on the unpaid part declared and never corrected
  (MWSTG Art. 41 Abs. 1).
- **F5 «Set off against the next invoice»** (`settlement: 'offset'`) is printed on the credit
  note, but nothing carries it to the next invoice.

---

## 2. The personas and what they need

The verify personas are in `.claude/skills/verify/personas/`: `first-run.md` (painter, Malerei
Huber GmbH), `invoices.md` (the painter's office writes invoices), `first-run-consulting.md`,
`first-run-webshop.md`, `other-firms.md` (coiffeur, webshop, IT consultant, Schreinerei),
`treuhaender.md`. There is no persona file of its own for the coiffeur or the Schreinerei; they
exist as `other-firms.md` bullets and as demos (`demo-coiffeur/`, `demo-schreinerei/`).

| Persona | Firm (VAT setup) | Invoices a year | What they write | Must have | Nice to have |
|---|---|---|---|---|---|
| **Painter** (Sandra for Malerei Huber) | GmbH, effective, cash basis, quarterly | 80–200 | Offerte → (Auftragsbestätigung) → for big jobs Akonto invoices → Schlussrechnung less the Akonto amounts; Regie by hours plus material; m² and running metres; discount; Skonto | quote and conversion; m², m, l, kg units; title and subtotal lines; Akonto and final invoice with deductions; discount line; Skonto and write-off of the rest; dunning with fee | retention (Rückbehalt, construction clients after SIA 118: a private norm, not checked here) as a second due date; materials from the receipts of the job; a Rapport PDF attached |
| **Consultant** (Matthias, Kälin Advisory GmbH) | GmbH, effective, cash basis | 30–80 | monthly invoices by hours per client; a monthly retainer; one client in Berlin in EUR (service abroad, Ziffer 221); expenses re-billed (train, hotel) | recurring invoices (drafted by code each month); hours from a table or CSV; EUR invoice to the EU with the customer's VAT number and the place-of-supply note (exists); re-billed costs as lines from receipts; write-off of a foreign bank's fee | USD invoices; a time-tracker export read by a workspace source |
| **Webshop** (`demo/`, a coffee roaster as GmbH) | effective, cash basis | shop sales come from the provider (`provider:`, not this area); 20–60 B2B invoices | wholesale to cafés: coffee at 2.6 % and accessories at 8.1 % on one invoice; returns as credit notes; a German shop in EUR (export, Ziffer 220) | article list with rate and price; delivery note (Lieferschein); mixed rates (exists); credit note for a return (exists) | order confirmation; customer price lists |
| **Coiffeur** (`demo-coiffeur/`, Einzelfirma) | not registered | a few | an invoice for a company event or a wedding; gift vouchers | invoice without VAT (exists); a simple receipt (Quittung) as a PDF for a cash or TWINT payment | voucher sale and redemption (not a VAT question while not registered) |
| **Schreinerei** (`demo-schreinerei/`, GmbH) | net tax rate 4.5 %, half-yearly, cash basis | 40–100 | Offerte, Akonto for kitchens and cabinets, final invoice; often «inkl. MWST» prices | quote; Akonto and final invoice; statutory rate on the invoice and F1/F2 per activity (F3); «VAT included» lines (exists) | retention |
| **Treuhänderin** (Monika, 40 firms, no AI) | any | issues for clients in full service | the same documents by hand, fast; an opening list of open invoices from the old tool | everything without the AI (exists for today's scope); import of customers and open invoices at the switch; open-items list per customer with age; invoice journal (Fakturajournal) export | bulk reminder run with one confirmation |

What the personas share: a document the customer can pay with one scan (the QR-bill), the money
found without a click, VAT right on the paper and in the books, and the paper kept as sent. The
app does all of this today. The gaps are the work before the invoice (quotes, hours, articles)
and after it (Skonto, write-off, dunning, open items).

---

## 3. Swiss requirements, checked against the sources

| Topic | Rule | Source | App today |
|---|---|---|---|
| Invoice content | The invoice identifies supplier, recipient and supply, and as a rule contains: (a) name and place of the supplier as it appears in business, that it is registered, and its number; (b) name and place of the recipient; (c) date or period of the supply if it differs from the invoice date; (d) kind, object and extent of the supply; (e) the consideration; (f) the rate and the tax owed; if the price includes the tax, the rate is enough. | MWSTG Art. 26 Abs. 2 | checked by `missingForIssue` |
| Till receipts | Receipts from automated tills need no recipient if the amount is below the threshold the Federal Council sets. The threshold is CHF 400. Such a receipt gives no refund in the refund procedure. | MWSTG Art. 26 Abs. 3; MWSTV Art. 57 | not built and not planned: the Quittung (decision 7.11) is an invoice paid at issue and names its recipient |
| VAT shown wrongly | Someone not in the register may not mention the tax on an invoice. A tax shown without right, or too high, is owed unless the invoice is corrected. | MWSTG Art. 27 Abs. 1, 2 | not-registered firms print no VAT (exists) |
| Net tax rate | The tax is the gross taxable turnover times the approved net rate. Invoices to customers show the statutory rates (8.1, 2.6, 3.8 %), never the net rate. Showing the net rate costs the difference. | MWSTG Art. 37 Abs. 2; ESTV MWST-Info 12 «Saldosteuersätze», Ziff. 1.2 (as quoted by ESTV pages; the current issue was not opened here) | statutory rates printed (exists) |
| When the tax arises | Agreed basis: with the invoice; with each partial invoice or partial payment for supplies that run in parts; on receipt for prepayments and for supplies without an invoice. Cash basis: on receipt. | MWSTG Art. 40 Abs. 1 lit. a–c, Abs. 2 | events and prepayment (exist) |
| Later changes of the consideration | When the agreed or paid consideration is corrected (discount, Skonto, a loss), the tax is adjusted when the correction is booked or the corrected amount received. | MWSTG Art. 41 Abs. 1 | missing (F4) |
| Damages and fees | Damages and similar payments are not consideration. A reminder fee or default interest carries no VAT. | MWSTG Art. 18 Abs. 2 lit. i | fee without VAT (exists); no interest |
| Re-billed costs | The consideration includes reimbursed costs even when billed separately. Re-billed expenses carry the rate of the supply. | MWSTG Art. 24 Abs. 1 | possible as a line; no help |
| Foreign currency | Convert at the time the tax arises. The invoice's currency decides. Use the ESTV's published monthly mean or daily sell rate, the choice held for at least one tax period. | MWSTV Art. 45 Abs. 1–3, 5 | daily sell rate of the tax point (ADR 0001, exists) |
| Switch of basis | On a switch from cash to agreed, the tax on the receivables open at the switch is declared in the next period, and the reverse on a switch back. | MWSTV Art. 106 | handled by `lockedTaxPoint` and `eventPlan` (exists) |
| Supplies abroad | Service with place of supply abroad (Art. 8) or export of goods (Art. 23): no Swiss VAT, with the reason on the invoice. The customer abroad accounts for its own VAT (EU reverse charge is the customer's law, not Swiss). | MWSTG Art. 8, 23 | `exemption: abroad | export` with the printed note (exists) |
| Retention | Books and records kept 10 years from the end of the business year, on paper or electronically if they stay faithful to the events and readable at any time. VAT records until the absolute limitation, 10 years after the tax period. Records on the own use and the input tax correction of real estate: 20 years. | OR Art. 958f Abs. 1, 3 (SR 220); MWSTG Art. 70 Abs. 2, 3; Art. 42 Abs. 6 | issued PDFs stored once with SHA-256, never printed again (exists) |
| Storage medium | Changeable media are allowed when the integrity is guaranteed (for example a digital signature) and the time of storage is provable (for example a time stamp). | GeBüV Art. 9 Abs. 1 lit. b (SR 221.431) | SHA-256 per PDF, git history; no time stamp, judged enough (decision 7.9) |
| Default and dunning | A debt that is due falls into default through a reminder. If a payment day was agreed, default starts when that day passes. The default interest is 5 % a year unless more was agreed. Swiss law sets no number of reminders and no fee. A fee must be agreed (for example in the terms) to be claimed. | OR Art. 102 Abs. 1, 2; Art. 104 Abs. 1 | 3 levels, optional fee; no interest |
| QR-bill | Standard for written invoices in CH and LI. QR-IBAN goes only with a QR reference (QRR); IBAN goes with SCOR or no reference. Since v2.3 (21.11.2025), structured addresses only. Since v2.4, QR-IBAN and QRR are for CHF only, and EUR uses IBAN with SCOR or a message. «Billing information» (Swico S1 syntax, now owned by SIX, Annex D) can carry invoice number, date, UID and VAT rates for the payer's software. | SIX IG QR-bill v2.4 (24.02.2026): general notes, change log, ch. 4.2.2, 4.3.3, Annex D | QRR/SCOR (exists); F1; no billing information |
| eBill | Invoices delivered into the payer's e-banking. A biller joins through a network partner (a bank or a provider), not directly. | ebill.ch (SIX) | none |

**Retention in the app:** an issued invoice's PDF is the receipt of its booking
(`invoiceReceipt` in `events.ts`). The 10 years run from the end of the business year in which
the books were kept, so they hold for `invoices/<year>/` and the books' `receipts/` the same way.
Deleting an issued invoice is not possible today and stays impossible.

---

## 4. The spec

### 4.1 Goals

1. Every persona in section 2 writes every document of their normal year in the app, without
   help, and the document is correct under section 3.
2. Each document is booked the way its basis and VAT setup require (4.5), by code, with no
   question to the person except what only she knows.
3. Work before the invoice comes in by itself where code can do it: hours from a table, re-billed
   costs from the receipts, a monthly retainer drafted on its day.
4. Work after the invoice is visible as a fact: what is open, since when, what was reminded. A
   dunning run is one click and one confirmation.
5. Everything the AI does in this area, a person can do by hand (MISSION.md). This includes the
   Treuhänderin without a subscription.

### 4.2 Non-goals

- **Time tracking.** No timer and no timesheet. Hours come in as a table or a CSV (a workspace
  source reads a tracker's export, ADR 0015), or are typed as lines.
- **Stock and inventory.** The article list has a price and a rate, not a stock level.
- **A point-of-sale system** for the coiffeur or a shop. Shop sales come from the provider's
  report (`provider:`, AGENTS.md). Till receipts are not built.
- **Project accounting** beyond the existing reporting dimensions (`dimensions` in
  `belege.workspace.yaml`, #127). A document may carry tags; there are no project budgets.
- **Payroll, purchase orders, supplier invoices** (other areas).
- **A direct connector to one bank or eBill provider in the app** (ADR 0015). The app ships the
  channel and the contract (4.7).
- **Accrual (agreed) bookkeeping as a default.** The basis stays the firm's setting (`company.vat`).

### 4.3 Data model additions

Everything below lives in `invoices.json` (its own ladder, `INVOICES_MIGRATIONS`) or in the
`invoicing:` section of `belege.workspace.yaml` (manifest ladder). The books' own format
(`ledger.json` `schema`) changes only where marked **books**. Each row marked **step** needs a
version and a ladder step in `src/workspace/schema.ts`: one `invoices.json` step per phase
(decision 7.1).

| Addition | Where | Step |
|---|---|---|
| `kind` gains `quote`, `order` and `delivery-note` (beside `invoice`, `credit-note`): one record shape and one editor for every kind (4.4). A quote has its own number series (`OF-YYYY-NNN`), `validUntil`, and `status` `draft` → `sent` → `accepted` / `declined` / `expired`. An order confirmation has its own series (`AB-YYYY-NNN`), prices and no booking. A delivery note has its own series (`LS-…`), no prices on paper, no reference and no booking. | `invoices.json` | **step** (INVOICES 2→3) |
| `from?: { id, kind }` on any document: the document it was made from by «Folgedokument erstellen». The chain shown on each document is derived from `from` (and `creditFor`), never stored twice. `ordered?: string` (the customer's order reference, printed) | `invoices.json` | **step** (same) |
| `InvoiceLine.optional?: true` on a quote or an order confirmation: priced and printed, marked «Option», never in a total, a VAT figure or a QR amount. An invoice or credit note has no optional line: a follow-up turns a picked option into an ordinary line and leaves the others out | `invoices.json` | **step** (same) |
| `role?: 'partial' | 'final'` on an invoice (Akonto / Schlussrechnung). A final invoice's deduction lines carry `deducts: <invoice id>` and a negative price at the deducted invoice's rate, so totals, QR amount and booking work as they do today | `invoices.json` `InvoiceLine.deducts` | **step** (same) |
| `schedule?: Array<{ amount, dueDate, label }>` on an issued invoice: the retention or instalments. The QR-bill asks for what is due first. A later instalment is sent as a payment notice (a sent document of kind `instalment`) with its own QR-bill and the same reference | `invoices.json`; `SENT_KINDS` gains `instalment` | **step** (same) |
| `writeOffs: Array<{ date, amount, reason: 'skonto' | 'discount' | 'loss' | 'fee' | 'rounding', note? }>` on an issued invoice. `openAmount` subtracts it | `invoices.json` | **step** (same) |
| `offsets: Array<{ creditNoteId, amount }>` on an invoice: a credit note set off against it (F5), as a deduction line on the invoice (decision 7.6) | `invoices.json` | **step** (same) |
| `InvoiceLine` gains `kind?: 'item' | 'title' | 'subtotal' | 'text'` (a title or text line has no amount), `discount?: number` (percent, per line), `articleId?`, `activity?: 1 | 2` (net tax rate method: which approved rate, F3), `tags?` (dimensions), `source?: { receiptId } | { hours: rowId }` (where the line came from) | `invoices.json` | **step** (same) |
| `UNITS` widens to `h, day, pcs, flat, km, m2, m, m3, l, kg, month` | `model.ts:18` | **step** (same; an old reader refuses a new unit) |
| `INVOICE_CURRENCIES` widens to any ISO 4217 code the ESTV publishes a rate for. The QR-bill only for CHF and EUR; other currencies print bank details only | `model.ts:12`; `payTo` may map more currencies | **step** for `invoices.json`, **step** for the manifest |
| `Customer` gains `number?` (Kundennummer), `currency?`, `revenueAccount?`, `contacts?: Array<{ name, email, role? }>`, `noReminders?: true`, `discount?` | `invoices.json` | **step** (same) |
| `articles: Array<Envelope & { number?, text, unit, price, vatRate, vatIncluded?, account?, activity? }>` | `invoices.json` (top level, beside `customers`) | **step** (same) |
| `recurring: Array<Envelope & { customerId, template: InvoiceContent, every: 'month' | 'quarter' | 'year', next: date, until?, issue: 'draft' | 'issue' | 'send' }>` | `invoices.json` | **step** (same) |
| Settings: `numbering: { invoice: 'YYYY-NNN', quote: 'OF-YYYY-NNN', … }` (a pattern with `YYYY` and `N…`, digits enough for QRR's 26), `quoteValidDays`, `skonto?: { percent, days }` (printed in the terms and applied on payment), `dunning: { levels: [{ afterDays, fee? }], interest?: 5 }`, `writeOffAccount: { skonto: '3800', loss: '3805' }` | `belege.workspace.yaml` `invoicing:` | **step** (manifest) |
| A new booking ref on the agreed basis: `RE-<number>-wo-<n>` for a write-off. Same entry shape as today; a new ref pattern that `refs.ts` must name. A set-off needs no ref of its own: the deduction line is on the invoice (decision 7.6) | books (journal entries) | no `schema` step: no shape change (decision 7.2). Named in `src/books/refs.ts` and in the CHANGELOG |
| `paidAtIssue?: { means: 'cash' | 'twint' | 'card' | 'bank', account }` on an invoice: the Quittung (decision 7.11), printed with the title «Quittung» and no QR-bill | `invoices.json` | **step** (phase 3) |
| Dated histories (4.12): a customer's address, terms, discount and revenue account; the firm's name and address, `payTo` per currency, payment term, Skonto, dunning levels and fees, interest and accounts | `invoices.json` (customers), `belege.workspace.yaml` | **step** in phase 1, one for each file: a single value becomes `[{ validFrom: <first day of the books>, value }]` |
| An article's `price` as a dated history from its start (phase 3, 4.12) | `invoices.json` | **step** (phase 3, new field) |
| `Issued.terms`: the due date's basis, Skonto and dunning terms as printed (4.12; customer, sender and layout are kept already) | `invoices.json` | **step** (phase 1) |

Nothing here changes a filed figure. Write-offs and set-offs are new events dated in the open
period (golden rule 1).

### 4.4 Flows

```
quote ──Folgedokument──► order confirmation ──Folgedokument──► delivery note
   │                           │                                    │
   └──convert (options?)───────┴────────────Folgedokument──────────┴──► invoice draft ──issue──► invoice ──send──► customer
                          (whole, or partial: Akonto 1..n, then final with deductions)
                                                     │
              recurring template ──on its day──► draft (or issued and sent, if the person chose so)
                                                     │
                     overdue (a fact in the list) ──dunning run──► reminder 1..3 (+ fee, + interest)
                                                     │
          camt.053 import ──reference / number──► payment allocated ──► booked (4.5)
                                                     │
                 rest open ──person──► write-off (Skonto, loss, fee) │ credit note │ cancellation
```

- **One editor for every kind.** Quote, order confirmation, delivery note, invoice and credit note
  are the same record and the same A4 editor (today's `Sheet.tsx`): lines, title and subtotal
  lines, preview, issue, send. The kind decides the title, the number series, what the paper shows
  (a delivery note has no prices) and whether anything is booked (only invoices and credit notes).
- **Folgedokument erstellen.** On any issued document, one click makes the next document of the
  chain as a draft, every line copied with text, quantity, unit, price, rate and tags, and `from`
  set. From a quote: order confirmation, delivery note or invoice. From an order confirmation:
  delivery note or invoice. From a delivery note: invoice. From an invoice: delivery note or credit
  note (all lines with a minus; the person deletes what is not credited). A quote that gets an
  order confirmation or an invoice is `accepted` by that fact. Each document shows its chain
  (OF-2026-002 → AB-2026-001 → LS-2026-001 → 2026-006), each step a link.
- **Quote → invoice.** «In Rechnung umwandeln» is the follow-up «invoice» of a quote. A quote can
  become several partial invoices. The quote shows what is invoiced of it.
- **Optional lines.** A line of a quote or order confirmation can be marked optional: it is priced
  and printed with «Option» and its amount in brackets, and the sheet names the sum of the options
  below the total; it is never in the total, the VAT or the QR amount. On «In Rechnung umwandeln»
  (and any follow-up) the person picks which options come along: the picked ones become ordinary
  lines, the others stay on the quote.
- **Facts stay by code.** A document is «gesendet» because the sent log holds it (time,
  recipient, Message-ID or download, checksum), and «bezahlt» or «offen» because the bank statement
  was matched (ADR 0010). There is no click «als versendet markieren» or «als bezahlt markieren»,
  where a tool without its own mailbox and bank matching needs one. Only what the customer alone
  knows is a click: a quote «angenommen» or «abgelehnt» (or a follow-up says it). Money the app
  never saw (cash in hand) is booked by hand as a payment, which is then a fact like any other.
- **Partial and final invoice.** A partial invoice is an ordinary invoice with `role: 'partial'`.
  The final invoice lists the whole work. «Akontos abziehen» adds one deduction line per partial
  invoice that is issued and not cancelled, at its rates, gross or net as the partial invoice was.
  A partial invoice still unpaid stays open on its own. The final invoice deducts what was
  invoiced, not what was paid. This keeps the VAT of each document its own (MWSTG Art. 40 Abs. 1
  lit. b).
- **Retention.** At issue the person enters «Rückbehalt 5 % bis 30.06.2027». The QR-bill asks for
  the total less the retention. The retention is due on its date. On that day the list shows it
  as a fact («Rückbehalt fällig seit …»), and «Zahlungsaufforderung» sends the instalment notice.
- **Recurring.** Code drafts each due template on the next start of the app or run after its
  day. With `issue: 'issue'` or `'send'` it also issues (and sends), which the person chose once
  on the template. Only the device that holds the books issues; a clone without that role only
  drafts (decision 7.4). A failure (mail refused, something missing for Art. 26) becomes a task
  with words (ADR 0015 base errors).
- **Dunning run.** «Mahnlauf» lists every overdue invoice with its next level, fee and interest
  by the settings, leaves out customers marked `noReminders` and invoices with a comment from the
  last 7 days, and sends or downloads all of them after one confirmation. The list shows overdue
  invoices as a fact («fällig seit 12 Tagen»), never as a nudge to the person (memory: no nagging
  reminders). Default interest is off for a new firm (decision 7.10). When the person switches it
  on in the settings, it is calculated from the due date at the rate set (OR Art. 104 Abs. 1:
  5 %) and printed as a line without VAT.
- **Payment.** Unchanged (ADR 0010), plus: a payment that is less than open by the Skonto the
  terms offered, paid within the Skonto days, is allocated and the rest written off as `skonto`
  by code. Any other shortfall below a limit in the settings (default CHF 5, the limit named
  when hit) is proposed as a write-off `fee`. Anything larger stays open and asks the person.
- **Write-off.** «Rest ausbuchen» on an invoice with something open: reason, date, amount.
- **Set-off** (decision 7.6). The next draft for a customer with a credit note
  `settlement: 'offset'` still to set off gets a deduction line «Gutschrift … verrechnet» (the
  person may remove it). Issuing records the offset on both documents.
- **Re-billed costs.** On a draft, «Spesen weiterverrechnen» lists the customer's receipts
  (tagged with the customer or a project dimension, or picked by hand) not yet re-billed. Each one
  becomes a line at its net amount and at the supply's rate (MWSTG Art. 24 Abs. 1), with
  `source.receiptId`, so it is never re-billed twice.
- **Quittung** (decision 7.11). For a sale paid on the spot (the coiffeur's cash or TWINT
  customer), «Bezahlt bei Ausstellung» on a draft names the means (cash, TWINT, card, bank).
  Issuing then prints the document under the title «Quittung» with «bezahlt am … in bar» instead
  of a QR-bill, and records the payment on the issue day. It is an invoice like any other: its
  number is the next of the invoice series, and the Art. 26 check applies.
- **Hours.** «Stunden übernehmen» takes a table (pasted, or a CSV the workspace source produced)
  of date, text, hours and rate, and makes lines grouped by text or one per row, as the person
  picks.

### 4.5 How each event is booked

Cash basis = `company.vat.reporting: received`. Agreed = `agreed`. The codes are those of
`modules/ch/tax-codes.yaml`. «Net rate» means `method: net-rate`, «none» means not registered.

| Event | Cash basis | Agreed basis |
|---|---|---|
| Quote, order confirmation, delivery note | nothing | nothing |
| Optional line of a quote or order confirmation | nothing (never in a total) | nothing |
| Invoice issued (also partial or final) | nothing (open item in `invoices.json`) | `RE-<n>`: 1100 / revenue, the sale codes per rate (V81, V26, V38; V0-E / V0 abroad or export; F1 or F2 by `activity` on the net rate; no code when not registered), its date. Exists, plus `activity` |
| Final invoice with deductions | its payment books the revenue split of its own lines, deductions included (the remainder) | `RE-<n>` for its total, which is already the remainder |
| Payment | bank / revenue with the codes, split like the invoice (exists) | bank / 1100, exchange difference on 6960 (exists) |
| Prepayment before the invoice | as a payment | taxed on its day, the event rebooked for the rest (exists, `prepaidEvent`) |
| Credit note, cancellation | as today (refund with minus codes; storno not booked) | `GS-<n>`, `RE-<n>-storno` (exists) |
| Quittung (paid at issue, decision 7.11) | on the issue day: the means' account (1000 Kasse for cash; for TWINT or a card, the account the settings name for it) / revenue with the sale codes, split like any invoice | `RE-<n>` as for any invoice, and on the same day the means' account / 1100 |
| Write-off `skonto` or `discount` | nothing: what was never received was never taxed (no note entry either, decision 7.3) | `RE-<n>-wo-<k>`: 3800 Erlösminderungen / 1100 with the minus sale codes, split like the invoice (MWSTG Art. 41 Abs. 1) |
| Write-off `loss` | nothing | `RE-<n>-wo-<k>`: 3805 Verluste aus Forderungen / 1100 with the minus sale codes. If the customer pays later, the payment books revenue with the sale codes again (Art. 41: when received) |
| Write-off `fee` or `rounding` | nothing | as `discount`, on 3800 |
| Reminder fee, default interest paid | revenue without a code on `feeAccount` (exists for fees), interest on a financial income account | same, from the payment; not booked on issue (not consideration, MWSTG Art. 18 Abs. 2 lit. i) |
| Set-off of a credit note (a deduction line on the next invoice, decision 7.6) | the invoice's payment is smaller; its revenue split takes the deduction line | `RE-<n>` holds the deduction line; the credit note's `GS-<m>` stands; no entry of its own |
| Retention instalment notice | nothing | nothing (the receivable stands since issue) |
| A document of a filed period | never changed; a write-off or credit note is dated in the open period, with `corrects` where golden rule 1 says so (as `eventPlan` does) | same |

All entries go through the write door (`update` in `src/books/store.ts`) as the module
`invoicing` (`moduleActor`). A person's booking is never replaced (exists in `confirmPayment`).

### 4.6 Code, AI, person (MISSION.md)

| Work | Code | AI | Person |
|---|---|---|---|
| Numbers, references, totals, rates, QR-bill, Art. 26 check, the PDF | all | – | – |
| Drafting a recurring invoice on its day | all | – | chooses once whether it is issued and sent by itself |
| Matching payments, Skonto in terms, small differences under the limit | all | – | – |
| Booking every event (4.5) | all | – | – |
| Dunning run: who, which level, fee, interest | proposes the list | – | confirms once |
| «Schreib Müller AG eine Rechnung für 12 Stunden im Oktober» | – | drafts (exists: `invoiceDraft`) | issues |
| An invoice from a quote PDF of another tool, a Rapport photo, an e-mail «bitte offerieren» | – | reads it into a draft | checks and issues |
| Which receipts are re-billed to whom (without tags) | proposes by the customer's name on the receipt | proposes by context | picks |
| Whether a supply is abroad, export or domestic | asks the reason when a line is 0 % (exists) | proposes from the customer's country and the text | decides |
| Write-off of a loss, a cancellation, a credit note | – | – | decides |
| Wishes: «schick jeder Rechnung den Rapport mit», «mahn die Gemeinde nie» | – | turns into a setting or a customer flag, shown on a card | keeps it with one click |

Every action has a button: the AI is never the only way (Treuhänderin persona).

### 4.7 App and workspace (ADR 0015)

| In the app | In the workspace |
|---|---|
| Documents, numbering, Art. 26 check, QR-bill, PDF, sending by SMTP, the sent log | Texts, layout, logo, number patterns (settings) |
| Quotes, partial and final invoices, retention, recurring, dunning, write-offs, set-offs and their bookings | Per-customer terms, discounts, «never remind» (customer records) |
| Article list and units | The firm's articles and prices |
| A **lines import contract**: a table of date, text, quantity, unit, price and optional tags, from a pasted table or a CSV | A source that turns one tracker's or one shop system's export into that table, written by the AI with the person |
| A **delivery channel contract** for documents beyond e-mail and download (`deliver(doc) → { to, channel, id }`, as `Deliver` in `service.ts`) | An eBill or portal source for one network partner, written on site |
| Import of customers and open invoices from a table (the switch from another tool) | The mapping of one tool's export columns (another bookkeeping tool, a spreadsheet) |

No branch for one bank, tracker, eBill partner or tool goes into the app.

### 4.8 UI

The new UI's rules apply (`docs/redesign/architecture.md`, AGENTS.md «UI links», «UI theming»).
Rechnungen stays one area (`src/app/areas/invoices/`) with list and detail (`Split.tsx`).

- **Route** (`src/app/shell/route.ts`, `docs/urls.md`): `view` gains `quotes`, `articles`,
  `recurring`, `open-items`. A quote is `/invoices/OF-2026-004`. A delivery note is
  `/invoices/LS-2026-002`. A recurring template is `/invoices/recurring/<id>`. `status` gains
  `quote-open`, `accepted`.
- **List:** the tabs Rechnungen · Offerten · Aufträge · Kunden · Artikel · Wiederkehrend · Offene
  Posten · Versendet. «Offerten · Aufträge» lists quotes, order confirmations and delivery notes,
  grouped by kind and state. Offene Posten lists every invoice with something open, by customer, with age bands
  (0–30, 31–60, 61–90, > 90 days). It is printable (Debitorenliste, year end and audit) and
  exports to CSV.
- **Overview table** (owner, 2026-11-15): Rechnungen and «Offerten · Aufträge» are one table
  component, not a list of rows. Above it, status tabs from facts, each with its count and total:
  «Alle · Entwürfe · Offen · Überfällig · Bezahlt · Gutschriften» (for quotes: «Alle · Entwürfe ·
  Offen · Angenommen · Abgelehnt, abgelaufen · Aufträge · Lieferscheine»). «Eigene Filter» are saved
  from a tab and a search (a customer, a currency, «gemahnt» as well), each shown with its count; a
  filter is a viewer's preference, never in the books. A search over number, customer and line text.
  One line of facts above the table: how many invoices are open and their sum per currency, and
  how many of them are overdue and their sum. Columns: Datum · Nr. · Kunde (with the subject) · Status chip (Entwurf,
  ausgestellt, gesendet, überfällig N Tage, teilbezahlt, bezahlt, gutgeschrieben, storniert) · Fällig ·
  Währung · Brutto · Offen · gesendet (a tick from the sent log, its time and recipient on hover) ·
  Mahnstufe. Every column sorts. Amounts are right-aligned in tabular figures; an EUR row shows EUR
  and its CHF value (ESTV rate of the invoice date) in muted text. A totals row sums Brutto and
  Offen for the current tab, filter and search, cancelled invoices left out, in CHF with the EUR
  part named. Rows can be ticked: a bulk bar («3 gewählt», their totals) offers «Mahnen» (a dialog
  that names each invoice it leaves out and why: not overdue, a draft, paid, «nie mahnen»), «PDF»
  (drafts named as left out), «Export CSV» and «Als Kontext an die KI». «⋯» on a row: Öffnen, PDF,
  Senden, the next Mahnung, Folgedokument, Als Entwurf kopieren, Als Kontext an die KI. The footer
  says how many rows of how many and the page size (50; the rest is named when hit). ↑ ↓ move
  through the rows while a document is open. Nothing in a row is typed: every status and figure
  comes from the issued documents, the bank statement and the sent log.
- **Table and detail, two layouts** (prototype, «Übersicht» A/B in the bar): **A**, the table full
  width; a row opens the document as a panel over the right part of the table, the first columns
  (Datum, Nr., Kunde) stay visible and clickable, Esc or «×» closes it and keeps the tab; with
  nothing selected the table stands alone. **B**, the table with fewer columns (Nr., Kunde, Status,
  Brutto, Offen) as the list and the document beside it, the first row selected, as the app's rule
  «An area is a list and a detail beside it» says. **Recommendation: A.** The table is the overview
  the owner asked for and keeps all its columns and totals; the document keeps a full A4 width,
  where B shrinks the sheet to about a third and drops Fällig, Währung, gesendet and Mahnstufe. A
  deviates from the list + detail rule (AGENTS.md «UI links»: the detail column is always there, the
  first row is selected) for Rechnungen and Offerten · Aufträge only; it needs the owner's OK
  before it is built. With B, the rule holds unchanged.
- **Four figures** on every issued invoice, above its sheet: Betrag · erhalten · gutgeschrieben ·
  offen. «erhalten» is the sum of the matched payments, «gutgeschrieben» the sum of its credit
  notes and write-offs, «offen» the rest; a negative rest is the customer's credit («Guthaben, zu
  verrechnen»). Each figure names where it comes from (the statement's date, the credit note's
  number) and none is typed. The same figures feed the open-items list.
- **Chain** on every document that has one: each step a link (`hrefOf`), the current one bold.
- **Detail:** the A4 sheet as today. New buttons by state: «Folgedokument erstellen» (any issued
  document), «In Rechnung umwandeln» (quote),
  «Akontos abziehen» (final), «Rest ausbuchen» (open), «Zahlungsaufforderung» (retention due),
  «Lieferschein» (from an invoice or a quote). The margin shows `from`, the partial invoices of a
  final invoice, the write-offs, and the bookings each event made (links to `/journal/<id>` with
  `hrefOf`).
- **Mahnlauf:** a dialog (an action, not a place) with the proposed list, the totals and one
  «Senden». Limits are named when hit («40 Mahnungen, 12 weitere nicht: höchstens 40 pro Lauf»).
- **Dated values** (4.12): an article's price, a customer's terms and address, and the firm's
  address, IBAN and terms each show the current value with «ab TT.MM.JJJJ», a planned entry, and a
  small «Verlauf». «Ändern» asks «gilt ab» (default: today).
- **Firma › Rechnungslayout** gains the number patterns, Skonto, dunning levels, interest and
  write-off accounts. A new firm's first invoice asks only what Art. 26 and the QR-bill need
  (exists).

### 4.9 i18n

- UI texts go through `t('key')` in `src/app/i18n/locales/` (de, then fr, it, en; `tests/i18n.test.ts`).
- Document texts (quote, order confirmation, delivery note, partial and final invoice, deduction
  line, retention, instalment notice, Skonto terms, interest line, set-off line) go into
  `src/invoices/texts.ts` for de, fr, it, en. The jurisdiction words (MWST, Art. 8 notes) stay
  where they are today. Swiss names may not appear outside `modules/ch` and `src/providers` (the
  layers lint, `tests/layers.test.ts`). Form wordings that are Swiss belong in
  `modules/ch/invoicing.yaml`.
- Romansh: QR-bill headings in Romansh exist since 1 January 2026 (SIX IG v2.4, ch. 3.2). Not a
  goal until a persona asks (decision 7.8).

### 4.10 Tests and golden master

- Pure rules in `tests/invoices.test.ts` style: deductions, schedule, write-off amounts per rate,
  Skonto detection, offset, numbering patterns (QRR fits in 26 digits, SCOR in 21 characters),
  F1 (EUR never QRR), F3 (`activity` → F1/F2).
- Booking per basis: `tests/invoice-payments.test.ts` and a new `tests/invoice-events.test.ts` for
  each row of 4.5, on cash and agreed basis, each VAT setup (effective, net rate, none), and a
  write-off of an invoice of a filed period (dated open, `corrects` where due).
- API: a row in `tests/period-lock.test.ts` for every new route that writes the books.
- Follow-up and options: a follow-up copies every line and sets `from`; the chain is the same seen
  from each of its documents; an optional line changes no total, VAT figure or QR amount; picked
  options become ordinary lines, unpicked ones are left out.
- Four figures: Betrag − erhalten − gutgeschrieben = offen for every invoice of the demos, and the
  open-items list sums the same «offen».
- Warnings (4.11): each one names the fact, the rule and what follows, and «Trotzdem …» does the
  action and records it as an ordinary entry of the log, with no override field.
- Dated values (4.12): a draft reads the price, terms and IBAN valid on its date; an issued
  invoice is byte for byte the same after a later change; a recurring line from an article takes
  the new price on the first invoice dated after the change; a backdated price change names
  exactly the issued invoices that carry the old price.
- UI: `tests/invoices-area.test.ts` for the new views. One e2e walk (`tests/e2e-invoices.test.ts`):
  quote → two partial invoices → final → payment with Skonto.
- **Golden master:** only `demo/` books invoice entries today. The new demo data (below) changes
  the golden books and figures of the demos that receive invoices. Each such change goes through
  `npm run test:update`, a reviewed diff, and a CHANGELOG entry marked **⚠ figures**
  (docs/releasing.md). Phase 1 should leave existing golden files unchanged except for F1. F1 does
  not touch `demo/` because its EUR account has no QR-IBAN (`demo/vanilla-accounting/belege.workspace.yaml`).
- **Demos:** `tools/demo/invoices.ts` gains invoicing for `demo-consulting/` (monthly by hours,
  one EUR client abroad, a retainer), `demo-schreinerei/` (Akonto and final, «inkl. MWST») and
  `demo-coiffeur/` (one invoice without VAT). They are generated by `npm run demo:generate`, the
  only writer of the originals.
- **Personas:** `invoices.md` gets the checkpoints of section 5 per phase, and a persona file each
  for the consultant's and the Schreinerei's invoicing (or sections in `other-firms.md`).

### 4.11 Warn, then the person decides (owner, 2026-11-15)

Where this area refuses a person today, it warns instead: it says what is off, which rule it
touches and what follows, and offers «Trotzdem …». The action is recorded like any other (log,
sent log, books), with no override flag and no «trotz Warnung» mark. The exception is a security
boundary. Code still refuses what is not the person's to decide in the first place: a format a
third party rejects outright, or a write the golden rules forbid.

| Refused (today, or as first written in this spec) | The warning: what is off · rule · what follows | The person's way on |
|---|---|---|
| Issue with something Art. 26 asks missing (`missingForIssue`) | «Es fehlt: …» · MWSTG Art. 26 Abs. 2 lit. a–f, the letter named · the customer may not deduct the input tax on it; once issued it changes only by credit note or cancellation | «Trotzdem ausstellen»; the missing item links to where it is fixed (exists) |
| Issue with a line without text or price | «Eine Position ohne Text oder Preis» · Art. 26 Abs. 2 lit. d, e · it prints as 0.00 | «Trotzdem ausstellen» |
| No account to pay to | «Kein Konto für CHF» · QR-bill needs an IBAN · the invoice prints without a payment part | «Trotzdem ausstellen» (bank details by hand in the text) |
| Cancel a paid invoice (refused today) | «2026-001 ist bezahlt» · a cancellation undoes the invoice, the money stays received · the payment is released and waits unmatched until matched or paid back; a filed quarter stays as filed, the reversal is booked in the open one | «Gutschrift statt Storno», or «Trotzdem stornieren» |
| A credit note above what is still credited of its invoice (refused today) | «Gutschrift über dem Rechnungsbetrag» · MWSTG Art. 41: the tax follows the consideration · the VAT reduction is larger than the supply | «Trotzdem ausstellen» |
| A QR-IBAN under EUR (F1) | «Seit v2.4 nur für CHF» · SIX IG v2.4, v2.3 valid until November 2027 · banks refuse it after November 2027 | «Trotzdem speichern» |
| A follow-up of an expired or declined quote | «Abgelaufen am …» or «abgelehnt am …» · the quote's own `validUntil`, or the customer's answer in the log · the old prices and rates go into the draft, the quote becomes accepted | «Trotzdem erstellen» |
| A write-off above what is open | «Mehr als offen» · the open amount · the invoice shows a credit balance | «Trotzdem ausbuchen» |
| A price, terms or IBAN changed with a «gilt ab» before issued invoices (4.12) | «2 Rechnungen seit 01.08.2026 mit 28 ausgestellt; ab 01.08.2026 gilt jetzt 29» · an issued invoice is kept as issued · they stay as they are; new lines take the new value | «Nachbelastung als Entwurf» (or «Gutschrift als Entwurf» for a lower price), «So lassen» |

Kept as hard rules, each for its reason:

- **A filed VAT quarter** (AGENTS.md golden rule 1). A write-off, credit note or cancellation
  that touches a filed period is dated in the open period, with `corrects` where due; nothing in
  the filed quarter changes. The app's hard lock stays exactly as it is until the owner rewrites
  that rule. If he does, the warning would read: «Q3 2026 ist bei der ESTV eingereicht · Regel 1:
  eine eingereichte Abrechnung ändert sich nicht mehr · eine Änderung hier macht die Zahlen der
  Abrechnung ungleich der eingereichten; die Korrekturabrechnung (0535) zeigt die Differenz» with
  «Trotzdem ändern». This spec builds no such switch.
- **An issued document is kept** (OR Art. 958f, GeBüV): it is never deleted or printed again;
  cancellation and credit note are the ways on. Treated like golden rule 1: it stays until the
  owner rules otherwise.
- **Who issues on which device** (decision 7.4): two devices issuing would give one number twice.
  Kept as a guard of the one gapless series; the owner may confirm or turn it into a warning.
- **Security boundaries**: the SMTP password, the mailbox, a workspace's private data.

### 4.12 Values that change over time (owner, 2026-11-15)

The owner asked whether the app takes change into account: a price, a customer's terms or the
firm's IBAN all change. It does, by the rule of docs/specs/domain-model.md §5 (branch
`spec/domain-model`). Each such value is a dated history (`Dated<T>`: `validFrom`, optional
`validUntil`, never overwritten). A document reads the value valid on its own date, and an issued
document keeps what it printed.

**What is dated in this area:**

| Value | Typical change | Read on |
|---|---|---|
| An article's price | a new price list from 1 January | the invoice's date, when the line is added; a recurring invoice's date for a line from an article |
| A customer's address, payment term, discount, revenue account | a move; 20 days instead of 30 from a new contract | the document's date |
| The firm's name and address (letterhead), UID | a move, a new name | the document's date |
| `payTo` per currency: IBAN, QR-IBAN, ledger account | a new bank | the document's date |
| Payment term, Skonto, dunning levels and fees, interest, write-off and fee accounts | a new policy | the document's date; a reminder reads its own date, and a write-off its own |
| The VAT setup | a switch of method or basis, held for whole years | the document's date (it is already per year) |

Not dated: the layout, the texts and the number patterns. An issued document keeps its own copy,
and a draft takes them as they are now. An article's VAT rate is its kind (normal, reduced,
accommodation, none). The percent comes from `modules/ch/rates.yaml` for the day of the supply,
so a change in the law needs no change to any article (MWSTG Art. 115: a new rate applies to
supplies made from its start).

**What an issued document keeps.** Its lines with prices and rates, the customer (address,
terms), the sender (name, address, UID, `payTo`), the layout and the PDF with its SHA-256. All of
these are kept today (`Issued.customer`, `sender`, `layout`, `pdf`). Phase 1 adds `terms` (the
due date's basis, Skonto, dunning terms), so a later change of the terms never changes the
reminders of an earlier invoice. A reminder computes from the printed due date, and Skonto is
recognised by the printed Skonto.

**Drafts.** A line from an article copies the article's price valid on the draft's date when it
is added, as today. If the draft's date moves, or a new price starts before the issue, the
preview names the difference as a fact on the line: «Artikelpreis ab 01.12.2026: 29; Zeile:
28». The line's price is the person's to keep or change. The letterhead, the IBAN and the terms
are read on the document's date at issue.

**Recurring invoices.** A template line from an article takes the price valid on each new
invoice's date, so a new price from 1 January reaches the January invoice by itself. A line typed
by hand keeps its price. The template shows the coming change as a fact: «ab 01.01.2027:
Hausmischung 29 statt 28».

**A change dated before issued documents.** When the new entry's days cover issued documents
that carry another value, the card says so before it saves (4.11):

- **Price.** «2 Rechnungen seit 01.08.2026 mit 28 ausgestellt; ab 01.08.2026 gilt jetzt 29».
  They stay as issued. The ways on are «Nachbelastung als Entwurf» (one draft per customer with
  the difference per invoice; a credit note draft when the new price is lower) or «So lassen». A
  quote sent at the old price stays as sent, and its follow-up copies the quote's lines, with the
  difference named on the draft.
- **IBAN or QR-IBAN.** Open invoices keep the QR-bill they printed. Code still matches their
  payments by reference, whichever of the firm's accounts receives them. The card names the open
  invoices with the old account. The ways on are «Zahlungsaufforderung mit neuer IBAN» (an
  instalment notice with a new QR-bill and the same reference, 4.4) or «So lassen».
- **Terms or address.** Issued invoices keep theirs. The card names them, and nothing else
  follows.

The choice is an ordinary action (a draft, a sent notice, or nothing), recorded like any other.
The entry carries no warning mark. A filed period stays as filed: a credit note or supplementary
invoice is dated in the open period (golden rule 1).

**UI and the AI.** The article's detail shows «CHF 28 ab 01.07.2026», a planned price below
it, and «Verlauf» with the earlier prices. «Ändern» asks for the price and «gilt ab» (default:
today). The customer's «Vorgaben» and Firma › Rechnungslayout show their values the same way. A
wish in the sidebar («Hausmischung ab Januar 29 Franken», «Müller zahlt ab jetzt in 20 Tagen»)
becomes `{ path, value, validFrom }`. Code writes the entry and shows the card, and the person
keeps it. Prototype: the article «Hausmischung Espresso» (`#/invoices/articles/a1` in
[mockups/invoicing/app.html](mockups/invoicing/app.html)).

---

## 5. Phases

Each phase ends with a persona walk in the `verify` skill, scored 0/1/2 per checkpoint as
`first-run.md` defines. A phase is done when each checkpoint scores 2.

### Phase 1: correct and closed (smallest valuable slice)

Scope: F1 (QR-IBAN/QRR CHF only), F2, F3 (`activity` on lines for two net rates), **write-off**
(«Rest ausbuchen»: skonto, discount, loss, fee; booked on the agreed basis as in 4.5), **Skonto in
the terms** recognised on payment, **open-items list** (Offene Posten, by customer, with age,
printable, CSV), **the four figures** on every invoice (Betrag · erhalten · gutgeschrieben · offen,
from what the records hold today), **the warnings of 4.11** for what this phase touches,
**units** m², m, m³, l, kg, month, **title and subtotal lines**, **dated customer and firm
values** with `Issued.terms` (4.12), and the `invoicing:` section in the three demos that lack it. One `invoices.json` step (2→3: `writeOffs`,
line `kind`, `activity`, units) and one manifest step (Skonto, write-off accounts).

Why first: it closes what is wrong or stuck today (F1 is in force from today's SIC release, F4
leaves invoices open forever and VAT declared on money never received on the agreed basis). It
touches no new document kind and keeps the golden figures of the existing demos.

Acceptance (persona `invoices.md`, Sandra, and the consultant):

| # | Checkpoint | 2 means |
|---|---|---|
| P1.1 | EUR invoice with a QR-IBAN set | saving it warns with the rule and what follows; without «Trotzdem speichern» an EUR invoice prints SCOR with the plain IBAN; an issued invoice keeps what it printed |
| P1.2 | Painter's invoice by m² with a title line per room and a subtotal | sheet and PDF correct, totals per rate right, Art. 26 check passes |
| P1.3 | Payment 2 % short within the Skonto days | the invoice reads «bezahlt», the Skonto written off by code; on the agreed basis a `-V81` entry on 3800 equals 2 % of the gross |
| P1.4 | Customer gone bankrupt | «Rest ausbuchen» as loss in three clicks; cash basis: no entry; agreed: 3805 / 1100 with `-V81`; the MWST tab shows the reduction in the open quarter |
| P1.5 | Offene Posten on 31.12. | matches the year-end receivables proposal to the Rappen; prints and exports |
| P1.6 | Schreinerei with two net rates | a line marked as the second activity books F2; the half year's form shows it in the second rate's row (333; the box numbers are marked uncertain in AGENTS.md) |
| P1.7 | Treuhänderin without AI | P1.2–P1.5 done by hand, no AI asked |
| P1.8 | The four figures | on every invoice of the demos Betrag − erhalten − gutgeschrieben = offen; a credit note and a write-off each show in «gutgeschrieben» |
| P1.9 | Cancel a paid invoice | a warning with the payment, the rule and what follows; «Gutschrift statt Storno» offered; «Trotzdem stornieren» releases the payment, which waits unmatched; the log holds it as an ordinary entry |
| P1.10 | New IBAN from 01.12.2026, entered on 15.11. | invoices dated before 01.12. print the old IBAN, those from 01.12. the new one; the card names the open invoices with the old IBAN; their payments are still matched by reference |

### Phase 2: quotes, partial and final invoices, retention

Scope: one editor for every kind; `quote` with its series, sending, accept or decline, optional
lines and «In Rechnung umwandeln» with the pick of options; `order` (Auftragsbestätigung) with its
series; delivery note; «Folgedokument erstellen» and the chain on each document; partial and final
invoices with «Akontos abziehen»; retention and instalment notices (`schedule`). `invoices.json`
step for the new kinds, `from`, `optional`, `role`, `deducts`, `schedule`.

Acceptance (Sandra and the Schreinerei):

| # | Checkpoint | 2 means |
|---|---|---|
| P2.1 | Offerte for a facade, sent, accepted | quote PDF, its own number, `accepted`; no booking |
| P2.2 | Two Akonto invoices, then the final invoice | the final invoice lists the whole work, deducts both partial invoices with their VAT, its QR-bill asks for the remainder; agreed basis: three events whose sum is the whole; cash basis: the three payments' revenue is the whole |
| P2.3 | Retention 5 % until acceptance | QR-bill for 95 %; on the due day a fact in the list; the instalment notice with its own QR-bill pays the rest, matched by the same reference |
| P2.4 | Final invoice while an Akonto is unpaid | the unpaid partial invoice stays open on its own; nothing is counted twice |
| P2.5 | Quote with two options, one taken | the quote's total leaves both out and names them; «In Rechnung umwandeln» asks; the invoice holds the taken one as an ordinary line, its total and QR amount include it |
| P2.6 | Quote → order confirmation → delivery note → invoice | each step one click, every line copied; each document shows the same chain; the delivery note prints no prices; only the invoice books |
| P2.7 | Follow-up of an expired quote | a warning with the date and what follows; «Trotzdem erstellen» makes the draft |

### Phase 3: recurring, hours, re-billed costs, articles

Scope: recurring templates (draft, issue or send on their day), the lines import contract (paste
or CSV), «Spesen weiterverrechnen» from receipts, the article list with rate and price, customer
defaults (currency, account, discount, number, contacts), set-off of credit notes as a deduction
line (F5), the Quittung (an invoice paid at issue), the article's dated price (4.12). Further `invoices.json` step (`articles`,
`recurring`, customer fields, `offsets`, line `source`, `paidAtIssue`).

Acceptance (the consultant and the webshop):

| # | Checkpoint | 2 means |
|---|---|---|
| P3.1 | Monthly retainer | on the 1st the draft (or the sent invoice) is there without a click; a mail failure is a task with words |
| P3.2 | 37.5 hours from a CSV of the tracker | the lines are on the draft, grouped as chosen; a workspace source the AI wrote reads the tracker's own export |
| P3.3 | Train and hotel re-billed | the receipts become lines at the supply's rate, net; the same receipt is never offered twice |
| P3.4 | Wholesale invoice: coffee 2.6 % and grinders 8.1 % from the article list | both rates right on paper and in the books |
| P3.5 | Credit note set off against the next invoice | the next invoice carries the deduction line; both documents show it |
| P3.6 | Coiffeur: a wedding party paid in cash after the appointment | a Quittung with the next invoice number, no VAT, «bezahlt in bar», no QR-bill; on the cash basis 1000 / revenue on the issue day; nothing left open |
| P3.7 | Hausmischung 29 from 01.01.2027, entered in November | the December invoice still at 28; the January abo invoice at 29 without a click; the same change dated 01.08.2026 names the issued invoices with 28 and offers the supplementary draft |

### Phase 4: dunning run, interest, currencies, import, delivery channels

Scope: «Mahnlauf» with levels from the settings, default interest, customer stop; currencies
beyond CHF and EUR (no QR-bill, bank details only); import of customers and open invoices from
a table at the switch; the delivery channel contract and a reference eBill source in the
workspace (ADR 0015); QR «billing information» (Swico S1, decision 7.7).

Acceptance (Treuhänderin and the consultant):

| # | Checkpoint | 2 means |
|---|---|---|
| P4.1 | 14 overdue invoices of 9 customers | one run, one confirmation, the right level each, the customer marked «nie mahnen» left out; every PDF in the sent log |
| P4.2 | Switch from another tool on 1 January with 23 open invoices | imported from a table; payments in January find them by number; the year-end list of the old tool matches |
| P4.3 | USD invoice | issued in USD with bank details and no QR-bill; booked at the ESTV rate of the tax point |
| P4.4 | eBill | a document goes out through a workspace source on the channel contract; the sent log records the channel and id |

---

## 6. Risks

- **Numbering across devices.** ADR 0010 planned «issue pulls main and pushes». Today a number
  is safe only within one process (`serial` in `service.ts`). Recurring issuing makes more issues
  happen without a person. The owner decided that only the device holding the books issues
  (decision 7.4); phase 3 builds that role check before recurring issuing.
- **Agreed-basis write-offs of filed periods** must follow golden rule 1 and the `eventPlan`
  logic (`events.ts`): dated open, `corrects` when the firm reported on the agreed basis then.
  This needs the same reviews as any change under `src/accounting`.
- **Golden master churn** from the new demo invoices: one figure change per demo, reviewed once,
  marked **⚠ figures**.

---

## 7. Decisions (owner, 2026-11-14)

The owner accepted the recommendation of each of the twelve questions of the draft. Sections 4 to
6 follow them.

1. **Format steps.** One `invoices.json` step per phase (2→3 in phase 1, then one each in phases 2
   and 3) and one manifest step in phase 1. Each release migrates only what it uses.
2. **New refs in the books.** `RE-<n>-wo-<k>` is no books format change: the entry shape stays,
   so there is no `schema` step. The ref is named in `src/books/refs.ts` and in the CHANGELOG.
3. **Write-off on the cash basis** books nothing, not even a 0.00 note entry. The write-off stands
   on the invoice record and in the open-items list, with date, reason and person.
4. **Who issues on which device.** Only the device that holds the books (the desktop app or
   `npm start`) issues, recurring invoices included. A clone without that role only drafts.
   Revisited if collaboration (ADR 0003) ships.
5. **Quote numbers.** Quotes have their own series, `OF-YYYY-NNN`. The invoice series stays the
   one gapless sequence customers and auditors expect; a declined quote leaves no gap in it.
6. **Set-off of a credit note** is a deduction line on the next invoice. It is what the customer
   reads, the QR amount is right, and the booking falls out of the existing revenue split, so no
   `-off-` ref is needed.
7. **QR «billing information» (Swico S1)** goes into the QR code in phase 4, through
   `swissqrbill` if it supports it, otherwise a small encoder in `src/providers/qr-bill/`.
8. **Romansh** document texts and QR headings are not built now. They are added when a persona
   asks.
9. **Retention proof (GeBüV Art. 9 Abs. 1 lit. b).** SHA-256 per PDF, git history and seals are
   enough for this target group; no trusted time stamp. This is noted in `docs/audit-export.md`
   and revisited with an auditor.
10. **Default interest** on reminders is off by default and offered in the settings at 5 %
    (OR Art. 104 Abs. 1). Most small firms do not charge it, and a wrong interest line costs a
    customer.
11. **Simple receipt (Quittung)** is an invoice paid at issue, with the means named (cash, TWINT,
    card, bank) and the title «Quittung». It needs no new document kind and books like any invoice
    paid on its day (4.5). It comes in phase 3.
12. **Currencies beyond CHF and EUR** come in phase 4. No persona has a client outside CHF and EUR
    today.

### Decisions (owner, 2026-11-15)

13. **Patterns of the market review** go into the spec and the prototype: one editor and
    «Folgedokument erstellen» with the chain (4.4, phase 2), the four figures (4.8, phase 1),
    optional lines on quotes (4.3, 4.4, phase 2), and facts kept by code where other tools set a
    status by hand (4.4).
14. **Warn, then the person decides** (4.11): every refusal of this area becomes a warning with
    «Trotzdem …», recorded like any other action, except security boundaries. The filed-quarter
    lock of golden rule 1 stays as it is until the owner rewrites that rule.
15. **Values that change over time** (4.12): prices, terms, the letterhead and the IBAN are dated
    histories; a document reads them on its own date and keeps what it printed; a change dated
    before issued documents warns and offers a supplementary draft, and the person decides.

### Patterns taken from the market review (2026-11-15)

A review of a Swiss market leader's invoicing (an internal teardown; nothing of its look, names or
words is copied) gave four patterns: one editor for every document kind with a one-click follow-up
that copies all lines and shows the chain; a strip of four figures per invoice; optional lines on
quotes, picked on conversion; and statuses a person sets by hand. The first three are taken. The
fourth is not: here «gesendet» and «bezahlt» stay facts from the sent log and the bank, which is
where this app is ahead.

## Sources

- MWSTG Art. 8, 18, 23, 24, 26, 27, 37, 40, 41, 42, 70, 115, as published (via
  justement.ch, text of fedlex).
- MWSTV Art. 45, 57, 106.
- OR (SR 220) Art. 102, 104, 958f. GeBüV (SR 221.431) Art. 9.
- SIX, Swiss Implementation Guidelines for the QR-bill, v2.4 of 24.02.2026:
  <https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.4-en.pdf>
- ESTV, Saldosteuersätze und Pauschalsteuersätze:
  <https://www.estv.admin.ch/de/mwst-saldosteuersaetze-pauschalsteuersaetze>; MWST-Info 12.
- eBill: <https://ebill.ch>.
