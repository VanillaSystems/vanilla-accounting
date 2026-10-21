# Dateien hinzufügen (drop on the window)

Files dropped anywhere on the window (left of the AI sidebar) open `Dateien hinzufügen`. Code recognizes each file without a model: a camt.053 or a bank statement PDF is read into the books, a PDF or photo goes into the inbox and starts the receipt intake, what is no receipt goes to quarantine, other formats are refused with a reason. Each row can be undone. The Mac app's version of the same dialog is features/desktop-drop.md.

## Sub-features

- `dr-open`: a window drop on any area but Kontoauszüge (which imports statements directly) opens `.palette.dropdlg[role=dialog][aria-label="Dateien hinzufügen"]`; overlay `[data-testid=drop-page]` `Als Beleg ablegen` while dragging.
- `dr-tabs`: `.wftabs button[role=tab]`: Alle, Kontoauszüge, Belege, Unklar (only when such rows exist), Nicht übernommen.
- `dr-statement`: a camt.053 of a known IBAN → `.droprow.s-taken .dchip.p-statement`, payments in the books (`bank-import` run).
- `dr-receipt`: a PDF → taken into the inbox (`beleg-import/`), intake run starts; `Beleg öffnen →`. A PDF whose text repeats a receipt in the books is a possible twin: `schon da?`, `möglicher Doppelbeleg`, `ist dasselbe` / `verschieden` (`verschieden` takes it and marks the books receipt `distinctFrom`).
- `dr-refuse`: CSV (`Kontoauszug als CSV: die App braucht ihn als camt.053 (XML). …`), Word/Excel (`… bitte als PDF sichern …`), other XML (`XML, aber kein Kontoauszug`) → tab Nicht übernommen.
- `dr-duplicate`: bytes already in the books or the inbox → chip `nicht übernommen: schon da`, reason `schon in den Büchern oder im Eingang`, `trotzdem übernehmen`.
- `dr-account`: a statement of an IBAN no bank account has → `Der Kontoauszug ist vom Konto <iban> (<currency>), das in den Büchern noch fehlt. Gehört dieses Konto der Firma?` with `Ja, Bankkonto hinzufügen` (bank draft, Firma › Bankkonten) and `Nein, privat`.
- `dr-undo`: `Rückgängig` per taken row; `button.dx[aria-label="<name> entfernen"]`; closing (`Schliessen` / `Im Hintergrund weiter`) sends `DELETE /api/drop/<id>`.

## How to get to it (user POV)

Drag files from Finder onto the window. Belege's `Beleg` add button (or `N`), its strip `Hierher ziehen` and, on empty books, `Dateien wählen` feed the same dialog.

## Driving it with browse + sandbox.sh

Preconditions: a demo sandbox. The demo's bank accounts are Raiffeisen (1021) and Wise EUR (1023); their IBANs are in `$SB/belege.workspace.yaml` (`bankAccounts[].iban`). Headless `browse` cannot drag from Finder; dispatch a drop with real bytes fetched from the sandbox:

```bash
$B goto "$UI/company/profile"
$B js "(async()=>{const r=await fetch('/receipts/<file>.pdf');const f=new File([await r.blob()],'probe.pdf',{type:'application/pdf'});const dt=new DataTransfer();dt.items.add(f);window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,clientX:200,clientY:200,bubbles:true,cancelable:true}));return 'dropped'})()"
```

- **Duplicate (driven 2026-10-21).** Drop a receipt PDF the sandbox already has (`/receipts/<file>` with a name from `ls "$SB"/transactional-data/2026/receipts`; the URL takes the bare file name, no year): the dialog opens, `Nicht übernommen 1`, the row reads `nicht übernommen: schon da` / `schon in den Büchern oder im Eingang`; `$S diff` says `no changes`.
- **Refuse.** Drop `new File(['Datum;Betrag\n'],'konto.csv',{type:'text/csv'})`: `nicht gespeichert`, `Kontoauszug als CSV: die App braucht ihn als camt.053 (XML). Im E-Banking beim Export «camt.053» oder «ISO 20022» wählen.`
- **New receipt (write, from source; not driven yet).** A demo receipt with changed bytes is caught as a possible twin (same text); `verschieden` takes it into `$SB/beleg-import/` and `$S diff` shows the books receipt's `distinctFrom`. The intake's reading step then fails on the claude shim (row ends in `wartet auf dich` or refused), which is the sandbox, not a bug.
- **Statement (write, from source; not driven yet).** Drop a camt.053 of the Raiffeisen IBAN with entries the books lack (fetch `/bank-statements/Raiffeisen/<camt>.xml`; the demo's own files are already read, so change dates and references): `.dchip.p-statement`, `$S diff` lists the new `transactions`, `/automation/runs` shows the `bank-import` run.
- **Unknown account.** Fetch the July camt.053 (`/bank-statements/Raiffeisen/<file>.xml`, `ls "$SB"/transactional-data/2026/bank-statements/Raiffeisen/*.xml`), `replaceAll(<the Raiffeisen IBAN>, <any valid IBAN the books lack>)` (persona-files.mjs computes valid ones), drop it as `fremd.xml`: the row reads `camt.053 · … · 20 Bewegungen`, `nicht gespeichert`, `Der Kontoauszug ist vom Konto <iban> (CHF) von «Muster Kaffee GmbH» bei Raiffeisenbank Musterdorf, das in den Büchern noch fehlt. Gehört dieses Konto der Firma?`. `Nein, privat` → `beiseitegelegt: ein privates Konto gehört nicht in die Bücher der Firma`; `$S diff` says `no changes`.
- Proof: the dialog screenshot, the row texts, `$SB/data/drop/<id>/session.json` while the dialog is open, `$S diff`.

## Gotchas

- `clientX` must lie left of the sidebar, else the files attach to the chat (features/ai-sidebar.md).
- Dropping while Kontoauszüge is open imports straight into the books (features/bank.md), not through the dialog.
- `Schliessen` ends the drop session and removes `data/drop/<id>/`: copy `session.json` before closing.
- Read-only (`READONLY=1`) ignores drops.
- Pending: PR #49 (open on 2026-10-21) replaces the yes/no account question with a question which account the statement belongs to, and reads statement PDFs by their title in four languages. Update `dr-account` when it lands on 0.4.0.
