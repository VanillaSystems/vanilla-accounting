# Export

The export dialog (redesign phase 6) builds any export of the books in one place: presets on the left, the period on top, the parts and their formats on the right. The server builds the files (`POST /api/export`, `src/export/`): one ZIP with a root folder `<company>_<from>_<to>/`, a LIESMICH in the UI language, and on request `SHA256SUMS.txt` and `manifest.json`. One file without checksums and without missing originals comes as it is, named `<root>_<basename>`. The root replaces spaces in the company name with `-` (`Muster-Kaffee-GmbH_2026-07-01_2026-09-30/`; `<company>_all` for all periods). It only reads the books, so it works in audit mode (`READONLY=1`).

## Sub-features

- `export-open`: the top bar's export chip, ⇧E, ⌘K `Exportieren …`, and ⌘K `Export: <preset>` for every built-in and own preset. ⇧E presets the page: Belege → receipt list + originals, Kontoauszüge → payments + statements, Buchungen → journal CSV, MWST → returns PDF+CSV (its quarter, else the open one), Bilanz & ER → the shown report PDF+CSV.
- `export-presets`: Treuhänder-Paket (open quarter, checksums and filed returns on), Prüfung ESTV / AHV and Jahresarchiv (the open quarter's year, checksums on, with `MWST-eingereicht/<year>/` returns and seals of the filed quarters), Excel-Rohdaten (page period, one workbook). `Als Vorlage sichern` keeps an own preset in localStorage `export.presets`; `×` deletes it with an undo toast.
- `export-period`: the period row (`.xper [role=radio]`: Q1–Q4 and the year of the open quarter, `Jahr bis heute`, the page's period, the chosen period) and `Zeitraum …` (`.xcal`), the period picker (`.pp`) inside the dialog.
- `export-parts`: each part (`.xrow`) with its count, ticked by its checkbox, formats toggled by `.xf button[aria-pressed]`; a part with nothing in the period is disabled (`.xrow.empty`). `.xsum` says files, size and ZIP or single file.
- `export-run`: `Exportieren` (⌘↵) posts the request and saves the answer under the server's file name (`Content-Disposition`), toast `<name> wird gespeichert …`.
- `export-ledger`: the ledger's `Herunterladen` (`[data-dlpop]`, key D) opens `.menu.dlpop`: CSV, Excel, PDF of that account and period in one click, `Weitere Optionen …` opens the dialog with the Kontoblatt ticked.
- `export-close`: Abschluss › Übergabe's cards open the dialog with the year's journal as Banana TSV, or the Prüfung preset.
- `export-static`: the static audit export shows the dialog with a note and a disabled `Exportieren`; the ledger has no download menu.

## How to get to it (user POV)

- Any page: ⇧E, or the download chip in the top bar (move to the top edge), or ⌘K `export`.
- Bilanz & ER, an account selected: `Herunterladen` above the ledger, or D.

## Driving it with browse + sandbox.sh

- **Open.** `$B goto "$UI/reports/income/3000?period=2026-Q3"`, `$B press Shift+E`, read `$B js "document.querySelector('.xsum').innerText"`.
- **Preset and run.** `$B click ".xpre > button:nth-of-type(1)"` (Treuhänder-Paket), pick Q3 in `.xper`. Headless browse saves no downloads: hook the anchor first, `HTMLAnchorElement.prototype.click` wrapped to `fetch(this.href)` into `window.__dl` (name, base64), then `$B click ".xft .btn.primary"`, wait, read `window.__dl`, decode, unzip, `shasum -a 256 -c SHA256SUMS.txt` in the root folder: every line `OK`.
- **API.** `curl -s -X POST $API/api/export -H 'Content-Type: application/json' -d '{"period":"2026-Q3","items":{"journal":["csv"]},"language":"de"}'` gives one CSV (`Muster-Kaffee-GmbH_2026-07-01_2026-09-30_Buchungen.csv`, `text/csv`); with `"sums":true` a ZIP. Driven 2026-10-21: `{"period":"2026","items":{"journal":["csv"],"filings":["orig"]},"sums":true}` gives `Muster-Kaffee-GmbH_2026-01-01_2026-12-31.zip`, `shasum -a 256 -c SHA256SUMS.txt` all `OK` (LIESMICH, `Daten/Buchungen.csv`, `MWST-eingereicht/2026/mwst-ech0217-2026-Q1.xml`, `seal-Q1.json`, `manifest.json`).
- **Audit mode.** `READONLY=1 $S up <run>`: the dialog exports the same; `$S diff` shows nothing.
- **Ledger.** On `/reports/income/6570?period=2026-Q3` press D, click the first `.dlpop button[role=menuitem]` (`$B js` click; the menu's head reads `Kontoblatt 6570 Informatik, Hosting, Software · Q3 2026`): toast `Muster-Kaffee-GmbH_2026-07-01_2026-09-30_Kontoblatt-6570.csv wird gespeichert …`; the file's first row is the opening balance, its last balance the ledger's Ende.

## Gotchas

- Report PDFs are printed by the installed Chromium (src/invoices/pdf.ts `printPdf`); without one the API answers 503 `noBrowser`.
- Known product bug (2026-10-31): with an installed Google Chrome the PDF browser ends 12-18 s after its first use and the API never relaunches it; every later export with a PDF part answers 500 «Connection closed.». Start the sandbox with `CHROME_PATH` on Chrome for Testing (features/invoices.md, Gotchas). The ZIP's `SHA256SUMS.txt` then checks out (`shasum -a 256 -c`, 35 of 35 for the Treuhänder preset on Q2).
- The demo has no filed quarter in Q3: `Eingereichte MWST-Abrechnungen` is empty there; choose 2026 for Q1's return and seal.
- Own presets live in the browser profile of the tab: a new sandbox port starts without them, and with the browser's language until one is picked.
