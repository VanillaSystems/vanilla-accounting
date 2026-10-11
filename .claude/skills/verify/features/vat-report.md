# MWST report

The MWST area (`/vat`, rebuilt in redesign phase 5) shows one VAT return per page: the Ziffern of a quarter (or a half year or year as an overview), computed from the journal entries on a cash basis by `src/accounting` (`computeVatReport`, `entriesForReturn`, `vatLine`). The list holds the Ziffern by part of the form with the result on top; the detail shows the selected Ziffer's sum or the entries behind it. A filed quarter keeps its lock, marks every Ziffer that differs from the filed return, and ends with its Korrekturabrechnung (0535). The `vat-report` CLI must show the same figures. That CLI-to-UI agreement is the main proof for any VAT-logic change.

## Sub-features

- `vat-ziffern` is the list (`.rows.vz .row[data-z]`): groups `I · Umsatz`, `II · Steuerberechnung` (rate rows show turnover `.tv` and tax), `III · Vorsteuer`, `Ergebnis`; Ziffer 200, the sums and every Ziffer with a figure, `Alle Ziffern zeigen` for the rest (kept per viewer). The box on top (`.vresult`) is `Zu bezahlen` or `Guthaben` and selects 500 or 510. The line under the heading (`.counts.vst`) says `offen · fällig <date>` (60 days after the quarter; `fällig seit` in amber when past), `eingereicht` with `N Korrekturen seither`, or `Zusammenzug, nur zur Übersicht` for a half year or year. `Codes erklärt` opens `/vat/codes`.
- `vat-detail` is the Ziffer on the right: name, `Ziffer N · <period>`, the amount (the tax for a rate row), facts, a one-line explanation. A sum (289, 299, 399, 479, 500, 510) shows its formula (`.formula`, each part selects its Ziffer). A source Ziffer lists its entries (`.vlines`) grouped by VAT code, newest first; the code links to `/vat/codes/<code>`, each entry to `/journal/<id>`; an entry that corrects another quarter carries `Korrektur Q…`; `config.vatAdjustments` show as `Nachdeklaration` rows. Which entries a Ziffer lists comes from `sourceZiffern(parseVatCode(code))`, so `B81-1` lands in 383 and 405.
- `vat-filed` marks a Ziffer of a filed quarter whose figure differs from `filings/<year>/mwst-ech0217-<q>.xml` (`.was` dot) and explains it in the detail (`.notice.warn`): the difference from N correction entries with a link to the 0535, or a rounding difference (the filing computes the tax on each rate's total). A rate row compares its turnover (gross for supplies, net for Bezugsteuer), as the XML holds it.
- `vat-0535` is the pseudo-Ziffer `0535` (`/vat/0535?period=<filed quarter>`, last row of the list, side: the change in tax). The detail compares «bisher eingereicht» with «korrigiert» (`figuresFromBooks`: today's books plus entries tagged `corrects: "<quarter>"`) line by line (`.ftable .fl[data-ziffer]`, changed lines `.chg`); a line selects its Ziffer. `Drucken` prints the form and every case.
- `vat-0535-cases` follows the form: `[data-reconciliation]` is `ok` when the cases of `config.correctionCases` explain the whole difference, `unexplained` otherwise (naming Ziffer, amount, and any `corrects` entry in no case); one `details.case[data-case=<id>]` per case with what was wrong, the fix, the source receipt (linked), the entries before and the correction entries (linked), and its effect per Ziffer.
- `vat-keys`: ↑/↓ or J/K walk the list (0535 included), ↵ opens the selected Ziffer's first entry, ⌘K offers the shown Ziffern of the period.
- `vat-cli` runs `src/cli/vat-report.ts <period> [--detail]`, which must match the UI.
- `vat-xml` runs `src/cli/vat-ech0217.ts`, which writes the eCH-0217 XML. Run it on the sandbox only (`VANILLA_WORKSPACE="$SB"`), so that no file is written into the real workspace.

## How to get to it (user POV)

- Dock `MWST` or `G M`; `/vat` is the open quarter, `/vat/<ziffer>?period=2026-Q1` one Ziffer of a quarter. A period that is no ESTV period (a month, a range) shows the open quarter.
- Terminal: `npm run vat-report -- 2026-Q1`. In verification, run the sandbox form shown below.

## Driving it with browse + sandbox.sh

Preconditions:

- The doctor passes.

- **UI figures.** `$B newtab "$UI/vat?period=$OPEN_Q"`, `$B wait --networkidle`, then `$B js "[...document.querySelectorAll('.rows.vz .row')].map(r=>r.dataset.z+'='+r.querySelector('.a').textContent).join('  ')" > $EVIDENCE/vat-report/ui.txt`. The URL becomes `/vat/500` (or 510): the result is selected. A rate row's `.a` reads turnover then tax run together.
- **CLI figures.** `VANILLA_WORKSPACE="$SB" node --import tsx src/cli/vat-report.ts "$OPEN_Q" | tee $EVIDENCE/vat-report/cli.txt`. Exit `0`; Ziffern 200 to 510 equal the UI's. The CLI's 303/313 are the net base: UI turnover = base + tax.
- **Detail.** Click `[data-z="405"]`. The `.vlines` groups' tax sums equal the Ziffer; a group header's `a.vlink` goes to `/vat/codes/<code>`, an entry row (`a.vl`) to `/journal/<id>`. ↵ on the list opens the first entry.
- **Filed quarter.** `$B goto "$UI/vat?period=$CLOSED_Q"`: the heading's period carries the lock, `.counts.vst` says `eingereicht`. On the demo, 405, 479 and 500 carry `.was` (one correction entry); select 405 and read `.detail .notice` (`Eingereicht: <filed>, heute <today>. Die Differenz … 1 Korrekturbuchung …`).
- **Korrekturabrechnung.** Click `[data-z="0535"]`: the URL is `/vat/0535?period=$CLOSED_Q`, `.ftable .fl.chg` are the changed lines (demo: 405, 479, 500), `[data-reconciliation]` is `ok`. Click `details.case summary` to open a case. To see `unexplained`, empty one case's `correctionEntryIds` in the sandbox books. To move a correction, tag an `$OPEN_Q` entry `"corrects": "<$CLOSED_Q>"` in the sandbox books only, reload, and check that its tax leaves the open quarter and enters the 0535 «korrigiert» column.
- **Proof.** Save `ui.txt`, `cli.txt`, and screenshots. Report any Ziffer that differs between them.

## Gotchas

- The CLI period must be `YYYY-Qn`, `YYYY-Hn`, or `YYYY`. Bare `Q2` exits with `Unknown period`. `vat-xml` takes only an open `YYYY-Qn`: for a filed quarter it exits 1 ("is filed").
- `vat-report <quarter>` of a filed quarter equals the 0535 «korrigiert» column, except that the form's 500/510 can differ by a Rappen (eCH rounding); the list then marks 500 with a rounding note.
- The quarters up to `closedThrough` are filed (`filings/<year>/`). Any change in their figures is a regression unless it is intended and backed by a Korrekturbuchung in the open period.
- The UI uses `'` as the thousands separator and the CLI uses `’`. Normalize before comparing.
- No correction is booked from this page: a correction is a journal entry with `corrects:` in the open quarter (Buchungen, or the CLI); this page shows where it is declared.
- The filing date is not in the XML the app writes, so a filed quarter says `eingereicht` without a date.
