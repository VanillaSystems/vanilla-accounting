# Receipts (Belege)

Belege (`src/app/areas/receipts/`) lists the receipts of the period in groups: `Braucht dich`
(open receipts after `closedThrough`, open undated ones, files still being read; a suggestion first),
then one group per month, newest first; linked undated receipts wait at the end behind
`N ohne Datum … · zeigen`, files that are no receipt behind `N Dateien sind keine Belege … · zeigen`
(`[data-testid=toggle-hidden]`). Quarantined files show in `[data-testid=quarantine]` with `Ist ein Beleg`. The detail shows the paper (pdf.js, each
page cut to its ink), the facts line, the payment status and the margin sections Zahlung, Angaben
and Datei. The order and the ranking are pure functions in `model.ts` (tests/receipts-model.test.ts).

## Sub-features

- `rc-list`: rows `.list .row[data-id="<receipt id>"]` (selected: `.row.sel`), group headers
  `.list button.group` (click collapses; kept per viewer), counts `.counts [role=tab]` with
  `data-filter="linked|open|noDate"` (absent = alle): each count sets the one state chip it names.
  The chips and the search are in the URL: `/receipts/<id>?f=state_open&q=coop` (an old
  `?filter=offen` redirects). ↑↓ or j/k move, the dock badge counts `Braucht dich`.
