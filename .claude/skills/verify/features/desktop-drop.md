# Desktop: drop files (Dateien hinzufügen)

Files dropped on the window or picked through the drop zone open `Dateien hinzufügen`. Each file
is recognized and taken at once: a receipt goes into the inbox for the receipt-intake run, a
camt.053 is read into the books, what is no receipt goes to quarantine, refused files say why.
Tabs: Alle, Bankdaten, Kontoauszüge, Belege, Nicht übernommen. Server: `src/server/routes/drop.ts`.

## Sub-features

- `dd-take`: a PDF or photo → `taken`, with its run.
- `dd-statement`: the camt.053 → payments in Kontoauszüge, balance checked.
- `dd-refuse`: CSV, .docx → `nicht gespeichert` with a reason.
- `dd-duplicate`: the same bytes twice → duplicate.
- `dd-undo`: `Rückgängig` per file.
- `dd-accumulate`: later picks add rows to the open dialog.

## How to get to it (user POV)

Drag files onto the window, or click the drop zone (`PDFs hierher ziehen oder klicken`) in Belege.

## Driving it with vm.sh + app.mjs

```bash
node $A 20-csv "await pick('PDFs hierher ziehen', ['Kontoauszug_Juli-Sept.csv'])" "await wait(4000)"
node $A 21-statement "await clickText('Schliessen','button')" "await pick('PDFs hierher ziehen', [process.env.PERSONA_CAMT])" "await wait(8000)"
node $A 22-receipts "await pick('PDFs hierher ziehen', ['swisscom_juli.pdf','IMG_4471.jpg','Farbmix_Rechnung_FM-77812.pdf','Farbmix_Rechnung_FM-77812 (1).pdf'])" "await wait(10000)"
$V sh 'ls ~/Documents/"Buchhaltung Malerei Huber GmbH"/vanilla-accounting/beleg-import; tail -20 /tmp/va.log'
```

Proof: each row's state in the printed text, the inbox listing, and the session file
`vanilla-accounting/data/drop/<id>/session.json`.

## Gotchas

- Synthetic VNC drags do not reach the app; `drop([...])` is the route (the drop zone's picker disappears once the period has a receipt).
- Photos and scans need `claude` to be read; the VM has none (see SKILL.md).
- On 2026-10-15 every upload that was to be taken hung (`POST /api/drop/<id>/files` never answered)
  until the app was restarted; after the restart the same PDF went through. When the dialog sits
  at `liest 1 …`, read `/tmp/va.log` and the session file before restarting, and record it.
