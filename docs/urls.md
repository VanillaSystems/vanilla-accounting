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
| `/receipts` | Belege of the period of the newest data |
| `/receipts/<receipt-id>` | one receipt (id: the first 16 hex characters of its SHA-256) |
| `/receipts/bills` | Zu bezahlen: the bills among the period's receipts with their due date, overdue, open or paid (#571); `?status=open\|overdue\|paid` (`open` holds the overdue ones), and Belege's chips but `state` and `linked` |
| `/receipts/bills/<receipt-id>` | one receipt, beside that list |
| `/bank` | Kontoauszüge |
| `/bank/<account>-<yyyy-mm>` | one statement, e.g. `/bank/1021-2026-09` |
| `/bank/<account>-<yyyy-mm-dd>` | a statement of some days, by its first day, when a month has several, e.g. `/bank/1020-2026-10-15` (`_<last day>` added when two start the same day) |
| `/bank/<statement>/<bank-ref>` | one payment in that statement |
| `/bank/files/<account>/<file name>` | one statement file read in, whole, with its details and every movement it holds (Kontoauszüge › Datei), e.g. `/bank/files/1021/camt053_2026-09.xml` |
| `/payments/<bank-ref>` | resolves to the statement of that payment, or to its entry if it was paid privately |
| `/journal` | Buchungen; `?vat=<code>` filters by VAT code |
| `/journal/<entry-id>` | one journal entry |
| `/vat` | MWST report of the oldest return not filed (the period after the filed ones; books that never filed: the period of their first payment or entry) |
| `/vat/open` | what is still open in the period of a return not filed: questions, payments without a booking, receipts without a payment |
| `/vat/<ziffer>` | one form line with the entries behind it, e.g. `/vat/405?period=2026-Q3` |
| `/vat/codes` and `/vat/codes/<code>` | the VAT code catalogue, one code, e.g. `/vat/codes/I81` |
| `/reports/income`, `/reports/balance`, `/reports/trial` | Erfolgsrechnung, Bilanz, Saldobilanz |
| `/reports/<report>/<account>` | one account's ledger inside that report, e.g. `/reports/balance/1021` |
| `/close` and `/close/<step>` | year-end close and one of its steps |
| `/company/<section>` | `profile`, `vat`, `banks`, `invoice-layout`, `mail`, `sources`, `rules`, `accounts`, `dimensions`, `periods`, `opening`, `display` |
| `/company/rules?payment=<ref>` | the form of a new rule, started from that payment (`&by=text`: with the payment's lasting words instead of its payer) |
| `/invoices` | Verkauf › Rechnungen; `?status=draft\|open\|overdue\|partly-paid\|paid\|cancelled\|unsent` (`unsent`: «Nicht gesendet») |
| `/invoices/<number>` | an issued document of any kind, e.g. `/invoices/2026-006`, `/invoices/AN-2026-00004`; it opens in the view of its kind (a credit note in Gutschriften, `/invoices/credit-notes/<number>`; an Angebot in Angebote, …) |
| `/invoices/quotes` and `/invoices/quotes/<number>` | Angebote and one open over the table; `?status=draft\|open\|accepted\|declined\|expired\|unsent` |
| `/invoices/orders` and `/invoices/orders/<number>` | Aufträge; `?status=draft\|open\|partly\|done\|cancelled\|unsent` |
| `/invoices/deliveries` and `/invoices/deliveries/<number>` | Lieferscheine; `?status=draft\|done\|cancelled\|unsent` |
| `/invoices/credit-notes` and `/invoices/credit-notes/<number>` | Gutschriften and one open over the table; `?status=draft\|open\|partly\|settled\|unsent` |
| `/invoices/open-items` and `/invoices/open-items/<number>` | Offene Posten on today, or on `?date=2026-12-31`, and one invoice open over it |
| `/invoices/draft-<id>` | a draft (it has no number until it is issued) |
| `/invoices/<number>.pdf` | the invoice as PDF, exactly as issued (app only) |
| `/invoices/new?customer=<id>` | a new draft for that customer (app only) |
| `/invoices/contacts` and `/invoices/contacts/<id>` | the contacts and one contact (`/invoices/customers[/<id>]`, the old links, lead there) |
| `/invoices/articles` and `/invoices/articles/<id>` | the Artikel and one Artikel, its form in the panel over the table |
| `/invoices/sent` and `/invoices/sent/<document-id>` | the log of sent documents and one of them, exactly as sent |
| `/partners` and `/partners/<id>` | Geschäftspartner and one partner's page; the id is its knowledge file's (`gruenkaffee-muster`) or, for a customer of Rechnungen without one, the customer's (`cu_…`) |
| `/knowledge` | Wissen, opening on its first page (Lücken) |
| `/knowledge/gaps`, `/knowledge/app` | Lücken and Von der App |
| `/knowledge/<topic>` | one page of Arbeitsweise, by its file's name (`knowledge/company/<topic>.md`); a topic is never named `gaps` or `app` |
| `/automation` | Automatisierung's home: the shown period's receipts from collected to filed, what waits for you, what runs; `?period=` another filing period |
| `/automation/runs` and `/automation/runs/<run-id>` | Läufe, the latest runs, and one run |
| `/payroll` | Löhne › Übersicht: the year strip and the Lohnlauf of this month; `?period=2026-09` another month, `?period=2026` another year |
| `/payroll/<yyyy-mm>` and `/payroll/<yyyy-mm>/<employeeId>` | Lohnabrechnungen: a month's Lohnlauf, and one payslip, e.g. `/payroll/2026-09/p1a2b3c`; `/payroll/payslips` is this month's |
| `/payroll/payslips/<yyyy-mm>-<employeeId>.pdf` | a closed payslip's PDF, exactly as filed in Belege (app only) |
| `/payroll/payments/<yyyy-mm>`, `/payroll/payments/<yyyy-mm>/<employeeId>` and `/payroll/payments/<yyyy-mm>/insurances/<insuranceId>` | Lohnzahlungen: a month's payouts with the bank line that paid each, one of them, and one insurer's balance of that month's year with its final statement; `/payroll/payments` is this month's |
| `/payroll/employees` and `/payroll/employees/<id>` | Mitarbeitende and one person; `/payroll/employees/new` the form of a new one (app only) |
| `/payroll/documents/<year>` and `/payroll/documents/<year>/<doc>` | Dokumente: a year's documents; `<doc>` a person's Lohnausweis by her id, `lohnkonto`, `declarations` (the figures of the annual declarations), `family` (the family allowances against the fund), `pension` (the pension fund's expected wages), `journal` (the Lohnbuchungen per month) or `tax-at-source` (the Quellensteuer settlement lists per canton and month); `/payroll/documents` is this year's |
| `/payroll/documents/<year>/lohnausweis/<id>.pdf`, `/payroll/documents/<year>/lohnausweis.csv`, `/payroll/documents/<year>/lohnkonto.csv[?employee=<id>]`, `/payroll/documents/<year>/declarations.csv`, `/payroll/documents/<year>/family.csv`, `/payroll/documents/<year>/pension.csv`, `/payroll/documents/journal/<yyyy-mm>.csv`, `/payroll/documents/<year>/tax-at-source.csv[?month=<yyyy-mm>&region=<canton>]` | an issued Lohnausweis's PDF and the year's tables as CSV (app only) |
| `/payroll/payments/<yyyy-mm>/payment-file.xml[?account=<number>]` | the month's payment file (pain.001) of the payouts not paid yet (app only) |
| `/payroll/settings/<section>` | Einstellungen: `company` (Stammdaten), `insurances`, `wage-types`, `accounts` |

## Query parameters

| Parameter | Where | Meaning |
|---|---|---|
| `period` | every list with periods | `2026`, `2026-Q3`, `2026-09` or `2026-07-01_2026-09-30`; left out when it is the period of the newest data (the filing period of the newest payment, receipt or entry, `dataPeriod`; for Rechnungen also its newest issued invoice; for MWST the oldest return not filed, `booksOpenPeriod`), which a page shows without one |
| `f` | receipts, journal | a filter chip `<field>_<value>`, repeated, one per chip (#211, `src/app/shell/chips.ts`): `?f=partner_fedex&f=partner_amazon&f=over_100`. Chips of different fields all hold (AND), chips of one field are alternatives (OR); a bound (`over`, `under`, `amount`, `from`, `to`) or a yes/no field takes one value. Belege: `partner` (a knowledge file's id), `state` (`linked`, `open`, `noDate`, `needsYou`, `unreadable`, `notReceipt`, `quarantine`), `month` (`2026-08`), `from`, `to` (`2026-08-01`), `over`, `under`, `amount` (a number), `currency`, `rate` (the rate the receipt shows, `8.1`, or `none`), `kind`, `linked` (`yes`, `no`). Buchungen: `account`, `rate` (the code's rate, or `none` without a code), `partner`, the same dates and amounts, `currency`, `who` (`classify`, `rule`, `code`, `manual`, `assistant`, `invoice`, `year-close`, `other`), `receipt` (`yes`, `no`, `missing`), `corrects` (`yes`, `no`). The old `?filter=zugeordnet\|offen\|ohneDatum` of Belege redirects to `f=state_linked\|open\|noDate`. |
| `status` | invoices, receipts/bills | as above |
| `date` | invoices › open-items | the reference date of Offene Posten, `2026-12-31`; left out for today |
| `vat` | journal | VAT code filter |
| `q` | every list | search text (also the filter's «Text enthält»: it stays the search, not a chip) |

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
