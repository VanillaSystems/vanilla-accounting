# Bank statements (Kontoauszüge)

Kontoauszüge (`src/app/areas/bank/`) lists each bank account's monthly statements of the period, grouped by account
(`Konto`) or by month (`Monat`). A month that ended without its statement PDF is a `fehlt` row; the running month shows
with its payments (`Monat läuft`). The detail is the statement: the bank's opening and closing balance and whether its
payments add up to them, the books' balance of the account on its last day (`bookBalanceNative` of
src/accounting/reconcile-bank.ts), the PDF with the chosen payment's line marked, and in the margin Zahlungen, Kurse
(foreign accounts) and Datei. Statements, checks and the folded Wise fees are pure functions in `model.ts`, the line
finder in `lines.ts` (tests/bank-model.test.ts). The import is `POST /api/statements` (src/server/routes/statements.ts,
rows in tests/period-lock.test.ts).

## Sub-features

- `bk-list`: rows `.list .row[data-stmt="<account>-<yyyy-mm>"]` (selected `.row.sel`, missing `.row.missing`), group
  headers `.list button.group` (collapse, kept per viewer), `.counts.stc` with `N Auszüge`, `N fehlt`/`fehlen`, `N weicht ab`/`weichen ab`,
  `[data-testid=gap-count]` (a statement missing between two), the button `[data-testid=unbooked-count]` (`N Zahlungen
  ohne Buchung`, jumps to the first) or `Salden stimmen`, and the toggle `[data-bg=konto|monat]` (kept per viewer). ↑↓
  or j/k move. `[data-testid=bank-strays]` lists bookings on the bank account without a statement line. The dock badge
  counts the statements from the open quarter until today that are missing, have a gap or do not add up.
- `bk-search`: `.list .search input` (`/` focuses, Esc clears; `?q=` in the link). A statement stays when its name or one
  of its payments matches (text, reference, amount, date, linked receipt); the row says `N Treffer` and the detail dims
  the payments that do not match (`.pay.dim`).
- `bk-detail`: `.detail .who` (`Kontoauszug September 2026`), `.amount` (closing balance), `.facts` (Anfang, +, −, Ende,
  Buchhaltung), `.status` (`Stimmt. …`, `Differenz …`, `Der Anfangssaldo fehlt …`, `Der Endsaldo ist aus dem PDF nicht
  gelesen.`), `[data-testid=statement-gap]`, `Der Monat läuft noch …`, and, when the books differ from the bank's close,
  a second `.status` with `Die Buchhaltung weicht um …` (or `[data-testid=opening-missing]` with `Eröffnungssaldo …
  setzen`). The paper is `.paper.real.stmt .pgw canvas.pg`, served from `/bank-statements/<bank>/<file>`; a camt.053
  statement has no paper, only `[data-testid=camt-notice]`. Datei (folded) holds `[data-testid=remove-statement]`
  (`Auszug entfernen`, `DELETE /api/statements/<bank>/<file>`, Rückgängig; refused when a payment has a booking by hand).
- `bk-payment`: `.pay[data-pay="<ref>"]` in Zahlungen; a click selects it (`/bank/<key>/<ref>`), again clears it. The
  line shows as `.pgw .hl` and `.pgno` says `Seite N von M` (or `Zeile nicht gefunden`). `.paybar` names the receipt
  (`[data-testid=go-receipt]` → `/receipts/<id>`), the entry (`[data-testid=go-entry]` → `/journal/<id>`), a folded Wise
  fee (`Gebühr …`), or `kein Beleg` with `braucht keinen` (`PATCH /api/transactions/<ref>` noReceiptNeeded; ⌘Z undoes;
  `zurücksetzen` clears it). `×` or Esc clears the choice. Also on a payment: `[data-testid=only-unbooked]` (filter),
  an `ungebucht` mark and a booking by hand, `[data-testid=link-invoice]` on incoming payments,
  `[data-testid=sale-without-vat]`, `[data-testid=payment-parts]` for a collective payment.
- `bk-note`: `[data-testid=payment-note]` in `.paybar` (`Notiz`, or the note itself) opens `input.note`; ↵ or leaving
  the field saves (`PATCH /api/transactions/<ref>` remarks; an empty note removes it), Esc cancels. Toast `Notiz
  gespeichert` or `Notiz entfernt`, ⌘Z restores the old note. A payment of a filed quarter shows its note as text.
- `bk-links`: `/payments/<ref>` resolves to `/bank/<key>/<ref>` in a period holding it, to its entry when paid privately
  (`Privat bezahlt: …`), else the list with `Die Zahlung <ref> gibt es nicht.` A statement link without `?period=`
  outside the period opens the period holding it.
