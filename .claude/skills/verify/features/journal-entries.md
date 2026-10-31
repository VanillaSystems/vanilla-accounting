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
  filter `?vat=<code>` (`?vat=none`: entries without a code) shown as a chip, and the origin filter
  `.origins button[data-origin=classify|rule|code|manual|assistant|invoice|year-close]`. The counts
  and origin buttons set chips of the chip filter (`rc-chips` in receipts.md): `ohne Beleg` is
  `?f=receipt_missing`, `Korrekturen` `?f=corrects_yes`, an origin `?f=who_<origin>`. Fields: Konto
  (debit or credit), MWST-Satz (the code's rate, or ohne MWST-Code), Geschäftspartner, Monat, Ab,
  Bis, Betrag über/unter/genau, Währung, Gebucht von, Beleg (verknüpft, keiner, fehlt), Korrektur
  einer eingereichten Periode, Text enthält (the search).
- `je-detail` shows the Buchungssatz, the FX line of a foreign entry (`= CHF … · Kurs …`, the ESTV
  check as its tooltip, a warning row when the rate is not the ESTV rate), the payment (→ `/payments/<ref>`),
  the receipts (→ `/receipts/<id>`), `kein Beleg`, and the receipt's paper or a link to the statement.
- `je-edit` saves Soll, Haben (account field: number or name, ↑/↓, ↵), MWST, amount and text when
  you leave the form or press ↵ (`PATCH /api/journal-entries/:id`). Unknown accounts or codes are
  refused in the form; a rate typed in MWST becomes its code. Undo writes the old values back.
  `[data-testid=entry-actions]`: Gegenbuchung, Kopieren, and for accruals `Am <date> zurückbuchen`.
- `je-new` is the add button and N: `Neue Buchung von Hand` (`POST /api/journal-entries`). The date
  (`dd.mm.yyyy` only) starts as today, or the open quarter's first day when today is filed; any date
  after `closedThrough` is taken; the ref is the next `M<year>-NNN`. A payment picker
  (`[data-testid=payment-field]`) books an unbooked payment, `[data-testid=reverse-on-new-year]`
  books an accrual and its reversal. Undo deletes it.
- `je-correct` is `Korrektur in <quarter> erfassen →` on a filed entry (the quarter that holds the
  new entry's date, usually today's): the dialog `Korrekturbuchung` with a kind switch
  `.jcorr button[data-correct=vat|account|storno]` (MWST-Code / Konto / Ganze Buchung). It opens on
  `vat` when the entry has a code (the code turned on the entry's own account), `storno` swaps Soll
  and Haben. Booked with `corrects: <filed quarter>`.
- `je-delete` is Löschen (or Delete / ⌘⌫; a bare Backspace does nothing): no question, the entry's
  place keeps `[data-testid=deleted]` with Rückgängig, which puts it back with its id, ref, FX fields,
  `corrects` and origin.
- `je-reclassify` is Neu klassifizieren (Herkunft): the payment is booked again by the classifier
  (a model call). A payment with a person's entries first asks `[data-testid=keep-hers]` (Behalten /
  Neu buchen lassen). Undo removes the new entries and restores the old ones.
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
- Keys in Buchungen: ↑/↓ or j/k select, ↵ opens the receipt, ⇧↵ the payment, E edits, D
  downloads the receipt, Delete or ⌘⌫ deletes, N adds, `/` searches, Esc clears the search, then the code
  filter.

## Driving it with browse + sandbox.sh

Preconditions: the doctor passes; `$CT`, `$OPEN_Q`, `$CLOSED_Q` from the env. The language is a
per-viewer preference: `$B js "localStorage.setItem('language','de')"` once, then reload.

- **List and detail.** `$B goto "$UI/journal?period=$OPEN_Q"`. Rows are `.rows.je .row[data-id=<entry id>]`
  with `.dr`, `.cr`, `.vc[data-vat]`, `.cu`, `.a`; the selected one has `.sel`. The first row should be
  selected when the link names none; on 2026-10-21 nothing was selected (a product bug, reported),
  so click a row (`$B js "document.querySelector('.rows.je .row[data-id]').click()"`) first.
- **Card and histogram.** Hover a cell that has a code (`browse` hovers only a unique selector: mark one
  first, `$B js "document.querySelector('.rows.je .vc[data-vat=I81]').id='__vc'"`, `$B hover '#__vc'`),
  wait 0.5 s, then `.vcard` reads `I81 / 8.1 % / … / 405 …`. A cell without a code shows no card.
  `.vhbtn` opens `.vhist`; its rows are `.hr[data-code]`.
- **Edit.** Select an open entry, `$B press e` (focus in `input[name=accountDebit]`), `$B type "65"`,
  `$B press Enter` (typing opens the list with the first match active; ArrowDown would take the
  second). The toast says `Gespeichert: Soll`; `$S diff` shows `~ journalEntries <id> .accountDebit`,
  `.origin -> "manual"`, `.by` and `.reason`. The toast's Rückgängig within 6 s writes it back.
- **New entry.** `$B press n`, `$B fill '.jnew [name=date]' '15.05.2026'` (Swiss date; an ISO date is
  refused), fill `amount`, `accountDebit` (`6570`), `accountCredit` (`6000`), `description`, pressing
  Escape after each account field (↵ in an open list picks instead of booking), focus the description,
  `$B press Enter`. Toast `Gebucht: 6570 / 6000 · <amount>`, the URL is `/journal/<new id>`; `$S diff`
  shows `+ journalEntries <id>` (ref `M2026-003` on the demo). ⌘Z (focus outside a field) deletes it
  again: `no changes`.
- **Filed entry.** `$B goto "$UI/journal?period=$CLOSED_Q"`, select a row: the detail shows the lock
  notice, every form input is `readOnly`, `$B press Delete` toasts `Eingereicht: diese Buchung ändert
  sich nicht mehr. Eine Korrektur geht in die offene Periode.` The notice's link opens
  `.jnew` titled Korrekturbuchung; booking it adds an entry with `corrects`.
- **Re-classify.** The sandbox refuses model calls: the toast says `claude exited 1`. To drive it,
  `$S stub <run>` (the stub books 6570), then `$S unstub <run>`.

## Gotchas

- The toast with Rückgängig stays 6 s. Run the undo in the same browse call chain as the action.
  ⌘Z while the focus is still in a form field is the field's own undo, not the app's: click the
  toast's button instead.
- Two account fields filled from `$B js` both show their list; `$B type` in the focused field is
  the user path.
- The account field's list hides the account name under the field while it is open.
- Entries of a filed quarter can still be found and read; only the open quarter takes writes.
