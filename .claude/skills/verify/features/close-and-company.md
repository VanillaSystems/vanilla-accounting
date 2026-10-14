# Abschluss and Firma

Abschluss (`/close[/<step>]`, rebuilt in redesign phase 7) is the year-end in seven steps over the year-close engine (`src/accounting/year-close.ts`, `src/books/year-close.ts`, routes `/api/year-close/:year/*`). Firma (`/company/<section>`) shows and edits what the workspace says about the company: `belege.workspace.yaml` through `PATCH /api/workspace` (field by field, comments and unknown fields kept), `master-data/accounts.json` through `PUT /api/accounts/<number>`, and the seals and filings read by `GET /api/workspace`.

## Sub-features

- `close-steps`: the list `.row.ystep[data-step]` (`q4`, `checks`, `entries`, `close`, `open`, `profit`, `handover`) grouped Vorher, Abschliessen, Nachher, each with its state pill (`st-ok|warn|open|later`). The year is the period's (`?period=2025`), else the open quarter's; the `.ytag` opens the period picker.
- `close-checks`: `.chk[data-check]` rows: the engine's checks, then `fx`, `vat`, `entries`, `invoices` (open on 31.12.), `balance`; a row with `→` goes to its step or area. Below: the VAT reconciliation table.
- `close-entries`: `[data-template=<id>]` rows with `Nicht nötig`, `Erfassen` (an inline form prefilled from the template), `zurück`. `receivables` appears only with invoices open on 31.12., amount and revenue account prefilled; booking it marks it done; the toast's Rückgängig deletes the entry and resets the mark.
- `close-close`: the Kursdifferenz table with `Kursdifferenz buchen`, the closing balance sheet, `Jahr <year> abschliessen` (disabled with the blocking problems listed; when only the Kursdifferenz is open it books it first, after a confirm dialog).
- `close-open`, `close-profit`, `close-handover`: the opening preview or table with `Neues Jahr eröffnen` / `Eröffnungssaldi aktualisieren`; the profit allocation (date, reserve, dividend, 35 % split; booking only after the close); three handover cards; the Banana and Prüfung cards open the export dialog with the year.
- `company-sections`: `.row.fset[data-section]`: `profile`, `vat`, `banks`, `invoice-layout` (features/invoices.md), `accounts`, `periods`, `opening`, `display`.
- `company-edit`: profile (`Bearbeiten`, inline form, Rückgängig), banks (`Bezeichnung und IBAN bearbeiten`, `Bankkonto hinzufügen`), accounts (number + name: rename an existing account or add a new one; a rename can be undone). A change the manifest's reader refuses is shown in the toast and nothing is written.

## How to get to it (user POV)

- Dock `Abschluss` (`G A`) or `Firma` (`G F`); ⌘K lists the steps and the sections.
- From Firma › MWST to the MWST area and the codes; from Perioden to Abschluss; account rows open their ledger in Bilanz & ER.

## Driving it with browse + sandbox.sh

- **Checks.** `$B goto "$UI/close"`: the URL stays `/close`, the detail is `Prüfen, was offen ist`. On the demo: Q4 and the bank checks are `later`, `invoices` lists the demo's 3 open invoices with their CHF total.
- **Receivables.** `/close/entries`, in `[data-template=receivables]` click `Erfassen`: inputs read `2026-12-31`, `1100`, `3300` and the open total of the `invoices` check. Submit, then `$S diff` shows `+ journalEntries <id>` and `$SB/transactional-data/2026/filings/year-close.json` has `receivables: done`. Click the toast's `Rückgängig` within 6 s: `$S diff` says `no changes`.
- **Profile.** `/company/profile`, `Bearbeiten`, type into `input[name=business]`, save: `diff` of the manifest shows one added line `business: …`; clearing it and saving again leaves the file byte-identical.
- **Accounts.** `/company/accounts`, number `1100`, a name, `Konto hinzufügen`: accounts.json gains the account in number order; a known number switches the button to `Umbenennen`.
- **Refusal.** `/company/banks`, `Bezeichnung und IBAN bearbeiten`, an IBAN with a wrong check digit, save: the toast names it, the manifest is unchanged.

## Gotchas

- The sandbox clones `invoices.json` and `invoices/` (since phase 7): without them the receivables proposal is empty.
- The toast's Rückgängig only works while the toast shows (6 s); a stale toast's button does nothing.
- A bank account added with a ledger account missing from accounts.json makes `npm run doctor` fail, and the Abschluss checks show it.
- Closing the year needs Q4 filed, Q1–Q3 sealed and December statements; the demo cannot get there, so `Jahr abschliessen` stays disabled there. The close itself is covered by tests/year-close.test.ts.
