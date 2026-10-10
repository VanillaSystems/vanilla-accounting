# ADR 0010: Invoicing in the same app, paid invoices matched by their QR reference

Status: accepted (2026-10-10). Nothing built yet.

## Problem

A company that leaves an all-in-one tool such as bexio needs to write invoices, not only book
them. bexio's invoicing, as its own pages describe it: a QR-bill on every invoice, incoming
payments recognized through the e-banking link, reminders (automatic if wanted), quotes,
invoices and delivery notes from stored customers, articles and services, invoices from a quote
or from recorded hours, and an own layout with logo and letterhead.

The app books on the cash basis (vereinnahmte Entgelte) from the bank statements and keeps no
open invoices ([getting-started.md](../getting-started.md)). The question is whether invoicing
belongs in this app or in a product of its own, and how it fits the cash basis.

## Decision

### Invoicing is an area of this app

Invoices, customers, incoming payments and bookings are the same data in the same workspace. A
separate product would keep two data sets in sync. Invoicing is one more area in the app
("Rechnungen"), with the same command registry, history, roles and agents.

### The core: a paid invoice is found by its reference

```
  issue invoice ──► QR-bill with a reference ──► customer pays ──► camt.053 line carries
  (number, lines,    (QRR with a QR-IBAN, or                         the same reference
   VAT per line)      SCOR creditor reference with an IBAN)                │
                                                                           ▼
                                   on import: invoice found by reference, marked paid,
                                   revenue booked with the VAT code of its lines,
                                   the invoice PDF as the entry's receipt
```

No model and no manual matching are needed for a paid QR-bill: the reference is in the
structured remittance information of the camt line. This fits the cash basis exactly: the
revenue is booked when the money arrives, from the invoice's own lines.

- **Partial and multiple payments:** a payment smaller than the invoice leaves the rest open; one
  payment for several invoices, or several payments for one, are allocations
  ([ADR 0003](0003-deployment-and-collaboration.md), section 3).
- **Payments without the reference** (a customer typed the amount by hand) fall back to matching
  by amount, customer and date, proposed and confirmed like other matches.
- **Year-end:** invoices still open on 31 December are proposed as receivables (Debitoren) in the
  year-end checklist ([year-end.md](../year-end.md)); the opening of the next year reverses them.

### What an invoice is

- **A record with the envelope** ([ADR 0004](0004-versions-and-record-envelope.md)): customer,
  date, due date, lines (text, quantity, price, VAT rate), currency (CHF or EUR, both supported
  by the QR-bill), reference, state.
- **The content a VAT invoice needs** (Art. 26 MWSTG): the supplier's name, address and VAT
  number, the recipient, date or period, the description, the amount, and the VAT rate and
  amount. The app refuses to issue an invoice that lacks one.
- **Issued means frozen.** A draft can be changed; an issued invoice cannot. A correction is a
  credit note (Gutschrift) or a cancellation (Storno) referring to it, as in any bookkeeping.
- **Drafts can be deleted; issued invoices are cancelled, never deleted.** A cancellation (Storno) keeps
  the number taken and the invoice on file, marks it with date and reason, drops it from the open
  invoices and its QR-bill from the document; a later payment with its reference is reported for a
  decision. A paid invoice is not cancelled: the money goes back through a credit note for the full
  amount.
- **A reminder is a document of its own,** drafted from the invoice: title "1. Mahnung", "2. Mahnung" (in
  the invoice's language), the same lines, total and QR reference, a new due date, and texts that can be
  changed before sending.
- **Everything sent is kept as sent.** Invoice, resent invoice, reminder, credit note, cancellation notice:
  the PDF as it went out, with its checksum, the time and the recipient, listed per invoice and in one
  log of all sent documents. A sent document is never rendered again from changed data.
- **Comments are internal.** Any invoice carries notes with author and time ("zahlt Ende Oktober");
  they are never printed or sent.
- **Numbers are unique and given at issue.** Invoice numbers are the one place customers expect
  a running sequence, which clashes with clones that work offline (rule D,
  [ADR 0003](0003-deployment-and-collaboration.md)). So drafts carry no number; **issuing** pulls
  `main`, takes the next number, commits and pushes at once, like a small finalization. Offline,
  an invoice stays a draft.
- **Customers** are records of their own (name, address, language, VAT number, payment terms).

### First version

| In | Later |
|---|---|
| customers | quotes, converted to an invoice |
| invoices with VAT per line, credit notes, cancellation | recurring invoices |
| QR-bill and PDF with logo and letterhead | invoices from recorded hours |
| numbering at issue | delivery notes, an article catalogue |
| sending by e-mail through the company's own mailbox, or download | eBill |
| automatic matching by reference on camt import | |
| reminders in levels, optional fee | |
| open invoices in the year-end checklist | |

The QR-bill is produced with an existing open-source implementation of the Swiss QR-bill
standard rather than written anew (to be chosen when building).

### Agents and roles

The registry gains tools such as `create_invoice`, `issue_invoice`, `list_open_invoices`,
`send_reminder` ([ADR 0005](0005-agents-command-registry-cli-mcp.md)): "Claude, write Müller AG
an invoice for 12 hours in October". Owner and bookkeeper issue invoices; the Treuhänder may in
full service; employees do not ([personas](../personas/README.md)).

### Prerequisite for many who leave bexio

Today the app supports only companies registered for VAT on the effective method; a freelancer
without VAT is refused by the setup, and a sole proprietorship (Einzelfirma) is covered only in
part. Invoicing reaches the typical freelancer only once those are supported; that is a decision
of its own.

## Consequences

- New record kinds: customer, invoice (with lines), credit note, reminder.
- The camt import reads the structured reference and matches invoices before anything else.
- The receipt kind `sales-record` gains the issued invoice PDF as a source.
- The year-end checklist gains "open invoices on 31.12.".
- Sending needs the company's outgoing mail settings next to the existing `mail.yaml`.

## Rejected

- **A separate invoicing product:** two data sets for one company's customers, invoices and
  payments.
- **Switching the books to the accrual basis (vereinbarte Entgelte) for invoicing:** the cash
  basis stays; open invoices are a list beside the books until paid, and receivables at
  year-end.
- **Editing issued invoices:** a sent invoice is a document the customer holds; corrections are
  credit notes or cancellations.
- **A model for payment matching:** the reference makes it exact and free; the model is only for
  payments without it.
- **Numbers for drafts:** gaps and collisions across clones; the number belongs to the moment of
  issue.
