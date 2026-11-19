# Spec: invoicing (Verkauf) after the market leader's approach

Status: decided 2026-11-19, on `0.6.0` (owner questions O1 to O4 answered the same day, section 7;
the sent state made visible at a glance, 4.8). The owner decided that day that invoicing follows the
concept of the Swiss market leader closely, because «many in Switzerland are used to that
concept». This version replaces the concept of 2026-11-14/15: the documents, their chain, the
statuses, the terms and the phases now follow the market leader's way of working, with Swiss
standard terms (Angebot, Auftrag, Lieferschein, Rechnung, Gutschrift, Artikel, Positionen,
Mahnung, Zahlungseingang). Section 8 lists every decision of 2026-11-15 that changed, old → new
and why. What stays: MISSION.md (code first, the AI where judgement is needed, everything doable
by hand), ADR 0015 (no branch for one vendor), «warn, then the person decides» (4.11), values that
change over time (4.12), i18n, golden rule 1 on filed periods, and the cash- and agreed-basis
bookings already built.

The comparison behind this rewrite is a teardown of the market leader's invoicing (an internal
review; nothing of its look, texts or labels is copied here, only patterns and Swiss domain
terms). The prototype of 2026-11-15 in [mockups/invoicing/](mockups/invoicing/index.html) still
shows the earlier concept; section 6.1 lists what must change in it.

This spec builds on [ADR 0010](../adr/0010-invoicing.md) (invoicing in the same app, paid
invoices matched by their reference; amended 2026-11-19) and [ADR 0012](../adr/0012-invoice-pdfs.md)
(PDFs). It follows [MISSION.md](../../MISSION.md) for who does the work and
[ADR 0015](../adr/0015-base-cases-in-the-app-long-tail-in-the-workspace.md) for what is in the app
and what is in the workspace. Sections 1 to 3 report what exists and what applies. Section 4 sets
out the concept, section 5 the phases, section 7 the decisions, section 8 the changes.

---

## 1. What exists today

Invoicing is not a stub. Drafts, issuing, the QR-bill, e-mail, reminders, credit notes,
cancellations, payment matching and the agreed-basis events all work end to end, and 16 test
files cover them. What is missing is the work before the invoice (Angebot, Auftrag, Lieferschein,
Artikel, Leistungen), the partial and recurring invoices, and the work after it (Ausziffern of
short payments, write-offs, the Mahnlauf, the open-items list).

### 1.1 Inventory