- `rc-chips` (#211, shared with `je-list`): `[data-testid=chipbar]` under the counts holds the chips
  `.fchip[data-field][data-value]` (× is `.fchip .x`; chips of one field are joined by `.or`, OR;
  different fields AND), `[data-testid=filter-button]` opens `[data-testid=filter-menu]` (fields
  `button[data-field]`, then values `button[data-value]` with their counts, or a typed amount or
  date and `Hinzufügen`), and the search; typed text offers values as `.fsuggest button`. Nothing
  left: `[data-testid=chip-empty]` names the fields that exclude everything, each removal with its
  count (`button[data-field]`), and `Alle Filter entfernen`. Fields: Geschäftspartner (the open
  year's partners), Zustand, Monat, Ab, Bis, Betrag über/unter/genau, Währung, MWST-Satz, Art,
  Zahlung verknüpft, Text enthält (focuses the search).
  With no id in the link the first row is selected.
- `rc-search`: `.list .search input` (`/` focuses it, Esc clears). It looks in description, vendor,
  file name, note, VAT number, date (ISO or TT.MM.JJJJ) and amount.
- `rc-detail`: `.detail .who` (vendor, the description up to the first `, ` / ` — ` / ` - `),
  `.amount`, `.facts`, `.status`. A receipt linked to a payment or entry of a filed quarter shows
  `.notice` with `ist eingereicht. Nur lesen.`; its row has only the preview button and its form is
  read only. The paper is `.paper.real canvas.pg`, served from `/api/receipts/<id>`. Notes that can
  show: `[data-testid=twin]` (`ist dasselbe` / `verschieden`), `[data-testid=filed-payment]` with
  `filed-correct`, `fit-off` / `fit-skonto`, `vat-misfit`, `read-failed`.
- `rc-link`: `L`, the row's link button or `.addlink` opens `.linkdlg` (`.o[data-ref="<tx ref>"]`,
  the last option `data-ref="private"`, filed payments `.o.filed[data-filed]`). ↑↓ choose; Enter with
  nothing chosen picks the first row, a second Enter links (`POST /api/mapping/add`); Esc closes. A
  receipt that already has a payment shows `[data-testid=has-payment]` and needs one more Enter.
  `private` books a manual payment on the receipt's date and amount and links it
  (`POST /api/receipts/<id>/private-payment`; for a receipt of a filed period dated on the first open day). A unique exact fit shows as `.sug` with
  `[data-accept]` (Enter accepts and selects the next receipt that needs you).
- `rc-unlink`: `.status .quiet` (`lösen`) or `.tx .un` in Zahlung (`POST /api/mapping/remove`).
  When the payment is a private one only this receipt holds, the same place says `Privat bezahlt
  aufheben`: it deletes that payment (`DELETE /api/transactions/<ref>`) and its link; ⌘Z pays the
  receipt privately again (a new manual payment with a new ref). Deleting a booked private payment
  takes its entries with it.
- `rc-edit`: `E` opens Angaben (`.sec[data-sec=angaben]`) and focuses the date. `form.form`
  fields `filename`, `date` (TT.MM.JJJJ), `currency`, `amount`, `description`, `remarks` (a
  textarea); Enter or leaving the form saves only the changed fields in one
  `PATCH /api/receipts/:id`.
- `rc-vat`: in Angaben, `.vatf` (VatFields.tsx): `Schweizer MWST auf dem Beleg` with
  `.seg2 [role=radio]` `keine` / `ja`; for `ja` one `.vline` per rate (a `select` of the
  jurisdiction's rates in force, from the VAT engine, and the VAT amount), `weiterer Satz` adds one,
  `×` removes one, and `MWST-Nummer`. `ja` on a receipt with an amount fills the first line at once
  (amount × rate / (100 + rate), to the cent) and saves; a rate change refills a figure that was
  filled so. Each change saves `PATCH /api/receipts/:id {vat}`: the facts become the person's
  (`vatBy: human`, `.byhand` «von Hand» in the facts line and beside the label) and the VAT step
  never reads them over, not with `--force`. The classifier's open bookings of the receipt's
  payments go and the inbox run books them again (toast `MWST gespeichert · die Zahlung wird damit
  neu gebucht`); the undo puts back what the AI read (`vatBy: null`), or no facts (`vat: null`,
  read again by the next run).
- `rc-kind`: Datei › `Kein Beleg` sets `kind: noise` (kindBy human), `Ist doch ein Beleg` (also
  the check button of a hidden row) sets `kind: invoice`.
- `rc-undo`: link, unlink, private outlay, edit and kind answer with a toast `.toast` whose button
  (or ⌘Z while it shows, 6 s) writes the opposite.
- `rc-delete`: ⌘⌫, Delete or Datei › `Löschen` opens `.confirm` (a bare Backspace does nothing) (`Beleg löschen?`); Enter or `.btn.danger`
  deletes the record and its mappings, with the classifier's entries that saw it; the inbox run
  books those payments again without it. The file moves to `data/trash/<id>/<deletion>/` beside
  `trashed.json` (30 days); the
  toast's Rückgängig (`POST /api/receipts/<id>/restore`) brings record, links and file back and
  the run books the payment with it again.
- `rc-preview`: Space opens `.quick` (Space or Esc closes); D clicks `.detail a.dl` (download
  under the file name).
- `rc-intake`: the add button `Beleg` (`[data-add]`, N), the strip `Hierher ziehen`
  (`[data-testid=inflow-strip]`; on empty books `inflow-firstrun` with `Dateien wählen`) or a drop on
  the page open `Dateien hinzufügen` (features/drop.md); the page stays where it is. A file in the inbox
  shows as `.row.reading` (`wird gelesen`) from `GET /api/inbox` until the books hold it (polled every
  3 s; a failed read is `.row.reading.failed`). `[data-testid=run-inbox]` (Eingang verarbeiten, also
  in ⌘K) starts the intake run: `POST /api/automation {kind:'start', workflow: receipt-intake}`.
- `rc-links`: `[data-testid=go-payment]` opens `/payments/<ref>` (the bank area),
  `[data-testid=go-entry]` opens `/journal/<entry id>`.

## How to get to it (user POV)

- Dock › Belege (`G B`), or `/receipts`. Deep link `/receipts/<id>`: a receipt of another period
  opens that period when the link names none.

## Driving it with browse + sandbox.sh

- `VERIFY_WORKSPACE=demo $S up <run>`; `$B` and the language as in SKILL.md (Drive). On the fresh demo
  all 60 receipts are linked: `Braucht dich` and `.sug` are empty until something is unlinked.
- **Unlink and undo.** Open `$UI/receipts/<linked id>`, click `.status .quiet`, then at once
  `$B press Meta+z`. `$S diff` shows the mapping gone and back.
- **Link.** After an unlink, focus `.list .row.sel`, press `l`, Enter, Enter. `$S diff` shows `+ mappings`
  (unlink and link also book the payment again, so entries can change too).
- **Private outlay.** In the dialog `ArrowUp` (wraps to `private`), Enter: `+ transactions
  M<year>-…` and its mapping; ⌘Z removes both.
- **Edit.** `e`, `$B fill "form.form input[name=description]" "…"`, Enter: toast `Gespeichert ·
  Beschreibung`, `~ receipts <id> .description`. The focus stays in the field, so ⌘Z there is the
  field's own undo: click the toast's `Rückgängig` (`no changes` again, driven 2026-10-21). A bad
  date shows `Datum als TT.MM.JJJJ.` in `.form .err`.
- **Delete.** Select a row, `$B press Meta+Backspace`, Enter: `- receipts <id>` and its mappings; the
  file is in `$SB/data/trash/<id>/<deletion>/`, the repo's
  `demo/vanilla-accounting/transactional-data/2026/receipts/` still has it. The toast's undo must be
  taken within 6 s (no diff in between).
- **VAT by hand.** `$S stub <run>`,
  open a receipt of the open quarter linked to a payment, click `.vatf .seg2` `ja`: `$S diff`
  shows `~ receipts <id> .hasSwissVat/.vatSummary/.vatBy` and, once `GET /api/automation` has no
  running run, the payment's entry replaced (`-`/`+ journalEntries`, the stub books `I81`). The run
  also rewrites `bankStatements` in another key order: those lines are noise. `$S unstub <run>` after.
- **Filed quarter.** `$UI/receipts?period=$CLOSED_Q`: `.notice` says it is filed, `l` only toasts.
- **Intake.** Drop a new PDF as in features/drop.md: the dialog takes it into `$SB/beleg-import/`,
  `.row.reading` shows in Belege, `curl $API/api/inbox` lists it. The intake's model steps fail on the
  shim (they note `noModel`); `$S stub <run>` drives them (`CLAUDE_STUB_GATE=<file>` and
  `CLAUDE_STUB_ANSWER=<json>` in the shell of `up` hold or shape the stub's answers).

## Gotchas

- The sandbox makes no model calls: `Neu lesen (KI)` answers with the shim's error in the toast.
- Toasts with an undo vanish after 6 s; take the undo before a slow step (a screenshot, a diff).
- Undoing `Kein Beleg` puts the kind back but marks it as a person's (`kindBy: human`).
- Driven end to end on 2026-10-11 (redesign phase 2); edit and undo again on 2026-10-21.
- Photos (JPG, PNG, HEIC) land in `beleg-import/` as they are; the read step wraps them into a PDF
  (HEIC through `/usr/bin/sips`).
