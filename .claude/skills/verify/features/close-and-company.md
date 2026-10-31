# Abschluss and Firma

Abschluss (`/close[/<step>]`, rebuilt in redesign phase 7) is the year-end in seven steps over the year-close engine (`src/accounting/year-close.ts`, `src/books/year-close.ts`, routes `/api/year-close/:year/*`). Firma (`/company/<section>`) shows and edits what the workspace says about the company: `belege.workspace.yaml` through `PATCH /api/workspace` (field by field, comments and unknown fields kept), `master-data/accounts.json` through `PUT /api/accounts/<number>`, and the seals and filings read by `GET /api/workspace`.

## Sub-features

- `close-steps`: the list `.row.ystep[data-step]` (`q4`, `checks`, `entries`, `close`, `open`, `profit`, `handover`) grouped Vorher, Abschliessen, Nachher, each with its state pill (`st-ok|warn|open|later`). The year is the period's (`?period=2025`), else the open quarter's; the `.ytag` opens the period picker.
- `close-checks`: `.chk[data-check]` rows: the engine's checks, then `fx`, `vat`, `entries`, `invoices` (open on 31.12.), `balance`; a row with `→` goes to its step or area. Below: the VAT reconciliation table.
- `close-entries`: `[data-template=<id>]` rows with `Nicht nötig`, `Erfassen` (an inline form prefilled from the template), `zurück`. `receivables` appears only with invoices open on 31.12., amount and revenue account prefilled (the debit account only when the chart has it, else `[data-testid=receivables-account-missing]` with `Konto 1100 anlegen`; payments naming an open invoice without its link block it, `[data-testid=receivables-unlinked]`); booking it marks it done; the toast's Rückgängig deletes the entry and resets the mark.
- `close-close`: the Kursdifferenz table with `Kursdifferenz buchen`, the closing balance sheet, `Jahr <year> abschliessen` (disabled with the blocking problems listed; every click asks `Abschliessen` first, and a waiting Kursdifferenz is booked before the close).
- `close-open`, `close-profit`, `close-handover`: the opening preview or table with `Neues Jahr eröffnen` / `Eröffnungssaldi aktualisieren`; the profit allocation (date, reserve, dividend, 35 % split; booking only after the close); three handover cards; the Banana and Prüfung cards open the export dialog with the year.
- `company-sections`: `.row.fset[data-section]` in three groups: Stammdaten `profile`, `vat`, `banks`, `invoice-layout` (features/invoices.md), `mail` (E-Mail-Versand), `sources` (Quellen); Buchhaltung `accounts`, `rules` (Regeln), `periods`, `opening` (Eröffnung <year>); Diese App `display`, `phone` (Handy, desktop app only). Above them `.obentry button.aiact` (`Einrichtung öffnen` / `fortsetzen`, features/setup.md); below, the app version `.appver`.
- `company-edit`: profile (`Bearbeiten`, inline form, Rückgängig; logo `POST /api/workspace/logo`), VAT (`Bearbeiten`: `input[name=registered]`, `select[name=method|period]`, `rate1/label1/activity1…`, `PATCH /api/workspace {vat}`, refused with `vatMethodHeld` while the open year has entries), banks (`Bezeichnung und IBAN bearbeiten`, `Bankkonto hinzufügen`, `[data-testid=remove-bank][data-bank]` with undo), accounts (number + name: rename an existing account or add a new one; a rename can be undone; `[data-testid=account-unplaced]` for an account outside the statements), opening balances (`PUT /api/opening-balances/<year>/<account>`). A change the manifest's reader refuses is shown in the toast and nothing is written.

## How to get to it (user POV)

- Dock `Abschluss` (`G A`) or `Firma` (`G F`); ⌘K lists the steps and the sections.
- From Firma › MWST to the MWST area and the codes; from Perioden to Abschluss; account rows open their ledger in Bilanz & ER.

## Driving it with browse + sandbox.sh

- **Checks.** `$B goto "$UI/close"`: the URL stays `/close`, the detail is `Prüfen, was offen ist`. On the demo: Q4 and the bank checks are `later`, `invoices` lists the demo's 3 open invoices with their CHF total.
- **Receivables.** The demo's chart has no 1100: add it first (Accounts below, `1100` `Debitoren`). `/close/entries`, in `[data-template=receivables]` click `Erfassen`: inputs read `2026-12-31`, `1100`, `3300`, the open total of the `invoices` check, `Debitoren per 31.12.2026: offene Rechnungen 2026-003, 2026-005, 2026-006`. Click `Buchen`: toast `Debitoren (offene Rechnungen): CHF <total> gebucht`, `$S diff` shows `+ journalEntries yc-2026-receivables` and `$SB/transactional-data/2026/filings/year-close.json` has `"receivables": "done"` (driven 2026-10-21). The toast's `Rückgängig` within 6 s: `$S diff` says `no changes`.
- **Profile.** `/company/profile`, `Bearbeiten`, type into `input[name=business]`, save: `diff` of the manifest shows one added line `business: …`; clearing it and saving again leaves the file byte-identical.
- **Accounts.** `/company/accounts`: the two inputs (number, name; fill them through React's value setter, see features/partners.md, or `$B type`), `Konto hinzufügen`: toast `Konto 1100 Debitoren hinzugefügt`, accounts.json gains the account in number order; a known number switches the button to `Umbenennen`.
- **Refusal.** `/company/banks`, `Bezeichnung und IBAN bearbeiten`, an IBAN with a wrong check digit, save: the toast names it, the manifest is unchanged.

## Gotchas

- The sandbox clones the whole workspace but `data/`, `invoices.json` included: without it the receivables proposal is empty.
- The toast's Rückgängig only works while the toast shows (6 s); a stale toast's button does nothing.
- A bank account added with a ledger account missing from accounts.json makes `npm run doctor` fail, and the Abschluss checks show it.
- Closing the year needs Q4 filed, Q1–Q3 sealed and December statements; the demo cannot get there, so `Jahr abschliessen` stays disabled there. The close itself is covered by tests/year-close.test.ts.
