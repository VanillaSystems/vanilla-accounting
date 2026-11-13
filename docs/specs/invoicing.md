# Spec: invoicing for the personas

Status: draft for the owner (2026-11-13), on `0.4.2`. Asked: «can we on the start speccing out the
invoicing for the personas in question? I want a fully fledged invoicing tool».

This spec builds on [ADR 0010](../adr/0010-invoicing.md) (invoicing in the same app, paid
invoices matched by their reference) and [ADR 0012](../adr/0012-invoice-pdfs.md) (PDFs). It
follows [MISSION.md](../../MISSION.md) for who does the work and
[ADR 0015](../adr/0015-base-cases-in-the-app-long-tail-in-the-workspace.md) for what is in the app
and what is in the workspace. Sections 1 to 3 report what exists and what applies. Sections 4 to 6
propose the work. Section 7 lists what the owner decides.

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
  under `payTo.EUR`, and `referenceFor` (`reference.ts`) then gives a QRR reference to a EUR
  invoice. Fix: refuse `qrIban` under any currency but CHF, with words. On a EUR invoice, use the
  plain IBAN and SCOR even if a QR-IBAN is set. Also check that `swissqrbill` ^4.4.2 writes only
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
| Till receipts | Receipts from automated tills need no recipient if the amount is below the threshold the Federal Council sets. The threshold is CHF 400. Such a receipt gives no refund in the refund procedure. | MWSTG Art. 26 Abs. 3; MWSTV Art. 57 | not built; it matters only if a simple receipt (Quittung) is added |
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
| Storage medium | Changeable media are allowed when the integrity is guaranteed (for example a digital signature) and the time of storage is provable (for example a time stamp). | GeBüV Art. 9 Abs. 1 lit. b (SR 221.431) | SHA-256 per PDF, git history; no time stamp. Open question 7.9 |
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
version and a ladder step in `src/workspace/schema.ts`. The owner decides each one (7.1).