| Capability | Where | State |
|---|---|---|
| Data: customers, invoices (drafts and issued), credit notes, reminders, sent documents, comments, each with the ADR 0004 envelope | `src/invoices/model.ts`, `invoices.json` (owner: `src/invoices/store.ts`; ladder `INVOICES_SCHEMA = 2` in `src/workspace/schema.ts:72`) | done |
| Settings: `payTo` per currency (ledger account, IBAN, optional QR-IBAN), revenue account, fee account, payment term, layout, texts per language | `InvoicingSettings` in `model.ts`, parsed in `src/workspace/manifest.ts:150-165` (`belege.workspace.yaml` `invoicing:`) | done |
| Outgoing mail through the firm's own mailbox (SMTP, password in the secret store) | `src/invoices/mail.ts`, `OutgoingMail` in `model.ts`, Firma › E-Mail-Versand (`src/app/areas/company/MailSection.tsx`) | done; one recipient, no CC, no mail templates |
| Customers: name, attn, structured address in any country, language, VAT number (CHE UIDs checked by check digit), e-mail, payment term | `CustomerFields` `model.ts`, `parseCustomer` `service.ts`, address forms per country `src/app/areas/invoices/address.ts` | done; no persons, no contact persons, no extra addresses, no customer number, no default currency or account, no import |
| Lines: text, quantity, unit, price, VAT rate, «VAT included» flag, revenue account per line | `InvoiceLine` `model.ts`, totals per rate to the Rappen `rules.ts totals` | done; units only `h, day, pcs, flat, km` (`model.ts:18`); no text, subtotal or discount positions, no article list |
| Currencies | `INVOICE_CURRENCIES = ['CHF', 'EUR']` `model.ts:12` | CHF and EUR only |
| Languages of the document | `de, fr, it, en` `model.ts:8`, texts `src/invoices/texts.ts` | done |
| Check before issue: what MWSTG Art. 26 asks, plus an account to pay to | `missingForIssue` `rules.ts`; the UI names each gap and links to where it is fixed (`tests/invoices-fixes.test.ts`) | done |
| Issue: number `YYYY-NNN` (next of the invoice year, cancelled ones count, shared by invoices and credit notes), due date, payment reference, frozen copy of customer, sender and layout, PDF printed once with SHA-256 | `issue`, `nextNumber` `rules.ts`; `issueInvoice` `service.ts` (one printing change at a time per process, `serial`) | done; the format is fixed; ADR 0010's «issuing pulls main and pushes» is not built |
| QR-bill: QRR with a QR-IBAN, SCOR otherwise; payment part on the last sheet or a sheet of its own; only for a CH or LI IBAN | `src/providers/qr-bill/reference.ts`, `sheet.ts payment / hasQrBill`, library `swissqrbill` ^4.4.2 | done; see finding F1 (#506) |
| PDF and sheet: A4, C5 window left or right, logo, accent colour, two fonts, elements on or off, pagination with a repeated table header | `src/invoices/sheet.ts`, `pdf.ts`, Firma › Rechnungslayout (`src/app/areas/company/InvoiceLayout.tsx`) | done; one layout per firm |
| Draft edited on the A4 sheet itself | `src/app/areas/invoices/Sheet.tsx`, `edit.ts` | done |
| Sending by e-mail (the PDF byte for byte) or as a download; every sent document kept with checksum, time, recipient and Message-ID | `recordSend`, `printOwnDocument` `service.ts`; `SentDocument` `model.ts` | done |
| Reminders: levels 1 to 3, due in 10 days, optional fee (no VAT), texts editable before sending | `reminderDraft` `rules.ts`, `sendReminder` `service.ts` | by hand only; no level list, no Mahnlauf, no default interest, no stop per customer |
| Credit notes: whole invoice or an amount (gross, split over the rates or at one rate), refund or set off; never more than the invoice | `creditNoteDraft`, `refundDue` `rules.ts` | done; «set off» is a flag only (F5) |
| Cancellation (Storno) with date and reason, optional notice; refused on a paid invoice | `cancel` `rules.ts`, `cancelInvoice` `service.ts` | done |
| Internal comments | `addComment` `service.ts` | done |
| Payment matching on import: by QR or SCOR reference, else by the number in the text when the amount is what is open; a credit note's refund by its number; anything less sure is proposed; «Lösen» undoes a link | `src/invoices/payments.ts` | done; no allocation of one payment over several invoices, no payment entered by hand |
| Booking on the cash basis: a payment books revenue from the invoice's lines and codes (V81, V0-E, V0, F1, none), the invoice PDF as its receipt | `bookPayment`, `revenueSplit`, `revenueVatCode` `rules.ts` | done |
| Booking on the agreed basis: `RE-<number>`, `GS-<number>`, `RE-<number>-storno`; payments settle 1100, exchange difference on 6960; prepayment taxed on its own day (MWSTG Art. 40 Abs. 1 lit. c) | `src/invoices/events.ts`, `src/books/refs.ts`, `src/accounting/tax-point.ts` | done |
| Foreign currency: the ESTV daily sell rate of the tax point | `ctx.fx.daily` in `events.ts` and `payments.ts`, `src/accounting/fx-rates.ts` | done |
| Firm not registered: the only rate is 0, no exemption asked, no «MWST» after the UID | `chargesVat`, `invoiceRates` `src/engines/index.ts`, `tests/firms-invoices.test.ts` | done |
| Net tax rate method: statutory rates printed, revenue booked with F1 | `revenueVatCode` `rules.ts:381` | partly; F3 (#504) |
| Year end: invoices open on 31.12. proposed as receivables (1100) | `openOn` `rules.ts`, [year-end.md](../year-end.md) | done; no open-items list of its own |
| AI: drafts an invoice (also for a new customer) and changes the invoicing settings | `invoiceDraft`, `invoicing` changes in `src/assistant/changes.ts` | done; the AI cannot issue, send or remind (by design) |
| The firm's own invoices made in another tool, dropped as PDFs | CHANGELOG #365, #382; `src/accounting/sale-document.ts` | done; not records in `invoices.json` |
| UI: Rechnungen with list, customers and sent log; detail with the A4 sheet, state, actions and margin | `src/app/areas/invoices/*`, routes `/invoices`, `/invoices/<number>`, `/invoices/draft-<id>` (docs/urls.md) | done |
| API | `src/server/routes/invoices.ts` (24 routes) | done |
| Demos | `demo/` only (`tools/demo/invoices.ts`) | the three other demos have no `invoicing:` section |
| Tests | 16 files from `tests/invoices.test.ts` to `tests/invoice-print-failed.test.ts` | broad |

### 1.2 Findings to fix regardless of new features

- **F1 QR-bill v2.4: QR-IBAN and QR reference are for CHF only (#506).** SIX Implementation
  Guidelines for the QR-bill, version 2.4 of 24.02.2026, in force with the SIC release of 13
  November 2026: «For invoicing in euros (EUR), only the combination IBAN/SCOR reference and
  IBAN/unstructured message is possible» (chapters 2.8, 2.10, 2.12, 4.2.2, 4.3.2). Version 2.3
  remains valid until November 2027. `manifest.ts:161` accepts a `qrIban` under `payTo.EUR`, and
  `referenceFor` then gives a QRR reference to a EUR invoice. Fix: a `qrIban` under any currency
  but CHF warns (4.11); without «Trotzdem speichern» a EUR invoice uses the plain IBAN and SCOR. An
  issued invoice keeps what it printed. Also check that `swissqrbill` writes only structured
  addresses (v2.3, chapter 4.2.2).
- **F2 Citation.** The code says the supply date is Art. 26 Abs. 2 lit. d MWSTG. The law has it
  under lit. c. A comment fix.
- **F3 Two net tax rates (#504).** `revenueVatCode` falls back to `netRateCode(1)` for every rate
  (`rules.ts:383`). A firm approved for two net rates books every line on F1. The position needs the
  activity it belongs to (4.4.3).
- **F4 Paid less, forever open (#505).** A customer who takes Skonto, or whose bank keeps a fee,
  leaves the rest open with no way to close it; bad debts cannot be written off. On the agreed basis
  the VAT on the unpaid part stays declared (MWSTG Art. 41 Abs. 1). Closed by the Ausziffern of 4.4.6.
- **F5 «Set off against the next invoice»** (`settlement: 'offset'`) is printed on the credit
  note, but nothing carries it to the next invoice. Closed by the Verrechnung of 4.4.6.

---

## 2. The personas and what they need

The verify personas are in `.claude/skills/verify/personas/`: `first-run.md` (painter, Malerei
Huber GmbH), `invoices.md` (the painter's office writes invoices), `first-run-consulting.md`,
`first-run-webshop.md`, `other-firms.md` (coiffeur, webshop, IT consultant, Schreinerei),
`treuhaender.md`.

| Persona | Firm (VAT setup) | Invoices a year | What they write | Must have | Nice to have |
|---|---|---|---|---|---|
| **Painter** (Sandra for Malerei Huber) | GmbH, effective, cash basis, quarterly | 80–200 | Angebot → Auftrag → for big jobs Akontorechnungen → Schlussrechnung less the Akonto amounts; Regie by hours plus material; m² and running metres; Rabatt; Skonto | Angebot and conversion; m², m, l, kg; text and subtotal positions; Akonto and Schlussrechnung with deductions; discount position; Skonto and write-off of the rest; Mahnungen with fee | retention (Rückbehalt) as a second due date; materials from the receipts of the job; a Rapport PDF attached |
| **Consultant** (Matthias, Kälin Advisory GmbH) | GmbH, effective, cash basis | 30–80 | monthly invoices by hours per client; a monthly retainer; one client in Berlin in EUR (service abroad, Ziffer 221); expenses re-billed | recurring Auftrag; Leistungen by the hour from a table or CSV; EUR invoice with the customer's VAT number and the place-of-supply note (exists); re-billed costs; write-off of a foreign bank's fee | USD invoices; a tracker's export read by a workspace source |
| **Webshop** (`demo/`, a coffee roaster as GmbH) | effective, cash basis | shop sales from the provider; 20–60 B2B invoices | wholesale to cafés: coffee at 2.6 % and accessories at 8.1 % on one invoice; returns as Gutschriften; a German shop in EUR (export, Ziffer 220) | Artikel with rate and price; Auftrag and Lieferschein; mixed rates (exists); Gutschrift for a return (exists) | customer discount |
| **Coiffeur** (`demo-coiffeur/`, Einzelfirma) | not registered | a few | an invoice for a company event or a wedding | invoice without VAT (exists); a Quittung for a cash or TWINT payment | voucher sale and redemption |
| **Schreinerei** (`demo-schreinerei/`, GmbH) | net tax rate 4.5 %, half-yearly, cash basis | 40–100 | Angebot, Akonto for kitchens and cabinets, Schlussrechnung; often «inkl. MWST» prices | Angebot; Akonto and Schlussrechnung; statutory rate on paper and F1/F2 per activity (F3); prices incl. VAT per document | retention |
| **Treuhänderin** (Monika, 40 firms, no AI) | any | issues for clients in full service | the same documents by hand, fast; the open items of the old tool at the switch | everything without the AI; import of contacts and open invoices; Offene Posten per customer with age; Kontoauszug; invoice journal export | Mahnlauf with one confirmation |

What they share: one Swiss way of selling that most of them know from the market leader (Angebot →
Auftrag → Lieferschein → Rechnung → Zahlungseingang → Mahnung), a document the customer pays with
one scan, the money found without a click, VAT right on paper and in the books, and the paper kept as
sent.

---

## 3. Swiss requirements, checked against the sources

| Topic | Rule | Source | App today |
|---|---|---|---|
| Invoice content | The invoice identifies supplier, recipient and supply, and as a rule contains: (a) name and place of the supplier, that it is registered, and its number; (b) name and place of the recipient; (c) date or period of the supply if it differs from the invoice date; (d) kind, object and extent of the supply; (e) the consideration; (f) the rate and the tax owed; if the price includes the tax, the rate is enough. | MWSTG Art. 26 Abs. 2 | checked by `missingForIssue` |
| Till receipts | Receipts from automated tills need no recipient below CHF 400; no refund in the refund procedure. | MWSTG Art. 26 Abs. 3; MWSTV Art. 57 | not built and not planned: the Quittung (decision 7.11) names its recipient |
| VAT shown wrongly | Someone not in the register may not mention the tax on an invoice. A tax shown without right, or too high, is owed unless the invoice is corrected. | MWSTG Art. 27 Abs. 1, 2 | not-registered firms print no VAT (exists); the reason a sent invoice is never edited in place (4.4.2) |
| Net tax rate | The tax is the gross taxable turnover times the approved net rate. Invoices show the statutory rates, never the net rate. | MWSTG Art. 37 Abs. 2; ESTV MWST-Info 12, Ziff. 1.2 | statutory rates printed (exists) |
| When the tax arises | Agreed basis: with the invoice; with each partial invoice or partial payment; on receipt for prepayments and for supplies without an invoice. Cash basis: on receipt. | MWSTG Art. 40 Abs. 1 lit. a–c, Abs. 2 | events and prepayment (exist) |
| Later changes of the consideration | When the consideration is corrected (discount, Skonto, a loss), the tax is adjusted when the correction is booked or the corrected amount received. | MWSTG Art. 41 Abs. 1 | missing (F4) |
| Damages and fees | Damages and similar payments are not consideration. A reminder fee or default interest carries no VAT. | MWSTG Art. 18 Abs. 2 lit. i | fee without VAT (exists); no interest |
| Re-billed costs | The consideration includes reimbursed costs even when billed separately; re-billed expenses carry the rate of the supply. | MWSTG Art. 24 Abs. 1 | possible as a line; no help |
| Foreign currency | Convert at the time the tax arises, with the ESTV's monthly mean or daily sell rate, held for at least one tax period. | MWSTV Art. 45 Abs. 1–3, 5 | daily sell rate of the tax point (ADR 0001, exists) |
| Switch of basis | On a switch from cash to agreed, the tax on the receivables open at the switch is declared in the next period, and the reverse on a switch back. | MWSTV Art. 106 | `lockedTaxPoint`, `eventPlan` (exist) |
| Supplies abroad | Service with place of supply abroad (Art. 8) or export of goods (Art. 23): no Swiss VAT, with the reason on the invoice. | MWSTG Art. 8, 23 | `exemption: abroad | export` with the printed note (exists) |
| Retention | Books and records 10 years from the end of the business year, faithful and readable. VAT records until the absolute limitation. | OR Art. 958f Abs. 1, 3; MWSTG Art. 70 Abs. 2, 3; Art. 42 Abs. 6 | issued PDFs stored once with SHA-256 (exists) |
| Storage medium | Changeable media are allowed when integrity and the time of storage are provable. | GeBüV Art. 9 Abs. 1 lit. b | SHA-256 per PDF, git history (decision 7.9) |
| Default and dunning | A debt that is due falls into default through a reminder; with an agreed payment day, when it passes. Default interest 5 % a year unless more was agreed. No legal number of reminders, no legal fee; a fee must be agreed to be claimed. | OR Art. 102 Abs. 1, 2; Art. 104 Abs. 1 | 3 levels, optional fee; no interest |
| QR-bill | QR-IBAN only with QRR; IBAN with SCOR or no reference. Structured addresses only since v2.3. QR-IBAN and QRR for CHF only since v2.4. «Billing information» (Swico S1, Annex D). | SIX IG QR-bill v2.4 (24.02.2026) | QRR/SCOR (exists); F1; no billing information |
| eBill | Invoices into the payer's e-banking, through a network partner. | ebill.ch (SIX) | none |

**Retention in the app:** an issued invoice's PDF is the receipt of its booking (`invoiceReceipt`
in `events.ts`). Deleting an issued invoice is not possible today and stays impossible.

---

## 4. The concept

### Terms

The app and its documents use these names. The code names are those of `src/invoices/`.

| Term (de) | fr / it / en | Code | Meaning |
|---|---|---|---|
| Verkauf | Vente / Vendita / Sales | area `invoices` | The area: every document below, Kontakte, Artikel, Leistungen, Offene Posten |
| Angebot | Offre / Offerta / Quote | `quote` | What the firm offers; no booking |
| Auftrag | Commande / Ordine / Sales order | `sales-order` | What the customer ordered; the hub of delivery, partial and recurring invoices. Printed as «Auftragsbestätigung» or «Proformarechnung». Not the same as a Bestellung, a customer's order from outside the app (domain-model.md §2.3), which can become an Auftrag |
| Lieferschein | Bulletin de livraison / Bollettino di consegna / Delivery note | `delivery-note` | What was delivered of an Auftrag; no prices, no booking |
| Rechnung | Facture / Fattura / Invoice | `invoice` | The claim; booked. A Teilrechnung (`role: 'partial'`, also Akontorechnung) or a Schlussrechnung (`role: 'final'`) is a Rechnung |
| Gutschrift | Note de crédit / Nota di credito / Credit note | `credit-note` | A reduction of a Rechnung, applied to it, to another, or paid back; booked |
| Mahnung | Rappel / Sollecito / Reminder | `reminder` | A reminder of one Rechnung at a Mahnstufe; the first level is usually named «Zahlungserinnerung» |
| Kontoauszug | Relevé de compte / Estratto conto / Account statement | `statement` | A contact's open and paid items as a PDF; no booking |
| Position | Position / Posizione / Position | `InvoiceLine` | A line of a document: Artikel, Standard, Text, Zwischentotal, Rabatt, Seitenumbruch, Leistung, Spesen |
| Artikel | Article / Articolo / Article | `Article` | A product or service with code, unit, price, VAT kind, revenue account |
| Tätigkeit | Activité / Attività / Activity | `Activity` | A kind of work with a default hourly rate and revenue account |
| Leistung | Prestation / Prestazione / Time entry | `TimeEntry` | Hours of a Tätigkeit for a contact, billable, «verrechnet» once on an issued Rechnung |
| Kontakt | Contact / Contatto / Contact | `Contact` | A firm or a person; customers are contacts |
| Kontaktperson | Personne de contact / Persona di contatto / Contact person | `Contact.persons` | Who a document goes to at a firm |
| Zahlungskondition | Condition de paiement / Condizione di pagamento / Payment terms | `PaymentTerms` | Days to pay, optional Skonto, a text for the paper |
| Zahlungseingang | Paiement reçu / Pagamento ricevuto / Payment received | `Payment` | Money received for a Rechnung: from the bank statement, or entered by hand |
| Ausziffern | Lettrage / Pareggio / Allocation | `Allocation` | Assigning a payment, a Gutschrift or customer credit to open items, and deciding what becomes of a rest |
| Verrechnung | Compensation / Compensazione / Set-off | `Allocation` of a Gutschrift | A Gutschrift or customer credit applied to an open Rechnung |
| Ausbuchung | Passation en perte / Stralcio / Write-off | `WriteOff` | The rest of a Rechnung closed as Skonto, Rabatt, Verlust, Spesen or Rundung |
| Kundenguthaben | Avoir client / Credito cliente / Customer credit | `Credit` | Money a customer paid beyond what was due, held for the next Rechnung or paid back |
| Mahnlauf | Relance groupée / Sollecito collettivo / Dunning run | dialog | All overdue Rechnungen at once, one confirmation |
| Belegkette | Chaîne de documents / Catena di documenti / Document chain | derived from `from` | Angebot → Auftrag → Lieferschein → Rechnung → Gutschrift, each a link |
| Vorlage | Modèle / Modello / Template | `Template` | Layout, letterhead and texts of a document kind |

### 4.1 Goals

1. A firm that comes from the market leader finds the same way of selling: the same documents, the
   same chain, the same status names, the same Swiss terms. Nothing has to be learned anew except
   that more is done by code.
2. Every persona of section 2 writes every document of a normal year in the app, without help, and
   the document is correct under section 3.
3. Each document is booked as its basis and VAT setup require (4.5), by code, with no question to
   the person except what only she knows.
4. A status is a fact: issued, sent, paid, delivered, invoiced come from the issue, the sent log, the
   bank statement and the documents that follow. Only what the customer alone knows is a click.
5. Work after the invoice is visible as a fact: what is open, since when, what was reminded. A
   Mahnlauf is one dialog and one confirmation.
6. Everything the AI does in this area, a person can do by hand (MISSION.md), also the Treuhänderin
   without a subscription.

### 4.2 Non-goals

- **A timer and project management.** Leistungen (time entries) are records to bill (4.4.10): typed,
  pasted, read from a CSV or by a workspace source from a tracker's export (ADR 0015). No stopwatch,
  no budgets, no milestones, no rates per employee. A project is the reporting dimension `projekt`
  (`dimensions`, #127).
- **Stock and inventory.** An Artikel has a price and a VAT kind, not a stock level; a Lieferschein
  books no stock.
- **A point-of-sale system.** Shop sales come from the provider's report (`provider:`, AGENTS.md).
- **Payroll, purchase orders, supplier invoices** (other areas).
- **A connector to one bank, eBill partner, payment link or tool in the app** (ADR 0015). The app
  ships the channel and the contract (4.7).
- **A hosted online view of documents with read tracking.** A delivery channel in the workspace may
  add one (4.7).
- **Rights per document kind and «own records only».** Roles stay as ADR 0010 says until
  collaboration (ADR 0003) ships.
- **Debitoren in the books during the year on the cash basis.** The cash basis keeps booking revenue
  at payment, as built (section 8, decision 19).

### 4.3 Data model additions

Everything lives in `invoices.json` (its ladder `INVOICES_MIGRATIONS`) or in the `invoicing:` section
of `belege.workspace.yaml` (manifest ladder). The books' format changes only where marked **books**.
One `invoices.json` step per phase and one manifest step where a phase needs it (decision 7.1).

| Addition | Where | Phase |
|---|---|---|
| `InvoiceLine.kind`: `item` (Standard), `article`, `text`, `subtotal`, `discount`, `pagebreak`, `group` (with `children`), `time`, `expense`; `discount?` (percent per position); `activity?: 1 | 2`; `tags?`; `source?: { receiptId } | { timeEntries: id[] }`; `optional?` | `invoices.json` | 1 (`item`, `text`, `subtotal`, `discount`, `pagebreak`, `activity`, `discount %`); 2 (`article`, `group`, `optional`); 4 (`time`, `expense`, `source`) |
| `prices: 'net' | 'gross'` per document, replacing the line flag `vatIncluded` (read on old lines as `gross`) | `invoices.json` | 1 |
| Units as a list with words per language | `belege.workspace.yaml` `invoicing.units` | 1 (manifest step) |
| `paymentTerms: Array<{ id, name, days, skonto?: { percent, days }, text }>` and a default per kind | `belege.workspace.yaml` | 1 (manifest step) |
| `Issued.terms`: the printed terms (due date basis, Skonto, dunning terms) | `invoices.json` | 1 |
| `payments[]` on an issued Rechnung gains `source: 'statement' | 'hand'`, `account` (for a hand payment) and `linkedTransaction?` | `invoices.json` | 1 |
| `allocations: Array<{ from: { kind: 'payment' | 'credit-note' | 'credit', id }, to: invoiceId, amount, date }>` (Ausziffern, Verrechnung) | `invoices.json` | 1 |
| `writeOffs: Array<{ date, amount, reason: 'skonto' | 'discount' | 'loss' | 'fee' | 'rounding', note? }>` on an issued Rechnung; `openAmount` subtracts it | `invoices.json` | 1 |
| Settings: `writeOffAccount: { skonto, loss }`, `shortfallLimit` | `belege.workspace.yaml` | 1 (manifest step) |
| `kind` gains `quote`, `sales-order`, `delivery-note`; `validUntil` on a quote; `accepted?`/`declined?` with date and person; `from?: { id, kind }`; `ordered?` (the customer's order reference); `printAs?: 'confirmation' | 'proforma'` on an Auftrag | `invoices.json` | 2 |
| `numbering: { [kind]: { format, restartYearly } }`; a migration writes today's format for invoices and credit notes | `belege.workspace.yaml` | 2 (manifest step) |
| `contacts` replace `customers`: `type: 'firm' | 'person'`, `number?`, `persons[]`, `addresses[]` with `billing`/`delivery` flags, `currency?`, `revenueAccount?`, `paymentTerms?`, `discount?`, `noReminders?`, `business?` (knowledge file id), `archived?`; a document gains `personId?` | `invoices.json` | 2 (the ladder step maps each customer to a firm contact with its address) |
| `articles: Array<Envelope & { code?, type: 'goods' | 'service', name, text?, unit, price, vatKind, account?, activity?, group? }>` | `invoices.json` | 2; `price` becomes `Dated` in phase 3 |
| `role?: 'partial' | 'final'`, `InvoiceLine.deducts`, `stages?` on an Auftrag (`{ label, percent? | amount?, date? }`), `schedule?` on a Rechnung (retention, instalments); `SENT_KINDS` gains `instalment`, `statement` | `invoices.json` | 3 |
| `dunning: { levels: [{ name, days, fee?, auto?: { afterDays } }], interest? }` | `belege.workspace.yaml` | 3 (manifest step) |
| `templates: Array<{ id, name, layout, texts, attachment? }>` and a default per kind; e-mail templates per kind and level | `belege.workspace.yaml` | 3 (manifest step) |
| Dated histories (4.12): a contact's addresses and terms, the firm's letterhead, `payTo`, terms, Mahnstufen; an Artikel's price | `invoices.json`, `belege.workspace.yaml` | 3 |
| `repetition?: { every, day, from, until?, start: 'draft' | 'issue' | 'send' }` on an Auftrag | `invoices.json` | 4 |
| `activities`, `timeEntries` | `invoices.json` | 4 |
| `credits: Array<{ contactId, amount, from: paymentId, date }>` (Kundenguthaben) | `invoices.json` | 4 |
| `paidAtIssue?: { means, account }` (Quittung) | `invoices.json` | 4 |
| `INVOICE_CURRENCIES` widens to any ISO 4217 code the ESTV publishes; QR-bill only for CHF and EUR | `model.ts`, manifest `payTo` | 5 (both steps) |
| Refs `RE-<n>-wo-<k>`, `KG-<contact>-<k>` | books (journal entries) | 1 and 4; no `schema` step (decision 7.2) |

Nothing here changes a filed figure. Write-offs, allocations and reclassifications are new events dated
in the open period (golden rule 1).

### 4.4 Flows

```
Angebot ──Auftrag erstellen──► Auftrag ──Lieferschein──► Lieferschein (no prices, no booking)
   │      (positions, qty)       │  │
   │                             │  ├──Rechnung (positions, qty still open)──► Rechnung ──► …
   └──Rechnung erstellen─────────┼──┘
                                 ├──Teilrechnungsplan: Akonto 1..n ──► Schlussrechnung less the Akontos
                                 └──Wiederholung: monthly …  ──on its day by code──► Rechnung (draft, issued, sent)

Rechnung ──ausstellen──► Offen ──senden──► (sent log)
   │                       │
   │   camt.053 import ──reference / number──► Zahlungseingang ──► Teilbezahlt │ Bezahlt (4.5)
   │   Zahlungseingang by hand (cash, another account)
   │   Ausziffern: one payment over several Rechnungen, rest: offen │ Skonto │ Verlust │ Spesen
   │                       │
   │   overdue (a fact) ──Mahnung / Mahnlauf──► Mahnstufe 1..n (+ fee, + interest)
   │                       │
   └──Gutschrift (positions or amount) ──► applied to the Rechnung │ to another │ paid back
```

#### 4.4.1 Document kinds and the chain

- **One record shape and one editor** for every kind: the A4 sheet of today's `Sheet.tsx`, with
  positions, preview, issue, send. The kind decides the title, the number series, what the paper
  shows and whether anything is booked (only Rechnung and Gutschrift).
- **The Auftrag is the hub.** Delivery notes, partial invoices and the repetition of an Abo hang on
  it. Each of its positions knows what was delivered and what was invoiced of it (`delivered`,
  `invoiced`, derived from the documents made from it, never typed). An Auftrag can collect a month
  of work and be invoiced once.
- **Conversions.** From an Angebot: «Auftrag erstellen» or «Rechnung erstellen». From an Auftrag:
  «Lieferschein erstellen» or «Rechnung erstellen». From a Rechnung: «Gutschrift erstellen». Each
  conversion shows the positions with the quantity still open, each ticked and editable; the new
  draft gets the ticked positions with their text, quantity, unit, price, rate, account and tags,
  and `from` set. Leaving nothing ticked copies nothing and says so. A Lieferschein comes only from
  an Auftrag (the chain stays one shape); a firm that delivers without an Auftrag makes one first,
  in one step from the Angebot or from nothing.
- **Belegkette.** Each document shows its chain (AN-2026-00002 → AU-2026-00001 → LS-2026-00001 →
  RE-2026-00006 → GS-2026-00001), each step a link (`hrefOf`), the current one bold. The chain is
  derived from `from` and `creditFor`, never stored twice.
- **Pro forma.** An Auftrag prints under the title «Proformarechnung» (a print variant, for customs
  or a prepayment request). It takes no number of the invoice series and books nothing.
- **Copy.** «Als Entwurf kopieren» on any document makes a draft of the same kind with every
  position, no `from`.
- **Optional positions** on an Angebot or Auftrag: priced and printed, marked «Option», never in a
  total, a VAT figure or a QR amount. A conversion lists them unticked; a ticked one becomes an
  ordinary position.

#### 4.4.2 Statuses

Every status but the two of a quote's customer is a fact. The list tabs and chips use these names.

| Kind | Status | Comes from |
|---|---|---|
| Angebot | Entwurf | not issued |
| | Offen | issued (numbered, printed); «gesendet» beside it from the sent log |
| | Angenommen | the person's click, or an Auftrag or Rechnung made from it |
| | Abgelehnt | the person's click |
| | Abgelaufen | `validUntil` passed while Offen (derived) |
| Auftrag | Entwurf | not issued |
| | Offen | issued, nothing delivered or invoiced |
| | Teilweise | some positions delivered or invoiced |
| | Erledigt | every position invoiced (and delivered, where a Lieferschein exists); for an Abo: its repetition ended |
| | Storniert | cancelled with date and reason; refused while an issued Rechnung of it stands, warned while a Lieferschein does |
| Lieferschein | Entwurf, Ausgeführt, Storniert | issued = ausgeführt |
| Rechnung | Entwurf | not issued |
| | Offen | issued, nothing received; «gesendet» or «nicht gesendet» beside it from the sent log (4.8) |
| | Teilbezahlt | something received, credited or written off, something open |
| | Bezahlt | nothing open |
| | Überfällig | Offen or Teilbezahlt past the printed due date (derived; with «N Tage»); the Mahnstufe beside it |
| | Storniert | cancelled |
| Gutschrift | Entwurf, Offen (not yet applied or paid back), Teilweise, Abgerechnet | the allocations and refunds of 4.4.6 |

- **Facts, not clicks.** There is no click «gesendet» or «bezahlt». A document sent outside the app
  (printed, posted) is downloaded first, and the download is the sent log's entry. Money the bank
  statement never shows (cash in hand, a customer who paid another account) is a Zahlungseingang
  entered by hand (4.4.6), a fact like any other.
- **Back to draft.** An issued Rechnung goes back to Entwurf with «Zurück zum Entwurf» while it was
  never sent or downloaded, nothing was received, credited or written off, and (agreed basis) its
  `RE-` entry lies in an open period. It keeps its number; the printed PDF stays in the log as
  replaced; on the agreed basis the module takes its `RE-` entry back. A sent Rechnung stays issued:
  the customer holds it, and a changed copy under the same number would be a second invoice whose
  VAT is owed until corrected (MWSTG Art. 27 Abs. 2). Its ways on are Gutschrift and Storno (owner
  question O1). An Angebot or Auftrag goes back to draft also after sending, with a warning that names
  the sent version, which stays in the sent log (4.11).
- **Konten ändern.** On an issued Rechnung, the revenue account of a position changes, never an
  amount, a rate or a code. In an open period its booking changes; in a filed period the module books a
  reclassification without a VAT code in the open period (golden rule 1: the filed entry stays).

#### 4.4.3 Positions

| Kind | Fields | On paper | In totals |
|---|---|---|---|
| Standard | text, quantity, unit, price, discount %, VAT rate kind, account, tags, `activity` (two net rates only), optional | as today | yes (not when optional) |
| Artikel | as Standard, filled from the Artikel and editable; `articleId` | as Standard, the article code if the template shows it | yes |
| Text | text, a title style or plain | text only | no |
| Zwischentotal | label | the sum since the last Zwischentotal or the start | no (a display) |
| Rabatt | label, percent or amount; a minus makes it a surcharge (Zuschlag) | its line and amount | yes: split over the rates in proportion to the amounts above it |
| Seitenumbruch | – | a page break in the PDF | no |
| Gruppe | a title and sub-positions | the group with its sum | its sub-positions |
| Leistung | from Leistungen (4.4.10): date range, hours, Tätigkeit, rate; `source.timeEntries` | as Standard | yes |
| Spesen | from a receipt (4.4.10): net amount, the supply's rate; `source.receiptId` | as Standard | yes |

- **Prices incl. or excl. VAT per document,** with a default per kind in the settings. The line flag
  `vatIncluded` of today becomes the document's choice; an existing document keeps its lines as they
  are.
- **VAT rate kind** (normal, reduced, accommodation, none) on each position; the percent comes from
  `modules/ch/rates.yaml` for the supply date. A 0 % position asks the reason (abroad, export) as
  today.
- **Account and code by code.** The revenue account comes from the Artikel, else the Tätigkeit, else
  the contact, else the settings; the code from the rate kind, the exemption and the firm's VAT
  setup. Both show on the position and can be changed; the person is never asked to choose one.
- **Two net tax rates (F3, #504).** On a firm with two approved rates, a position carries
  `activity: 1 | 2`, by default the Artikel's or Tätigkeit's, else 1, shown beside the rate on screen
  only (never on paper, MWSTG Art. 37 Abs. 2). It decides F1 or F2.
- **Units** are a list the firm extends in the settings: `Std., Tag, Stk., pauschal, km, m², m, m³,
  l, kg, Mt.` to start, each with its words in de, fr, it, en.
- **Discount on a position** (percent) prints beside it; a standing discount of the contact (4.4.5)
  fills every new position, the person may remove it.
- Positions are reordered by drag and by keyboard.

#### 4.4.4 Numbering

- **One series per kind,** each with a format: prefix, the year if wanted, digits, and a yearly
  restart. Defaults for a new firm: `AN-{JJJJ}-{NNNNN}`, `AU-…`, `LS-…`, `RE-…`, `GS-…`, restart each
  year. A format keeps a number's digits within QRR's 26 and SCOR's 21 characters.
- **Credit notes have their own series** (today they share the invoice series). An existing
  workspace keeps its format: its migration writes today's `YYYY-NNN` as the format of the invoice
  series and of the credit-note series together, so no number changes and nothing gaps.
- **Numbers are given at issue.** Drafts carry none, so a deleted draft leaves no gap and no number
  needs resetting (ADR 0010). The invoice series is gapless; cancelled invoices keep their numbers.
- A change of format applies from the next number; issued numbers never change.

#### 4.4.5 Kontakte

- **One register for firms and persons.** A contact is a firm (name, UID, contact persons) or a person
  (salutation, first and last name). Customers are contacts; suppliers may follow later.
- **Fields:** customer number (from its own series, set on the first document or by hand), language,
  addresses (the main one and extra ones, one marked «Rechnungsadresse», one «Lieferadresse»),
  e-mails, phone, UID and EU VAT number, default Zahlungskondition, currency and revenue account,
  standing discount, «keine Mahnungen», notes, tags.
- **Contact persons** of a firm: name, role, e-mail, phone; the document's «z. Hd.» and the mail's
  recipient. A document picks the contact, then the contact person.
- **Archived, not deleted,** while any document names it. A contact without documents is deleted.
- **Its business file.** A contact may name the business of its knowledge
  (`knowledge/customers/<id>.yaml`): booking rules stay there, address and terms here. Code proposes
  the link by UID, IBAN or name; the person keeps it.
- **Kontoauszug** of a contact: open and paid Rechnungen, Gutschriften, payments and write-offs of a
  period, with the balance, as a PDF to send.
- **Import** of contacts from a table (CSV) with a column mapping, as for the switch from another tool
  (4.7).

#### 4.4.6 Payments, Ausziffern, Skonto, write-off

- **Zahlungskonditionen** are named templates: days, an optional Skonto (percent and days), and a text
  for the paper («30 Tage netto», «10 Tage 2 %, 30 Tage netto»). The settings name a default per
  document kind; a contact may have its own. An issued Rechnung keeps the terms it printed
  (`Issued.terms`, 4.12).
- **Zahlungseingang by code** (unchanged, ADR 0010): a statement line with the QR or SCOR reference, or
  with the number and the open amount, is allocated by code. A payment that is less than open by the
  Skonto the printed terms offer, paid within the Skonto days, is allocated and its rest written off
  as Skonto by code. A shortfall below a limit in the settings (default CHF 5, named when hit) is
  proposed as Spesen.
- **Zahlungseingang by hand** on a Rechnung: date, account (a bank or cash account of the chart),
  amount (prefilled with what is open). When the statement later brings a line that matches it on a
  bank account (amount, date within the settings' days, the number or the reference), code links the
  line to that payment instead of booking it again, and names the link.
- **Ausziffern.** A statement line that matches no Rechnung exactly opens, from its proposal or from
  the contact, the allocation dialog: the contact's open items (Rechnungen with what is open,
  Gutschriften and Kundenguthaben not yet applied), each with an amount to allocate. For each Rechnung
  the person picks what becomes of a rest: **bleibt offen**, **Skonto**, **Rabatt**, **Verlust**,
  **Spesen** (bank charges), **Rundung**. «Buchen» books every allocation and write-off at once. A
  payment above what is open leaves the surplus as Kundenguthaben.
- **Rest ausbuchen** on a Rechnung with something open: reason (as above), date (today by default,
  any day of an open period), amount (what is open by default). The same write-off as in the dialog.
- **Gutschrift.** From a Rechnung: by positions (quantity per position) or by an amount (gross, split
  over the rates in proportion, or at one rate). It is applied to its Rechnung's open amount first;
  what is left is Kundenguthaben for another Rechnung of the contact, or paid back (the refund is
  matched by its number on the statement, as today). A free-standing Gutschrift is applied in the
  Ausziffern dialog. The date is the person's (today by default, any day of an open period).
- **Verrechnung** replaces the deduction line of decision 7.6 (section 8): a Gutschrift or customer
  credit applied to a Rechnung is an allocation, shown in the Rechnung's figures. Applied to a draft
  before it is issued, the paper shows it below the total («abzüglich Gutschrift GS-2026-00004») and
  the QR amount is what is left; it is no position and carries no VAT of its own.
- **Kundenguthaben** from an overpayment: held on the contact, offered in the Ausziffern of the next
  Rechnung and on the next draft, or paid back (an outgoing payment naming the Rechnung or the contact,
  proposed).

#### 4.4.7 Mahnwesen

- **Mahnstufen** are a list in the settings: name, days to pay, optional fee, text per language,
  e-mail template. A new firm starts with three: «Zahlungserinnerung» (no fee), «1. Mahnung», «2.
  Mahnung». Default interest is off (decision 7.10); when on, it runs from the due date at the rate set
  (OR Art. 104 Abs. 1: 5 %) and prints as a position without VAT.
- **Mahnung from a Rechnung:** «Mahnen» drafts the next level with every position, what is open, a new
  due date and the level's texts, editable before sending, in the Rechnung's language. A sent Mahnung
  is kept as sent; an unsent one can be deleted, which takes the level back.
- **Mahnlauf:** a dialog with a reference date. It lists every Rechnung overdue on that date with its
  next level, fee and interest; it leaves out contacts with «keine Mahnungen», Rechnungen with a
  comment of the last 7 days, and those an automatic reminder is about to send, each named with its
  reason; the person unticks what she wants; «Senden» sends by mail or downloads all, after one
  confirmation. Limits are named when hit («40 Mahnungen, 12 weitere nicht: höchstens 40 pro Lauf»).
- **Automatic reminders** per level, off by default: «N Tage nach Fälligkeit» sends that level by
  mail without a click, only on the device that holds the books (decision 7.4). A failure (mail
  refused, no address) is a task with words.
- Overdue is a fact in the list («überfällig seit 12 Tagen»), never a nudge (no nagging reminders).

#### 4.4.8 Wiederkehrende Rechnungen

- **The Abo is an Auftrag with a repetition:** every month, quarter, half year or year, on a day of the
  period, from a start, until an end or open. The positions of the Auftrag are what each Rechnung bills.
  The Auftrag shows the Rechnungen it made and the next date.
- **By code on its day.** On the next start of the app or run after the day, code makes each due
  Rechnung with the start status chosen once on the Auftrag: Entwurf, ausgestellt, or ausgestellt und
  gesendet. Only the device that holds the books issues (decision 7.4). A catch-up of more than one
  period names how many it makes before it makes them.
- **By hand:** «Wiederkehrende Rechnungen erstellen bis …» lists every due Rechnung of every Abo up to a
  date, and makes them after one confirmation.
- A position from an Artikel takes the price valid on each Rechnung's date (4.12).

#### 4.4.9 Teilrechnungen, Akonto, Schlussrechnung, Rückbehalt

- **Teilrechnungsplan on the Auftrag:** stages by percent or amount of the Auftrag's total («30 % bei
  Auftrag, 40 % nach Rohbau, Rest»), each with a text and a planned date. The stages add up to the
  total; the dialog says what is missing or too much. Each stage makes a Teilrechnung (`role:
  'partial'`) with one position «Akonto n gemäss Auftrag AU-…» at the Auftrag's rates in proportion.
  While a stage is invoiced, the Auftrag's total changes only with a warning (4.11).
- **Schlussrechnung** (`role: 'final'`): the last stage, or «Schlussrechnung erstellen» on the
  Auftrag. It lists every position of the Auftrag (or of the work as finally measured) and adds one
  deduction position per Teilrechnung that is issued and not cancelled, at its rates, gross or net as
  it was (`deducts: <invoice id>`). It deducts what was invoiced, not what was paid; an unpaid
  Teilrechnung stays open on its own. This keeps each document's VAT its own (MWSTG Art. 40 Abs. 1
  lit. b).
- **A Teilrechnung without an Auftrag** is an ordinary Rechnung marked partial; «Akontos abziehen» on a
  final draft finds the contact's partial invoices.
- **Rückbehalt:** at issue the person enters «Rückbehalt 5 % bis 30.06.2027». The QR-bill asks for the
  total less the retention; on its date the list shows it as a fact («Rückbehalt fällig seit …»), and
  «Zahlungsaufforderung» sends the instalment notice with its own QR-bill and the same reference.

#### 4.4.10 Leistungen and re-billed costs

- **Tätigkeiten:** name, default hourly rate, revenue account, VAT kind, `activity` (two net rates).
- **Leistungen:** date, contact, Tätigkeit, hours, text, tags (project), billable. Entered by hand,
  pasted as a table, read from a CSV (the lines import contract, 4.7), or produced by a workspace source
  from a tracker's export. Status Offen, then **verrechnet** once a position of an issued Rechnung
  names it (a fact, never a click); not billable ones stay out.
- **Rate:** the contact's rate for the Tätigkeit, else the Tätigkeit's default.
- **«Leistungen verrechnen»** on a draft (or on an Auftrag) lists the contact's open, billable
  Leistungen, filtered by date and project; the picked ones become positions, grouped by Tätigkeit or
  one per entry. A Leistung is never billed twice.
- **«Spesen weiterverrechnen»** on a draft lists the contact's receipts (tagged with the contact or a
  project, or picked by hand) not yet re-billed. Each one becomes a position at its net amount and the
  supply's rate (MWSTG Art. 24 Abs. 1), with `source.receiptId`, offered once.

#### 4.4.11 Vorlagen, texts, sending

- **Vorlagen:** several named templates (logo, letterhead PDF as background, accent colour, fonts, C5
  window left or right, elements on or off, QR-bill on the last sheet or a sheet of its own). One
  default per document kind; a document may pick another. An issued document keeps the layout it
  printed (exists).
- **Texts per kind and language:** title, intro and closing text, with placeholders (contact person,
  number, due date, total). A document may change them as a draft.
- **A fixed attachment** per kind (the firm's terms as a PDF) goes with every sent document of that
  kind; a document may carry further attachments (a Rapport PDF). The sent log keeps each attachment's
  checksum.
- **E-mail templates** per kind and per Mahnstufe, with the same placeholders.
- **Sending:** several recipients and CC (the contact's e-mail and contact persons proposed), a copy
  to the firm's own address, the PDF byte for byte, through the firm's own mailbox (exists). Bulk
  sending from the list for ticked documents, with the limit named when hit.
- **Quittung** (decision 7.11): a Rechnung paid at issue, with the means (cash, TWINT, card, bank), the
  title «Quittung» and no QR-bill.

#### 4.4.12 Lists and exports

- **Offene Posten:** every Rechnung with something open, by contact, with age bands by the days
  past due (nicht fällig, 1–30, 31–60, 61–90, > 90 days; decision 23), printable as the Debitorenliste and exported to CSV. On 31.12. it equals the year
  end's receivables proposal to the Rappen.
- **Fakturajournal:** every position of the issued Rechnungen and Gutschriften of a period, to CSV.
- **Export** of every list (current tab, filter and search) to CSV.
- **Versendet:** the sent log as a list of its own (date and time, document, kind, recipient,
  channel, checksum), filterable by contact, kind and channel; each row links to its document.

### 4.5 How each event is booked

Cash basis = `company.vat.reporting: received`. Agreed = `agreed`. The codes are those of
`modules/ch/tax-codes.yaml`. «Net rate» means `method: net-rate`, «none» means not registered. What is
marked «exists» is built and stays as it is.

| Event | Cash basis | Agreed basis |
|---|---|---|
| Angebot, Auftrag, Lieferschein, Proforma, Kontoauszug, Leistung | nothing | nothing |
| Optional position | nothing (never in a total) | nothing |
| Rechnung issued (also Teil- or Schlussrechnung) | nothing (open item in `invoices.json`) | `RE-<n>`: 1100 / revenue, the sale codes per rate (V81, V26, V38; V0-E / V0; F1 or F2 by `activity`; none when not registered), its date. Exists, plus `activity` |
| Rabatt position | part of the revenue split: lowers each rate in proportion | the same, inside `RE-<n>` |
| Rechnung back to draft (unsent, 4.4.2) | nothing | `RE-<n>` taken back by the module; refused if it lies in a filed period |
| Zahlungseingang (statement or by hand) | bank or cash / revenue with the codes, split like the Rechnung (exists) | bank or cash / 1100, exchange difference on 6960 (exists) |
| A statement line linked to a payment entered by hand | nothing more | nothing more |
| One payment allocated over several Rechnungen | each part as that Rechnung's payment | each part bank / 1100 |
| Prepayment before the Rechnung | as a payment | taxed on its day, the event rebooked for the rest (exists) |
| Gutschrift issued | nothing until it is paid back or applied | `GS-<n>` (exists) |
| Gutschrift paid back | refund with the minus codes (exists) | bank / 1100 (exists) |
| Gutschrift applied to a Rechnung (Verrechnung) | at that Rechnung's payment, its booking takes the Gutschrift's positions with the minus codes for the applied part, so revenue and tax are right per rate | no entry (both on 1100) |
| Storno | not booked (exists) | `RE-<n>-storno` (exists) |
| Ausbuchung `skonto`, `discount`, `fee`, `rounding` | nothing: what was never received was never taxed (decision 7.3) | `RE-<n>-wo-<k>`: 3800 Erlösminderungen / 1100 with the minus sale codes, split like the Rechnung (MWSTG Art. 41 Abs. 1) |
| Ausbuchung `loss` | nothing | `RE-<n>-wo-<k>`: 3805 Verluste aus Forderungen / 1100 with the minus sale codes. A later payment books revenue with the sale codes again |
| Kundenguthaben from an overpayment | bank / 2030 Anzahlungen von Kunden, no code | the same |
| Kundenguthaben applied to a Rechnung | 2030 / revenue with the codes, split like the Rechnung, on the day it is applied (the consideration is received then) | 2030 / 1100 |
| Kundenguthaben paid back | 2030 / bank | the same |
| Mahngebühr, Verzugszins paid | revenue without a code on `feeAccount` (exists for fees), interest on a financial income account | the same, from the payment; never on issue (MWSTG Art. 18 Abs. 2 lit. i) |
| Konten ändern | open period: the entry's account changes; filed period: a reclassification without a code in the open period | the same, on `RE-<n>` |
| Quittung (decision 7.11) | on the issue day: the means' account / revenue with the sale codes | `RE-<n>` and on the same day the means' account / 1100 |
| Rückbehalt instalment notice | nothing | nothing |
| A document of a filed period | never changed; a write-off, Gutschrift or reclassification is dated in the open period, with `corrects` where golden rule 1 says so (as `eventPlan` does) | the same |

The new ref patterns `RE-<n>-wo-<k>` and the Kundenguthaben refs (`KG-<contact>-<k>`) are no books
format change (decision 7.2): named in `src/books/refs.ts` and in the CHANGELOG. All entries go through
the write door (`update` in `src/books/store.ts`) as the module `invoicing` (`moduleActor`). A person's
booking is never replaced (exists in `confirmPayment`).

### 4.6 Code, AI, person (MISSION.md)

| Work | Code | AI | Person |
|---|---|---|---|
| Numbers, references, totals, rates, discount split, QR-bill, Art. 26 check, the PDF | all | – | – |
| Statuses, open quantities of an Auftrag, «verrechnet» of a Leistung | all | – | only Angenommen / Abgelehnt |
| Recurring Rechnungen on their day | all | – | chooses the start status once on the Auftrag |
| Matching payments, Skonto in the printed terms, small differences under the limit, linking a statement line to a payment entered by hand | all | – | – |
| Ausziffern of a payment that matches nothing exactly | proposes by contact, amount and date | proposes from the text | allocates, decides the rest |
| Booking every event (4.5) | all | – | – |
| Mahnlauf: who, which level, fee, interest | proposes the list | – | confirms once |
| «Schreib Müller AG eine Rechnung für 12 Stunden im Oktober» | – | drafts (exists: `invoiceDraft`) | issues |
| An Angebot from an e-mail «bitte offerieren», a Rapport photo, another tool's PDF | – | reads it into a draft | checks and issues |
| Which receipts are re-billed to whom (without tags) | proposes by the contact's name on the receipt | proposes by context | picks |
| Whether a supply is abroad, export or domestic | asks the reason at 0 % (exists) | proposes from the country and the text | decides |
| Write-off of a loss, a Storno, a Gutschrift | – | – | decides |
| Wishes: «schick jeder Rechnung den Rapport mit», «mahn die Gemeinde nie» | – | turns into a setting or a contact flag, shown on a card | keeps it with one click |

Every action has a button: the AI is never the only way (Treuhänderin persona).

### 4.7 App and workspace (ADR 0015)

| In the app | In the workspace |
|---|---|
| Every document kind, the chain, numbering, Art. 26 check, QR-bill, PDF, sending by SMTP, the sent log | Vorlagen, texts, logo, number formats, Zahlungskonditionen, Mahnstufen (settings) |
| Teilrechnungen, Abos, Mahnwesen, Ausziffern, write-offs, Kundenguthaben and their bookings | Per-contact terms, discounts, «keine Mahnungen» |
| Artikel, Tätigkeiten, Leistungen and units as records | The firm's Artikel, prices and Tätigkeiten |
| A **lines import contract**: a table of date, text, quantity, unit, price and optional tags (Leistungen and positions), from a paste or a CSV | A source that turns one tracker's or one shop system's export into that table, written by the AI with the person |
| A **delivery channel contract** beyond e-mail and download (`deliver(doc) → { to, channel, id }`, as `Deliver` in `service.ts`) | An eBill, portal or online-view source for one network partner |
| Import of contacts, Artikel and open Rechnungen from a table (the switch from another tool) | The mapping of one tool's export columns (the market leader's, a spreadsheet) |

No branch for one bank, tracker, eBill partner, payment-link provider or tool goes into the app.

### 4.8 UI

The new UI's rules apply (`docs/redesign/architecture.md`, AGENTS.md «UI links», «UI theming»).

- **One area, «Verkauf».** The area of `src/app/areas/invoices/` takes the label «Verkauf». Its route
  base stays `/invoices` (links keep working). Views as tabs: Angebote · Aufträge · Lieferscheine ·
  Rechnungen · Gutschriften · Offene Posten · Kontakte · Artikel · Leistungen · Versendet. A view
  appears with the phase that builds it.
- **Route** (`src/app/shell/route.ts`, `docs/urls.md`): a document is `/invoices/<number>` whatever its
  kind (`/invoices/AN-2026-00004`, `/invoices/AU-2026-00001`); a draft `/invoices/draft-<id>`; a contact
  `/invoices/contacts/<id>`; an Artikel `/invoices/articles/<id>`. `view` gains `quotes`, `orders`,
  `deliveries`, `credit-notes`, `open-items`, `contacts`, `articles`, `time`.
- **Overview table** (owner, 2026-11-15, unchanged in shape): each document view is one table with
  status tabs from facts, each with count and total. Rechnungen: «Alle · Entwürfe · Offen ·
  Überfällig · Teilbezahlt · Bezahlt · Storniert». Angebote: «Alle · Entwürfe · Offen · Angenommen ·
  Abgelehnt · Abgelaufen». Aufträge: «Alle · Entwürfe · Offen · Teilweise · Erledigt · Abos».
  Gutschriften: «Alle · Entwürfe · Offen · Abgerechnet». «Eigene Filter» saved from a tab and a search,
  a viewer's preference. One line of facts above the table: what is open and overdue, per currency.
  Columns of Rechnungen: Datum · Nr. · Kontakt (with the title) · Status · Versand · Fällig · Währung ·
  Brutto · Offen · Mahnstufe; of Aufträge: Datum · Nr. · Kontakt · Status · geliefert · verrechnet ·
  Brutto · nächste Rechnung (Abo). Every column sorts; amounts right-aligned in tabular figures; EUR
  rows with their CHF value in muted text; a totals row for the current tab, filter and search. Ticked
  rows get a bulk bar: «Mahnen», «PDF», «Senden», «Export CSV», «Als Kontext an die KI», each dialog
  naming what it leaves out and why. «⋯» on a row: Öffnen, PDF, Senden, the next Mahnung, the
  conversions, Als Entwurf kopieren. Page size 50, the rest named. ↑ ↓ move through the rows while a
  document is open.
- **The sent state at a glance** (owner, 2026-11-19). The owner found it hard today to see what has
  been sent. Every document table therefore shows it from the sent log, never set by hand:
  - The status chip reads «Offen · gesendet» or «Offen · nicht gesendet» on an issued document; the
    other statuses (Entwurf, Teilbezahlt, Bezahlt, Überfällig, Storniert) carry the same mark.
  - A column «Versand»: the last send's date and channel («12.11.2026 · E-Mail», «03.11.2026 ·
    Download», later «eBill»), a dash when never sent; on hover every send with time and recipient.
    For a Rechnung with Mahnungen it also names the last Mahnung sent («2. Mahnung 18.11.»).
  - A filter tab «Nicht gesendet» beside the status tabs of each kind: issued documents with no entry
    in the sent log, counted and summed like any tab. The bulk bar on it offers «Senden».
  - On the detail, the margin's section «Versand» lists every send of the document and of its
    Mahnungen and instalment notices: time, recipient(s), CC, channel, Message-ID or download, the
    PDF's checksum, each PDF openable as it went out. Above the sheet the four figures carry a fifth
    fact, «gesendet am … an …» or «noch nicht gesendet» with «Senden».
  - A document sent outside the app is first downloaded; the download is its entry (channel
    «Download»). There is no click «als gesendet markieren».
- **Table and detail: layout A** (decided 2026-11-15): the table full width; a row opens the document
  as a panel over the right part of the table; Esc or «×» closes it. AGENTS.md names these views as
  the exception to the list + detail rule when built.
- **Four figures** on every issued Rechnung, above its sheet: Betrag · erhalten · gutgeschrieben ·
  offen. «erhalten» sums the payments, «gutgeschrieben» the Gutschriften, Verrechnungen and
  write-offs, «offen» the rest; a negative rest is Kundenguthaben. Each figure names its source. The
  same figures feed Offene Posten and the Kontoauszug.
- **Detail:** the A4 sheet as today. Actions by kind and status: issue, send, the conversions of
  4.4.1, «Zurück zum Entwurf» (4.4.2), «Zahlungseingang erfassen», «Ausziffern», «Rest ausbuchen»,
  «Gutschrift erstellen», «Mahnen», «Stornieren», «Konten ändern», «Zahlungsaufforderung» (retention
  due). The margin shows the Belegkette, the payments and allocations, the write-offs, the Mahnungen
  and the bookings each event made (links to `/journal/<id>` with `hrefOf`).
- **Conversion dialog:** the positions with the quantity still open, each ticked and editable, the
  optional ones unticked; the total of what is ticked.
- **Ausziffern dialog:** the payment (amount, date, text), the contact's open items, an amount per
  item, the rest's choice per Rechnung, the sum left; «Buchen».
- **Mahnlauf:** a dialog (an action, not a place) with the reference date, the proposed list, the
  totals and one «Senden».
- **Dated values** (4.12): current value with «ab TT.MM.JJJJ», a planned entry, «Verlauf». «Ändern» asks
  «gilt ab» (default today).
- **Firma › Verkauf** (today Firma › Rechnungslayout) gains number formats, Zahlungskonditionen,
  Mahnstufen, interest, write-off accounts, units, Vorlagen and e-mail templates. A new firm's first
  Rechnung asks only what Art. 26 and the QR-bill need (exists).

### 4.9 i18n

- UI texts go through `t('key')` in `src/app/i18n/locales/` (de, then fr, it, en; `tests/i18n.test.ts`).
- Document texts (every kind and print variant, status names on paper, Teil- and Schlussrechnung,
  deduction, Rabatt and Zuschlag, Gutschrift below the total, retention, instalment notice, Skonto
  terms, interest, Kontoauszug) go into `src/invoices/texts.ts` for de, fr, it, en. The terms of 4.3
  are the German source; fr, it, en follow the table there.
- Jurisdiction words (MWST, Art. 8 notes, QR-bill headings) stay in `modules/ch` and
  `src/providers` (layers lint, `tests/layers.test.ts`). Swiss form wordings go into
  `modules/ch/invoicing.yaml`.
- Romansh: not a goal until a persona asks (decision 7.8).

### 4.10 Tests and golden master

- Pure rules (`tests/invoices.test.ts` style): discount split per rate, subtotals, numbering formats
  (QRR fits 26 digits, SCOR 21 characters; an old workspace keeps its numbers), F1 (EUR never QRR), F3
  (`activity` → F1/F2), open quantities of an Auftrag after partial conversions, status of every kind
  from facts, Skonto detection from `Issued.terms`, allocation sums.
- Booking per basis (`tests/invoice-payments.test.ts`, new `tests/invoice-events.test.ts`): each row of
  4.5 on cash and agreed basis, each VAT setup (effective, net rate, none), and a write-off,
  Gutschrift and reclassification of a Rechnung of a filed period (dated open, `corrects` where due).
- A payment entered by hand, then the statement line: one payment, one booking.
- API: a row in `tests/period-lock.test.ts` for every new route that writes the books.
- Conversions: the ticked positions and quantities only; the chain is the same seen from each
  document; an optional position changes no total, VAT figure or QR amount.
- Four figures: Betrag − erhalten − gutgeschrieben = offen for every Rechnung of the demos; Offene
  Posten sums the same «offen»; on 31.12. it equals the year end's receivables.
- Warnings (4.11): each names the fact, the rule and what follows; «Trotzdem …» does the action and
  records it as an ordinary entry, with no override field.
- Dated values (4.12): as in the version of 2026-11-15.
- UI: `tests/invoices-area.test.ts` for each new view. e2e walks (`tests/e2e-invoices.test.ts`): phase
  1 payment with Skonto and an Ausziffern; phase 2 Angebot → Auftrag → Lieferschein → Rechnung; phase 3
  Akonto, Akonto, Schlussrechnung and a Mahnlauf.
- **Golden master:** only `demo/` books invoice entries today. Phase 1 leaves existing golden files
  unchanged except where the demos gain invoicing; each change goes through `npm run test:update`, a
  reviewed diff and a CHANGELOG entry marked **⚠ figures** (docs/releasing.md). F1 does not touch
  `demo/` (its EUR account has no QR-IBAN).
- **Demos:** `tools/demo/invoices.ts` gains invoicing for `demo-consulting/` (an Abo, Leistungen, one EUR
  client abroad), `demo-schreinerei/` (Angebot, Auftrag with a Teilrechnungsplan, Schlussrechnung,
  prices incl. VAT, a second activity), `demo-coiffeur/` (one Rechnung without VAT, a Quittung).
  Generated by `npm run demo:generate`, the only writer of the originals.
- **Personas:** `invoices.md` gets the checkpoints of section 5 per phase.

### 4.11 Warn, then the person decides (owner, 2026-11-15)

Where this area refuses a person, it warns instead: it says what is off, which rule it touches and what
follows, and offers «Trotzdem …». The action is recorded like any other, with no override flag. Code
still refuses what is not the person's to decide: a format a third party rejects outright, a write the
golden rules forbid, a security boundary.

| Refused (today, or as first written) | The warning: what is off · rule · what follows | The person's way on |
|---|---|---|
| Issue with something Art. 26 asks missing | «Es fehlt: …» · MWSTG Art. 26 Abs. 2, the letter named · the customer may not deduct the input tax; once sent it changes only by Gutschrift or Storno | «Trotzdem ausstellen»; each gap links to where it is fixed (exists) |
| A position without text or price | «Eine Position ohne Text oder Preis» · Art. 26 Abs. 2 lit. d, e · it prints as 0.00 | «Trotzdem ausstellen» |
| No account to pay to | «Kein Konto für CHF» · the QR-bill needs an IBAN · no payment part | «Trotzdem ausstellen» |
| Storno of a paid Rechnung | «RE-… ist bezahlt» · a Storno undoes the claim, the money stays received · the payment waits unmatched, or becomes Kundenguthaben | «Gutschrift statt Storno», or «Trotzdem stornieren» |
| A Gutschrift above what is open of its Rechnung | «Gutschrift über dem offenen Betrag» · MWSTG Art. 41 · the rest becomes Kundenguthaben | «Trotzdem ausstellen» |
| A QR-IBAN under EUR (F1) | «Seit v2.4 nur für CHF» · SIX IG v2.4, v2.3 valid until November 2027 · banks refuse it after November 2027 | «Trotzdem speichern» |
| A conversion of an expired or declined Angebot | «Abgelaufen am …» or «abgelehnt am …» · the quote's `validUntil`, or the answer in the log · the old prices go into the draft, the quote becomes Angenommen | «Trotzdem erstellen» |
| A conversion of more than is still open of a position | «Mehr als offen: 12 von 10 m²» · the Auftrag · the position shows more invoiced than ordered | «Trotzdem übernehmen» |
| An Angebot or Auftrag back to draft after sending | «Gesendet am … an …» · the sent version stays in the sent log · the customer may hold another version | «Trotzdem bearbeiten» |
| An Auftrag's total changed while Teilrechnungen stand | «2 Teilrechnungen über CHF 12 000 ausgestellt» · the stages add up to the old total · the Schlussrechnung deducts what was invoiced | «Trotzdem ändern» |
| A write-off above what is open | «Mehr als offen» · the open amount · the Rechnung shows a credit | «Trotzdem ausbuchen» |
| A price, terms or IBAN changed with a «gilt ab» before issued documents (4.12) | as in 4.12 | «Nachbelastung als Entwurf» or «Gutschrift als Entwurf», «So lassen» |

Kept as hard rules, each for its reason:

- **A filed VAT quarter** (AGENTS.md golden rule 1). A write-off, Gutschrift, reclassification or Storno
  that touches a filed period is dated in the open period, with `corrects` where due; nothing in the
  filed quarter changes. «Zurück zum Entwurf» is refused when the Rechnung's `RE-` entry lies in a filed
  period.
- **A sent Rechnung or Gutschrift is kept as sent** (OR Art. 958f, GeBüV, MWSTG Art. 27 Abs. 2): never
  changed in place, deleted or printed again; Gutschrift and Storno are the ways on (decision 18).
- **Who issues on which device** (decision 7.4): two devices issuing would give one number twice.
- **Security boundaries:** the SMTP password, the mailbox, a workspace's private data.

### 4.12 Values that change over time (owner, 2026-11-15)

Unchanged in substance; built in phase 3 except `Issued.terms` (phase 1). Each value below is a dated
history (`Dated<T>`: `validFrom`, optional `validUntil`, never overwritten), by the rule of
docs/specs/domain-model.md §5. A document reads the value valid on its own date, and an issued
document keeps what it printed.

| Value | Typical change | Read on |
|---|---|---|
| An Artikel's price | a new price list from 1 January | the document's date, when the position is added; each Abo Rechnung's date |
| A contact's addresses, Zahlungskondition, discount, revenue account | a move; 20 days instead of 30 | the document's date |
| The firm's name and address (letterhead), UID | a move, a new name | the document's date |
| `payTo` per currency: IBAN, QR-IBAN, ledger account | a new bank | the document's date |
| Zahlungskonditionen, Mahnstufen and fees, interest, write-off and fee accounts | a new policy | the document's date; a Mahnung reads its own date, a write-off its own |
| A Tätigkeit's rate, a contact's rate | a new rate from 1 January | the Leistung's date |
| The VAT setup | a switch of method or basis, held for whole years | the document's date |

Not dated: Vorlagen, texts, number formats. An Artikel's VAT is a kind; the percent comes from
`modules/ch/rates.yaml` for the day of the supply (MWSTG Art. 115).

**What an issued document keeps:** its positions with prices and rates, the contact (address, terms),
the sender (name, address, UID, `payTo`), the layout, the PDF with its SHA-256, and `terms` (phase 1).
A Mahnung computes from the printed due date; Skonto is recognised by the printed Skonto.

**Drafts.** A position from an Artikel copies the price valid on the draft's date when it is added. If
the date moves, or a new price starts before issue, the preview names the difference on the position:
«Artikelpreis ab 01.12.2026: 29; Position: 28». The person keeps or changes it.

**Abos.** A position from an Artikel takes the price valid on each Rechnung's date; a typed position
keeps its price. The Auftrag shows the coming change: «ab 01.01.2027: Hausmischung 29 statt 28».

**A change dated before issued documents.** The card says so before it saves (4.11):

- **Price.** «2 Rechnungen seit 01.08.2026 mit 28 ausgestellt; ab 01.08.2026 gilt jetzt 29». They stay as
  issued. Ways on: «Nachbelastung als Entwurf» (one draft per contact with the difference; a Gutschrift
  draft for a lower price) or «So lassen». A sent Angebot stays as sent; its conversion names the
  difference on the draft.
- **IBAN or QR-IBAN.** Open Rechnungen keep the QR-bill they printed; code still matches their payments
  by reference. Ways on: «Zahlungsaufforderung mit neuer IBAN» or «So lassen».
- **Terms or address.** Issued documents keep theirs; the card names them.

The choice is an ordinary action. A filed period stays as filed.

**UI and the AI.** The Artikel shows «CHF 28 ab 01.07.2026», a planned price, and «Verlauf». A wish in
the sidebar («Hausmischung ab Januar 29 Franken», «Müller zahlt ab jetzt in 20 Tagen») becomes
`{ path, value, validFrom }`; code writes it and shows the card, the person keeps it.

---

## 5. Phases

Each phase ends with a persona walk in the `verify` skill, scored 0/1/2 per checkpoint as
`first-run.md` defines. A phase is done when each checkpoint scores 2.

### Phase 1: correct and closed, in the market leader's terms

The smallest slice that a user of the market leader recognises and that closes #504, #505 and #506.
It adds no new document kind.

Scope:

- **#506 (F1):** QR-IBAN and QRR for CHF only; a EUR Rechnung prints the IBAN with SCOR; the warning of
  4.11 for a QR-IBAN under EUR.
- **#504 (F3):** `activity` on the position for firms with two net rates; F1 or F2 in the booking and in
  the form's rows.
- **#505 (F4):** «Zahlungseingang erfassen» by hand (and its link to the later statement line),
  **Ausziffern** (one payment over several Rechnungen; the rest bleibt offen, Skonto, Rabatt, Verlust,
  Spesen, Rundung), **Rest ausbuchen**, each booked per basis as in 4.5.
- **Zahlungskonditionen** as named templates with Skonto, printed; `Issued.terms`; Skonto within the
  printed days written off by code; shortfalls under the limit proposed as Spesen.
- **Gutschrift applied to its Rechnung** (Verrechnung); Gutschrift statuses Offen, Teilweise,
  Abgerechnet; the **four figures** on every Rechnung.
- **Statuses and tabs** of Rechnungen and Gutschriften as in 4.4.2, from facts.
- **Positions:** Standard, Text (title or plain), Zwischentotal, Rabatt/Zuschlag on the total (split per
  rate), Seitenumbruch, discount % per position; **prices incl. or excl. VAT per document**; **units**
  as the firm's list (m², m, m³, l, kg, Mt. added).
- **Offene Posten** (by contact, age bands, printable, CSV).
- **The sent state at a glance** (4.8): the chip mark, the «Versand» column, the tab «Nicht gesendet»,
  the margin's «Versand» section and the «Versendet» list, all from the sent log.
- F2; the warnings of 4.11 this phase touches; the `invoicing:` section in the three demos that lack it.
- One `invoices.json` step (2→3: line kinds, `prices`, `activity`, `payments.source`, `allocations`,
  `writeOffs`, `terms`) and one manifest step (units, Zahlungskonditionen, write-off accounts, limit).

Why first: F1 is in force since the SIC release of 13.11.2026; F4 leaves Rechnungen open forever and VAT
declared on money never received; F3 books the wrong rate. The Ausziffern dialog and the named terms
are what users of the market leader use daily after the invoice, so they come before the work before
the invoice. The golden figures of the existing demos stay.

Acceptance (persona `invoices.md`, Sandra, the consultant, the Schreinerei, the Treuhänderin). The
Treuhänderin also walks P1.2 to P1.11 by hand, no AI asked; each scores 2 only if she can:

| # | Checkpoint | 2 means |
|---|---|---|
| P1.1 | EUR Rechnung with a QR-IBAN set (#506) | saving warns with the rule and what follows; without «Trotzdem speichern» a EUR Rechnung prints SCOR with the plain IBAN; an issued Rechnung keeps what it printed |
| P1.2 | Painter's Rechnung by m² with a text title per room, a Zwischentotal per room and 3 % Rabatt on the total | sheet and PDF right; totals per rate right; the Rabatt lowers each rate in proportion; Art. 26 check passes |
| P1.3 | Webshop Rechnung with coffee 2.6 % and grinders 8.1 %, prices incl. VAT, 2 % Rabatt | the Rabatt splits over both rates to the Rappen; on the agreed basis `RE-<n>` shows both rates net of the Rabatt |
| P1.4 | Payment 2 % short within the Skonto days of «10 Tage 2 %, 30 Tage netto» | the Rechnung reads «Bezahlt» and moves from the tab «Offen» to «Bezahlt» (tabs «Alle · Entwürfe · Offen · Überfällig · Teilbezahlt · Bezahlt · Storniert» with counts and totals from facts, no click sets a status), the Skonto written off by code; agreed basis: a `-V81` entry on 3800 equals 2 % of the gross |
| P1.5 | One payment of CHF 3 180 for two Rechnungen of 1 620 and 1 580, CHF 20 short | the Ausziffern dialog proposes both; the person books the rest of the second as Spesen; both read «Bezahlt»; agreed basis: one `-wo-` entry on 3800 (#505) |
| P1.6 | Customer bankrupt | «Rest ausbuchen» as Verlust in three clicks; cash basis: no entry; agreed: 3805 / 1100 with the minus codes; the MWST tab shows the reduction in the open quarter (#505) |
| P1.7 | Customer paid in cash at the door, then the same Rechnung appears in no statement; another paid to the second bank account by hand, then its statement line arrives | the cash one: one Zahlungseingang on 1000 Kasse, «Bezahlt»; the bank one: the statement line links to the hand payment, one booking, the link named |
| P1.8 | Gutschrift for 2 of 10 m² from a Rechnung | applied to that Rechnung at once; the Gutschrift reads «Abgerechnet»; the four figures show it under «gutgeschrieben»; on the cash basis the payment of the rest books revenue less the Gutschrift's positions with the minus code |
| P1.9 | Schreinerei with two net rates (#504) | a position of the second activity books F2; the half year's form shows it in the second rate's row (333; the box numbers are marked uncertain in AGENTS.md) |
| P1.10 | Offene Posten on 31.12. | equals the year end's receivables proposal to the Rappen; prints and exports |
| P1.11 | Eight issued Rechnungen, five sent by mail, one downloaded, two not sent | the tab «Nicht gesendet» shows the two with count and total; «Versand» shows date and channel for the six; the detail lists each send with recipient and checksum; nothing was set by hand |
| P1.12 | Storno of a paid Rechnung | a warning with the payment, the rule and what follows; «Gutschrift statt Storno» offered; «Trotzdem stornieren» leaves the payment unmatched; the log holds it as an ordinary entry |

### Phase 2: Angebot, Auftrag, Lieferschein, Artikel, Kontakte

Scope: the kinds `quote`, `sales-order`, `delivery-note`; issue, send, Angenommen and Abgelehnt,
Abgelaufen; the conversions with the positions and quantities still open; the open quantities and the
status of an Auftrag; optional positions; the Belegkette; the print variants Auftragsbestätigung and
Proformarechnung; number series per kind with formats (credit notes their own); Kontakte (firm or
person, contact persons, addresses, customer number, defaults, discount, archive, knowledge link, CSV
import); Artikel with Artikel positions and Gruppen, and their CSV import; «Zurück zum Entwurf» for an
unsent Rechnung; «Konten ändern». One `invoices.json` step and one manifest step.

Acceptance (Sandra, the webshop):

| # | Checkpoint | 2 means |
|---|---|---|
| P2.1 | Angebot for a facade, sent, accepted by phone | its own number AN-…, PDF, «Angenommen» by the person's click; no booking |
| P2.2 | Angebot → Auftrag → two Lieferscheine (6 and 4 of 10 boxes) → Rechnung | each step one dialog with the open quantities; after the first Lieferschein the Auftrag reads «Teilweise»; after the Rechnung «Erledigt»; each document shows the same chain; the Lieferschein prints no prices; only the Rechnung books |
| P2.3 | Angebot with two optional positions, one taken | the Angebot's total leaves both out and names them; the conversion lists them unticked; the Rechnung's total and QR amount include the taken one |
| P2.4 | A wholesale Rechnung from the Artikel list | code, text, unit, price, rate and account from the Artikel; changeable on the position |
| P2.5 | A café chain with a head office and two branches | one firm contact with two contact persons and two delivery addresses; the Rechnung goes to the billing address, «z. Hd.» the picked person |
| P2.6 | An existing workspace after the update | every issued number as before; the next Rechnung continues the old series; a new firm starts with AN-, AU-, LS-, RE-, GS- |
| P2.7 | Rechnung issued by mistake, not yet sent | «Zurück zum Entwurf» keeps its number; the PDF stays in the log as replaced; on the agreed basis `RE-<n>` is gone from the open quarter; once sent, the action is not offered and Gutschrift and Storno are |
| P2.8 | Conversion of an expired Angebot | a warning with the date and what follows; «Trotzdem erstellen» makes the draft |

### Phase 3: Teilrechnungen, Mahnwesen, Vorlagen, values over time

Scope: the Teilrechnungsplan on the Auftrag, Akonto and Schlussrechnung with deductions, Rückbehalt and
instalment notices; Mahnstufen as a list, the Mahnlauf, automatic reminders per level, default interest
(off by default), «keine Mahnungen»; several Vorlagen, texts per kind and language, the fixed attachment
and further attachments, e-mail templates, several recipients and CC, bulk sending; the Kontoauszug;
the dated values of 4.12 (Artikel price, contact, letterhead, `payTo`, terms, Mahnstufen).

Acceptance (Sandra, the Schreinerei, the Treuhänderin):

| # | Checkpoint | 2 means |
|---|---|---|
| P3.1 | Auftrag with the plan 30 % / 40 % / rest, then the Schlussrechnung | two Teilrechnungen and a Schlussrechnung listing the whole work less both, its QR-bill asks for the rest; agreed basis: three events whose sum is the whole; cash basis: the three payments' revenue is the whole |
| P3.2 | Schlussrechnung while an Akonto is unpaid | the unpaid Teilrechnung stays open on its own; nothing is counted twice |
| P3.3 | Rückbehalt 5 % until acceptance | QR-bill for 95 %; on the due day a fact in the list; the instalment notice with its own QR-bill pays the rest, matched by the same reference |
| P3.4 | 14 overdue Rechnungen of 9 contacts | one Mahnlauf, one confirmation, the right level each, the contact with «keine Mahnungen» named as left out; every PDF in the sent log |
| P3.5 | Automatic Zahlungserinnerung 5 days after due | sent without a click on the device that holds the books; the next Mahnlauf does not send it again |
| P3.6 | A second Vorlage «Regie» with the Rapport as attachment | picked on one Rechnung; sent with both PDFs; the sent log keeps both checksums |
| P3.7 | Kontoauszug of a contact for 2026 | open and paid items with dates and the balance; equals Offene Posten for that contact |
| P3.8 | New IBAN from 01.12.2026, entered on 15.11. | documents dated before 01.12. print the old IBAN, those from 01.12. the new; the card names the open Rechnungen with the old IBAN; their payments are still matched |

### Phase 4: Abos, Leistungen, Spesen, Kundenguthaben, Quittung

Scope: the repetition on an Auftrag (by code on its day, or the run by hand); Tätigkeiten and Leistungen
with the lines import contract (paste or CSV) and «Leistungen verrechnen»; «Spesen weiterverrechnen»
from receipts; Kundenguthaben from overpayments, applied or paid back; the Quittung; the
Fakturajournal export.

Acceptance (the consultant, the webshop, the coiffeur):

| # | Checkpoint | 2 means |
|---|---|---|
| P4.1 | Monthly retainer as an Abo | on the 1st the Rechnung (or the sent one) is there without a click; a mail failure is a task with words; the Auftrag shows each Rechnung it made |
| P4.2 | 37.5 hours from a tracker's CSV | Leistungen in the list; «Leistungen verrechnen» makes positions grouped by Tätigkeit at the contact's rate; after issue they read «verrechnet»; a workspace source the AI wrote reads the tracker's own export |
| P4.3 | Train and hotel re-billed | the receipts become positions at the supply's rate, net; the same receipt is never offered twice |
| P4.4 | Customer pays CHF 100 too much | Kundenguthaben on the contact; offered on the next draft; applied; on the cash basis 2030 / revenue on that day; the four figures of both Rechnungen add up |
| P4.5 | Coiffeur: a wedding party paid in cash | a Quittung with the next number, no VAT, «bezahlt in bar», no QR-bill; cash basis 1000 / revenue on the issue day; nothing open |
| P4.6 | Hausmischung 29 from 01.01.2027, entered in November | the December Abo Rechnung still at 28; the January one at 29 without a click |

### Phase 5: currencies, the switch, delivery channels

Scope: currencies beyond CHF and EUR (bank details only, no QR-bill); import of open Rechnungen from a
table at the switch (beside the contact and Artikel imports of phase 2); the delivery channel contract
and a reference eBill source in the workspace (ADR 0015); QR «billing information» (Swico S1, decision
7.7).

Acceptance (the Treuhänderin and the consultant):

| # | Checkpoint | 2 means |
|---|---|---|
| P5.1 | Switch from another tool on 1 January with 23 open Rechnungen | imported from a table; payments in January find them by number; the old tool's year-end list matches |
| P5.2 | USD Rechnung | issued in USD with bank details and no QR-bill; booked at the ESTV rate of the tax point |
| P5.3 | eBill | a document goes out through a workspace source on the channel contract; the sent log records the channel and id |

---

## 6. Risks

- **Numbering across devices.** Today a number is safe only within one process (`serial` in
  `service.ts`). Abos and automatic reminders make more issues happen without a person. Only the device
  holding the books issues (decision 7.4); phase 3 builds that role check before automatic reminders,
  phase 4 before Abos.
- **Agreed-basis write-offs and reclassifications of filed periods** follow golden rule 1 and the
  `eventPlan` logic (`events.ts`): dated open, `corrects` when the firm reported on the agreed basis
  then. The same reviews as any change under `src/accounting`.
- **Verrechnung on the cash basis** splits a payment's revenue over two documents' positions; the
  rounding per rate must add up to the payment to the Rappen (a test per mixed-rate case).
- **The customers → contacts step** rewrites every customer record of `invoices.json`; issued documents
  keep their frozen copy, so nothing printed changes. The step is tested on the demos and on a copy of
  real books before release.
- **Golden master churn** from the new demo invoices: one figure change per demo, reviewed once, marked
  **⚠ figures**.

### 6.1 The prototype

The prototype of 2026-11-15 ([mockups/invoicing/](mockups/invoicing/index.html)) shows the earlier
concept. Changing its German strings is not a rename (Offerte is feminine, Angebot neuter), so it is
listed here and updated with phase 2's build:

- «Offerte(n)» → «Angebot(e)», series `OF-` → `AN-`; «Auftragsbestätigung» `AB-` → «Auftrag» `AU-`
  (printed as Auftragsbestätigung); numbers in the new format.
- «Kunden» → «Kontakte», with a person contact and contact persons; area label «Verkauf».
- Tabs and chips with the status names of 4.4.2; Aufträge with «geliefert» and «verrechnet» columns.
- The conversion dialog with positions and open quantities instead of «every line copied»; the
  Lieferschein only from an Auftrag.
- The Gutschrift set off as an allocation shown below the total, not as a deduction line.
- «Rest ausbuchen» beside the Ausziffern dialog with the rest's choices; «Zahlungseingang erfassen».
- «Wiederkehrend» as the Abos tab of Aufträge (a repetition on an Auftrag), not a template list.
- «Stunden übernehmen» as «Leistungen verrechnen» from the Leistungen view.
- Positions: Rabatt/Zuschlag, Seitenumbruch, Gruppe; prices incl./excl. per document.
- index.html: the walk-through and the «What is real and what is new» table follow the new terms.

---

## 7. Decisions

### Decisions (owner, 2026-11-14), as they stand on 2026-11-19

1. **Format steps.** One `invoices.json` step per phase and one manifest step where a phase needs it.
   Each release migrates only what it uses. (Kept; five phases now.)
2. **New refs in the books.** `RE-<n>-wo-<k>` (and `KG-<contact>-<k>`) are no books format change: the
   entry shape stays, no `schema` step. Named in `src/books/refs.ts` and the CHANGELOG. (Kept.)
3. **Write-off on the cash basis** books nothing, not even a 0.00 note entry. (Kept.)
4. **Who issues on which device.** Only the device that holds the books issues, Abos and automatic
   reminders included. A clone only drafts. Revisited with collaboration (ADR 0003). (Kept; extended to
   automatic reminders.)
5. **Number series.** *Replaced* (section 8, C1): one series per kind with a prefix and a format; credit
   notes their own series; numbers at issue, the invoice series gapless.
6. **Set-off of a credit note.** *Replaced* (section 8, C2): an allocation (Verrechnung), not a
   deduction position.
7. **QR «billing information» (Swico S1)** in phase 5, through `swissqrbill` if it supports it,
   otherwise a small encoder in `src/providers/qr-bill/`. (Kept; phase renumbered.)
8. **Romansh** document texts and QR headings are not built now. (Kept.)
9. **Retention proof (GeBüV Art. 9 Abs. 1 lit. b).** SHA-256 per PDF, git history and seals; no
   trusted time stamp. (Kept.)
10. **Default interest** off by default, offered at 5 % (OR Art. 104 Abs. 1). (Kept.)
11. **Quittung** is a Rechnung paid at issue with the means named and the title «Quittung», no new
    kind. (Kept; phase 4.)
12. **Currencies beyond CHF and EUR** come last. (Kept; phase 5.)

### Decisions (owner, 2026-11-15), as they stand on 2026-11-19

13. **Patterns of the market review.** *Widened* (section 8, C3 to C5): the document chain now follows
    the market leader's whole shape, with the Auftrag as hub and conversions that pick positions and
    quantities. The four figures and optional positions stay. Statuses set by hand stay not taken: a
    status is a fact (4.4.2), with the market leader's names.
14. **Warn, then the person decides** (4.11). (Kept; the table follows the new flows.)
15. **Values that change over time** (4.12). (Kept; built in phase 3, `Issued.terms` in phase 1.)

### Decisions (owner, 2026-11-19)

16. **Invoicing follows the market leader's concept closely.** Documents, chain, statuses, terms and
    phases as in sections 4 and 5. Kept from our own: statuses from facts, numbers at issue, the
    cash- and agreed-basis bookings as built, golden rule 1, warn-then-decide, MISSION.md, ADR 0015.
17. **An open point follows the market leader.** «If you have a question, look at how [the market
    leader] does it»: any open point of this spec is settled by the market leader's way (internal
    research), unless it breaks golden rule 1, warn-then-decide or «everything doable without the AI».
    The public repo never names it or copies its wording.
18. **O1 (back to draft):** ours is kept. Only before sending; a sent Rechnung is cancelled or
    credited.
19. **O2 (Debitoren on the cash basis):** kept as built. The cash basis books no Debitoren at issue; the
    agreed basis does (`RE-<n>`).
20. **O3 (time):** Leistungen without a timer or budgets are enough for now.
21. **O4 (Lieferschein):** only from an Auftrag.
22. **The sent state at a glance** (4.8): status mark, «Versand» column with date and channel, the tab
    «Nicht gesendet», the send history on the detail and the «Versendet» list, all from the sent log,
    never set by hand; built in phase 1.

### Decisions in the build (2026-11-19)

23. **The age of an open item counts from the due date** (changed by the lead on 2026-11-19, after the
    phase-1 walk; first built from the invoice date). The market leader's notes capture its open-items
    list only as a download at a key date, with no age basis. Counted from the invoice date, an item 63
    days overdue stood under «> 90 Tage» beside its «Tage überfällig»; now the five bands are the
    days overdue themselves: «nicht fällig», 1–30, 31–60, 61–90 and > 90 days. Offene Posten takes its reference date as
    `?date=` (default today) and sums `openOn`, the year end's own figure. On 31.12. it equals, on the
    cash basis, the year end's receivables proposal (which leaves out only invoices whose event the
    books carry); on the agreed basis, where every app invoice has its event, what the app's invoices
    hold on the receivable account (event less payments and credit notes). A foreign-currency invoice
    is listed in its own currency; the books hold it in theirs.
24. **Überfällig overlaps.** An overdue Rechnung is in the tab Überfällig and in Offen or Teilbezahlt;
    its chip reads «Überfällig · N Tage» with the sent mark.
25. **A Gutschrift's status is one function**, `creditNoteStatus` in `src/invoices/lists.ts`: Offen while
    something of it is still to pay back or set off, Teilweise once part went back, Abgerechnet when
    nothing is left. A note marked «set off» stays Offen until its rest is applied (slice C widens the
    function with allocations).
26. **«Nicht gesendet»** holds the issued documents whose own entry the sent log lacks, cancelled ones
    left out (nothing to send); a paid Rechnung never sent stays in it.
27. **Totals.** A tab's total and the totals row sum Brutto (and Offen) per currency; a cancelled
    document counts only in Storniert, a tab Rechnungen and Gutschriften both have. A cancelled document
    never reads «nicht gesendet» and offers no «Senden».
28. **Bulk actions.** «Senden» sends each ticked issued document by e-mail through the send route, at
    most 25 per run; «PDF» saves at most 20 PDFs per run and records no send; «Export CSV» in the bulk
    bar takes the ticked rows, the one in the facts line the whole tab, filter and search. A document that goes out
    by hand is recorded by its own «Senden › PDF herunterladen» (the download is its entry); there is
    no «als gesendet markieren».
29. **Routes.** A Gutschrift opens under `/invoices/credit-notes/<number>`; `/invoices/<number>` of a
    credit note leads there. An invoice opened from Offene Posten stays there
    (`/invoices/open-items/<number>`).
30. **Layout A is an area option**, `table(route)` in `src/app/areas/index.ts`. Rechnungen, Gutschriften,
    Offene Posten and Versendet are tables; Kunden stays list + detail until Kontakte (phase 2). A row
    of Versendet opens the PDF as sent; its document column links the document.
31. **Sorting is a viewer's preference**, kept in the browser per table, not in the link.
32. **F1 follows 4.11 literally (lead).** A QR-IBAN under any currency but CHF warns when saved (API code
    `qrIbanNotChf`: what is off, SIX IG v2.4 with v2.3 valid until November 2027, banks refuse it after);
    «Trotzdem speichern» sends `invoicing.confirm: 'qrIbanNotChf'` on that one request and the QR-IBAN is
    stored like any other value, nothing else recorded. One stored so, or written by hand before the
    fix, shows the same warning beside the field as a fact. An invoice issued with it carries QRR (the
    person decided); without one a EUR invoice carries the plain IBAN with SCOR, as before. No manifest
    step: the format is unchanged.
33. **Where a QR-IBAN is entered.** No app path wrote one before (only the YAML by hand, and the AI's
    `invoicing` change has no `payTo`), so there was nothing to warn on. Firma › Rechnungslayout ›
    Zahlungskonten gets a QR-IBAN field under each currency's account; `PATCH /api/workspace` takes
    `payTo.<cur>.qrIban` (null takes it out; a text that is no QR-IBAN is refused, `notQrIban`). The
    QR-IBAN stays while its currency keeps the same account and leaves with a change of account.
34. **Structured addresses (v2.3, 4.2.2).** swissqrbill 4.4.2 writes address type S for creditor and
    debtor, street and number apart, postcode and town apart; `line2` has no field there. Proven with
    the library's own encoder (tests/invoice-qr-v24.test.ts); nothing to fix.
35. **`activity` on a position (F3).** 1 is the default and is not stored; 2 is. The picker sits under
    the rate on screen, on a firm with two approved rates only, and not on a 0 % line (its code is the
    exemption's; a 0 % line keeps no activity). A 2 on a firm with one rate (a draft or an invoice from
    before it went back to one) is never refused: a draft drops it at its next save, so it stays
    editable, and booking takes the first rate (`netRateCode(activity) ?? netRateCode(1)`), so a
    statement import never stops on it. A credit note for part of the total splits each rate over its
    activities on a firm with two rates, each line named by the first position of its activity, so a
    credit of activity 2 takes back F2; on any other firm one line per rate as before. The default
    from the Artikel or Tätigkeit (4.4.3) comes with those in phase 2.
36. **Format.** `activity` rides on the one invoices.json step 2→3 of phase 1 (introduced by the
    positions slice); this slice adds no step of its own.
37. **Rabatt on the total (slice B).** A Rabatt takes its percent of, or its amount off, the running
    total of everything above it: the item positions and the Rabatte above it, so several combine
    one after the other (10 %, then CHF 5, then a 2 % Zuschlag). Its total is rounded to the Rappen
    first and then split over the groups above it (rate, net or gross pricing, revenue account), by
    largest remainder: a percent takes its share of each group with the group's sign (a deposit taken
    back at 0 % shrinks too), an amount is spread by the groups' size whatever their sign, so
    positions that nearly cancel never blow it up, so the parts add up to the printed line exactly and every
    rate's net, VAT and gross stay consistent (`priced` in `src/invoices/rules.ts`). An amount is in
    the document's prices (net or gross). On a credit note (negative positions) a Rabatt reduces the
    credit. A Rabatt with no item above it takes nothing and is warned of before issue
    («Trotzdem ausstellen»). An invoice whose total is zero or less (a Rabatt above the total) is
    refused, not warned of: a QR-bill carries no amount below zero (a third party's format); what is
    owed back is a Gutschrift. A position's own discount lies within 0 to 100 %.
38. **Discount per position.** The position's amount is quantity × price to the Rappen, less its
    percent of that, to the Rappen. A Zwischentotal sums the item positions (after their own
    discount) since the last Zwischentotal; Rabatte do not count in it. A Seitenumbruch breaks only
    after a table row on its sheet: one as the first position or a second in a row is no blank sheet.
39. **Prices per document.** `prices: 'net' | 'gross'`; absent reads as net. The step 2 → 3 sets
    `gross` on a document whose every line above 0 % had `vatIncluded` (the credit notes «by
    amount»), else `net`; a line whose flag differs from its document keeps it as `true` or
    `false`, which totals still honour, so no issued figure changes (proved in
    `tests/invoice-positions.test.ts` on the demo and on a mixed file). New lines never carry the
    flag; switching a draft's prices drops it. The VAT rate picker no longer offers «inkl.» per line.
40. **Units.** Ids with a word per document language; the old ids keep their meaning. The German
    word of `h` is «Std.». An issued document freezes the definitions of the units it names
    (`Issued.units`, riding on `invoices.json` schema 3), so a later reminder prints the words the
    invoice printed; the step 2 → 3 freezes the words of 0.6.0 (`h` as «h») on every document issued
    before. A unit an issued document names passes the API even when the list no longer has it, so
    «Als Entwurf kopieren» never fails on it; it prints as the copy's list words it, else its id. A unit is added in Firma › Rechnungslayout with its four words, its id made from
    the German word; it is removed only while no draft uses it (`unitInUse`); a draft that holds a
    removed unit keeps it and prints its id if no list names it.
41. **«Trotzdem ausstellen».** No such path existed for issuing. A position without text or amount
    and a Rabatt with nothing above it are warnings (`warningsForIssue`), no longer gaps: issuing
    refuses with `unconfirmed` unless the request carries `confirm: 'unconfirmed'`, and the invoice
    is then issued with no mark of it. The other Art. 26 gaps stay refusals; turning them into
    warnings is a change of its own.
42. **Phase-1 settings without behaviour yet** (manifest schema 5): the terms a firm names none of
    are one, id `net<N>`, named «N Tage netto» (the words per language in `NET_TERMS`); the write-off
    accounts default to the jurisdiction's (`modules/ch/invoicing.yaml` `writeOff`: 3800, 3805),
    read through `writeOffAccounts`; `shortfallLimit` defaults to 5.
43. **Positions at the API.** Each kind takes only its own fields (an unknown field is refused), so
    a field a later slice adds (`activity`) is added to the item's list in `parseLines`.
30. **A Zahlungseingang by hand is a hand movement (slice C).** «Zahlungseingang erfassen» (date, a
    bank or cash account of the manifest in the invoice's currency, the amount prefilled with what is
    open) adds a movement `source: 'manual'` on that account, allocated to the Rechnung with
    `PaymentAllocation.source: 'hand'` and booked as a statement's payment is (`recordHandPayment`). A
    statement imported later confirms it through `matchStatementRows` (`statement` on the movement):
    nothing is booked twice and the margin names the confirmation. The spec's `account` and
    `linkedTransaction` on the allocation are not needed: the movement carries its account and its
    statement row. A cash payment stays a hand movement. Its «Rückgängig» (open period only) takes the
    movement, its bookings and the allocation; one a statement confirmed is a bank row and is only
    released («Lösen»). The owner's, an employee's or a card account is refused: an invoice is paid
    to the firm.
31. **One payment over several Rechnungen** is one allocation per Rechnung on the same
    `transactionRef`, each booked as that Rechnung's payment; no `allocations[]` array in phase 1
    (payment → invoice lives in `payments[]`, a Gutschrift → its Rechnung in `creditFor`). A surplus is
    refused with the code `surplus` and stays unallocated, so the payment remains a question: the
    Kundenguthaben on 2030 is phase 4. A part above what a Rechnung has open is refused the same way.
32. **Write-offs** (`Issued.writeOffs`, ids `wo-1`, `wo-2`, … per invoice): `openAmount`, `openOn`,
    `refundDue` and the statuses subtract them. Cash basis: nothing in the books (decision 3). A
    document whose `RE-` event the books carry books `RE-<n>-wo-<k>` on the write-off's date: the
    Skonto account (Skonto, Rabatt, Spesen, Rundung) or the loss account (Verlust) against the
    receivable, the invoice's mix of rates with the minus sale codes, one line per code, at the rate
    the receivable holds, the invoice PDF as its receipt. The date lies in an open period (golden rule
    1); no `corrects` (MWSTG Art. 41 Abs. 1: the tax is adjusted when the correction is booked). A
    write-off account the chart lacks joins it under the jurisdiction chart's name when a write-off
    books on it. A Storno reverses the write-offs' entries with the event (`RE-<n>-storno`), so the
    receivable nets to zero.
33. **Skonto by code.** `Issued.terms` freezes the terms printed. A payment found by reference or by
    number is taken for the Skonto when it is the invoice's first, comes on or after the invoice date
    and within the Skonto days, and pays what is open less the Skonto (percent of what is open, to the
    Rappen) within 5 Rappen either way (`SKONTO_TOLERANCE`: a customer's bank may round to 5 Rappen);
    the rest is written off as `skonto` by `code` with the payment's ref, and goes with the payment
    when it is released. Further off it is a short payment for the person (Ausziffern). The paper
    prints the terms' text and «Bei Zahlung bis … 2 % Skonto (CHF …): zu zahlen CHF …» only for terms
    with a Skonto; net terms leave the paper as it was (the closing names the days).
34. **Which terms a draft takes.** A new draft takes the firm's default terms when their days are the
    customer's; a customer with days of its own (`paymentTermsDays`) gets no `termsId` and prints its
    days net, frozen as `net<N>`. A draft may pick any of the firm's terms (`termsId`).
35. **Shortfall below the limit** (`shortfallLimit`, the books' currency): a rest of at most the limit
    after a payment, on an invoice in the books' currency, is a fact on the detail with «als Spesen
    ausbuchen»; code never books it.
36. **Statuses.** Teilbezahlt once something was received, credited or written off and something is
    open; Bezahlt when nothing is. A Gutschrift is Abgerechnet once nothing of it waits (applied to its
    Rechnung at once, the rest paid back), Teilweise while part of a refund waits and something is
    applied or back, Offen while all of it waits; a rest set off against a next invoice waits for
    phase 4 (`creditNoteStatus`).
37. **A Gutschrift above what is open** warns at issue (`unconfirmed` with `credit.aboveOpen`,
    «Trotzdem ausstellen»); above the invoice's total it stays refused.
38. **Verrechnung on the cash basis.** A payment of a Rechnung with Gutschriften applied by its date
    books its share of the Rechnung's positions with the sale codes and its share of the Gutschriften's
    applied parts with the minus codes, in proportion to what each still has unbooked (the earlier
    payments replayed in date order, `cashRevenue`); the lines add up to the payment to the Rappen and,
    once paid in full, each rate is right within a Rappen.
39. **Storno of a paid Rechnung** is a warning (`paid`, the payments named); «Trotzdem stornieren»
    (`confirm: 'paid'`) cancels it and releases its payments, which wait unmatched again and go to the
    booking run. A payment of a filed period is never released, so such a Storno is refused.
40. **The four figures** are one pure function (`figures` in `src/invoices/rules.ts`): Betrag, erhalten
    (the payments without their reminder fees), gutgeschrieben (Gutschriften and write-offs) and offen
    = Betrag − erhalten − gutgeschrieben, which may be below zero (a credit of the customer, phase 4);
    `openAmount` is the same figure, never below zero.
41. **Where the money shows (slice C UI).** The four figures sit between the actions and the sheet
    of every issued, uncancelled Rechnung, in a component of their own (`Figures.tsx`), each figure's
    sources on hover. The margin's «Zahlungen» lists the payments (statement or by hand, a hand one
    with the statement row that confirmed it), the write-offs with «Rückgängig» and the entries each
    event made, each a link to `/journal/<id>`. A shortfall under the limit is a fact on the status
    with one button «Rest … als Spesen ausbuchen». «Ausziffern» opens from a payment proposed for the
    Rechnung and from «Andere Zahlung zuordnen»; Firma › Rechnungslayout › Konditionen lists the terms
    with one default; a draft picks its terms in its margin.
42. **One payment, several documents, one «Lösen» each (review of slice C).** Every entry a payment
    books for a document names the document's number in its text (invoices and credit notes share
    one series), so «Lösen» or «Trotzdem stornieren» takes off only that document's part (`bookedFor`).
    What an Ausziffern replaced is kept beside the books for the payment, not for one invoice, and
    comes back, with the booking run, only when the last allocation leaves the payment. A write-off
    of a cancelled invoice stays (its Storno reversed it); one dated before the invoice is refused
    (`beforeInvoice`). A write-off recorded while the agreed basis's event waited for its rate is
    booked with the event. A hand movement names no counterparty, so a statement row of whoever paid
    confirms it. The write-off account joins the chart in the booking itself (`ensureAccount`),
    whoever books it, code's Skonto included. A refusal of the money carries `paymentRefusal`.
43. **One Gutschrift status.** `creditNoteStatus` lives in `src/invoices/lists.ts` (slice D's, with
    its statuses draft, open, partly, settled, cancelled); slice C widened it: Teilweise also when part
    of the note is applied to its invoice while a rest waits to go back. The four figures share
    `.ivtop` with D's sent line above the status and the actions.
44. **Back to draft: what «sent» means (slice F2).** The way back is refused once the sent log holds
    any document of it (an e-mail, the send dialog's download, a reminder). The plain «PDF
    herunterladen» link records nothing, so the dialog says that the sent log shows no sending and
    that a PDF passed on another way is better corrected by Gutschrift or Storno. Also refused: a
    Rechnung with a payment, a write-off or an issued Gutschrift; a cancelled one; a Gutschrift that a
    payment of its Rechnung dated on or after it took (on the cash basis that payment's booking carries
    the credit's minus lines).
45. **The replaced PDF (slice F2).** The file keeps its bytes and moves to
    `invoices/<number>.replaced-<k>.pdf` beside the number's file, which issuing again needs (storePdf
    never replaces a file). The record names it in `replaced: [{ file, sha256, issuedAt, replacedAt }]`
    (on the draft and, after issuing again, on the issued document); Verlauf shows it with a link
    (`/api/invoices/<id>/replaced/<k>.pdf`). The draft keeps its number in `Draft.number`; the next
    number skips it, issuing takes it again with its reference, and such a draft is not deleted (code
    `numbered`): it is issued again and cancelled, so the series has no gap. The intro loses the
    greeting issuing put above it; a due date the terms gave is dropped.
46. **Back to draft on the books (slice F2).** The `RE-`/`GS-` entries go with every link on that ref,
    and the sales record the PDF became goes with its file when nothing else holds it (named with
    `release`, #405): issuing again books a new receipt under the same file name. On the cash basis the
    books hold nothing of an unpaid document, so nothing is booked or taken back.
47. **Konten ändern, code by code (slice F2, after review).** For each booking of the invoice and of
    its credit notes (events, payments booked from them, refunds), the revenue of each VAT code and
    side (booked, or taken back) is spread over the accounts the positions now name, in proportion
    to the nets of the positions, to the cent; so no code's total moves. Only the positions whose
    old account the booking's own lines carry take part: a line a person changed stays hers and her
    account gets nothing of ours. A booking of an open period changes in place (its ids kept where
    the lines are as many). A document's filed bookings are taken together with its earlier
    reclassifications: one reclassification `RE-<n>-kk-<k>` (a credit note's `GS-<n>-kk-<k>`,
    src/books/refs.ts `reclassRef`) moves, in the books' currency and without a VAT code, what their
    revenue carries now to where the positions put it; so change, change, change back leaves every
    account as filed. Dated today or on the open day the person picks. A payment a person booked
    herself is named and kept. The PDF stays.
48. **Credit notes follow (slice F2, after review).** A credit note of the whole invoice holds its
    positions one by one: each follows its own. Any other's position follows its account when the
    invoice moves that account to one other; when the change splits an account a credit note books
    on over two, it is refused (`credited`) with the way on (one account each, or cancel and issue
    the credit note again). The credit notes' positions record the change too. A Storno reverses a
    document's `-kk-` entries with its event, so no revenue account keeps a part of it.
49. **Foreign currency (slice F2, after review).** Every line keeps the official daily sell rate of
    its booking (AGENTS.md, ADR 0001); no rate of our own. A booking split into more lines converts
    each line on its own, so a code's total in the books' currency may move by a cent. The plan names
    it (`rounding` on the booking) and the dialog says so as a fact («Rundung: CHF 0.01 durch die
    Aufteilung von …»); the change goes ahead (warn, don't block).
50. **Order of writes (slice F2, after review).** Both actions write the books first through the
    write door, then the documents in the invoicing queue (service.ts `backToDraft`,
    `changeAccounts`). Documents changed meanwhile: back to draft renames the PDF back; Konten ändern
    books the change back; both refuse with `changed`. Back to draft takes the receipt a matched and
    released payment left on the cash basis too, and a document issued again files its receipt under
    a name with the PDF's short checksum, so it never resolves to the replaced PDF's file. A draft
    that keeps its number, dated into another year, warns («Nummer 2026-005 im Jahr 2027») and is
    issued on «Trotzdem ausstellen».

51. **The demos' sales (slice E).** The generator plays every document step through the invoicing
    service and every step a person takes after the import (Zahlungseingang by hand, the statement
    row that confirms it, Ausziffern, Rest ausbuchen) through the same functions the API calls
    (`recordHandPayment`, `matchStatementRows`, `allocatePayment`, `writeOffRest`), so a demo can
    hold no state the app could not reach. Payments still lie in Q1 to Q3 only: the demos' bank
    statements end on 30.09., so a payment in Q4 is a cash one entered by hand.
52. **The consultant's invoices replace his old ones from July.** `demo-consulting/` invoices in the
    app from July (the monthly mandate by the hour, the Munich audit in EUR with the place-of-supply
    note); the Q3 sales the generator booked before as sales records of the old tool are these
    invoices now, with the same amounts, so no figure of the consultant moves. Its numbers start at
    2026-001 beside the old tool's 2026-011 … 2026-084, as at a switch in the middle of a year.
53. **A second net rate for the joinery from January.** `demo-schreinerei/` holds a second approved
    rate (2.1 %, trade in appliances) for the whole year, as the method holds for whole years
    (Firma › MWST refuses a change while the year has entries). H1 had no trade turnover: its filed
    return and seal stay byte for byte; its figures gain the row 333 at 0. The appliances of the
    August kitchen book F2.
54. **Golden master re-frozen.** The four demos' frozen books (`tests/golden/<demo>/books.json`) are
    frozen again from today's demos, the entries of the old freeze in their old order, so that every
    file of a filed period stays byte for byte except the 333 row above.
55. **The Skonto line says «Sie überweisen», not «zu zahlen».** «zu zahlen» is a total word of the
    receipt reader (modules/ch/documents.yaml), so a paid invoice filed as its payment's receipt read
    as the Skonto amount, not its total. The reader also takes ʼ (U+02BC, how the PDF reader gives the
    printed ’) as a thousands mark: before, an amount with it lost its thousands.
56. **«Ausgebucht», and the write-offs as a figure of their own** (lead, after the phase-1 walk). A
    Rechnung closed with a loss written off (`reason: loss`, any amount) reads «Ausgebucht», paid in
    part or not: the customer did not pay it. A rest closed as Skonto, Rabatt, Spesen or Rundung keeps
    «Bezahlt». The market leader clears a bad debt with a credit note and keeps no tab for it, so
    «Ausgebucht» counts in the tab «Bezahlt», the closed ones. The figures show the write-offs as
    «ausgebucht» beside «gutgeschrieben», only when there is one: Betrag − erhalten − gutgeschrieben −
    ausgebucht = offen; «gutgeschrieben» holds the Gutschriften alone (4.8 named both under it).
57. **Where a new position goes; a cancelled invoice pairs with nothing** (lead, after the walk).
    «＋ Position», «＋ Text», «＋ Zwischentotal», «＋ Rabatt» and «＋ Seitenumbruch» put the new
    position after the one the person is in, else at the end; a draft whose only position is its
    first item, untouched, starts with the new one instead, so a painter starts with a room's title.
    The PDF of a cancelled invoice, filed as its payment's receipt, is a receipt without a payment
    of its own (`noPaymentFor`): no pairing path (chain, near pairs, proposals, the intake's match)
    ties it to the payment again after «Trotzdem stornieren».
58. **Phase 2, one record shape (slice F1).** Angebot, Auftrag and Lieferschein are records of
    `invoices.json` like a Rechnung (`kind` `quote`, `sales-order`, `delivery-note`), on the same sheet
    and editor. `liveInvoices` holds only the kinds that are booked (Rechnung, Gutschrift), so payment
    matching, VAT events, Offene Posten, the year end's receivables and the reports never see the other
    three; `liveDocuments` holds every kind. A payment naming an Angebot's number names no claim.
59. **No payment part outside the Rechnung.** An Angebot, Auftrag (also as Proformarechnung) and
    Lieferschein carry no QR-bill and no payment reference (`reference` is empty) and need no account
    to pay to before issue. A prepayment asked for with a Proformarechnung is paid against the Rechnung
    made from the Auftrag.
60. **Pro forma is chosen on the draft.** `printAs` of an Auftrag picks the title (Auftragsbestätigung
    or Proformarechnung) and its texts; the issued PDF keeps what it printed (never printed again). It
    carries the Auftrag's own number (AU-…), never one of the invoice series.
61. **Number formats.** A format is letters, digits, `-` and `_`, at most one `{JJJJ}` (the document's
    year) and exactly one `{N…}` (the counter, as many digits as N's, 1 to 9; it grows past them). A
    slash or space is refused (`syntax`): it would break a link, a file name and a ref. A yearly
    restart needs `{JJJJ}` (`restartYearly` without it gives a number twice). Kinds with the same
    format share one counter, and must then restart alike (`sharedRestart`). The next number is one
    more than the highest of the series (cancelled ones count); a number some other document holds
    (a format changed back and forth) is passed over. Absent in the manifest: the defaults
    AN-/AU-/LS-/RE-/GS-`{JJJJ}-{NNNNN}`; the manifest step 5 → 6 writes `{JJJJ}-{NNN}` for invoices and
    credit notes into every manifest with an `invoicing:` section, so an existing workspace numbers on
    (the demo's generator writes the same line). The grammar is core (`src/workspace/numbering.ts`),
    the reference check the provider's (`src/providers/qr-bill/reference.ts` `formatFits`).
62. **QR reference of a number with letters.** QRR holds digits only: a letter of the number counts
    as two digits (A = 10 … Z = 35, as ISO 7064 reads it), so RE-2026-00001 and GS-2026-00001 get
    references of their own. A number without letters keeps its reference exactly (2026-007 as before). A format is refused (`numberFormat`, `tooLongQrr` or `tooLongScor`) when its widest
    number at its digit count exceeds QRR's 26 digits or SCOR's 21 characters; only the kinds with a
    reference are checked. If a counter grows past its digits so that a reference no longer fits,
    issuing refuses with `numberFormat`.
63. **Booking refs of the new numbers.** A number that begins with a letter is its own ref
    (`docRef`: RE-2026-00001, its Storno RE-2026-00001-storno, a write-off RE-2026-00001-wo-1), never
    «RE-RE-…»; a number that begins with a digit keeps `RE-`/`GS-` before it, as before. Refs are
    only compared, never parsed. Should a format make a number whose ref another document holds (a
    switch from `{JJJJ}-{NNN}` to `RE-{JJJJ}-{NNN}` in the same year), issuing is refused (`refTaken`,
    a hard rule: two documents with one ref would break the books). `namesNumber` stays as it was: a
    text «RE-2026-001» names 2026-001 too, and `namedInvoice` takes a payment by number only when
    exactly one document is named. Receipt file names (`<date>-rechnung-<number>.pdf`) and links
    (`/invoices/<number>`) carry the allowed characters as they are.
64. **Open quantities.** A converted position keeps `ofLine`, the index of the source's position.
    What an Auftrag delivered and invoiced of a position is the sum of the issued, uncancelled
    Lieferscheine and Rechnungen made from it (drafts do not count); a Gutschrift of such a Rechnung
    takes back the quantities of its positions that carry `ofLine` (a Gutschrift of the whole Rechnung
    copies them), while a Gutschrift by amount is a price reduction and leaves the quantities. An
    Angebot is taken once: what its Aufträge and Rechnungen took together. An Angebot or Auftrag back
    to draft is edited freely; a position moved then names the index it had.
65. **Statuses (4.4.2).** An Angebot is Angenommen by the click or as a fact (an Auftrag or Rechnung
    made from it, a draft included), which wins over Abgelehnt, since «Trotzdem erstellen» made it;
    the click Abgelehnt is not offered once something was made from it. An Auftrag is Erledigt when
    every position (options left out) is invoiced in full and, where any Lieferschein delivered
    something, delivered in full; Teilweise once something is delivered or invoiced. A Lieferschein is
    Ausgeführt when issued. The columns «geliefert» and «verrechnet» show the share of the Auftrag's
    value done (each position at most its quantity, weighted by its amount).
66. **Conversions.** Allowed: Angebot → Auftrag or Rechnung, Auftrag → Lieferschein or Rechnung; the
    source must be issued and not cancelled. Texts, Zwischentotale, Rabatte and page breaks stay
    where they stood (a Rabatt by amount too: the person sees it on the draft); a trailing page break
    goes. A Lieferschein keeps the prices, unprinted. The request names the warnings the person
    overrode (`confirm: ['expired', 'overOpen']`); each refusal names its facts (`params`). Nothing
    ticked is refused (`nothingTicked`) and makes no draft. The draft takes the customer, currency,
    language, prices, exemption, subject and the customer's order reference (`ordered`); a Rechnung its
    terms; `from` names the source. Conversions write only `invoices.json`, never the books.
67. **Back to draft (Angebot, Auftrag).** The one route of «Zurück zum Entwurf», `POST
    /api/invoices/:id/draft`, takes an Angebot or Auftrag too (F2's rules hold for Rechnung and
    Gutschrift). Refused for a cancelled one and for one something was made from. The draft keeps its
    number in `Draft.number` (decision 45) and is issued under it again. Unlike a Rechnung's, it may
    have been sent: after a send it warns (`sentVersion`, date and recipient) until «Trotzdem
    bearbeiten», and its PDF is not renamed, since the sent log names that file; the new PDF takes
    `<number>-2.pdf`, so the version sent stays byte-exact in the log. It books nothing.
68. **Storno outside the Rechnung.** An Auftrag and a Lieferschein are cancelled with date and reason,
    no notice and no booking; an Auftrag is refused while an issued Rechnung of it stands
    (`orderInvoiced`) and warned while a Lieferschein does (`orderDelivered`, «Trotzdem stornieren»).
    An Angebot is declined, not cancelled.
69. **Copy and defaults.** «Als Entwurf kopieren» makes a draft of the same kind with every position
    (no `from`, no `ofLine`); a Gutschrift's copy stays a Rechnung, as before. A Lieferschein is not
    copied and not created on its own: it comes only from an Auftrag (decision 21); the API refuses
    `kind: delivery-note` on a new draft (`deliveryFromOrder`), and the «＋» of Lieferscheine says so and
    leads to Aufträge. A new Angebot holds 30 days (`validUntil`, changed on the sheet). The «＋» of each
    other table makes its kind; on Gutschriften a Rechnung, since a Gutschrift comes only from its Rechnung.
70. **Numbers held by drafts (review of F1, with F2).** A draft back from issue keeps its number in
    `Draft.number`, one field and one rule for every kind (F2 uses it for Rechnungen): the number stays
    taken for every series (`nextNumberFor` counts it), the draft is issued again under it, never
    deleted (`numbered`), and its number's link opens it.
71. **Only a Rechnung is open money.** `openAmount`, `openOn` and `isOverdue` are 0 and false for every
    kind but the Rechnung; `status` says nothing more than issued for the others (their statuses are in
    lists.ts).
72. **Unique references.** Issuing refuses a number whose payment reference an issued Rechnung or
    Gutschrift carries (`referenceTaken`: a number with and without its dashes makes one QR reference). Firma › Nummern
    refuses a format whose next number would meet an issued document's reference or booking ref, a
    format whose number reads as a link to a draft or a ref of the books (`reserved`: `draft-…`, a
    manual ref M2026-001, `-storno`, `-wo-<k>`), and a Rechnung's or Gutschrift's series shared with a
    kind that is not booked (`sharedKinds`).
73. **Storno of an Auftrag (review of F1).** A Rechnung of it credited in full, or cancelled, no longer
    holds it. Drafts made from it warn first (`orderDrafts`); after the Storno each warns at its issue
    (`sourceCancelled`). Every «Trotzdem» names its own warning: the request carries a list of codes, and
    a code confirms only its warning (`paid` never passes `orderDelivered`). A Rechnung and a Gutschrift
    need an account to pay to before issue, as before; the other kinds none.
74. **Formats of phase 2.** `invoices.json` step 3 → 4 (no transform; the contacts slice G1 joins it)
    and manifest step 5 → 6 (`invoicing.numbering`; `invoicing.prices` takes the new kinds).

---

## 8. Changes from the concept of 2026-11-15 (owner, 2026-11-19)

| # | Old (2026-11-14/15) | New (2026-11-19) | Why |
|---|---|---|---|
| C1 | Decision 7.5: quotes `OF-YYYY-NNN`; invoices and credit notes share one series `YYYY-NNN`; the format fixed | One series per kind (AN-, AU-, LS-, RE-, GS-) with a format setting (prefix, year, digits, yearly restart); credit notes their own series; existing workspaces keep today's format | The market leader's users expect a prefix per kind and their own format. A credit note with its own series is what they know. Numbers stay given at issue, so the invoice series stays gapless, which the market leader does not guarantee |
| C2 | Decision 7.6: a credit note set off as a deduction line on the next invoice | Verrechnung: the credit note is allocated to an open Rechnung (its own first); before issue printed below the total, no position, no VAT of its own | The market leader offsets credit notes against open items. The allocation shows in the four figures and needs no extra booking; on the cash basis the payment's booking takes the credit's positions with the minus codes, so VAT stays right per rate |
| C3 | «Auftragsbestätigung» (AB-) as a printed step of the chain, every line copied on «Folgedokument» | The Auftrag (AU-) is the hub with open quantities per position; printed as Auftragsbestätigung or Proformarechnung; conversions pick positions and quantities | Partial delivery and partial invoicing need quantities per position; Abos and Teilrechnungen hang on the Auftrag in the market leader's concept |
| C4 | Lieferschein from an Angebot, an Auftragsbestätigung or a Rechnung | Lieferschein only from an Auftrag | One chain shape, as the market leader has it; the open quantities live on the Auftrag |
| C5 | «Offerte», «Kunde», «Folgedokument erstellen» as one generic action | «Angebot», «Kontakt», named conversions («Auftrag erstellen», «Lieferschein erstellen», «Rechnung erstellen», «Gutschrift erstellen»); the area «Verkauf» | The Swiss terms the market leader's users read every day |
| C6 | Recurring invoices as a separate template (`recurring[]`) | A repetition on an Auftrag (the Abo); by code on its day, or a run by hand | The market leader defines recurrence on the order; one document shows the subscription and what it invoiced |
| C7 | Hours from a pasted table or CSV straight into lines; time tracking a non-goal | Leistungen as records with Tätigkeiten and rates, «verrechnet» as a fact, «Leistungen verrechnen» onto a draft; still no timer or budgets | Billing by hours is a core of the market leader's sales; records let a Leistung be billed exactly once |
| C8 | Customers with an optional contacts list | Kontakte: firms and persons, contact persons, extra addresses, customer number, defaults, archive, Kontoauszug | The market leader's contact register; a fiduciary sends account statements |
| C9 | Units a fixed, widened list | Units as the firm's own list | The market leader keeps units as master data |
| C10 | «VAT included» per line | Prices incl. or excl. VAT per document, default per kind | The market leader's choice is per document; one document never mixes the two |
| C11 | Write-off only as «Rest ausbuchen»; no payment entered by hand; no allocation over several invoices | Ausziffern dialog with the rest's choice per Rechnung, «Zahlungseingang erfassen» by hand linked to the later statement line, plus «Rest ausbuchen» | The market leader's users close short payments where they allocate them. The link prevents the double booking a hand payment otherwise causes |
| C12 | One payment term and a Skonto setting | Zahlungskonditionen as named templates with Skonto and text | As the market leader keeps them; a contact or kind picks one |
| C13 | Positions: item, title, subtotal, text, discount % per line | Standard, Artikel, Text, Zwischentotal, Rabatt/Zuschlag on the total, Seitenumbruch, Gruppe, Leistung, Spesen | The market leader's position kinds; a discount on the total is split per rate |
| C14 | Issued means frozen, no way back | «Zurück zum Entwurf» while never sent, unpaid and in an open period; a sent Rechnung stays as it is (ADR 0010 amended) | The market leader lets an issued invoice go back to draft; ours only while the customer holds nothing (MWSTG Art. 27 Abs. 2) |
| C15 | No change of account on an issued invoice | «Konten ändern» (accounts only; a reclassification in the open period for a filed one) | A fiduciary corrects allocations this way in the market leader's tool |
| C16 | One layout per firm | Several Vorlagen, texts per kind and language, a fixed attachment, e-mail templates, several recipients and CC | As in the market leader's sales |
| C17 | Phases: 1 correct and closed (incl. dated values), 2 quotes and partial invoices, 3 recurring, hours, articles, 4 dunning run, currencies, import, channels | 1 correct and closed in the market leader's terms; 2 Angebot, Auftrag, Lieferschein, Artikel, Kontakte; 3 Teilrechnungen, Mahnwesen, Vorlagen, dated values; 4 Abos, Leistungen, Spesen, Kundenguthaben, Quittung; 5 currencies, switch, channels | Phase 1 stays the fixes plus what users of the market leader use after every invoice; the Mahnlauf moves from 4 to 3; dated values from 1 to 3 (only `Issued.terms` stays in 1, for Skonto) |
| C18 | Overpayment not handled | Kundenguthaben on 2030, applied to the next Rechnung or paid back | The market leader books a surplus as customer credit |
| C19 | A tick «gesendet» column, its detail on hover only | The sent state at a glance: chip mark, «Versand» with date and channel, tab «Nicht gesendet», send history in the margin, «Versendet» list; phase 1 | The owner (2026-11-19): it is hard today to see what has been sent. The market leader shows it per document; here it stays a fact of the sent log |

**Not taken from the market leader, each for its reason** (the internal synthesis has the detail):

- **Statuses set by a click** (sent, paid, delivered, invoiced): here they are facts (goal 4).
- **A credit note always dated today:** here the person dates it in any open period, today by default.
- **Entries into a filed VAT quarter**, which the market leader allows after a quarter is marked billed,
  so that late VAT appears in no return: here golden rule 1 refuses them; corrections go into the open
  period and form 0535.
- **A sent invoice back to draft:** here only an unsent one (decision 18).
- **Debitoren on 1100 all year on the cash basis:** here the cash basis books at payment as built
  (decision 19).
- **Reminder fees as a separate invoice or by rewriting the invoice:** here the fee is on the Mahnung
  and booked when paid.
- **A bad debt written off against revenue:** here against Verluste aus Forderungen with the VAT
  correction on the agreed basis.
- **Draft numbers that leave gaps:** here numbers at issue.
- **A timer, project budgets, stock, online view with read tracking, payment links, rights per
  kind:** non-goals (4.2).

### Owner questions, answered (2026-11-19)

- **O1 A sent Rechnung back to draft:** no. Only before sending; a sent one is cancelled or credited
  (decision 18).
- **O2 Debitoren in the books on the cash basis:** kept as built (decision 19).
- **O3 Time tracking:** Leistungen without timer or budgets are enough for now (decision 20).
- **O4 Lieferschein only from an Auftrag:** yes (decision 21).

## Sources

- MWSTG Art. 8, 18, 23, 24, 26, 27, 37, 40, 41, 42, 70, 115, as published (via justement.ch, text of
  fedlex).
- MWSTV Art. 45, 57, 106.
- OR (SR 220) Art. 102, 104, 958f. GeBüV (SR 221.431) Art. 9.
- SIX, Swiss Implementation Guidelines for the QR-bill, v2.4 of 24.02.2026:
  <https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.4-en.pdf>
- ESTV, Saldosteuersätze und Pauschalsteuersätze:
  <https://www.estv.admin.ch/de/mwst-saldosteuersaetze-pauschalsteuersaetze>; MWST-Info 12.
- eBill: <https://ebill.ch>.
