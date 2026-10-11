# Journal entries (Buchungen) and VAT codes (MWST-Codes)

Buchungen (`src/app/areas/journal/`) lists a period's journal entries month by month, newest first,
as one grid: Datum, Text, Soll, Haben, MWST, currency, amount. The entries of one payment are joined
in the date gutter. The detail shows the entry's Buchungssatz with account names, its VAT code
explained, its payment and receipt, the receipt's paper, and in the margin the other entries of the
same payment, the entry's form and where it came from. Every write goes through the API and can be
undone from the toast (⌘Z). Entries dated on or before `config.closedThrough` are read only.

MWST-Codes (`src/app/areas/codes/`) is the app's VAT-code catalogue by family. The hover card on any
`[data-vat]` element and the histogram of the period's codes (`codes/vat-card.tsx`) are shared: MWST
and other areas render `<VatCards>` to get them.

## Sub-features

- `je-list` lists the period's entries with the filters `alle`, `ohne Beleg` (a payment without a
  receipt, not a fee, not marked as needing none) and `Korrekturen` (entries with `corrects`), a
  search over text, accounts with their names, VAT code, ref, date and amount (`?q=`), and the code
  filter `?vat=<code>` (`?vat=none`: entries without a code) shown as a chip.
- `je-detail` shows the Buchungssatz, the FX line of a foreign entry (`= CHF … · Kurs …`, the ESTV
  check as its tooltip, a warning row when the rate is not the ESTV rate), the payment (→ `/payments/<ref>`),
  the receipts (→ `/receipts/<id>`), `kein Beleg`, and the receipt's paper or a link to the statement.
- `je-edit` saves Soll, Haben (account field: number or name, ↑/↓, ↵), MWST, amount and text when
  you leave the form or press ↵ (`PATCH /api/journal-entries/:id`). Unknown accounts or codes are
  refused in the form. Undo writes the old values back.
- `je-new` is the add button and N: `Neue Buchung von Hand` (`POST /api/journal-entries`), booked in
  the open period with the next `M<year>-NNN`. Undo deletes it.
- `je-correct` is `Korrektur in <open quarter> erfassen →` on a filed entry: the same dialog,
  pre-filled as the entry's reversal (Soll and Haben swapped, the VAT code's sign turned), booked
  with `corrects: <filed quarter>`.
- `je-delete` is Löschen (or Delete/Backspace): no question, undo puts the entry back with its id,
  ref, FX fields, `corrects` and origin.
- `je-reclassify` is Neu klassifizieren (Herkunft): the payment is booked again by the classifier
  (a model call). Undo removes the new entries and restores the old ones.
- `je-closed` refuses every write to a filed entry: the form is read only, Delete and E toast the
  reason, and the API answers 403 for anything that gets through.
- `vat-card`: hovering (or focusing) a code shows its rate, text, Ziffern, amount kind, the
  period's count, and `Erklärung`, `Nur diese zeigen`, `Verteilung aller Codes`.
- `vat-histogram`: the period's codes by count or by CHF, with the VAT in them; ↑/↓, ↵ shows only
  that code's entries, Esc closes.
- `codes`: `/vat/codes[/<code>]`, `alle`/`verwendet`, search, families that fold, the code's page
  (Wann, Nicht wenn with linked codes, Betrag, Ziffern, Beispiel, Regeln, the period's entries).

## How to get to it (user POV)

- Buchungen: the dock (`G U`) or `/journal[/<id>]?period=<period>`. MWST-Codes: a code's card
  (`Erklärung`), the old MWST tab's `Codes erklärt`, ⌘K (type a code), or `/vat/codes/<code>`.
- Keys in Buchungen: ↑/↓ or J/K select, ↵ opens the receipt, ⇧↵ the payment, E edits, D
  downloads the receipt, Delete deletes, N adds, `/` searches, Esc clears the search, then the code
  filter.

## Driving it with browse + sandbox.sh

Preconditions: the doctor passes; `$CT`, `$OPEN_Q`, `$CLOSED_Q` from the env. The language is a
per-viewer preference: `$B js "localStorage.setItem('language','de')"` once, then reload.

- **List and detail.** `$B goto "$UI/journal?period=$OPEN_Q"`. Rows are `.rows.je .row[data-id=<entry id>]`
  with `.dr`, `.cr`, `.vc[data-vat]`, `.cu`, `.a`; the selected one has `.sel`. The first row is
  selected when the link names none.
- **Card and histogram.** `$B hover '.rows.je .row.sel .vc'`, wait 0.5 s, then `.vcard` is there.
  `.vhbtn` opens `.vhist`; its rows are `.hr[data-code]`.
- **Edit.** Select an open entry, `$B press e` (focus in `input[name=accountDebit]`), `$B type "65"`,
  `$B press ArrowDown`, `$B press Enter`. The toast says `Gespeichert: Soll`; `$S diff` shows
  `~ journalEntries <id> .accountDebit` and `.origin -> "manual"`. `$B press Meta+z` within 6 s
  writes it back.
- **New entry.** `$B press n`, fill `.jnew [name=date|amount|accountDebit|accountCredit|vatCode|description]`
  with `$B fill`, then `$B press Enter`. The detail opens on the new entry; `$S diff` shows
  `+ journalEntries <id>` with the next `M<year>-NNN`.
- **Filed entry.** `$B goto "$UI/journal?period=$CLOSED_Q"`: the detail shows the lock notice,
  every form input is `readOnly`, `$B press Delete` toasts `Eingereicht: …`. The notice's link opens
  `.jnew` titled Korrekturbuchung; booking it adds an entry with `corrects`.
- **Re-classify.** The sandbox refuses model calls: the toast says `claude exited 1`. To drive it,
  copy `tests/support/stub-bin/claude` to `$SB/bin/claude` (the stub books 6570), and put the
  refusing shim back afterwards.

## Gotchas

- The toast with Rückgängig stays 6 s. Run the undo in the same browse call chain as the action.
- Two account fields filled from `$B js` both show their list; `$B type` in the focused field is
  the user path.
- The account field's list hides the account name under the field while it is open.
- Entries of a filed quarter can still be found and read; only the open quarter takes writes.