| Addition | Where | Step |
|---|---|---|
| `kind` gains `quote` and `delivery-note` (beside `invoice`, `credit-note`). A quote has its own number series (`OF-YYYY-NNN`), `validUntil`, and `status` `draft` → `sent` → `accepted` / `declined` / `expired`. A delivery note has its own series (`LS-…`), no prices on paper, no reference and no booking. | `invoices.json` | **step** (INVOICES 2→3) |
| `from?: { id, kind }` on an invoice: the quote or order it came from. `ordered?: string` (the customer's order reference, printed) | `invoices.json` | **step** (same) |
| `role?: 'partial' | 'final'` on an invoice (Akonto / Schlussrechnung). A final invoice's deduction lines carry `deducts: <invoice id>` and a negative price at the deducted invoice's rate, so totals, QR amount and booking work as they do today | `invoices.json` `InvoiceLine.deducts` | **step** (same) |
| `schedule?: Array<{ amount, dueDate, label }>` on an issued invoice: the retention or instalments. The QR-bill asks for what is due first. A later instalment is sent as a payment notice (a sent document of kind `instalment`) with its own QR-bill and the same reference | `invoices.json`; `SENT_KINDS` gains `instalment` | **step** (same) |
| `writeOffs: Array<{ date, amount, reason: 'skonto' | 'discount' | 'loss' | 'fee' | 'rounding', note? }>` on an issued invoice. `openAmount` subtracts it | `invoices.json` | **step** (same) |
| `offsets: Array<{ creditNoteId, amount }>` on an invoice: a credit note set off against it (F5) | `invoices.json` | **step** (same) |
| `InvoiceLine` gains `kind?: 'item' | 'title' | 'subtotal' | 'text'` (a title or text line has no amount), `discount?: number` (percent, per line), `articleId?`, `activity?: 1 | 2` (net tax rate method: which approved rate, F3), `tags?` (dimensions), `source?: { receiptId } | { hours: rowId }` (where the line came from) | `invoices.json` | **step** (same) |
| `UNITS` widens to `h, day, pcs, flat, km, m2, m, m3, l, kg, month` | `model.ts:18` | **step** (same; an old reader refuses a new unit) |
| `INVOICE_CURRENCIES` widens to any ISO 4217 code the ESTV publishes a rate for. The QR-bill only for CHF and EUR; other currencies print bank details only | `model.ts:12`; `payTo` may map more currencies | **step** for `invoices.json`, **step** for the manifest |
| `Customer` gains `number?` (Kundennummer), `currency?`, `revenueAccount?`, `contacts?: Array<{ name, email, role? }>`, `noReminders?: true`, `discount?` | `invoices.json` | **step** (same) |
| `articles: Array<Envelope & { number?, text, unit, price, vatRate, vatIncluded?, account?, activity? }>` | `invoices.json` (top level, beside `customers`) | **step** (same) |
| `recurring: Array<Envelope & { customerId, template: InvoiceContent, every: 'month' | 'quarter' | 'year', next: date, until?, issue: 'draft' | 'issue' | 'send' }>` | `invoices.json` | **step** (same) |
| Settings: `numbering: { invoice: 'YYYY-NNN', quote: 'OF-YYYY-NNN', … }` (a pattern with `YYYY` and `N…`, digits enough for QRR's 26), `quoteValidDays`, `skonto?: { percent, days }` (printed in the terms and applied on payment), `dunning: { levels: [{ afterDays, fee? }], interest?: 5 }`, `writeOffAccount: { skonto: '3800', loss: '3805' }` | `belege.workspace.yaml` `invoicing:` | **step** (manifest) |
| New booking refs on the agreed basis: `RE-<number>-wo-<n>` for a write-off, `RE-<number>-off-<GS number>` for a set-off. Same entry shape as today; new ref patterns that `refs.ts` must name | books (journal entries) | **books**: no shape change, but a new ref pattern that readers (reconcile, seals, refs) must know. The owner decides whether it counts as a format change |

Nothing here changes a filed figure. Write-offs and set-offs are new events dated in the open
period (golden rule 1).

### 4.4 Flows

```
quote ──accept──► (order confirmation = the quote re-sent as «Auftragsbestätigung»)
   │                 │
   └──convert────────┴──► invoice draft ──issue──► invoice ──send──► customer
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

- **Quote → invoice.** «In Rechnung umwandeln» copies the lines into a draft with `from`. A
  quote can become several partial invoices. The quote shows what is invoiced of it.
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
  on the template. A failure (mail refused, something missing for Art. 26) becomes a task with
  words (ADR 0015 base errors).
- **Dunning run.** «Mahnlauf» lists every overdue invoice with its next level, fee and interest
  by the settings, leaves out customers marked `noReminders` and invoices with a comment from the
  last 7 days, and sends or downloads all of them after one confirmation. The list shows overdue
  invoices as a fact («fällig seit 12 Tagen»), never as a nudge to the person (memory: no nagging
  reminders). Interest is calculated from the due date at the rate set (OR Art. 104 Abs. 1:
  5 %) and printed as a line without VAT.
- **Payment.** Unchanged (ADR 0010), plus: a payment that is less than open by the Skonto the
  terms offered, paid within the Skonto days, is allocated and the rest written off as `skonto`
  by code. Any other shortfall below a limit in the settings (default CHF 5, the limit named
  when hit) is proposed as a write-off `fee`. Anything larger stays open and asks the person.
- **Write-off.** «Rest ausbuchen» on an invoice with something open: reason, date, amount.
- **Set-off.** Issuing an invoice to a customer with a credit note `settlement: 'offset'` still
  to set off adds a deduction line «Gutschrift GS … verrechnet» (the person may remove it), and
  records the offset on both documents.
- **Re-billed costs.** On a draft, «Spesen weiterverrechnen» lists the customer's receipts
  (tagged with the customer or a project dimension, or picked by hand) not yet re-billed. Each one
  becomes a line at its net amount and at the supply's rate (MWSTG Art. 24 Abs. 1), with
  `source.receiptId`, so it is never re-billed twice.
- **Hours.** «Stunden übernehmen» takes a table (pasted, or a CSV the workspace source produced)
  of date, text, hours and rate, and makes lines grouped by text or one per row, as the person
  picks.

### 4.5 How each event is booked

Cash basis = `company.vat.reporting: received`. Agreed = `agreed`. The codes are those of
`modules/ch/tax-codes.yaml`. «Net rate» means `method: net-rate`, «none» means not registered.

| Event | Cash basis | Agreed basis |
|---|---|---|
| Quote, order confirmation, delivery note | nothing | nothing |
| Invoice issued (also partial or final) | nothing (open item in `invoices.json`) | `RE-<n>`: 1100 / revenue, the sale codes per rate (V81, V26, V38; V0-E / V0 abroad or export; F1 or F2 by `activity` on the net rate; no code when not registered), its date. Exists, plus `activity` |
| Final invoice with deductions | its payment books the revenue split of its own lines, deductions included (the remainder) | `RE-<n>` for its total, which is already the remainder |
| Payment | bank / revenue with the codes, split like the invoice (exists) | bank / 1100, exchange difference on 6960 (exists) |
| Prepayment before the invoice | as a payment | taxed on its day, the event rebooked for the rest (exists, `prepaidEvent`) |
| Credit note, cancellation | as today (refund with minus codes; storno not booked) | `GS-<n>`, `RE-<n>-storno` (exists) |
| Write-off `skonto` or `discount` | nothing: what was never received was never taxed | `RE-<n>-wo-<k>`: 3800 Erlösminderungen / 1100 with the minus sale codes, split like the invoice (MWSTG Art. 41 Abs. 1) |
| Write-off `loss` | nothing | `RE-<n>-wo-<k>`: 3805 Verluste aus Forderungen / 1100 with the minus sale codes. If the customer pays later, the payment books revenue with the sale codes again (Art. 41: when received) |
| Write-off `fee` or `rounding` | nothing | as `discount`, on 3800 |
| Reminder fee, default interest paid | revenue without a code on `feeAccount` (exists for fees), interest on a financial income account | same, from the payment; not booked on issue (not consideration, MWSTG Art. 18 Abs. 2 lit. i) |
| Set-off of a credit note | the invoice's payment is smaller; its revenue split takes the deduction line | `RE-<n>` already holds the deduction line; the credit note's `GS-<m>` stands; `RE-<n>-off-<m>` 1100 / 1100 is not needed if the deduction line is on the invoice. Open question 7.6 |
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
| Import of customers and open invoices from a table (the switch from another tool) | The mapping of one tool's export columns (bexio, Banana, a spreadsheet) |

No branch for one bank, tracker, eBill partner or tool goes into the app.

### 4.8 UI

The new UI's rules apply (`docs/redesign/architecture.md`, AGENTS.md «UI links», «UI theming»).
Rechnungen stays one area (`src/app/areas/invoices/`) with list and detail (`Split.tsx`).

- **Route** (`src/app/shell/route.ts`, `docs/urls.md`): `view` gains `quotes`, `articles`,
  `recurring`, `open-items`. A quote is `/invoices/OF-2026-004`. A delivery note is
  `/invoices/LS-2026-002`. A recurring template is `/invoices/recurring/<id>`. `status` gains
  `quote-open`, `accepted`.
- **List:** the tabs Rechnungen · Offerten · Kunden · Artikel · Wiederkehrend · Offene Posten ·
  Versendet. Offene Posten lists every invoice with something open, by customer, with age bands
  (0–30, 31–60, 61–90, > 90 days). It is printable (Debitorenliste, year end and audit) and
  exports to CSV.
- **Detail:** the A4 sheet as today. New buttons by state: «In Rechnung umwandeln» (quote),
  «Akontos abziehen» (final), «Rest ausbuchen» (open), «Zahlungsaufforderung» (retention due),
  «Lieferschein» (from an invoice or a quote). The margin shows `from`, the partial invoices of a
  final invoice, the write-offs, and the bookings each event made (links to `/journal/<id>` with
  `hrefOf`).
- **Mahnlauf:** a dialog (an action, not a place) with the proposed list, the totals and one
  «Senden». Limits are named when hit («40 Mahnungen, 12 weitere nicht: höchstens 40 pro Lauf»).
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
  goal; open question 7.8.

### 4.10 Tests and golden master

- Pure rules in `tests/invoices.test.ts` style: deductions, schedule, write-off amounts per rate,
  Skonto detection, offset, numbering patterns (QRR fits in 26 digits, SCOR in 21 characters),
  F1 (EUR never QRR), F3 (`activity` → F1/F2).
- Booking per basis: `tests/invoice-payments.test.ts` and a new `tests/invoice-events.test.ts` for
  each row of 4.5, on cash and agreed basis, each VAT setup (effective, net rate, none), and a
  write-off of an invoice of a filed period (dated open, `corrects` where due).
- API: a row in `tests/period-lock.test.ts` for every new route that writes the books.
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

---

## 5. Phases

Each phase ends with a persona walk in the `verify` skill, scored 0/1/2 per checkpoint as
`first-run.md` defines. A phase is done when each checkpoint scores 2.

### Phase 1: correct and closed (smallest valuable slice)

Scope: F1 (QR-IBAN/QRR CHF only), F2, F3 (`activity` on lines for two net rates), **write-off**
(«Rest ausbuchen»: skonto, discount, loss, fee; booked on the agreed basis as in 4.5), **Skonto in
the terms** recognised on payment, **open-items list** (Offene Posten, by customer, with age,
printable, CSV), **units** m², m, m³, l, kg, month, **title and subtotal lines**, and the
`invoicing:` section in the three demos that lack it. One `invoices.json` step (2→3: `writeOffs`,
line `kind`, `activity`, units) and one manifest step (Skonto, write-off accounts).

Why first: it closes what is wrong or stuck today (F1 is in force from today's SIC release, F4
leaves invoices open forever and VAT declared on money never received on the agreed basis). It
touches no new document kind and keeps the golden figures of the existing demos.

Acceptance (persona `invoices.md`, Sandra, and the consultant):

| # | Checkpoint | 2 means |
|---|---|---|
| P1.1 | EUR invoice with a QR-IBAN set | the setting is refused with words; an EUR invoice prints SCOR with the plain IBAN |
| P1.2 | Painter's invoice by m² with a title line per room and a subtotal | sheet and PDF correct, totals per rate right, Art. 26 check passes |
| P1.3 | Payment 2 % short within the Skonto days | the invoice reads «bezahlt», the Skonto written off by code; on the agreed basis a `-V81` entry on 3800 equals 2 % of the gross |
| P1.4 | Customer gone bankrupt | «Rest ausbuchen» as loss in three clicks; cash basis: no entry; agreed: 3805 / 1100 with `-V81`; the MWST tab shows the reduction in the open quarter |
| P1.5 | Offene Posten on 31.12. | matches the year-end receivables proposal to the Rappen; prints and exports |
| P1.6 | Schreinerei with two net rates | a line marked as the second activity books F2; the half year's form shows it in the second rate's row (333; the box numbers are marked uncertain in AGENTS.md) |
| P1.7 | Treuhänderin without AI | P1.2–P1.5 done by hand, no AI asked |

### Phase 2: quotes, partial and final invoices, retention

Scope: `quote` with its series, sending, accept or decline, «In Rechnung umwandeln»; order
confirmation as the quote re-sent under its title; partial and final invoices with «Akontos
abziehen»; retention and instalment notices (`schedule`); delivery note. `invoices.json` step
for the new kinds, `from`, `role`, `deducts`, `schedule`.

Acceptance (Sandra and the Schreinerei):

| # | Checkpoint | 2 means |
|---|---|---|
| P2.1 | Offerte for a facade, sent, accepted | quote PDF, its own number, `accepted`; no booking |
| P2.2 | Two Akonto invoices, then the final invoice | the final invoice lists the whole work, deducts both partial invoices with their VAT, its QR-bill asks for the remainder; agreed basis: three events whose sum is the whole; cash basis: the three payments' revenue is the whole |
| P2.3 | Retention 5 % until acceptance | QR-bill for 95 %; on the due day a fact in the list; the instalment notice with its own QR-bill pays the rest, matched by the same reference |
| P2.4 | Final invoice while an Akonto is unpaid | the unpaid partial invoice stays open on its own; nothing is counted twice |

### Phase 3: recurring, hours, re-billed costs, articles

Scope: recurring templates (draft, issue or send on their day), the lines import contract (paste
or CSV), «Spesen weiterverrechnen» from receipts, the article list with rate and price, customer
defaults (currency, account, discount, number, contacts), set-off of credit notes (F5). Further
`invoices.json` step (`articles`, `recurring`, customer fields, `offsets`, line `source`).

Acceptance (the consultant and the webshop):

| # | Checkpoint | 2 means |
|---|---|---|
| P3.1 | Monthly retainer | on the 1st the draft (or the sent invoice) is there without a click; a mail failure is a task with words |
| P3.2 | 37.5 hours from a CSV of the tracker | the lines are on the draft, grouped as chosen; a workspace source the AI wrote reads the tracker's own export |
| P3.3 | Train and hotel re-billed | the receipts become lines at the supply's rate, net; the same receipt is never offered twice |
| P3.4 | Wholesale invoice: coffee 2.6 % and grinders 8.1 % from the article list | both rates right on paper and in the books |
| P3.5 | Credit note set off against the next invoice | the next invoice carries the deduction line; both documents show it |

### Phase 4: dunning run, interest, currencies, import, delivery channels

Scope: «Mahnlauf» with levels from the settings, default interest, customer stop; currencies
beyond CHF and EUR (no QR-bill, bank details only); import of customers and open invoices from
a table at the switch; the delivery channel contract and a reference eBill source in the
workspace (ADR 0015); QR «billing information» (Swico S1) if open question 7.7 says yes.

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
  happen without a person. Before phase 3, the owner decides whether one device issues
  (open question 7.4).
- **Agreed-basis write-offs of filed periods** must follow golden rule 1 and the `eventPlan`
  logic (`events.ts`): dated open, `corrects` when the firm reported on the agreed basis then.
  This needs the same reviews as any change under `src/accounting`.
- **Golden master churn** from the new demo invoices: one figure change per demo, reviewed once,
  marked **⚠ figures**.

---

## 7. Open questions for the owner

Each question has a recommendation.

1. **Format steps.** Phase 1 needs one `invoices.json` step (2→3) and one manifest step. Phases
   2 and 3 each need another `invoices.json` step. Approve the steps per phase, or one larger
   step up front? *Recommendation:* one step per phase, so each release migrates only what it
   uses.
2. **New refs in the books** (`RE-<n>-wo-<k>`, possibly `-off-`). Do they count as a books format
   change? *Recommendation:* no shape change, so no `schema` step. Name them in `src/books/refs.ts`
   and in the CHANGELOG.
3. **Write-off on the cash basis** books nothing. Should it still leave a trace in the books (a
   0.00 note entry) for the auditor? *Recommendation:* no entry. The write-off is on the invoice
   record and in the open-items list, with date, reason and person. An entry without an amount
   breaks no rule but explains nothing the record doesn't.
4. **Who issues on which device.** Recurring invoices issue without a person. *Recommendation:*
   issue only on the device that holds the books (the desktop app or `npm start`). A clone
   without that role only drafts. Revisit if collaboration (ADR 0003) ships.
5. **Quote numbers.** Are quotes in their own series (`OF-YYYY-NNN`), or in the invoice series?
   *Recommendation:* their own series. Invoice numbers are the one gapless sequence customers and
   auditors expect, and declined quotes would leave gaps.
6. **Set-off of a credit note**: a deduction line on the next invoice (one document, simple
   booking), or an allocation between the two records with no line? *Recommendation:* the
   deduction line. It is what the customer reads, the QR amount is right, and the booking falls
   out of the existing revenue split.
7. **QR «billing information» (Swico S1)** in the QR code, for customers whose software reads it?
   *Recommendation:* yes, in phase 4, if `swissqrbill` supports it. Otherwise a small encoder in
   `src/providers/qr-bill/`.
8. **Romansh** document texts and QR headings? *Recommendation:* not now. Add it when a persona
   asks.
9. **Retention proof (GeBüV Art. 9 Abs. 1 lit. b).** PDFs carry SHA-256 and live in git, but have
   no trusted time stamp. Enough? *Recommendation:* enough for this target group, since git
   history and seals make changes visible. Note it in `docs/audit-export.md` and revisit with an
   auditor.
10. **Default interest** on reminders: off by default, or 5 % (OR Art. 104 Abs. 1)?
    *Recommendation:* off by default and offered in the settings. Most small firms do not charge
    it, and a wrong interest line on a reminder costs a customer.
11. **Simple receipt (Quittung)** for the coiffeur and cash sales: a document kind of its own, or
    an invoice marked paid at issue? *Recommendation:* an invoice paid at issue (cash or TWINT
    named), with a «Quittung» title. It needs no new record and books like any invoice paid on
    its day.
12. **Currencies beyond CHF and EUR** in phase 4, or earlier for the consultant? *Recommendation:*
    phase 4. No persona has a non-EUR client today.

## Sources

- MWSTG Art. 8, 18, 23, 24, 26, 27, 37, 40, 41, 42, 70, as published (via
  justement.ch, text of fedlex).
- MWSTV Art. 45, 57, 106.
- OR (SR 220) Art. 102, 104, 958f. GeBüV (SR 221.431) Art. 9.
- SIX, Swiss Implementation Guidelines for the QR-bill, v2.4 of 24.02.2026:
  <https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.4-en.pdf>
- ESTV, Saldosteuersätze und Pauschalsteuersätze:
  <https://www.estv.admin.ch/de/mwst-saldosteuersaetze-pauschalsteuersaetze>; MWST-Info 12.
- eBill: <https://ebill.ch>.
