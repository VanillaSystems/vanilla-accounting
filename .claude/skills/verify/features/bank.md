# Bank statements (Kontoauszüge)

Kontoauszüge (`src/app/areas/bank/`) lists each bank account's monthly statements of the period, grouped by account
(`Konto`) or by month (`Monat`). A month that ended without its statement PDF is a `fehlt` row
(`[data-testid=missing-count]`, detail `[data-testid=missing-notice]`) for an account that has had
statements before, else `ohne Auszug` (`[data-testid=without-count]`, `[data-testid=without-notice]`);
a month whose statement is filed among the receipts reads `Auszug unter Belege`. The running month shows
with its payments (`Monat läuft`). The detail is the statement: the bank's opening and closing balance and whether its
payments add up to them, the books' balance of the account on its last day (`bookBalanceNative` of
src/accounting/reconcile-bank.ts), the PDF with the chosen payment's line marked, and in the margin Zahlungen, Kurse
(foreign accounts) and Datei. Statements, checks and the folded Wise fees are pure functions in `model.ts`, the line
finder in `lines.ts` (tests/bank-model.test.ts). The import is `POST /api/statements` (src/server/routes/statements.ts,
rows in tests/period-lock.test.ts).

## Sub-features

- `bk-files` (#208): the group toggle `[data-bg=datei]` («Datei») lists each XML statement file whole by account (`.row[data-file="<account>/<file name>"]`, closing balance on the right); `/bank/files/<account>/<file name>` selects one (its period follows). The detail `[data-testid=bank-file]` shows `[data-testid=statement-file-details]` (bank and BIC, IBAN, owner, stated period and booked days, movements, balances, file, «Eingelesen am» from `GET /api/statements/<bank>/<file>/details`) and `[data-testid=bank-file-moves]`, every movement a link to `/payments/<ref>`. The demo's frozen books list no XML file until a statement is read in (any import rebuilds the list): drop an invented camt.053 of the demo IBAN first (driven 2026-10-27).
- `bk-export` (#273): a bank export over several months is no row of its own under Konto and Monat. Each month is one row: the PDF, marked `auch im Bank-Export`, else the export's part of the month (`aus dem Bank-Export · N Zahlungen`, its payments and balances of that month only); a month an export covers whole is never `fehlt`, and an export reaching one day into a month (a quarter's export dated through the 1st) adds no row there. The detail's `[data-testid=statement-export]` (`Aus dem Bank-Export <file>` / `Auch im Bank-Export <file>`) opens `/bank/files/<account>/<file>`. Driven 2026-10-29 on a Q2-like replay copy (camt.053 «since 2017» with the July to September PDFs).
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
  statement has no paper, only `[data-testid=camt-notice]`, unless its statement is filed among the receipts
  (`[data-testid=statement-receipt]` link, `[data-testid=statement-receipt-paper]`). Datei (`.sec[data-sec=datei]`,
  folded: open its `button.sum` first, or the click times out) holds `[data-testid=remove-statement]`
  (`Auszug entfernen`, `DELETE /api/statements/<bank>/<file>`, Rückgängig; refused when a payment has a booking by hand).
- `bk-payment`: `.pay[data-pay="<ref>"]` in Zahlungen; a click selects it (`/bank/<key>/<ref>`), again clears it. The
  line shows as `.pgw .hl` and `.pgno` says `Seite N von M` (or `Zeile nicht gefunden`). `.paybar` names the receipt
  (`[data-testid=go-receipt]` → `/receipts/<id>`), the entry (`[data-testid=go-entry]` → `/journal/<id>`), a folded Wise
  fee (`Gebühr …`), or `kein Beleg` with `braucht keinen` (`PATCH /api/transactions/<ref>` noReceiptNeeded; ⌘Z undoes;
  `zurücksetzen` clears it). `×` or Esc clears the choice. Also on a payment: `[data-testid=only-unbooked]` (filter),
  an `ungebucht` mark and a booking by hand (`[data-testid=payment-booking]`: opens filled, `[data-testid=proposal]` names each
  proposal's source, #344; below it `[data-testid=task-make-rule]` with `data-similar` and, where the payment's lasting words
  hold for more open payments, `[data-testid=task-make-rule-wider] [data-act=rule-start-wider]` (and `[data-act=rule-start]`) open the rule form in place, `[data-testid=rule-from-payment]`, with the hand form's account, VAT and private share (#383; `/company/rules?payment=<ref>&by=text` still starts it in Firma › Regeln); driven 2026-11-12
  on fresh books of `npm run init --preset trades` with the persona's files: a customer payment opens `1020 / 3400 · V81`
  with `[data-testid=note-sale]`, a wage `3 Zahlungen wie diese` and `oder eine für alle 6 mit «Lohn» im Text`; facts under the
  lines are `[data-testid=note-<kind>]`, a named invoice `[data-testid=pays-invoice]`; the form appears only once
  `/api/rules/hand` answered, tests/by-hand-without-ai-form-ui.test.ts), `[data-testid=link-invoice]` on incoming payments,
  `[data-testid=sale-without-vat]`, `[data-testid=payment-parts]` for a collective payment. The bank's own fee row
  (`type: 'bank-fee'`, «Kontoführung Q3» of the persona's statement) is booked by the run itself, with or without an AI:
  `6940 / 1020` without a code, «von der App gebucht» with the reason `Gebühr der Bank laut Kontoauszug: auf 6940
  Bankspesen, ohne MWST …` (#359); with 6940 missing from the chart it stays unbooked and its form shows
  `[data-testid=note-bankChargesMissing]` («… aber dieses Konto fehlt im Kontenplan …»).
  Money in whose text names the number of the firm's own invoice among the receipts (issued by its UID or name,
  its amount need not be read) shows `[data-testid=own-invoice]` (`data-receipt`, `data-from` invoice | other;
  «Deine Rechnung 2026-031 gefunden …»; `[data-act=not-own-invoice]` drops it). It proposes only what the invoice proves (a Swiss rate;
  `V0-E` for a place of supply abroad after «Leistungsort», src/accounting/sale-document.ts), revenue up to what is
  open of it (`[data-testid=note-ownInvoiceSurplus]`), and books with «Verknüpfen und buchen»
  (`POST /api/transactions/<ref>/entries` `links`, checked again: 409 `ownInvoiceTaken`). Where it proves nothing
  (and for money from a foreign IBAN or currency) `[data-testid=sale-question]` asks «War das ein Verkauf mit
  MWST?»; `[data-choice=saleDomestic|saleAbroad|notSale]` books the lines and answers the app's question in one
  call (`POST /api/transactions/<ref>/sale`, as the card's answer books), `saleAbroadForeignTax` opens the card's
  foreign-tax form; the answered card with «Immer so?» then stands under the payment. A wage follows her last
  booking of it, else `5000` without a code; `[data-testid=note-wageDeductions]` where the books carry wages with
  deductions. A payment out with a linked read receipt proposes the account of the business's last booking by a
  person or a rule (before a model's) with the receipt's rate, «wie deine letzte Buchung bei <Name> am <Datum>»;
  nothing is booked without her click (#382). tests/hand-form-382.test.ts, tests/hand-form-382-ui.test.ts.
- `bk-note`: `[data-testid=payment-note]` in `.paybar` (`Notiz`, or the note itself) opens `input.note`; ↵ or leaving
  the field saves (`PATCH /api/transactions/<ref>` remarks; an empty note removes it), Esc cancels. Toast `Notiz
  gespeichert` or `Notiz entfernt`, ⌘Z restores the old note. A payment of a filed quarter shows its note as text.
- `bk-links`: `/payments/<ref>` resolves to `/bank/<key>/<ref>` in a period holding it, to its entry when paid privately
  (`Privat bezahlt: …`), else the list with `Die Zahlung <ref> gibt es nicht.` A statement link without `?period=`
  outside the period opens the period holding it.
- `bk-missing`: a missing month's detail shows `Dieser Auszug fehlt …` and `.desk .well`; a click picks a file that is read
  in for that account and month (a PDF with another name is renamed the bank's way). Its payments still show in Zahlungen.
- `bk-import`: the add button (`.addbtn`, N): camt.053 (XML) and statement
  PDFs go to `POST /api/statements?name=<file>[&account=&month=]`, which stores them in `transactional-data/<year>/bank-statements/<bank>/` (the first open year from the statement's last day; an existing file's path is reused), reads
  the folder like `npm run extract` (payments kept, invoice payments matched) and the PDF closing balances. Toast
  `Auszug eingelesen · N neue Zahlungen` with Rückgängig (deletes the imported files); the page opens the statement.
  Refusals as toasts: a statement wholly inside the filed quarter (`Periode geschlossen bis $CT. Ein Auszug, der ganz in
  einer geschlossenen Periode liegt, …`), payments up to `$CT` the books lack (`filedPayments`), the same camt.053 again
  (409 `Schon eingelesen: …`), the same name with other bytes (`Datei … existiert bereits.`), no or two accounts for the
  file, an XML that is no camt.053, a PDF whose name gives no month; any other file (a photo, a ZIP), and the files after a refused one, go to the drop
  dialog, each with its row. A drop on the page while Kontoauszüge is open goes to the drop dialog as on any page
  (features/drop.md, #361).
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
  `dragenter` and `drop` on `window`: the drop dialog's row for it, `$S diff` shows `+ transactions <ref>`; a statement
  dated on or before `$CT` gets a row that names the refusal and `$S diff` is unchanged, the file is not kept.
- **No receipt needed.** Choose a payment with `kein Beleg`, click `braucht keinen`, read the book, ⌘Z, read it again
  (`noReceiptNeeded` gone). On a payment without a booking (`[data-testid=no-receipt-needed]`) the click also starts the
  booking run for it (#340): the bar says `Die App bucht sie gerade` (`[data-testid=booking-now]`), then the booking, or,
  where no rule and no model booked it, `nicht gebucht: die App konnte sie nicht selbst buchen …`
  (`[data-testid=not-booked-yours]`) above the form «Von Hand buchen»; the toast says the run's outcome. ⌘Z takes back
  the mark only, never a booking the run made.
- **Note.** Choose a payment of the open quarter, click `[data-testid=payment-note]`, `$B fill 'input.note' "Test"`,
  `$B press Enter`; toast `Notiz gespeichert`, `$S diff` shows `~ transactions <ref> .remarks: undefined -> "Test"`. ⌘Z,
  and the diff is `no changes` again (driven 2026-10-21 on a May payment of 1021).

## Gotchas

- The demo's statement PDFs are generated text pages; their balances were written by the generator and stay in the books. A
  kept PDF gets a new balance only from its table (#243): the model's read (`[data-testid=statement-reads-start]` «N Kontoauszüge
  von der KI lesen lassen?» above the list, `npm run read-statements`) or `[data-testid=pdf-facts-edit]` «Saldo und Referenzen von
  Hand erfassen» on the statement (`[data-testid=pdf-facts]`, its `data-state`). Their account has a camt.053, so every PDF of it is kept without a question, whatever
  days it shows (#254); an upload of a PDF of an account without camt.053 or CSV opens the drop dialog, which reads it (features/drop.md).
- **A statement PDF's question and «Aktionen» (#254, driven 2026-10-28).** A PDF statement with no movement in its days shows
  `[data-testid=no-movements]` `<Monat>: keine Bewegungen eingelesen.` with `[data-testid=no-movements-read]` `Bewegungen aus dem PDF lesen`;
  with no payment chosen the paybar's `Aktionen` (`[data-act=actions]`) offers `[data-action=readPdf]` `Bewegungen aus dem PDF einlesen`. Either
  reads the PDF (the sandbox has no model: the hand form, `[data-testid=drop-read-why]` `data-why=noProvider`, or `failed` with the stub) and keeps
  the table as the PDF's question in the books (`statementAsks`): `[data-testid=pdf-question]` with the drop dialog's table (`[data-testid=drop-read-*]`),
  `Einlesen` and `Als Monatsauszug behalten`. An empty table shows `Noch nichts erfasst …` in grey (`.dread-check.blank`), never `Geht auf`. Days a
  camt.053 or CSV of the account covers are named in `[data-testid=drop-read-covered]` (`data-whole`); all days: no `Einlesen`. To make the
  state by API: `POST /api/statements?name=x.pdf` (kept), then `POST|PUT /api/statements/<bank>/<file>/read[/import]`.
- **The account's reconciliation (#254).** Read movements and a bank camt.053 or CSV of the same days (± 7) meet in one reconciliation
  (`reconciliations` in `/books.json`, `reconcile.jsonl`): every statement of the account whose days it touches shows `[data-testid=reconcile]`
  «Abgleich: bisher aus PDFs gelesen ↔ jetzt vom Bank-Export», a row per read movement (`tr[data-read=<ref>]`) with
  `[data-testid=reconcile-choice]` (`— wählen —`, `own` «Eigene Zahlung», or a bank movement's ref, the code's pairs preselected; `$B select`
  works), `[data-testid=reconcile-account]` for a filed pair's difference, `[data-testid=reconcile-bank-only]`, `[data-testid=reconcile-same]`
  and `[data-testid=reconcile-confirm]` «Abgleich bestätigen» (`POST /api/reconciliations/<account>` with `{ pairs, own }`), disabled while a
  row is open. A held movement's paybar says `[data-testid=reconcile-held]`. Quickest state on the demo (Raiffeisen has camt.053 through
  September): upload an October PDF (`POST /api/statements?name=oktober.pdf`, kept), `POST …/read` (hand form), then `POST …/read/import` with
  a table whose first lines repeat the last September payments on 1 and 2 October: the import answers `reconcile: { read, bank }`.
- The import is additive: a payment no statement file holds any more stays in the books (extract's rebuild decides). The
  order of the books' transactions is kept; new ones come last.
- A statement's group label is the manifest's account label (`Bank Raiffeisen`), not a shortened one.
- Driven on 2026-10-11 (phase 3): list by account and month, payment line on the PDF, preview, links to receipt and entry
  and back, `/payments/<ref>`, missing month and its import through the well, camt.053 drop into the running month,
  closed-quarter refusal, `braucht keinen` and undo, search, ⌘K, dark mode.
- **A filed pair (#254).** A reconciliation's pair with a read movement filed and booked marks the bank's movement
  `[data-testid=filed-twin]` «schon im abgerechneten Quartal gebucht, als die am <date> aus dem PDF gelesene Zahlung» with `[data-testid=filed-twin-anyway]`
  `Trotzdem buchen` (`DELETE /api/transactions/<ref>/filed-twin`); a difference of a few Rappen is booked on it.
- Known product bug (2026-10-31): on the demo, «Auszug entfernen» on 1021-2026-07 and its Rückgängig leave the books
  changed: the PDF-read balances (`statementBalances` with `source: pdf`, July's 31.07. among them) do not come back,
  July then reads `Der Endsaldo ist aus dem PDF nicht gelesen.` and August `Der Anfangssaldo fehlt`. Run `down`/`up`
  after driving the removal.
