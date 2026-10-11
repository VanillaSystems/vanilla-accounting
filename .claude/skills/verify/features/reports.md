# Bilanz & ER

The Bilanz & ER area (`/reports/income|balance|trial`, rebuilt in redesign phase 5) shows the Erfolgsrechnung, the Bilanz and the Saldobilanz of any period as lists of accounts, with the selected account's ledger as the detail. Every figure comes from `src/accounting` (`computeIncomeStatement`, `computeBalanceSheet`, `computeTrialBalance`, `computeAccountLedger`, `openingBalancesAt`), the same code as the CLI and the golden master.

## Sub-features

- `reports-list`: tabs `Erfolgsrechnung | Bilanz | Saldobilanz` (`.counts [role=tab]`, each its own path), the headline box (`.vresult.static`: Ergebnis, Bilanzsumme, or `Soll = Haben`; `Differenz` in red when the Saldobilanz does not balance), groups (`button.group`, collapsible, kept per viewer) with their totals, sums (`.rsum`), and account rows `.row[data-acct]`. The Bilanz says `per <date>` and holds the `Jahresergebnis (noch nicht abgeschlossen)` row; the Saldobilanz has columns Anfang, Soll, Haben, Saldo, grouped by account class 1–9 and `Ohne Gegenkonto`.
- `reports-gap`: when Aktiven and Passiven differ, a notice (`.rgap`) names the difference and the count of entries booked on one side only (a code like `M81-2`); `Zeigen` opens `/reports/trial/none` for the year to date.
- `reports-all`: `.rall` toggles `Nur mit Betrag` / `Alle Konten` (every account of the chart; kept per viewer).
- `reports-search`: `/` focuses `Konto suchen`; number or name, every word must match (`?q=`). The search shows every matching account, with or without an amount, and switches between Bilanz and Erfolgsrechnung by itself when only the other holds a match (`.rnote` says `→ Bilanz`). Esc clears.
- `reports-ledger`: the detail of `/reports/<report>/<account>`: name, `Konto N · <report>`, the closing balance, facts Anfang, Soll, Haben, Ende (title: the day), the entries newest first under the opening row, each a link to `/journal/<id>` with its counter account (`.oc`, title: its name). `none` is the account of one-sided entries, with an explanation.
- `reports-keys`: ↑/↓ or J/K walk the accounts, ↵ opens the ledger's first entry, ⌘K finds every account of the chart and opens it in the report that holds it (1–2 Bilanz, 3–8 Erfolgsrechnung, 9 Saldobilanz).

## How to get to it (user POV)

- Dock `Bilanz & ER` or `G R`; ⌘K `Erfolgsrechnung`, `Bilanz`, `Saldobilanz`, or an account number or name.
- Any period from the picker: a quarter, a month, the year, a range. The Bilanz shows the balance at the period's last day.

## Driving it with browse + sandbox.sh

- **Reports.** `$B newtab "$UI/reports/balance"`; the URL becomes `/reports/balance/<first account>`. Read the headline with `$B js "document.querySelector('.vresult').textContent"`. On the demo's `$OPEN_Q` the Bilanz shows a gap of one one-sided entry.
- **Search.** On `/reports/income` press `/`, type `raiff`: the URL becomes `/reports/balance/1021?q=raiff`, `.rnote` reads `→ Bilanz`, one row `[data-acct="1021"]`.
- **All accounts.** On `/reports/balance` count `.rows.rep .row[data-acct]`, click `.rall`, count again (more rows, `.zero` ones faint).
- **Gap.** Click `.rgap button`: `/reports/trial/none?period=<year>-01-01_<to>`, detail heading `Ohne Gegenkonto`.
- **Ledger.** On `/reports/balance/1021` read `.detail .facts`; Ende equals the row's Saldo. Press ↓ (next account) and ↵ (opens `/journal/<id>`).

## Gotchas

- The Erfolgsrechnung lists only accounts of the chart (accounts.json), as `computeIncomeStatement` does; the Saldobilanz lists every account with a movement.
- A ledger's opening balance is the year's opening balances plus the year's entries before the period, also for income accounts (a Q3 ledger of an expense account starts at its January–June total).
- A link to a known account without an amount keeps it selected though the list hides the row; an unknown account number selects the first row.
- A ledger's `Herunterladen` (D) and the export dialog are driven in features/export.md.
