# Desktop: drop files (Dateien hinzufügen)

Files dropped on the window or picked through the drop zone open `Dateien hinzufügen`. Each file
is recognized and taken at once: a receipt goes into the inbox for the receipt-intake run, a
camt.053 is read into the books, what is no receipt goes to quarantine, refused files say why.
Tabs: Alle, Kontoauszüge, Belege, Unklar (only when a row is unclear or locked), Nicht übernommen, each
with a count. The browser version of the same dialog, with its rows and texts, is features/drop.md.
Server: `src/server/routes/drop.ts`.

## Sub-features

- `dd-take`: a PDF or photo → taken, with a progress chip (`in Arbeit` or the run's step, `gelesen, noch
  keine Zahlung`, `zugeordnet`, `wartet auf dich`); the head reads `Wird verarbeitet` / `Hinzugefügt`
  with `Gesamt <pct> % · <done> von <n> Dateien fertig`.
- `dd-statement`: the camt.053 → `<n> Bewegungen`, `eingelesen`; payments in Kontoauszüge, balance
  checked. A camt.053 of an IBAN the books lack asks `Gehört dieses Konto der Firma?`.
- `dd-refuse`: CSV (`Kontoauszug als CSV: … camt.053 …`), .docx (`Word-, Excel- oder Pages-Datei: bitte
  als PDF sichern …`) → `nicht gespeichert`. Non-receipts (newsletter, terms) go to quarantine with
  `doch ein Beleg`.
- `dd-duplicate`: the same bytes twice → `nicht übernommen: schon da`; the same text or facts →
  `schon da?` with `ist dasselbe` / `verschieden`.
- `dd-undo`: `Rückgängig` per file.
- `dd-accumulate`: later picks add rows to the open dialog.

## How to get to it (user POV)

Drag files onto the window. In Belege: on empty books the first-run card `Dateien wählen`, later the
strip `Hierher ziehen` (`PDFs und Fotos auf diese Seite ziehen, oder klicken`), and always the list
head's `Beleg` button (or N). A drop on Kontoauszüge imports statements straight away.

## Driving it with vm.sh + app.mjs

```bash
node $A 20-csv "await pick('Dateien wählen', ['Kontoauszug_Juli-Sept.csv','Offerte Familie Keller.docx'])" "await wait(4000)"
node $A 21-statement "await pick('Dateien wählen', [process.env.PERSONA_CAMT])" "await wait(8000)"   # the dialog is open: rows add up
node $A 22-receipts "await clickText('Schliessen','button')" "await drop(['swisscom_juli.pdf','IMG_4471.jpg','Farbmix_Rechnung_FM-77812.pdf','Farbmix_Rechnung_FM-77812 (1).pdf'])" "await wait(10000)"
$V sh 'ls ~/Documents/"Buchhaltung Malerei Huber GmbH"/vanilla-accounting/beleg-import; tail -20 /tmp/va.log'
```

Proof: each row's state in the printed text, the inbox listing, and the session file
`vanilla-accounting/data/drop/<id>/session.json`.

## Gotchas

- Synthetic VNC drags do not reach the app; `drop([...])` is the route. `Dateien wählen` exists only on
  empty books; later use `drop` or `pick('Beleg', …)`.
- Not driven on 2026-10-21: the packed app built from origin/0.4.0 (efd583a1) did not open the books it had
  just created (features/desktop-setup.md), so nothing could be dropped. Drive it again once that is fixed.
- Photos and scans need `claude` to be read; the VM has none (see SKILL.md).
- On 2026-10-15 every upload that was to be taken hung (`POST /api/drop/<id>/files` never answered)
  until the app was restarted; after the restart the same PDF went through. When the dialog sits
  at `liest 1 …`, read `/tmp/va.log` and the session file before restarting, and record it.
