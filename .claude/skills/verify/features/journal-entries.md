# Journal entries (Buchungen)

The Buchungen tab lists every journal entry per period. A user can double-click the description, Soll, Haben, or MWST-Code cell to edit it inline. The edit saves on Enter. Entries dated inside a closed period (on or before `config.closedThrough`) are refused with an alert, and nothing is written.

## Sub-features

- `je-list` lists entries for the selected period, with the filters `Alle`, `Klassifiziert`, and `Offen` and a `Suchen…` box.
- `je-edit` saves an inline double-click edit of the description, Soll, Haben, or MWST code to the index.
- `je-closed` refuses an edit to an entry dated on or before `closedThrough`, shows an alert, and leaves the data unchanged.
- `je-delete` is the X icon button `title="Löschen"` on a row. It first asks with a native `confirm()` that names the entry: `Buchung löschen?`, then the date, the amount with currency (`<date>  EUR <amount>`), and the description. Cancel writes nothing. On OK, closed periods are refused with `…Buchungen in geschlossenen Perioden können nicht gelöscht werden.`
- `je-reclassify` is the Sparkles icon button `title="Neu klassifizieren"`. On an open entry it calls the LLM and is skipped in the sandbox. On a closed entry the server refuses before any LLM call, so that refusal is drivable.
- `je-select` keeps the selection in the URL (`?je=<id>`, `?utx=<ref>`, `&receipt=<id>`). Opening such a URL selects that row (`bg-blue-50`) and scrolls it into view. ArrowUp/ArrowDown move it.

## How to get to it (user POV)

- Choose the `Buchungen <n>` tab, or open `/<period>/journal-entries`.
- Pick the period in the header `<select>` (`2026 Q2`, …). It has no label of its own; its wrapper has `title="Zeitraum / Quartal wählen"`.

## Driving it with browse + sandbox.sh

Preconditions:

- The doctor passes, and the env has `$CT` (demo: `2026-03-31`).
- Pick an open entry and a closed entry:
  `jq -r --arg ct "$CT" '[.journalEntries[]|select(.date>$ct)][0]|[.id,.date,.description]|@tsv' $SB/books.json`
  `jq -r --arg ct "$CT" --arg from "$CLOSED_FROM" '[.journalEntries[]|select(.date<=$ct and .date>=$from)][0]|[.id,.date,.description]|@tsv' $SB/books.json`

- **Open the tab.** Run `$B newtab "$UI/$OPEN_Q/journal-entries"` and `$B wait "tr[data-rowid=\"$ID\"]"`. Then run `$B screenshot --viewport $EVIDENCE/journal-entries/01-before.png`.
- **Start the edit.** Double-click the description cell: `$B js "document.querySelector('tr[data-rowid=\"$ID\"] td:nth-child(2) span[title]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))"`. A text input appears in the row.
- **Save.** Run `$B fill "tr[data-rowid=\"$ID\"] input" "<old> [verify]"`, then `$B press Enter`, then `$B wait --networkidle`. The input closes. `$B js "document.querySelector('tr[data-rowid=\"$ID\"] td:nth-child(2)').innerText"` returns the new text.
- **Side effect.** `$S diff <run> | tee $EVIDENCE/journal-entries/index-diff.txt` shows exactly `~ journalEntries <ID> .description: "<old>" -> "<old> [verify]"` and, for an entry not edited before, `~ journalEntries <ID> .origin: undefined -> "manual"`.
- **Closed-period refusal.** Run `$B dialog --clear`, then open `$UI/$CLOSED_Q/journal-entries` and repeat the double-click and fill on the closed ID. `$B dialog` contains `Periode geschlossen bis $CT. Korrekturen als neue Buchung in der offenen Periode erfassen.` (the alert wraps it as `Error: {"error":"…"}`, so assert with contains), and `$S diff` shows no line for that ID.
- **Closed delete and reclassify refusals (no LLM needed).** On the same closed row, `$B js "document.querySelector('tr[data-rowid=\"$ID\"] button[title=\"Löschen\"]').click()"`, then the same for `Neu klassifizieren`. `browse` accepts the delete confirm by default, so `$B dialog` shows the `[confirm] "Buchung löschen?…" → accepted` line, then contains `können nicht gelöscht werden` and `Korrekturen als neue Buchung`; `$S diff` shows nothing for the ID or its `transactionRef`.
- **Deep link.** With the open ID, `$B newtab "$UI/$OPEN_Q/journal-entries?je=$ID"`, then `$B wait "tr[data-rowid=\"$ID\"]"`. `$B js "location.search + ' ' + document.querySelector('tr.bg-blue-50')?.dataset.rowid"` returns `?je=<ID> <ID>` (plus `&receipt=<id>` when the entry has a Beleg). `?utx=<ref>` selects the row `u:<ref>` the same way.
- **Delete with confirm.** On the open ID, run `$B dialog --clear`, `$B dialog-dismiss`, then `$B click "tr[data-rowid=\"$ID\"] button[title=\"Löschen\"]"`. `$B dialog` shows `[confirm] "Buchung löschen?…" → dismissed` and `$S diff` prints `No changes`. Repeat with `$B dialog-accept`: the row disappears and `$S diff` prints exactly `- journalEntries <ID>`.
- **Proof.** Save `02-after.png`, `03-closed-period.png`, `closed-period-dialog.txt`, and `index-diff.txt` under `$EVIDENCE/journal-entries/`.

## Gotchas

- `?q=` in the URL does not filter this tab. The tab has its own `Suchen…` box. Wait on `tr[data-rowid=...]` instead.
- `browse` has no dblclick command. Use the `dispatchEvent` line above, which fires the app's own `onDoubleClick`.
- Editing works only while the header shows `● API aktiv`. Without the API, cells are not editable.
- The alert is auto-accepted by `browse`. Read it with `$B dialog`, not from a screenshot.
- `$B dialog-dismiss` stays in effect for every later dialog in the browse session, alerts included. Run `$B dialog-accept` once you are done testing the cancel path.
- The `Klassifiziert` and `Offen` counts are global, not per period (only `Alle (n)` follows the period). `Offen` can be negative because some entries hang on refs with no transaction (e.g. `SHOPIFY-<n>`, `M<year>-<n>` corrections). Existing behavior, not your change.
- Set an input's value with `$B fill` + `$B press Enter`. Setting `.value` and dispatching events from `$B js` does not reach React and silently saves nothing.
- Account cells display `accountTitle()` (`6570 Informatik…`). The stored value is the bare number, so assert on the diff, not on the display text.
