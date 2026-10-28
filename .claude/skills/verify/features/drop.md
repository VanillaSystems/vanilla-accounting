# Dateien hinzufügen (drop on the window)

Files dropped anywhere on the window (left of the AI sidebar) open `Dateien hinzufügen`. Code recognizes each file without a model: a camt.053 or a bank statement PDF is read into the books, a PDF or photo goes into the inbox and starts the receipt intake, what is no receipt goes to quarantine, other formats are refused with a reason. Each row can be undone. The Mac app's version of the same dialog is features/desktop-drop.md.

## Sub-features

- `dr-open`: a window drop on any area but Kontoauszüge (which imports statements directly) opens `.palette.dropdlg[role=dialog][aria-label="Dateien hinzufügen"]`; overlay `[data-testid=drop-page]` `Als Beleg ablegen` while dragging.
- `dr-tabs`: `.wftabs button[role=tab]`: Alle, Kontoauszüge, Belege, Unklar (only when such rows exist), Nicht übernommen.
- `dr-statement`: a camt.053 of a known IBAN → `.droprow.s-taken .dchip.p-statement`, payments in the books (`bank-import` run).
- `dr-receipt`: a PDF → taken into the inbox (`beleg-import/`), intake run starts; `Beleg öffnen →`. A PDF whose text repeats a receipt in the books is a possible twin: `schon da?`, `möglicher Doppelbeleg`, `ist dasselbe` / `verschieden` (`verschieden` takes it and marks the books receipt `distinctFrom`).
- `dr-refuse`: a CSV that reads as no table (`Diese CSV liest sich nicht als Tabelle …`), Word/Excel (`… bitte als PDF sichern …`), other XML (`XML, aber kein Kontoauszug`) → tab Nicht übernommen.
- `dr-read` (#217): a statement PDF (scan, photo) whose days no camt.053 in the books covers → `wartet auf Ihre Antwort`, below the row `[data-testid=drop-read]`: chip `[data-testid=drop-read-by]` (`aus PDF gelesen`, `von Hand erfasst` without AI, `aus CSV gelesen`), IBAN, currency, opening and closing balance, one `[data-testid=drop-read-line]` per movement (inputs; a line the books hold is shaded `schon in den Büchern`), `+ Zeile`, the page carry-overs, `[data-testid=drop-read-check]` (`data-ok`; green `Geht auf: …` or each gap `Seite N: … (Differenz CHF x)`), `[data-testid=drop-read-import]` `Einlesen` (disabled until it adds up). Imported: `Raiffeisen/<name>.xml` and the PDF beside it in `bank-statements/`, row `aus PDF gelesen · N Bewegungen`, Kontoauszüge › Datei shows `Gelesen aus PDF gelesen · <name>.pdf`. A bank CSV first shows `[data-testid=drop-csv]` (column selects, account, first rows, `Lesen`); the mapping lands in `knowledge/bank-csv.yaml`. A taken receipt or photo has `[data-testid=drop-as-statement]` `Ist ein Kontoauszug`.
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
- **Unknown account.** Fetch the July camt.053 (`/bank-statements/Raiffeisen/<file>.xml`, `ls "$SB"/transactional-data/2026/bank-statements/Raiffeisen/*.xml`), `replaceAll(<the Raiffeisen IBAN>, <any valid IBAN the books lack>)` (persona-files.mjs computes valid ones), drop it as `fremd.xml`: the row reads `camt.053 · … · 20 Bewegungen`, `wartet auf Ihre Antwort` (tab Kontoauszüge), `Der Kontoauszug ist vom Konto <iban> (CHF) von «Muster Kaffee GmbH» bei Raiffeisenbank Musterdorf, das in den Büchern noch fehlt. Gehört dieses Konto der Firma?`. `Nein, privat` → `beiseitegelegt: ein privates Konto gehört nicht in die Bücher der Firma`; `$S diff` says `no changes`.
- **A PDF statement read by the model (driven 2026-10-28, #217).** Generate an invented statement with `tests/support/statement-pdf.ts` (`inventedStatement(DEMO_OCTOBER)`: the demo's Raiffeisen IBAN, October, two pages with carry-overs) into `.verify/pdf217/`, and the answer a model would give (with one digit misread) as JSON. Point the sandbox's `claude` at the stub with that answer: `printf '#!/bin/sh\nCLAUDE_STUB_ANSWER="$(cat <repo>/.verify/pdf217/answer.json)" exec <repo>/tests/support/stub-bin/claude "$@"\n' > "$SB/bin/claude"`. Drop the PDF fetched from `/@fs/<repo>/.verify/pdf217/<file>`: the table, `aus PDF gelesen`, the check names the gap on `Seite 1` and the total, `Einlesen` disabled; `$B fill` the first line's amount as the PDF prints it → `Geht auf: …`; `Einlesen` → `eingelesen`, `$S diff` lists the 7 `read-<id>#n` transactions, the statement `<name>.xml` and its two balances. (A statement import also refreshes the demo's stale bank fields: `counterparty` on open payments, camt balances; any import does.)
- **Which account, with details and proposal (driven 2026-10-27, #208).** Needs two CHF accounts without IBAN: copy `demo/vanilla-accounting` to a temp dir, drop the Raiffeisen `iban:` and the `invoicing.payTo.CHF` line (it needs an IBAN), add `{ bank: PostFinance, currency: CHF, account: "1022", label: PostFinance Geschäftskonto, statements: camt053, role: bank }`, `VERIFY_WORKSPACE=<that dir> $S up`. Write invented camt.053 files (servicer `PostFinance AG`, another bank) into `.verify/camt208/` and fetch them in the drop snippet from `/@fs/<repo>/.verify/camt208/<file>` (Vite serves the repo). The row: `wartet auf Ihre Antwort`, `[data-testid=drop-proposed]` first (`VORSCHLAG PostFinance Geschäftskonto`), `Vorschlag: Die Bank des Auszugs passt zu …`; `[data-testid=drop-details]` folds out `[data-testid=statement-file-details]` (bank, BIC, IBAN, owner, period, movements, balances, file, first 5 movements and `… und N weitere`). Clicking the proposal reads it in (`eingelesen`), and the IBAN lands on the account. A row whose bank matches no account (or several) has no proposal.
- Proof: the dialog screenshot, the row texts, `$SB/data/drop/<id>/session.json` while the dialog is open, `$S diff`.

## Gotchas

- `clientX` must lie left of the sidebar, else the files attach to the chat (features/ai-sidebar.md).
- Dropping while Kontoauszüge is open imports straight into the books (features/bank.md), not through the dialog.
- `Schliessen` ends the drop session and removes `data/drop/<id>/`: copy `session.json` before closing.
- Read-only (`READONLY=1`) ignores drops.
