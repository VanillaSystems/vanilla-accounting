# Receipts (Belege)

The Belege tab lists every receipt PDF (archived in `receipts/` or staged in `beleg-import/`). A user can filter by link state, search by filename or text, select a receipt to preview the PDF, and edit its metadata (filename, date, amount, description, note) or delete it.

## Sub-features

- `rc-list` filters with `alle`, `zugeordnet`, and `nicht zugeordnet`, plus the period selector and a `Nur ohne Datum` checkbox. The header shows the global counts `<n> Belege` and `<n> nicht zugeordnet` (not filtered by period).
- `rc-hide` is the checkbox `Nicht-Belege ausblenden (<n>)` (wrapper `title^="Dokumente ohne"`), **on by default** and kept in localStorage. It hides receipts whose `kind` is `supporting`, `statement`, `noise` or `duplicate` (badges `Begleitdokument`, `Kontoauszug`, `kein Beleg`, `Duplikat`, title `Regel: <kindRule>`) and unlinked zero-amount receipts.
- `rc-search` searches with `Dateiname, Text suchen…` over filename, description, extracted text, and the linked transactions' ref, description and note.
- `rc-preview` shows the selected receipt in the PDF frame, served from `/api/receipts/<id>`.
- `rc-edit` opens with `Beleg bearbeiten` and edits filename (renames the file on disk), date, amount with currency, description, and note; `Speichern` sends only the changed fields in one `PATCH /api/receipts/:id`, which writes all or nothing. `KI-Vorschlag` is LLM-backed and skipped.
- `rc-delete` uses `Beleg löschen`, then a custom modal `Beleg löschen?` with a red `Löschen` button (not a native dialog). It removes the receipt record, its file and **all its mappings**. A receipt linked to a transaction dated on or before `closedThrough` is refused with the alert `Error: Periode geschlossen bis $CT. Belege mit Zuordnung zu Transaktionen in geschlossenen Perioden können nicht gelöscht werden.`; its edits (`rc-edit`) are refused the same way, `… können nicht geändert werden.`
- `rc-assign` is the assign strip under the header. It opens automatically when a receipt is selected (API online); `Transaktion zuordnen` toggles it, so clicking it on a fresh selection closes it.

## How to get to it (user POV)

- Choose the `Belege` tab, or open `/receipts`.
- Deep link: `/receipts?receipt=<id>`, with optional `filter=unlinked` and `q=<text>`.

## Driving it with browse + sandbox.sh

Preconditions:

- The doctor passes.
- Pick an archived, unlinked receipt with an amount and no kind, so it is visible with `rc-hide` on and the delete diff stays one record: `jq -r '[.mappings[].receiptId] as $l | [.receipts[]|select(.location=="archived" and (.amount//0)>0 and (.kind==null or .kind=="invoice") and (.id as $i|$l|index($i)|not))][0]|[.id,.filename]|@tsv' $SB/books.json`.
- **Hide toggle.** Open `$UI/receipts?q=<filename of a kind=noise receipt>`: no row. Click `label[title^="Dokumente ohne"] input`: the row appears with the `kein Beleg` badge. Click again to restore.

- **Search.** Run `$B newtab "$UI/receipts"` and `$B fill "input[placeholder^='Dateiname']" "<word from filename>"`. The table narrows to matching rows, and the URL gains `?q=`.
- **Preview.** Open `$UI/receipts?receipt=$RID`. The right pane shows the filename (scope the selector to the pane: the table cell has the same `span[title]`) and an `iframe`, the assign strip is already open, and `curl -sI "$API/api/receipts/$RID"` returns `application/pdf`.
- **Edit.** Click `Beleg bearbeiten`, run `$B fill "input[placeholder='Beschreibung…']" "<text>"`, then save. `$S diff` shows `~ receipts <RID> .description`.
- **Delete.** Click `Beleg löschen`, then the red `Löschen` in the `Beleg löschen?` modal (`$B dialog` shows nothing). `$S diff` shows `- receipts <RID>`, and the file is gone from `$SB/receipts/`, while the real `receipts/` still has it.
- **Delete refusal.** Pick a receipt linked to a closed-period transaction (`jq -r --arg ct "$CT" '[.transactions[]|select(.date<=$ct)|.ref] as $t | [.mappings[]|select(.transactionRef as $r|$t|index($r))][0].receiptId' $SB/books.json`) and repeat Delete. `$B dialog` shows the refusal alert, `$S diff` shows no change and the file is still in `$SB/receipts/`.
- **Proof.** Save screenshots, `index-diff.txt`, and `ls` output under `$EVIDENCE/receipts/`.

## Gotchas

- `$SB/receipts` is an APFS clone. Deleting or renaming there never touches the repo's `receipts/`. Still, prove that with `ls` on both.
- Rename (`/api/rename/*`) moves files on disk. Only verify it in the sandbox.
- A workspace can hold known blank captures (broken print-to-PDF files). Their preview is empty, and that is not a bug in your change.
- `rename/batch` skips receipts linked to the closed period instead of refusing the whole batch.
- Driven end to end on 2026-10-08: hide toggle, preview, description edit, delete via the modal, delete refusal on a receipt linked to a closed-period transaction.
