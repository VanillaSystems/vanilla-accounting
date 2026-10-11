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
  headers `.list button.group` (collapse, kept per viewer), `.counts.stc` with `N Auszüge`, `N fehlt`, `N weicht ab` or
  `Salden stimmen`, and the toggle `[data-bg=konto|monat]` (kept per viewer). ↑↓ or J/K move. The dock badge counts the
  statements from the open quarter until today that are missing or do not add up.
- `bk-search`: `.list .search input` (`/` focuses, Esc clears; `?q=` in the link). A statement stays when its name or one
  of its payments matches (text, reference, amount, date, linked receipt); the row says `N Treffer` and the detail dims
  the payments that do not match (`.pay.dim`).
- `bk-detail`: `.detail .who` (`Kontoauszug September 2026`), `.amount` (closing balance), `.facts` (Anfang, +, −, Ende,
  Buchhaltung), `.status` (`Stimmt. …`, `Differenz …`, `Der Anfangssaldo fehlt …`, `Der Endsaldo ist aus dem PDF nicht
  gelesen.`) and, when the books differ from the bank's close, a second `.status` with `Die Buchhaltung weicht um …`.
  The paper is `.paper.real.stmt .pgw canvas.pg`, served from `/bank-statements/<bank>/<file>`.
- `bk-payment`: `.pay[data-pay="<ref>"]` in Zahlungen; a click selects it (`/bank/<key>/<ref>`), again clears it. The
  line shows as `.pgw .hl` and `.pgno` says `Seite N von M` (or `Zeile nicht gefunden`). `.paybar` names the receipt
  (`[data-testid=go-receipt]` → `/receipts/<id>`), the entry (`[data-testid=go-entry]` → `/journal/<id>`), a folded Wise
  fee (`Gebühr …`), or `kein Beleg` with `braucht keinen` (`PATCH /api/transactions/<ref>` noReceiptNeeded; ⌘Z undoes;
  `zurücksetzen` clears it). `×` or Esc clears the choice.
- `bk-note`: `[data-testid=payment-note]` in `.paybar` (`Notiz`, or the note itself) opens `input.note`; ↵ or leaving
  the field saves (`PATCH /api/transactions/<ref>` remarks; an empty note removes it), Esc cancels. Toast `Notiz
  gespeichert` or `Notiz entfernt`, ⌘Z restores the old note. A payment of a filed quarter shows its note as text.
- `bk-links`: `/payments/<ref>` resolves to `/bank/<key>/<ref>` in a period holding it, to its entry when paid privately,
  else the list with a notice. A statement link outside the period opens the period holding it.
- `bk-missing`: a missing month's detail shows `Dieser Auszug fehlt …` and `.desk .well`; a click picks a file that is read
  in for that account and month (a PDF with another name is renamed the bank's way). Its payments still show in Zahlungen.
- `bk-import`: the add button (`.addbtn`, N) or a drop on the page while Kontoauszüge is open: camt.053 (XML) and statement
  PDFs go to `POST /api/statements?name=<file>[&account=&month=]`, which stores them in `bank-statements/<bank>/`, reads
  the folder like `npm run extract` (payments kept, invoice payments matched) and the PDF closing balances. Toast
  `Auszug eingelesen · N neue Zahlungen`; the page opens the statement. Refusals as toasts: a statement wholly inside the
  filed quarter (`Periode geschlossen bis $CT. Ein Auszug, der ganz in einer geschlossenen Periode liegt, …`), the same
  camt.053 again (`Schon eingelesen: …`), an XML that is no camt.053, a PDF whose name gives no month.
- `bk-quick`: Space or a click on the paper opens `.quick` (the statement large, the line marked); Space or Esc closes. D
  or `.detail a.dl` downloads the PDF.
- `bk-palette`: ⌘K lists statements (`Kontoauszug <Monat> · <Konto>`) and payments (`<name>  <date>  <amount>`).

## How to get to it (user POV)

- Dock `Kontoauszüge` or `G` `K`; `/bank` selects the newest statement of the open period.
- From a receipt: `Zahlung … → Auszug` (`[data-testid=go-payment]`) opens `/payments/<ref>`.
- Deep links: `/bank/<account>-<yyyy-mm>`, `/bank/<account>-<yyyy-mm>/<bank ref>`, `/payments/<ref>`.

## Driving it with browse + sandbox.sh

Preconditions: the doctor passes; `B=~/.claude/skills/gstack/browse/dist/browse` when `browse` is not on the PATH. Set the
language once: `$B js "localStorage.setItem('language','de')"`, reload. The demo's statements are Raiffeisen (1021) and
Wise EUR (1023), January to September 2026.

- **List and detail.** `$B newtab "$UI/bank?period=2026-Q3"`; the URL becomes `/bank/1021-2026-09?period=2026-Q3`.
  Screenshot; `[data-bg=monat]` regroups by month.
- **Payment line.** Click `.pay[data-pay="<ref>"]`; read `.paybar` and `.pgno`, screenshot the `.hl`.
- **Links.** Click `[data-testid=go-receipt]`, then on the receipt `[data-testid=go-payment]`: back on the same payment.
  `[data-testid=go-entry]` opens `/journal/<id>`.
- **Missing month.** In the sandbox, move a PDF away and drop its `bankStatements` row from `$SB/books.json`; the row
  shows `fehlt`, the dock badge counts it. To import through the well: `$B js "HTMLInputElement.prototype.click =
  function(){ this.id='__pick'; document.body.append(this) }"`, click `.desk .well`, then `$B upload '#__pick'
  <file under $TMPDIR>` (browse uploads only from the repo or the temp dir).
- **Drop a camt.053.** `$B eval <script>` that builds `new File([xml], 'x.xml')` in a `DataTransfer` and dispatches
  `dragenter` and `drop` on `window`. `$S diff` shows `+ transactions <ref>`; a statement dated on or before `$CT`
  shows the refusal toast and `$S diff` is unchanged, the file is not kept.
- **No receipt needed.** Choose a payment with `kein Beleg`, click `braucht keinen`, read the book, ⌘Z, read it again
  (`noReceiptNeeded` gone).
- **Note.** Choose a payment of the open quarter, click `[data-testid=payment-note]`, `$B fill 'input.note' "Test"`,
  `$B press Enter`; `$S diff` shows `~ transactions <ref> .remarks: … -> "Test"`. ⌘Z, and the diff is empty again.

## Gotchas

- The demo's statement PDFs are generated text pages: the closing-balance reader (`npm run extract-balances`,
  src/parsers/statement-pdf-balances.ts) does not recognise them, so a re-imported demo PDF shows `Ende ?`. The demo's
  balances were written by the generator.
- The import is additive: a payment no statement file holds any more stays in the books (extract's rebuild decides). The
  order of the books' transactions is kept; new ones come last.
- A statement's group label is the manifest's account label (`Bank Raiffeisen`), not a shortened one.
- Driven on 2026-10-11 (phase 3): list by account and month, payment line on the PDF, preview, links to receipt and entry
  and back, `/payments/<ref>`, missing month and its import through the well, camt.053 drop into the running month,
  closed-quarter refusal, `braucht keinen` and undo, search, ⌘K, dark mode.
