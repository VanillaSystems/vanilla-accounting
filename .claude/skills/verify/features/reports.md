# Bilanz & ER

The Bilanz & ER area (`/reports/income|balance|trial`, rebuilt in redesign phase 5) shows the Erfolgsrechnung, the Bilanz and the Saldobilanz of any period as lists of accounts, with the selected account's ledger as the detail. Every figure comes from `src/accounting` over `statementPostings`, which for CH (`modules/ch/statements.yaml` `vat: net`) adds the tax postings derived at read time: the figures are net of VAT, and a one-sided tax correction is balanced by its tax posting. The export's tables use the same code. A fourth tab, Eigene Berichte, keeps the owner's own reports.

## Sub-features

- `reports-list`: tabs `Erfolgsrechnung | Bilanz | Saldobilanz | Eigene Berichte` (`.counts [role=tab]`, each its own path), the VAT note `p.rvat[data-testid=vat-note]` (`Die Beträge sind ohne MWST: … MWST-Konto 2201.`), the headline box (`.vresult.static`: Ergebnis, Bilanzsumme, or `Soll = Haben`; `Differenz` in red when the Saldobilanz does not balance), groups (`button.group`, collapsible, kept per viewer) with their totals, sums (`.rsum`), and account rows `.row[data-acct]`. The Bilanz says `per <date>` and holds the `Jahresergebnis (noch nicht abgeschlossen)` row; the Saldobilanz has columns Anfang, Soll, Haben, Saldo, grouped by account class 1–9 and `Ohne Gegenkonto`.
- `reports-gap`: when Aktiven and Passiven differ, a notice (`.rgap`) reads `Passiven …, Differenz …:` and one `span.cause[data-cause]` per cause with `Zeigen`: `oneLeg` (`Buchungen mit nur einem Konto (CHF …): <entry ids>`, opens `/reports/trial/none` for the year to date), `openingUnbalanced` (Firma › Eröffnung), an account (`/reports/trial/<account>`); with none, `Keine Ursache gefunden …`. `.rgap[data-testid=opening-missing]` with `Eröffnung erfassen` shows on Bilanz and Saldobilanz when an opening balance is missing.
- `reports-all`: `.rall` toggles `Nur mit Betrag` / `Alle Konten` (every account of the chart; kept per viewer).
- `reports-search`: `/` focuses `Konto suchen`; number or name, every word must match (`?q=`). The search shows every matching account, with or without an amount, and switches between Bilanz and Erfolgsrechnung by itself when only the other holds a match (`.rnote` says `→ Bilanz`). Esc clears.
- `reports-ledger`: the detail of `/reports/<report>/<account>`: name, `Konto N · <report>`, the closing balance, facts Anfang, Soll, Haben, Ende (title: the day) and the entry count, the entries newest first under the opening row, each a link to `/journal/<id>` with its counter account (`.oc`, title: its name); derived tax rows `MWST <code> <id>` link to their entry. `none` (`Ohne Gegenkonto`, `Buchungen mit nur einer Seite`, list name `nur MWST-Betrag`) is the account of one-sided entries, explained in `.zexpl`.
- `reports-custom`: `/reports/custom[/<slug>]` (`[data-testid=tab-custom]`): `.row.crep[data-slug]`, `[data-testid=report-new]` `Neuer Bericht` → `[data-testid=report-form]` (`f-title`, `f-period`, `f-source`, `f-accounts`, `f-text`, `f-group`, `f-columns`, `f-add-section`, `f-comment`, `f-preview` Vorschau, `f-save` Bericht speichern, `form-error`). The detail `[data-testid=custom-detail]` has `own-period` / `page-period`, PDF and CSV (`POST /api/reports/file`), `report-edit`, `report-delete` with Rückgängig. A save writes `knowledge/reports/<slug>.report.yaml` (`GET`/`POST /api/reports/saved`).
- `reports-keys`: ↑/↓ or j/k walk the accounts (and the saved reports), ↵ opens the ledger's first entry, ⌘K finds every account of the chart and opens it in the report that holds it (1–2 Bilanz, 3–8 Erfolgsrechnung, 9 Saldobilanz).

## How to get to it (user POV)

- Dock `Bilanz & ER` or `G R`; ⌘K `Erfolgsrechnung`, `Bilanz`, `Saldobilanz`, or an account number or name.
- Any period from the picker: a quarter, a month, the year, a range. The Bilanz shows the balance at the period's last day.

## Driving it with browse + sandbox.sh

- **Reports.** `$B newtab "$UI/reports/balance"`; the URL becomes `/reports/balance/<first account>`. Read the headline with `$B js "document.querySelector('.vresult').textContent"`. On the demo's `$OPEN_Q` the Bilanz has no `.rgap` (its one one-sided entry, an `I81-2` correction, is balanced by its tax posting) and shows the VAT note.
- **Search.** On `/reports/income` press `/`, type `raiff`: the URL becomes `/reports/balance/1021?q=raiff`, `.rnote` reads `→ Bilanz`, one row `[data-acct="1021"]`.
- **All accounts.** On `/reports/balance` count `.rows.rep .row[data-acct]`, click `.rall`, count again (more rows, `.zero` ones faint).
- **Gap.** Only where the books have one: click `.rgap [data-cause=oneLeg] button`: `/reports/trial/none?period=<year>-01-01_<to>`, detail heading `Ohne Gegenkonto`. On the demo open `/reports/trial/none` directly.
- **Ledger.** On `/reports/balance/1021` read `.detail .facts`; Ende equals the row's Saldo. Press ↓ (next account) and ↵ (opens `/journal/<id>`).
- **Own report (write).** `/reports/custom` (empty: `Noch keine eigenen Berichte …`), click `[data-testid=report-new]`, fill `[data-testid=f-title]` `Spesen Test`, click `[data-testid=f-save]`: URL `/reports/custom/spesen-test`, toast `«Spesen Test» gespeichert, unter Eigene Berichte und in Änderungen`, `.row.crep[data-slug=spesen-test]`, `$SB/knowledge/reports/spesen-test.report.yaml` exists, `$S diff` unchanged (driven 2026-10-21).

## Gotchas

- The Erfolgsrechnung lists only accounts of the chart (accounts.json), as `computeIncomeStatement` does; the Saldobilanz lists every account with a movement.
- A ledger's opening balance is the year's opening balances plus the year's entries before the period, also for income accounts (a Q3 ledger of an expense account starts at its January–June total).
- A link to a known account without an amount keeps it selected though the list hides the row; an unknown account number selects the first row.
- A ledger's `Herunterladen` (D) and the export dialog are driven in features/export.md; on an own report D does nothing and ⇧E opens the dialog with nothing ticked.
- `/` right after a navigation can land before the page is ready (the browse daemon is shared and can be slow): check that `?q=` is in the URL after typing.
