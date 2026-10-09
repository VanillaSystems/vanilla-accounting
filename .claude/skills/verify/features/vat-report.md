# MWST report

The MWST tab renders the ESTV Ziffern (200 to 510, plus 900 and 910) for the selected period, computed from journal entries on a cash basis. A user can click a Ziffer to see the entries behind it. The `vat-report` CLI must show the same figures. That CLI-to-UI agreement is the main proof for any VAT-logic change.

## Sub-features

- `vat-ziffern` shows sections I. Umsatz, II. Steuerberechnung, Vorsteuer, Abrechnung, and III. Andere Mittelflüsse for the period.
- `vat-detail` shows the contributing entries for a clicked Ziffer in the right-hand column: fixed columns `Datum|Beschreibung|MWST|Soll|Haben|Betrag|CHF|Steuer CHF`, `-` codes negative in red, a `tfoot` Total. The Ziffer↔code match comes from `parseVatCode` (so `B81-1` lands in 383 and 405); the 383 row shows the net base next to the tax. A blue «Nachdeklaration» banner lists `config.vatAdjustments`; an amber «Eingereicht» banner marks closed periods.
- `vat-cli` runs `src/cli/vat-report.ts <period> [--detail]`, which must match the UI.
- `vat-0535` is the switch "Abrechnung | Korrekturabrechnung (0535)", shown for a quarter that has a filed return (`GET /api/vat/filed?year=YYYY` parses `filings/<year>/`). The form compares «bisher eingereicht» with «korrigiert» (today's books plus entries tagged `corrects: "<quarter>"`), highlights changed Ziffern, and lists the correction entries for a clicked Ziffer. The sandbox copies `filings/`.
- `vat-0535-cases` is the right panel of the 0535 view: one card per `config.correctionCases` entry of the quarter (`[data-case="<id>"]`, click the card's button to expand), filtered to the cases that change a clicked Ziffer. `[data-reconciliation]` is `ok` when the cases explain the whole 0535 difference, `unexplained` otherwise, naming the Ziffer and amount and any `corrects` entry in no case. On the demo every filed quarter's cases reconcile (`ok`); a workspace may keep its own expected counts in its docs. To see the warning, empty one case's `correctionEntryIds` in the sandbox index. Each card exists twice in the DOM (a print-only copy inside `.vat-print`), so select the visible one with `offsetParent`. `$B pdf` prints the form, then every case expanded.
- `vat-xml` runs `src/cli/vat-ech0217.ts`, which writes the eCH-0217 XML. Run it on the sandbox only (`VANILLA_WORKSPACE="$SB"`), so that no file is written into the real workspace.

## How to get to it (user POV)

- Choose the `MWST` tab, or open `/<period>/vat-report` (`2026-Q1`, `2026-Q2`, `2026-H1`, …).
- Terminal: `npm run vat-report -- 2026-Q1`. In verification, run the sandbox form shown below.

## Driving it with browse + sandbox.sh

Preconditions:

- The doctor passes.

- **UI figures.** Run `$B newtab "$UI/$CLOSED_Q/vat-report"`, `$B wait --networkidle`, then `$B text > $EVIDENCE/vat-report/ui.txt`. The text contains `MWST-Abrechnung $CLOSED_FROM bis $CT` (demo: `2026-01-01 bis 2026-03-31`), and Ziffern 200, 299, 399, 479 and 500 carry figures (the demo's quarters all owe tax; on a workspace with a credit it is 510 instead).
- **CLI figures.** Run `VANILLA_WORKSPACE="$SB" node --import tsx src/cli/vat-report.ts "$CLOSED_Q" | tee $EVIDENCE/vat-report/cli.txt`. The exit code is `0`, and Ziffern 200 to 510 equal the UI values.
- **Detail.** Click a Ziffer row such as `400`. The detail table appears in the right-hand column; its Total `Steuer CHF` equals the Ziffer. Take a screenshot.
- **Korrekturabrechnung.** On `$UI/$CLOSED_Q/vat-report`, click `Korrekturabrechnung (0535)`. Rows are `.vat-print tr[data-ziffer]`; a changed row has an amber class. A rate Ziffer (303, 313, 343, 383, and 302/312/342/382 when non-zero) has two rows with the same `data-ziffer`, Leistungen then Steuer, so use `querySelectorAll`. `Drucken` appears only in this view. To show a correction, tag an entry in the sandbox index only (`"corrects": "<$CLOSED_Q>"` on an `$OPEN_Q` entry), reload, and check that its tax moves from the open quarter's return to the closed quarter's «korrigiert» column. `$B pdf` prints the form alone.
- **Proof.** Save `ui.txt`, `cli.txt`, and a screenshot. Report any Ziffer that differs between them.

## Gotchas

- The CLI period must be `YYYY-Qn`, `YYYY-Hn`, or `YYYY`. Bare `Q2` exits with `Unknown period`. `vat-xml` takes only an open `YYYY-Qn`: for a filed quarter it exits 1 ("is filed"); an open quarter with Bezugsteuer writes XML with an `acquisitionTax` element.
- `vat-report <quarter>` of a filed quarter equals the 0535 «korrigiert» column, except that the form's 510 can differ by a Rappen (eCH rounding).
- The quarters up to `closedThrough` are filed (`filings/<year>/`). Any change in their figures is a regression unless it is intended and backed by a Korrekturbuchung in the open period.
- The UI uses `'` as the thousands separator and the CLI uses `’`. Normalize before comparing.
- The `vat-xml` tool's payableTax can differ from the UI by a Rappen (the eCH rounding). The XML is authoritative.