- `bk-missing`: a missing month's detail shows `Dieser Auszug fehlt …` and `.desk .well`; a click picks a file that is read
  in for that account and month (a PDF with another name is renamed the bank's way). Its payments still show in Zahlungen.
- `bk-import`: the add button (`.addbtn`, N) or a drop on the page while Kontoauszüge is open: camt.053 (XML) and statement
  PDFs go to `POST /api/statements?name=<file>[&account=&month=]`, which stores them in `transactional-data/<year>/bank-statements/<bank>/` (the first open year from the statement's last day; an existing file's path is reused), reads
  the folder like `npm run extract` (payments kept, invoice payments matched) and the PDF closing balances. Toast
  `Auszug eingelesen · N neue Zahlungen` with Rückgängig (deletes the imported files); the page opens the statement.
  Refusals as toasts: a statement wholly inside the filed quarter (`Periode geschlossen bis $CT. Ein Auszug, der ganz in
  einer geschlossenen Periode liegt, …`), payments up to `$CT` the books lack (`filedPayments`), the same camt.053 again
  (409 `Schon eingelesen: …`), the same name with other bytes (`Datei … existiert bereits.`), no or two accounts for the
  file, an XML that is no camt.053, a PDF whose name gives no month; other file types are skipped (`Übersprungen (kein
  XML oder PDF): …`).
- `bk-quick`: Space or a click on the paper opens `.quick` (the statement large, the line marked); Space or Esc closes. D
  or `.paybar a.dl.inline` downloads the PDF (the XML for a camt statement).
- `bk-palette`: ⌘K lists statements (`Kontoauszug <Monat> · <Konto>`, missing months from the open period on) and
  payments (the name, with `<date>  <CUR> <amount>` beside it).

## How to get to it (user POV)

- Dock `Kontoauszüge` or `G` `K`; `/bank` selects the newest statement of the open period.
- From a receipt or a journal entry: `Zahlung … → Auszug` (`[data-testid=go-payment]`) opens `/payments/<ref>`.
- Deep links: `/bank/<account>-<yyyy-mm>`, `/bank/<account>-<yyyy-mm>/<bank ref>`, `/payments/<ref>`.

## Driving it with browse + sandbox.sh

Preconditions: the doctor passes; `$B` and the language as in SKILL.md (Drive). The demo's statements are Raiffeisen (1021) and
Wise EUR (1023), January to September 2026.

- **List and detail.** `$B newtab "$UI/bank?period=2026-Q3"`; the URL becomes `/bank/1021-2026-09?period=2026-Q3`.
  Screenshot; `[data-bg=monat]` regroups by month.
- **Payment line.** `$B goto "$UI/bank/1021-2026-05?period=2026-Q2"`: `.who` `Kontoauszug Mai 2026`, `.status` `Stimmt. …`.
  Click one of its `.pay[data-pay]` (`$B js "document.querySelector('.pay[data-pay]').dataset.pay"`): the URL is
  `/bank/1021-2026-05/<ref>`, `.pgno` `Seite 1 von 1`, `.pgw .hl`.
- **Links.** Click `[data-testid=go-receipt]`, then on the receipt `[data-testid=go-payment]`: back on the same payment.
  `[data-testid=go-entry]` opens `/journal/<id>`.
- **Missing month.** In the sandbox, move a PDF away and drop its `bankStatements` row from `$SB/transactional-data/<year>/books/statements.jsonl`; the row
  shows `fehlt`, the dock badge counts it. Any later import rebuilds the list from the folder, and the demo's quarterly
  camt.053 covers the month again: move the matching XML away too. To import through the well: `$B js "HTMLInputElement.prototype.click =
  function(){ this.id='__pick'; document.body.append(this) }"`, click `.desk .well`, then `$B upload '#__pick'
  <file under $TMPDIR>` (browse uploads only from the repo or the temp dir).
- **Drop a camt.053.** `$B eval <script>` that builds `new File([xml], 'x.xml')` in a `DataTransfer` and dispatches
  `dragenter` and `drop` on `window`. `$S diff` shows `+ transactions <ref>`; a statement dated on or before `$CT`
  shows the refusal toast and `$S diff` is unchanged, the file is not kept.
- **No receipt needed.** Choose a payment with `kein Beleg`, click `braucht keinen`, read the book, ⌘Z, read it again
  (`noReceiptNeeded` gone).
- **Note.** Choose a payment of the open quarter, click `[data-testid=payment-note]`, `$B fill 'input.note' "Test"`,
  `$B press Enter`; toast `Notiz gespeichert`, `$S diff` shows `~ transactions <ref> .remarks: undefined -> "Test"`. ⌘Z,
  and the diff is `no changes` again (driven 2026-10-21 on a May payment of 1021).

## Gotchas

- The demo's statement PDFs are generated text pages: the closing-balance reader (`npm run extract-balances`,
  src/providers/statement-pdf/statement-pdf-balances.ts) does not recognise them, so a re-imported demo PDF shows `Ende ?`. The demo's
  balances were written by the generator.
- The import is additive: a payment no statement file holds any more stays in the books (extract's rebuild decides). The
  order of the books' transactions is kept; new ones come last.
- A statement's group label is the manifest's account label (`Bank Raiffeisen`), not a shortened one.
- Driven on 2026-10-11 (phase 3): list by account and month, payment line on the PDF, preview, links to receipt and entry
  and back, `/payments/<ref>`, missing month and its import through the well, camt.053 drop into the running month,
  closed-quarter refusal, `braucht keinen` and undo, search, ⌘K, dark mode.
