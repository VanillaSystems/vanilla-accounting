# Receipts (Belege)

Belege (`src/app/areas/receipts/`) lists the receipts of the period in groups: `Braucht dich`
(open receipts dated in the open quarter or later, a suggestion first), then one group per month,
newest first; undated receipts wait at the end behind `N ohne Datum … · zeigen`, files that are no
receipt behind `N Dateien sind keine Belege … · zeigen`. The detail shows the paper (pdf.js, each
page cut to its ink), the facts line, the payment status and the margin sections Zahlung, Angaben
and Datei. The order and the ranking are pure functions in `model.ts` (tests/receipts-model.test.ts).

## Sub-features

- `rc-list`: rows `.list .row[data-id="<receipt id>"]` (selected: `.row.sel`), group headers
  `.list button.group` (click collapses; kept per viewer), counts `.counts [role=tab]` with
  `data-filter="zugeordnet|offen|ohneDatum"` (absent = alle). The filter and the search are in the
  URL: `/receipts/<id>?filter=offen&q=coop`. ↑↓ or J/K move, the dock badge counts `Braucht dich`.
- `rc-search`: `.list .search input` (`/` focuses it, Esc clears). It looks in description, file
  name, note, date and amount.
- `rc-detail`: `.detail .who` (vendor, the description up to the first `, ` / ` — ` / ` - `),
  `.amount`, `.facts`, `.status`. A receipt linked to a payment or entry of a filed quarter shows
  `.notice` with `ist eingereicht. Nur lesen.`; its row has only the preview button and its form is
  read only. The paper is `.paper.real canvas.pg`, served from `/api/receipts/<id>`.
- `rc-link`: `L`, the row's link button or `.addlink` opens `.linkdlg` (`.o[data-ref="<tx ref>"]`,
  the last option `data-ref="private"`). ↑↓ choose, Enter links (`POST /api/mapping/add`), Esc
  closes. `private` books a manual payment on the receipt's date and amount and links it
  (`POST /api/transactions/manual` + mapping). A unique exact fit shows as `.sug` with
  `[data-accept]` (Enter accepts and selects the next receipt that needs you).
- `rc-unlink`: `.status .quiet` (`lösen`) or `.tx .un` in Zahlung (`POST /api/mapping/remove`).
- `rc-edit`: `E` opens Angaben (`.sec[data-sec=angaben]`) and focuses the date. `form.form`
  fields `filename`, `date` (TT.MM.JJJJ), `currency`, `amount`, `description`, `remarks` (a
  textarea); Enter or leaving the form saves only the changed fields in one
  `PATCH /api/receipts/:id`.
- `rc-kind`: Datei › `Kein Beleg` sets `kind: noise` (kindBy human), `Ist doch ein Beleg` (also
  the check button of a hidden row) sets `kind: invoice`.
- `rc-undo`: link, unlink, private outlay, edit and kind answer with a toast `.toast` whose button
  (or ⌘Z while it shows, 6 s) writes the opposite.
- `rc-delete`: ⌫ or Datei › `Löschen` opens `.confirm` (`Beleg löschen?`); Enter or `.btn.danger`
  deletes the record, its file and its mappings. No undo.
- `rc-preview`: Space opens `.quick` (Space or Esc closes); D clicks `.detail a.dl` (download
  under the file name).
- `rc-intake`: the add button (`[data-add]`, N) or a drop of PDFs on any page uploads to the inbox
  and opens `/receipts/<id>` (the id is the file's checksum, as extract computes it). The inbox
  file shows as `.row.reading` (`wird gelesen`) from `GET /api/inbox` until the books hold it;
  the page polls every 3 s and loads the books again when a file left the inbox.
- `rc-links`: `[data-testid=go-payment]` opens `/payments/<ref>` (the bank area),
  `[data-testid=go-entry]` opens `/journal/<entry id>`.

## How to get to it (user POV)

- Dock › Belege (`G B`), or `/receipts`. Deep link `/receipts/<id>`: a receipt of another period
  opens that period when the link names none.

## Driving it with browse + sandbox.sh

- `VERIFY_WORKSPACE=demo $S up <run>`; `B=~/.claude/skills/gstack/browse/dist/browse` when
  `command -v browse` is only a shell alias.
- **Unlink and undo.** Open `$UI/receipts/<linked id>`, click `.status .quiet`, then at once
  `$B press Meta+z`. `$S diff` shows the mapping gone and back.
- **Link.** Focus `.list .row.sel`, press `l`, Enter. `$S diff` shows `+ mappings`.
- **Private outlay.** In the dialog `ArrowUp` (wraps to `private`), Enter: `+ transactions
  M<year>-…` and its mapping; ⌘Z removes both.
- **Edit.** `e`, `$B fill "form.form input[name=description]" "…"`, Enter: `~ receipts <id>
  .description`. A bad date shows `Datum als TT.MM.JJJJ.` in `.form .err`.
- **Delete.** Select a row, `Backspace`, Enter: `- receipts <id>` and its mappings; the file is
  gone from `$SB/receipts`, the repo's `demo/receipts` still has it.
- **Filed quarter.** `$UI/receipts?period=$CLOSED_Q`: `.notice` says it is filed, `l` only toasts.
- **Intake.** On any page dispatch `dragenter` + `drop` with a `DataTransfer` holding a PDF
  (`$B js`): the URL becomes `/receipts/<id>`, `.row.reading` shows, `curl $API/api/inbox` lists
  it. The demo's `extract` refuses its own closed transactions, so stand in for it by adding the
  receipt (`location: staged`, same id and file name) to `$SB/books.json`: within 3 s the row
  becomes the receipt, still selected.

## Gotchas

- The sandbox makes no model calls: `Neu lesen (KI)` answers with the shim's error in the toast.
- Toasts with an undo vanish after 6 s; take the undo before a slow step (a screenshot, a diff).
- Undoing `Kein Beleg` puts the kind back but marks it as a person's (`kindBy: human`).
- Driven end to end on 2026-10-11 (redesign phase 2): every recipe above.
