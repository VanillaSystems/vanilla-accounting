# URLs: every page and every object has a link

Status: plan (2026-10-10). The UI mockup implements it with the hash (`index.html#/invoices/2026-006`); the
app uses real paths (`/invoices/2026-006`) with the server answering every path with the app.

## Rules

1. **A link names a thing, not a screen state.** `/journal/<entry-id>` opens that entry wherever it is.
   The period the list shows follows from the thing's date unless the link names one (`?period=`).
2. **Ids are stable and come from the data,** never a list position: a receipt's checksum id, a bank
   reference, an entry id, an invoice number, an account number, a VAT code, a form number (Ziffer).
3. **Slugs are English and never translated.** The UI language changes, links don't; a link sent from a
   German screen opens on a French one.
4. **Changing area adds a history entry; selecting a row replaces it.** Back goes to the previous page, not
   through every row the arrow keys passed.
5. **A link to something that no longer exists** opens its list with a notice ("Rechnung 2026-099 gibt es
   nicht"), never an empty or broken page.
6. **The tab title names the object:** `2026-006 · Rechnungen`.
7. **A link opens only for someone who may see it.** The URL carries no access; the role decides
   ([personas](personas/README.md)). The same link works on the desktop app, a cloud instance and the
   read-only audit export, wherever the object exists there.
8. **No amounts, names or private text in a URL.** Ids and numbers only. A search (`?q=`) is the one
   exception, and it is not added to links the app builds for sharing.

## Paths

| Path | Opens |
|---|---|
| `/receipts` | Belege of the open period |
| `/receipts/<receipt-id>` | one receipt (id: the first 16 hex characters of its SHA-256) |
| `/bank` | Kontoauszüge |
| `/bank/<account>-<yyyy-mm>` | one statement, e.g. `/bank/1021-2026-09` |
| `/bank/<account>-<yyyy-mm-dd>` | a statement of some days, by its first day, when a month has several, e.g. `/bank/1020-2026-10-15` (`_<last day>` added when two start the same day) |
| `/bank/<statement>/<bank-ref>` | one payment in that statement |
| `/payments/<bank-ref>` | resolves to the statement of that payment, or to its entry if it was paid privately |
| `/journal` | Buchungen; `?vat=<code>` filters by VAT code |
| `/journal/<entry-id>` | one journal entry |
| `/vat` | MWST report of the open quarter |
| `/vat/<ziffer>` | one form line with the entries behind it, e.g. `/vat/405?period=2026-Q3` |
| `/vat/codes` and `/vat/codes/<code>` | the VAT code catalogue, one code, e.g. `/vat/codes/I81` |
| `/reports/income`, `/reports/balance`, `/reports/trial` | Erfolgsrechnung, Bilanz, Saldobilanz |
| `/reports/<report>/<account>` | one account's ledger inside that report, e.g. `/reports/balance/1021` |
| `/close` and `/close/<step>` | year-end close and one of its steps |
| `/company/<section>` | `profile`, `vat`, `banks`, `invoice-layout`, `mail`, `sources`, `rules`, `accounts`, `periods`, `opening`, `display` |
| `/company/rules?payment=<ref>` | the form of a new rule, started from that payment |
| `/invoices` | Rechnungen; `?status=open\|overdue\|draft\|paid` |
| `/invoices/<number>` | an issued invoice or credit note, e.g. `/invoices/2026-006` |
| `/invoices/draft-<id>` | a draft (it has no number until it is issued) |
| `/invoices/<number>.pdf` | the invoice as PDF, exactly as issued (app only) |
| `/invoices/new?customer=<id>` | a new draft for that customer (app only) |
| `/invoices/customers` and `/invoices/customers/<id>` | customers and one customer |
| `/invoices/sent` and `/invoices/sent/<document-id>` | the log of sent documents and one of them, exactly as sent |

## Query parameters

| Parameter | Where | Meaning |
|---|---|---|
| `period` | every list with periods | `2026`, `2026-Q3`, `2026-09` or `2026-07-01_2026-09-30`; left out when it is the open period |
| `filter` | receipts | `zugeordnet`, `offen`, `ohneDatum` |
| `status` | invoices | as above |
| `vat` | journal | VAT code filter |
| `q` | every list | search text |

## Who builds links

- **The UI** keeps the address bar in step with what is selected, so copying the address always shares
  what is on screen.
- **Agents** (CLI and MCP, [ADR 0005](adr/0005-agents-command-registry-cli-mcp.md)) return a link with
  every object they create or find ("Entwurf angelegt: /invoices/draft-…"), relative to the instance
  they talk to.
- **Exports** (PDF reports, the audit export) may print the path next to an entry or receipt, so a
  printed report can be traced back to the record.

## Not in URLs

- Panel state (which sections are open), the theme, the list width and zoom: per viewer, kept in the browser.
- Dialogs (export, credit note): a dialog is an action, not a place. A link to a credit note dialog would
  be a link to a write.
