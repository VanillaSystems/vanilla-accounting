# Owner of a trades firm: Sandra, Malerei Huber GmbH

Sandra Huber does the office of a painting firm in Wil SG on the side: her husband Thomas runs
the jobs, Marco works on the sites. She is not technical, writes the way she talks («bitte
richtig eintragen»), uses the wrong words («Quittung», «Konto» for a booking) and gives up after
two tries. The firm is a GmbH, registered for VAT, effective method, cash basis (vereinnahmt),
quarterly. Her books start in Q3 2026. Her files are in `persona-files.mjs`; the snapshots
`huber-setup` (books set up, nothing dropped) and `huber-q3` (the whole Q3 dropped and booked)
start each test.

Format and status: [README.md](README.md).

## Setup and first run

### OW-01 Install the app and open it the first time

**Goal.** «Ich habe die App heruntergeladen und will sie öffnen.»

**Happy path.** She opens the dmg, drags the app to Applications (or the app offers to move
itself), opens it, and the start screen offers «Neue Buchhaltung anlegen» and «Bestehende
Buchhaltung öffnen».

**What goes wrong.**

**F1. macOS refuses the unsigned app.** `fails (usability#1, usability#2)`
- Noticed: macOS says the app «can't be opened» with only «OK» and «Show in Finder».
- By hand: System Settings › Privacy & Security › «Open Anyway», confirm, admin password.
- By wish: none (the app is not running yet).
- Learns: nothing to learn; the fix is a signed and notarised app (waits for the Developer ID).

**F2. She runs the app from the disk image.** `passes (usability#3, fixed 2ff0fdd)`
- Noticed: the app offers to move itself into Applications.
- By hand: drag it there.
- By wish: none.
- Learns: moved by the app, macOS does not ask again (usability#6).

**F3. The start screen speaks developer.** `fails (usability#5)`
- Noticed: «Pick the folder that holds belege.workspace.yaml».
- By hand: she guesses.
- By wish: none.
- Learns: the texts name what she knows: «den Ordner deiner Buchhaltung».

**Automation target.** Code: everything. Person: the double-click.

**Test.** VM from `vanilla-clean` (`vm.sh up`), Gatekeeper on, dmg in Downloads.

**Status.** fails (usability#1, usability#2, usability#5)

### OW-02 Set up the books

**Goal.** «Ich will die Buchhaltung für unsere Malerei einrichten.»

**Happy path.** «Neue Buchhaltung anlegen», the questions about the firm (name, UID, legal form,
VAT registration and method, cash or agreed basis, the bank accounts), «Buchhaltung anlegen».
The app creates the folder, the chart and the VAT codes.

**What goes wrong.**

**F1. A wrong field far up the form.** `passes (usability#12, fixed 2ff0fdd)`
- Noticed: setup jumps to the first error, focuses it, names every wrong field next to the button.
- By hand: correct the field.
- By wish: none (no AI yet).
- Learns: nothing.

**F2. A typo in the IBAN or UID.** `passes (usability#14)`
- Noticed: check digits are validated with a clear message.
- By hand: retype.
- By wish: none.
- Learns: nothing.

**F3. No preset for a trades firm.** `fails (usability#8), retest (48fdaa3 adds Handwerk, Bau)`
- Noticed: only Consulting, Webshop, Freelancer; she picks Consulting.
- By hand: answer every question herself.
- By wish: none.
- Learns: the trades preset sets material accounts (4400) and the labour/material split.

**F4. She quits halfway through.** `fails (usability#9)`
- Noticed: on reopening, everything typed is gone.
- By hand: start again.
- By wish: none.
- Learns: the form keeps a draft until «Buchhaltung anlegen».

**F5. Jargon in the explanations.** `fails (usability#11, low)`
- Noticed: «Durchlaufkonto (1093)», «K81-B» frighten her.
- By hand: she skips.
- By wish: none.
- Learns: account numbers and codes only on demand.

**Automation target.** Code: validation, chart, codes, defaults per preset. Person: the facts
of her firm (VAT method, basis, period), which no one else knows.

**Test.** VM `vanilla-clean`, setup with the persona's IBAN and UID (`PERSONA_IBAN`,
`PERSONA_UID`), one deliberate typo in each.

**Status.** fails (usability#8, usability#9, usability#11)

### OW-03 The first steps after setup

**Goal.** «Und jetzt? Ich will das dritte Quartal machen.»

**Happy path.** New books show three first steps: the statement as camt.053, drop everything,
check «Braucht dich». Books that never filed open on the period of their first payment (Q3).

**What goes wrong.**

**F1. The app lands on an empty Q4.** `passes (usability#15, fixed 9363ad3)`
- Noticed: the first steps and the period of the first payment.
- By hand: period picker.
- By wish: «zeig mir das dritte Quartal».
- Learns: books that never filed work on their first payment's period everywhere.

**F2. A small window wraps the headers; the dock icons have no labels.** `untested (usability#16 not retested)`
- Noticed: «Q4 / 2026» on two lines.
- By hand: a larger window.
- By wish: none.
- Learns: nothing; a layout fix.

**Automation target.** Code: the period to show. Person: nothing.

**Test.** `huber-setup`, first start after setup, 13-inch window size.

**Status.** partly (usability#15 passes, usability#16 untested)

### OW-04 Work with the AI, and without it

**Goal.** «Die KI soll mir helfen. Und wenn das Abo ausläuft, muss es trotzdem gehen.»

**Happy path.** She connects her Claude subscription once. Receipts are read, matched and
booked; the sidebar (⌘J) does what she asks. Without a subscription, every step has a way by
hand and the app says which steps wait for the AI.

**What goes wrong.**

**F1. Connecting Claude needs a terminal.** `fails (usability#29)`
- Noticed: the sidebar says «installieren und einmal im Terminal mit „claude" anmelden».
- By hand: she stops.
- By wish: impossible, the AI is what is missing.
- Learns: a sign-in inside the app.

**F2. A clear PDF without the AI.** `passes (usability#23, fixed d6b2c87)`
- Noticed: date, total and Swiss VAT read by code when the figures add up at a Swiss rate;
  unknown VAT reads «MWST noch nicht gelesen», never «keine CH-MWST».
- By hand: fill the rest in «Angaben bearbeiten».
- By wish: none.
- Learns: nothing; code first.

**F3. A photo without the AI.** `fails (usability#25, treuhaender-3)`
- Noticed: the photo stays «in Arbeit» forever; no word that a person must type it in.
- By hand: open the receipt, type date and amount.
- By wish: none.
- Learns: the row ends in «braucht dich: ohne KI nicht lesbar, bitte von Hand eintragen».

**F4. The subscription lapses mid-quarter.** `untested`
- Noticed: should be one plain message, once, not an error per file.
- By hand: every AI step has its manual twin (read, link, book).
- By wish: none.
- Learns: runs that waited for the AI resume when it is back, nothing booked twice.

**Automation target.** Code: everything a rule decides, with or without a subscription. AI:
photos, accounts for new suppliers, wishes. Person: whether to pay for the AI.

**Test.** `huber-setup` without Claude (`vm.sh claude` not run) for F2 and F3; `huber-q3` with
Claude, then sign out of Claude in the VM and drop a receipt for F4.

**Status.** fails (usability#25, usability#29, treuhaender-3)

### OW-05 The opening balance when the books start mid-year

**Goal.** «Auf dem Juni-Auszug steht der Kontostand. Das muss doch der Anfang sein.»

**Happy path.** The first camt.053 carries the bank's balance before its first day (OPBD).
Automatisierung offers «Als Eröffnungssaldo übernehmen»; one click, retained earnings on the
other side, and the balance check agrees.

**What goes wrong.**

**F1. She books the opening herself as a journal entry.** `fails (quarter-close-14)`
- Noticed: the Bilanz no longer balances; the banner names a cause that is not the cause.
- By hand: delete the entry, take the offer.
- By wish: «warum ist die Bank minus?» explains (quarter-close-13 passes) but books nothing.
- Learns: a journal entry on an opening account is caught: «Das ist ein Eröffnungssaldo, soll
  ich ihn dort eintragen?»

**F2. The offer exists, she does not find it.** `passes (regression-10)`
- Noticed: the statement's line in Automatisierung.
- By hand: one click.
- By wish: «trag den Anfangsbestand ein».
- Learns: nothing more.

**F3. The Treuhänder's closing of last year differs from the bank's OPBD.** `untested`
- Noticed: should show both figures and the difference.
- By hand: Firma › Eröffnung, type the balances.
- By wish: «nimm die Zahlen aus der Bilanz vom Treuhänder» with the PDF attached.
- Learns: the opening balances are the Treuhänder's, the bank's is the check.

**Automation target.** Code: take the OPBD, check it. Person: which closing counts.

**Test.** `huber-setup`, drop the Q3 camt, take the offer, check `config.openingBalances` and the
Bilanz; then book the opening by hand on a fresh VM.

**Status.** fails (quarter-close-14)

## Bank statements

### OW-06 Import the quarter's statement

**Goal.** «Ich habe den Kontoauszug aus dem E-Banking.»

**Happy path.** She drops the camt.053: «02.07.2026 – 30.09.2026 · 23 Bewegungen · eingelesen»;
the period switches to Q3; the payments are booked.

**What goes wrong.**

**F1. She drops the CSV the bank offers first.** `passes (mistakes-1)`
- Noticed: «Kontoauszug als CSV: die App braucht ihn als camt.053 (XML) …».
- By hand: download the camt.053.
- By wish: «wo finde ich das camt?» answers per bank.
- Learns: nothing.

**F2. The same statement twice.** `passes (mistakes-4); fails (mistakes-5, low)`
- Noticed: «nicht übernommen: schon da», books unchanged; but «trotzdem übernehmen» is offered
  for a statement that is refused anyway.
- By hand: nothing to do.
- By wish: none.
- Learns: no «trotzdem» on a statement.

**F3. The statement of another account (Thomas's private one).** `fails (regression-17, partly)`
- Noticed: plain German and «Bankkonto hinzufügen» with the IBAN prefilled.
- By hand: decide; add the account or leave the file out.
- By wish: «das ist das Privatkonto von Thomas» should keep it out for good.
- Learns: a known private IBAN is refused with «Privatkonto, gehört nicht in die Bücher». Missing
  today: the question «Gehört es der Firma?»; Bank and Konto stay empty, folder jargon.

**F4. A statement of a year the books do not have yet.** `untested`
- Noticed: should say «2025 ist nicht in diesen Büchern».
- By hand: none needed.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: read, deduplicate, assign the account by IBAN. Person: whether an
unknown account belongs to the firm.

**Test.** `huber-setup`: CSV, camt, camt again, a camt copy with another IBAN (`dropLocal`).

**Status.** fails (mistakes-5, regression-17)

### OW-07 Check the balance month by month

**Goal.** «Stimmt die Bank mit dem Auszug überein?»

**Happy path.** Kontoauszüge shows each month of each account with «Saldo stimmt», or the
difference and the payments around it.

**What goes wrong.**

**F1. A quarterly camt leaves every month «fehlt».** `fails (quarter-close-2, quarter-close-3, regression-9, regression-21), retest (0170d83)`
- Noticed: «0 Auszüge · 3 fehlen» although Automatisierung says «Saldo stimmt».
- By hand: none worked.
- By wish: none.
- Learns: a camt.053 counts as the statement of its days, its OPBD and CLBD as balances.

**F2. A month is missing.** `untested`
- Noticed: «Dieser Auszug fehlt», with what to download.
- By hand: drop it.
- By wish: «welcher Auszug fehlt?».
- Learns: nothing.

**F3. The balance differs by a small amount.** `untested`
- Noticed: the month shows the difference and the candidate payments (a fee not in the camt, a
  payment booked twice).
- By hand: find and fix the payment.
- By wish: «warum stimmt der September nicht?» names the payment.
- Learns: nothing; the check runs on every import.

**Automation target.** Code: the whole check. Person: nothing, unless a payment is truly missing.

**Test.** `huber-q3` for F1; a camt with one payment removed (made up in `persona-files.mjs`)
for F3.

**Status.** fails (quarter-close-2, regression-21)

### OW-08 Overlapping and intraday statements

**Goal.** «Ich habe den September schon einmal heruntergeladen, jetzt nochmals bis Ende Monat.»

**Happy path.** A camt.052 (intraday) and the later camt.053 over the same days, or two camt.053
whose days overlap: each payment is in the books once.

**What goes wrong.**

**F1. The same payment in two files.** `untested`
- Noticed: the second file says «12 neu, 8 schon da».
- By hand: nothing to do.
- By wish: none.
- Learns: nothing.

**F2. An intraday payment is reversed by the bank before the end of day.** `untested`
- Noticed: the camt.053 lacks a payment the camt.052 had; the app should drop it (or ask).
- By hand: delete the payment and its booking.
- By wish: «die Zahlung gibt es nicht mehr».
- Learns: the end-of-day statement wins over the intraday one.

**Automation target.** Code: deduplicate by bank reference. Person: nothing.

**Test.** Sandbox or `huber-q3`; two made-up camt files over the same days.

**Status.** untested

### OW-09 A bank that gives only PDF statements

**Goal.** «Bei der Kantonalbank habe ich nur ein PDF.»

**Happy path.** The PDF statement of a known layout is read by code; the balance is checked;
the payments come in.

**What goes wrong.**

**F1. An unknown PDF layout.** `untested`
- Noticed: «Auszug ohne Bewegungen gelesen» or the AI reads it (marked with the bot icon).
- By hand: ask the bank for camt.053.
- By wish: «lies die Zahlungen aus dem PDF».
- Learns: a layout once read is read by code next month.

**F2. The PDF has the balance, the camt has the payments.** `untested`
- Noticed: the hint «camt.053 bringt die Zahlungen, das PDF den Saldo».
- By hand: drop both.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: known layouts. AI: an unknown layout, once. Person: nothing.

**Test.** Sandbox with a made-up PDF statement.

**Status.** untested

## Receipts in

### OW-10 Drop a batch of receipts

**Goal.** «Hier sind alle Rechnungen vom Quartal.»

**Happy path.** She drops PDFs and photos anywhere; «Dateien hinzufügen» lists each with its
kind and facts; receipts are read, matched and booked; duplicates and wrong files are named.

**What goes wrong.**

**F1. Files hang at «liest 1 …».** `fails (usability#18), not reproduced since`
- Noticed: the row never ends.
- By hand: restart the app; the file goes through.
- By wish: none.
- Learns: every file ends in a visible state (intake.md).

**F2. A Word file.** `passes (mistakes-8)`
- Noticed: «Word-, Excel- oder Pages-Datei: bitte als PDF sichern …».
- By hand: export as PDF.
- By wish: none.
- Learns: nothing.

**F3. A byte-for-byte duplicate.** `passes (usability#27, mistakes-8)`
- Noticed: «nicht übernommen: schon da», with «trotzdem übernehmen».
- By hand: nothing.
- By wish: none.
- Learns: nothing.

**F4. A receipt waits with no reason on its row.** `passes (usability#24, fixed 2ff0fdd)`
- Noticed: the row says what it lacks.
- By hand: open it.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: kind, duplicate, text facts. AI: photos, vendor, account.
Person: nothing for a clean receipt.

**Test.** `huber-setup`: drop the statement, then all persona PDFs and photos in one go.

**Status.** fails (usability#18)

### OW-11 The same receipt in another form

**Goal.** «Ich habe das Mail-PDF, das Foto und nochmals das PDF vom Portal hochgeladen.»

**Happy path.** The photo of an invoice already in the books, and a PDF with other bytes but
the same supplier, number, date and amount, are caught as the same receipt; no input tax twice.

**What goes wrong.**

**F1. A photo of an invoice already in the books.** `fails (treuhaender-4, without AI); untested with AI`
- Noticed: with the AI, «Duplikat von FM-77812?» should show; without it, one more open receipt.
- By hand: delete the photo, or mark it as a duplicate.
- By wish: «das ist das gleiche wie die Farbmix-Rechnung».
- Learns: supplier, number and amount make a duplicate key.

**F2. The duplicate is linked to a second payment.** `untested`
- Noticed: the check «zwei Belege mit derselben Rechnungsnummer» in Braucht dich.
- By hand: unlink, delete.
- By wish: «die Rechnung ist doppelt».
- Learns: same number, same supplier: never two input taxes.

**Automation target.** Code: same bytes, same number and supplier. AI: a photo of a known
invoice. Person: confirm a near duplicate.

**Test.** `huber-q3`: `IMG_4801.jpg`, `Farbmix_Rechnung_FM-77812 (1).pdf` (scenario
duplicates-noise); check that the input tax of FM-77812 is claimed once.

**Status.** fails (treuhaender-4)

### OW-12 Files that are no receipt

**Goal.** «Das kam alles mit der Post von Farbmix.»

**Happy path.** An order confirmation is kept apart from its invoice (no second receipt, no
second input tax); a newsletter and the terms are kept out of Belege and the books; a file
refused by mistake can be taken back in.

**What goes wrong.**

**F1. The order confirmation becomes a second receipt.** `untested`
- Noticed: two receipts for one purchase.
- By hand: delete it, or mark it «Beilage zu …».
- By wish: «das ist nur die Auftragsbestätigung».
- Learns: «Auftragsbestätigung» is a supporting document.

**F2. A holiday photo is kept in the receipts folder.** `fails (mistakes-9, low)`
- Noticed: hidden as «1 Datei ist kein Beleg».
- By hand: none.
- By wish: «lösch das Ferienfoto».
- Learns: a photo without amounts goes to quarantine, not to the receipts.

**F3. A real invoice is refused as a newsletter.** `untested`
- Noticed: «Nicht übernommen» tab.
- By hand: «doch übernehmen».
- By wish: «das ist doch eine Rechnung».
- Learns: the sender's invoices are never quarantined again.

**Automation target.** Code: hints (page count, words). AI: the rest. Person: «doch übernehmen».

**Test.** `huber-q3`: the Farbmix order confirmation, newsletter and terms.

**Status.** fails (mistakes-9)

### OW-13 Undo a drop

**Goal.** «Das wollte ich nicht hochladen.»

**Happy path.** «Rückgängig» on the row takes the receipt out; the payment is booked as before
the drop; dropping the file again brings it back.

**What goes wrong.**

**F1. The payment lost its booking after the undo.** `passes (regression-11)`
- Noticed: the payment stays booked without the receipt.
- By hand: nothing.
- By wish: none.
- Learns: nothing.

**F2. The undone file is refused as «schon da».** `passes (regression-12)`
- Noticed: it is read and booked again.
- By hand: nothing.
- By wish: none.
- Learns: nothing.

**F3. The list still shows the receipt after the undo.** `passes (mistakes-13, fixed 7f31313)`
- Noticed: the list updates.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: all of it.

**Test.** `huber-q3`: drop `Geruest_August.pdf`, «Rückgängig», drop again.

**Status.** passes (regression-11, regression-12)

### OW-14 Delete a receipt and get it back

**Goal.** «Den habe ich aus Versehen gelöscht.»

**Happy path.** «Löschen» asks first, books the payment again without the receipt (no input
tax), keeps the file in the trash for 30 days; «Rückgängig» in the toast restores receipt,
links and booking with its VAT.

**What goes wrong.**

**F1. The receipt comes back, its input tax does not.** `fails (regression-14)`
- Noticed: nothing on the screen; the booking stays I0 without receipt.
- By hand: Buchungen › bearbeiten › MWST.
- By wish: «die Vorsteuer ist weg».
- Learns: restore books the payment with the receipt again, at once.

**F2. A second delete of the same file cannot be undone.** `fails (regression-15)`
- Noticed: «Diesen Beleg gibt es nicht».
- By hand: drop the original again, if she still has it.
- By wish: none.
- Learns: the trash keeps every delete, by id.

**F3. The toast with «Rückgängig» is gone too soon.** `fails (regression-16), not reproduced reliably`
- Noticed: the toast reads «Eingang verarbeitet».
- By hand: Änderungen should offer «Wiederherstellen».
- By wish: «hol den gelöschten Beleg zurück».
- Learns: a deleted receipt can be restored from Änderungen for 30 days.

**Automation target.** Code: all of it. Person: the click.

**Test.** `huber-q3`: delete the Swisscom receipt, undo at once and after 20 s; delete the
Gerüst receipt twice.

**Status.** fails (regression-14, regression-15)

### OW-15 A receipt arrives after its quarter was filed

**Goal.** «Die Rechnung vom August kam erst jetzt, und das Quartal ist schon abgerechnet.»

**Happy path.** The receipt is read and linked to its August payment. The August booking stays
as filed; a correction entry in the open quarter claims the input tax, names the quarter it
corrects, and lands on the Korrekturabrechnung, or (as the firm prefers) in the open quarter's
return where the law allows.

**What goes wrong.**

**F1. The app changes the filed booking.** `untested`
- Noticed: the seal check opens the books read-only.
- By hand: impossible, as it must be.
- By wish: «buch die Vorsteuer nach» books the correction in the open quarter.
- Learns: nothing; the period lock holds.

**F2. The receipt is linked but nothing books its input tax.** `untested`
- Noticed: Braucht dich should list «Beleg zu einer abgerechneten Zahlung: Vorsteuer nachholen?».
- By hand: «Korrektur in Q4 erfassen →».
- By wish: «hol die Vorsteuer im vierten Quartal nach».
- Learns: nothing.

**Automation target.** Code: the lock, the correction entry. Person: correct now or with 0535.

**Test.** `huber-q3`, seal Q3 (`seal -- 2026-Q3 --close` in the VM's workspace), then drop
`Geruest_August.pdf` after deleting it before the seal.

**Status.** untested

### OW-16 A photo without a legible date

**Goal.** «Das Foto ist verknittert, aber der Betrag stimmt.»

**Happy path.** The AI reads amount and VAT; the date is missing, so the receipt says «Datum
unsicher» and takes the date of the payment it matches.

**What goes wrong.**

**F1. The receipt gets today's date and lands in the wrong quarter.** `fails (misreads-3)`
- Noticed: it shows in Q4, the other receipts in Q3; no «Datum unsicher» mark.
- By hand: Angaben › Datum; then «Passt zur Zahlung … Zuordnen» (misreads-7 passes).
- By wish: «das Datum ist der 5. Oktober».
- Learns: a missing date is a missing fact, never today.

**F2. The blur misreads the amount.** `passes (misreads-2, reading right)`
- Noticed: no payment of that amount; the receipt waits.
- By hand: Angaben › Betrag.
- By wish: «der Betrag ist …».
- Learns: nothing.

**Automation target.** AI: the photo. Code: take the payment's date when amount matches.
Person: confirm when two payments fit.

**Test.** `huber-q3`, drop `IMG_4733.jpg` after the October statement.

**Status.** fails (misreads-3)

### OW-17 The receipt's VAT read wrong

**Goal.** «Da steht doch MWST drauf» / «Da ist gar keine Schweizer MWST drauf.»

**Happy path.** She sets the VAT in «Angaben bearbeiten» (Swiss VAT yes or no, rate, amount,
VAT number); it is marked «von Hand» and the booking follows.

**What goes wrong.**

**F1. No way to set the VAT by hand.** `fails (misreads-16), retest (862c10f)`
- Noticed: «Angaben bearbeiten» had no VAT fields.
- By hand: since the fix, the VAT fields in Angaben.
- By wish: works.
- Learns: facts set by hand are never read over (vatBy human).

**F2. She claims German VAT as input tax.** `passes (misreads-17)`
- Noticed: the AI pushes back and explains.
- By hand: should the VAT fields allow it? Only a domestic rate.
- By wish: refused with the reason.
- Learns: nothing.

**F3. She claims VAT on an insurance premium.** `passes (misreads-18)`
- Noticed: the AI quotes that premiums are exempt.
- By hand: same as F2.
- By wish: refused.
- Learns: nothing.

**F4. Without the AI, a hand-corrected VAT waits for the next run.** `untested (overnight decision 4)`
- Noticed: the booking keeps the old code until the AI books again.
- By hand: also change the booking's VAT code.
- By wish: none (no AI).
- Learns: code adjusts the booking from the receipt's facts, with no model.

**Automation target.** Code: the booking follows the facts. AI: reading. Person: the paper wins.

**Test.** `huber-q3`: Mobiliar policy and Malerbedarf with the AI; the same in the sandbox
without a model for F4.

**Status.** fails (misreads-16)

### OW-18 The receipt's amount or date wrong

**Goal.** «Der Betrag ist falsch eingelesen.»

**Happy path.** Angaben › Betrag or Datum, Tab or Enter saves («Gespeichert · Betrag»); the link
and the booking follow; the VAT figure follows the amount or is flagged.

**What goes wrong.**

**F1. Tab did not save.** `passes (regression-18, fixed 849d012)`
- Noticed: «Gespeichert · Datum».
- By hand: works.
- By wish: none.
- Learns: nothing.

**F2. «28.6.26» and «1'243,55».** `passes (regression-19, mistakes-27)`
- Noticed: understood.
- By hand: works.
- By wish: none.
- Learns: nothing.

**F3. The amount changes, the VAT stays the old amount's.** `fails (misreads-23)`
- Noticed: nothing; the header shows a VAT that does not fit the amount.
- By hand: set the VAT too (VAT fields, retest).
- By wish: «der Betrag ist der bezahlte, mit Skonto».
- Learns: «Betrag und MWST passen nicht zusammen» shown at once.

**F4. She types the paid amount where the invoice amount belongs.** `fails (misreads-23)`
- Noticed: should ask: «Rechnungsbetrag oder bezahlter Betrag?»
- By hand: restore.
- By wish: none.
- Learns: a receipt states what it states; a difference to the payment is a Skonto or a
  partial payment (OW-26).

**Automation target.** Code: parsing, checks. Person: the figure on the paper.

**Test.** `huber-q3`: Farbmix FM-79010, type the paid amount.

**Status.** fails (misreads-23)

### OW-19 A foreign supplier in EUR with German VAT

**Goal.** «Die Farbe aus Konstanz, bezahlt in Franken.»

**Happy path.** Read as EUR with 19 % German VAT, «keine CH-MWST»; matched to the CHF payment;
booked M0 at the payment's CHF amount.

**What goes wrong.**

**F1. Not matched to its payment.** `fails (misreads-4)`
- Noticed: «gelesen, noch keine Zahlung».
- By hand: «Zahlung verknüpfen», top suggestion (misreads-6 passes).
- By wish: «das ist die Zahlung vom 2. Oktober».
- Learns: see OW-22.

**F2. The app claims German VAT as input tax.** `passes (misreads-2, misreads-17)`
- Noticed: «keine CH-MWST».
- By hand: VAT fields.
- By wish: refused with the reason.
- Learns: nothing.

**F3. Goods bought abroad and carried over the border.** `untested`
- Noticed: should ask for the customs receipt (import VAT on the customs bill is input tax).
- By hand: drop the customs receipt, link it to the same purchase.
- By wish: «ich habe die Ware beim Zoll verzollt».
- Learns: this supplier's goods come with a customs receipt.

**Automation target.** Code: currency, rate of the payment day. AI: whose VAT. Person: whether
the goods crossed the border declared.

**Test.** `huber-q3` + October camt: `Malerbedarf_Konstanz_RE-4471.pdf`.

**Status.** fails (misreads-4)

### OW-20 A receipt with two VAT rates

**Goal.** «Im Baumarkt habe ich Farbe und Kaffee für die Baustelle gekauft.»

**Happy path.** Both rates read (8.1 % and 2.6 %), the booking split by rate, each with its code.

**What goes wrong.**

**F1. One rate for the whole receipt.** `untested`
- Noticed: the VAT on the receipt does not add up to its lines.
- By hand: VAT fields allow more than one rate.
- By wish: «da sind zwei Sätze drauf».
- Learns: nothing.

**F2. The food part was private.** `untested`
- Noticed: she says so.
- By hand: split the booking, the private part to 2451 without a code.
- By wish: «der Kaffee war privat».
- Learns: nothing.

**Automation target.** Code: lines per rate. AI: reading. Person: private or not.

**Test.** A made-up till photo with two rates, added to `persona-files.mjs`.

**Status.** untested

### OW-21 One receipt, part asset and part expense

**Goal.** «Die Leiter ist eine Anschaffung, der Rest ist Material.»

**Happy path.** The booking splits into the asset account (1510) and material (4400), each with
its input-tax code.

**What goes wrong.**

**F1. The whole receipt on material.** `passes (mistakes-18: split right)`
- Noticed: the asset list misses the ladder.
- By hand: split by hand in Buchungen.
- By wish: «die Leiter ist eine Anschaffung».
- Learns: items above the firm's threshold are assets.

**F2. A small tool booked as asset.** `untested`
- Noticed: the depreciation list at year-end.
- By hand: move to expense.
- By wish: «das ist zu klein für eine Anschaffung».
- Learns: the threshold, as a rule she keeps.

**Automation target.** AI: which line is an asset. Code: the threshold. Person: the threshold.

**Test.** `huber-setup`: drop `IMG_4502.jpg`.

**Status.** partly (mistakes-18)

## Matching and booking

### OW-22 Receipts matched to their payments by themselves

**Goal.** «Die Rechnung gehört doch zu der Zahlung, da steht sogar die Nummer.»

**Happy path.** A receipt with the same amount, or its number in the payment text, is linked by
code; the rest by the AI from candidates of the right days.

**What goes wrong.**

**F1. None of four receipts matched.** `fails (misreads-4, high)`
- Noticed: «gelesen, noch keine Zahlung» on every row.
- By hand: «Zahlung verknüpfen», «PASST AM BESTEN» lists the right one first (misreads-6 passes).
- By wish: «ordne die Belege den Zahlungen zu».
- Learns: a receipt without a date gets candidates from its amount and number, not the first
  20 transactions of the books.

**F2. The run says ok when nothing was linked.** `fails (misreads-5)`
- Noticed: «3 Belege gelesen · ok».
- By hand: open the run's rows.
- By wish: «was ist noch offen?».
- Learns: «3 Belege ohne Zahlung · prüfen».

**F3. Two payments of the same amount.** `untested`
- Noticed: the AI should ask, not pick.
- By hand: link the right one.
- By wish: «die vom 14. August».
- Learns: nothing.

**Automation target.** Code: amount plus number or date window. AI: the rest. Person: a tie.

**Test.** `huber-q3`: October camt, then the four October files (scenario misreads).

**Status.** fails (misreads-4, misreads-5)

### OW-23 Link by hand, and unlink

**Goal.** «Der Beleg gehört zu einer anderen Zahlung.»

**Happy path.** «Lösen», then «Zahlung verknüpfen» or the suggestion «Zuordnen»; the booking
follows the new link.

**What goes wrong.**

**F1. Linked to a payment of another amount without a word.** `fails (misreads-22)`
- Noticed: should warn «Betrag weicht ab» before linking.
- By hand: Lösen, Zuordnen.
- By wish: «das gehört zur Zahlung vom 6. August» pushes back when wrong (sidebar-wishes-11 passes).
- Learns: nothing.

**F2. After «Lösen» the booking keeps the input tax.** `fails (misreads-21)`
- Noticed: nothing; I81 without a receipt.
- By hand: change the code.
- By wish: none.
- Learns: unlinking books the payment again without the receipt, like deleting does.

**Automation target.** Code: the booking follows the link. Person: which payment.

**Test.** `huber-q3`: link `IMG_4733.jpg` to the wrong Baucenter payment.

**Status.** fails (misreads-21, misreads-22)

### OW-24 One payment for several receipts

**Goal.** «Ich habe zwei Farbmix-Rechnungen mit einer Zahlung bezahlt.»

**Happy path.** Both receipts link to the one payment; the booking splits per receipt, each with
its VAT; the sum is the payment.

**What goes wrong.**

**F1. Only one receipt is linked; the other waits forever.** `untested`
- Noticed: a receipt «noch keine Zahlung» whose amount is in no single payment.
- By hand: link the second to the same payment.
- By wish: «die beiden sind zusammen bezahlt».
- Learns: this supplier pays in batches (knowledge).

**F2. The two receipts and the payment differ (a credit note in between).** `untested`
- Noticed: «Belege ergeben … , bezahlt …».
- By hand: add the credit note (OW-27).
- By wish: «da war noch eine Gutschrift abgezogen».
- Learns: nothing.

**Automation target.** Code: sums of open receipts of one supplier. AI: when sums do not fit.

**Test.** A made-up camt line paying FM-77812 and FM-78230 together.

**Status.** untested

### OW-25 Paying a supplier in instalments

**Goal.** «Das Gerüst zahlen wir in zwei Raten.»

**Happy path.** One receipt, two payments; each payment books its share with the input tax of
that share (cash basis), the receipt shows «teilweise bezahlt».

**What goes wrong.**

**F1. The first payment claims all the input tax.** `untested`
- Noticed: the VAT of the first payment is the whole receipt's.
- By hand: change the booking's amount split.
- By wish: «das ist nur die erste Rate».
- Learns: VAT per payment, by its share.

**F2. The second payment finds no receipt.** `untested`
- Noticed: «ohne Beleg».
- By hand: link the same receipt.
- By wish: «das ist die zweite Rate vom Gerüst».
- Learns: nothing.

**Automation target.** Code: shares. Person: nothing.

**Test.** A made-up camt with two payments for `Geruest_August.pdf`.

**Status.** untested

### OW-26 Skonto

**Goal.** «Wir haben 2 % weniger bezahlt, Skonto.»

**Happy path.** Paid less than the invoice: on cash basis the input tax follows the paid amount;
one payment, one balanced booking.

**What goes wrong.**

**F1. Not matched because the amounts differ.** `fails (misreads-4)`
- Noticed: waits.
- By hand: link; the suggestion should say «2 % weniger: Skonto?».
- By wish: «das ist mit Skonto bezahlt».
- Learns: this supplier gives Skonto.

**F2. «Neu klassifizieren» books a one-leg Skonto entry.** `fails (misreads-10, misreads-14, high)`
- Noticed: Bilanz «Differenz … 1 Buchung mit MWST-Code, aber ohne Gegenkonto».
- By hand: set the empty account.
- By wish: «in der Bilanz steht jetzt eine Differenz … bitte richtig eintragen» (misreads-15 passes).
- Learns: a payment's bookings add up to the payment, also from classify.

**F3. Booked M0 when linked late.** `fails (misreads-8)`
- Noticed: input tax lost; see OW-29.
- By hand: M81 (misreads-9 passes).
- By wish: works.
- Learns: see OW-29.

**Automation target.** Code: paid less, same supplier, within the Skonto days: Skonto. Person:
nothing.

**Test.** `huber-q3`: `Farbmix_Rechnung_FM-79010.pdf` with the October camt.

**Status.** fails (misreads-4, misreads-8, misreads-14)

### OW-27 A supplier's credit note and a refund

**Goal.** «Farbmix hat uns eine Gutschrift geschickt, und das Geld zurücküberwiesen.»

**Happy path.** The credit note is read as a credit (negative), linked to the refund on the
bank; booked with the minus code (-M81), so the input tax is reduced in the quarter of the
refund. A credit note offset against the next invoice books on the next payment.

**What goes wrong.**

**F1. The credit note is read as an invoice.** `untested`
- Noticed: an input tax where there should be a reduction.
- By hand: Angaben › Betrag negative, or a «Gutschrift» kind.
- By wish: «das ist eine Gutschrift».
- Learns: «Gutschrift», «Rückvergütung» mean minus.

**F2. The refund on the bank is booked as a sale.** `untested`
- Noticed: Ziffer 200 grows.
- By hand: account 4400, code -M81.
- By wish: «das ist die Rückzahlung von Farbmix».
- Learns: incoming money from a supplier is a refund.

**F3. The credit note is offset on the next payment, no refund.** `untested`
- Noticed: the next payment is less than its invoice.
- By hand: link both receipts to the payment.
- By wish: «die Gutschrift ist mit der nächsten Rechnung verrechnet».
- Learns: nothing.

**Automation target.** Code: the sign and the code. AI: reading. Person: nothing.

**Test.** A made-up Farbmix credit note and a camt with a refund.

**Status.** untested

### OW-28 Paid privately, no bank payment

**Goal.** «Das habe ich mit meiner eigenen Karte bezahlt.»

**Happy path.** A receipt without a firm payment books against the owner's Kontokorrent (2451):
the expense with its input tax, the debt to her on 2451.

**What goes wrong.**

**F1. It waits forever for a bank payment.** `untested`
- Noticed: «noch keine Zahlung» long after the statement.
- By hand: Notiz «privat bezahlt» or a button «privat bezahlt».
- By wish: «das habe ich privat bezahlt».
- Learns: her card's receipts are private payments.

**F2. Booked as a private expense (no input tax).** `untested`
- Noticed: input tax lost.
- By hand: the paid-by is the owner, the purchase is the firm's.
- By wish: «privat bezahlt, aber für die Firma».
- Learns: «privat bezahlt» is not «privat».

**Automation target.** AI: «privat bezahlt» from the note. Person: whether the purchase was the
firm's.

**Test.** `huber-q3`: a made-up receipt with no matching payment, note «privat bezahlt».

**Status.** untested

### OW-29 The booking follows a receipt linked later

**Goal.** «Jetzt ist der Beleg doch da, also gibt es die Vorsteuer.»

**Happy path.** A payment booked before its receipt (M0, «ohne Beleg») is booked again when the
receipt is linked, by hand or by a run: the receipt's VAT, the receipt in the entry.

**What goes wrong.**

**F1. Linked by hand, the booking stays M0.** `fails (misreads-8, high)`
- Noticed: nothing warns; the booking page shows the receipt next to «M0».
- By hand: bearbeiten › MWST.
- By wish: «die Vorsteuer fehlt».
- Learns: linking rebooks the classifier's entry; a hand entry gets «Beleg zeigt 8.1 % MWST,
  Buchung M0: anpassen?».

**F2. Without the AI, nothing books again.** `untested (overnight decision 4)`
- Noticed: same.
- By hand: same.
- By wish: none.
- Learns: code sets the code from the receipt's facts.

**Automation target.** Code: rebook on link. Person: nothing.

**Test.** `huber-q3`: link FM-79010 and `IMG_4733.jpg` by hand, check the entries.

**Status.** fails (misreads-8)

### OW-30 A hand correction survives the next run

**Goal.** «Ich habe das korrigiert. Das muss so bleiben.»

**Happy path.** A booking she changed (origin manual) is never rebooked by «Neu klassifizieren»
or a run without asking; the run says «von Hand geändert, übersprungen».

**What goes wrong.**

**F1. «Neu klassifizieren» replaces her M81.** `fails (misreads-10, high)`
- Noticed: nothing; her entry is gone.
- By hand: redo.
- By wish: redo.
- Learns: «Diese Buchung hast du von Hand geändert. Trotzdem neu?».

**F2. «Neu klassifizieren» puts V0 back after V0-E.** `fails (misreads-11, misreads-19)`
- Noticed: nothing.
- By hand: redo.
- By wish: redo; and the next reclassify undoes it again.
- Learns: the correction becomes a rule for the customer (sales to Konstanz: V0-E).

**F3. A replayed run keeps her fix.** `passes (misreads-20)`
- Noticed: nothing changed.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: never overwrite manual. AI: turn the correction into a rule.
Person: keep the rule.

**Test.** `huber-q3`: correct FM-79010 and Rechnung 2026-031, then «Neu klassifizieren» each.

**Status.** fails (misreads-10, misreads-11, misreads-19)

### OW-31 Correct a booking's account or VAT code

**Goal.** «Das ist Material, nicht übriger Aufwand.»

**Happy path.** Buchungen › bearbeiten: Soll, Haben, MWST by number, name or rate; saved on Tab;
or by a wish.

**What goes wrong.**

**F1. She types the rate.** `fails (quarter-close-8), retest (0170d83)`
- Noticed: «MWST-Code 8.1 gibt es nicht».
- By hand: since the fix, a typed rate finds its code.
- By wish: works.
- Learns: nothing.

**F2. She types a word of the label («Ausland»).** `fails (misreads-13)`
- Noticed: «MWST-Code Ausland gibt es nicht».
- By hand: open the ▾ list.
- By wish: «die Ziffer für Arbeit im Ausland».
- Learns: label words find the code.

**F3. The account changes, the code stays the wrong kind.** `fails (misreads-25, low)`
- Noticed: I81 on a material account where M81 belongs.
- By hand: change the code too.
- By wish: should change both.
- Learns: account and code move together.

**Automation target.** Code: code from the account kind. Person: the account.

**Test.** `huber-q3`: Baucenter photo to 4400; Konstanz sale to V0-E by typing.

**Status.** fails (misreads-13, misreads-25)

### OW-32 Why is this booked so

**Goal.** «Warum hat diese Buchung keine MWST?»

**Happy path.** Every booking says why: which receipt, which rule, which run, or «von Hand am …
von Sandra». Änderungen lists runs, hand edits and wishes.

**What goes wrong.**

**F1. «Warum so gebucht?» shows the run and raw AI text, no reason in words.** `fails (misreads-24)`
- Noticed: she reads JSON.
- By hand: none.
- By wish: «warum hat diese Buchung keine MWST?» answers well (sidebar-wishes-13 passes).
- Learns: one sentence per booking: «gebucht ohne Beleg, darum M0».

**F2. After «Neu klassifizieren», no trace at all.** `fails (misreads-24)`
- Noticed: no run, no link.
- By hand: none.
- By wish: the AI cannot know either.
- Learns: a history per booking.

**Automation target.** Code: the reason recorded with the booking. Person: reads.

**Test.** `huber-q3`: «Warum so gebucht?» on a run booking, a hand booking, a reclassified one.

**Status.** fails (misreads-24)

### OW-33 A private share

**Goal.** «Das Natel ist zur Hälfte privat.» / «Das Mittagessen war privat.»

**Happy path.** The business part keeps its code; the private part goes to 2451 without a VAT
code (or K81-B at year-end for a share of a cost already claimed); the bookings add up to the
payment; one «Rückgängig» takes back both.

**What goes wrong.**

**F1. Half changed, the other half missing.** `passes (regression-3, fixed d87d8f5)`
- Noticed: two cards that add up.
- By hand: split in Buchungen.
- By wish: works.
- Learns: nothing.

**F2. The lunch was private.** `passes (sidebar-wishes-5, sidebar-wishes-6)`
- Noticed: one card.
- By hand: account 2451, no code.
- By wish: works; undo works.
- Learns: nothing.

**F3. Two shapes for «privat».** `fails (sidebar-wishes-19, low)`
- Noticed: once no code, once I0.
- By hand: remove the code.
- By wish: none.
- Learns: one shape.

**F4. Every Natel bill is half private.** `untested`
- Noticed: the AI offers a rule (sidebar-wishes-10 hints at it).
- By hand: a rule in Firma.
- By wish: «das Natel ist immer zur Hälfte privat».
- Learns: the rule; the next bill is split by itself.

**Automation target.** Code: the split. AI: offer the rule. Person: the share.

**Test.** `huber-q3`: Swisscom July, Restaurant Hirschen; then drop the August bill after keeping
the rule.

**Status.** fails (sidebar-wishes-19)

### OW-34 A payment without a receipt

**Goal.** «Für die Bankgebühren gibt es keinen Beleg.»

**Happy path.** Fees, interest, a cash withdrawal, a tax payment: «braucht keinen» marks it;
booked without input tax; the cash withdrawal goes to the cash account or 2451.

**What goes wrong.**

**F1. A cash withdrawal booked as an expense.** `untested`
- Noticed: an expense without a receipt.
- By hand: account 1000 or 2451.
- By wish: «das Bargeld habe ich für die Kasse geholt».
- Learns: withdrawals are transfers.

**F2. A payment marked «braucht keinen» that needs one.** `untested`
- Noticed: the Treuhänder asks.
- By hand: «zurücksetzen».
- By wish: none.
- Learns: nothing.

**Automation target.** Code: fees and interest by bank code. Person: cash use.

**Test.** `huber-q3`: the persona statement's fees and a made-up withdrawal.

**Status.** untested

### OW-35 Wages and social insurance payments

**Goal.** «Die Löhne von Marco und mir, und die SVA.»

**Happy path.** Salary payments book to 5000 against the bank (no VAT); social insurance
advances to 5700 or 2270; the app says plainly it does not compute payroll.

**What goes wrong.**

**F1. Salary booked with a VAT code.** `untested`
- Noticed: an expense line in the return.
- By hand: remove the code.
- By wish: «Lohn hat keine MWST».
- Learns: wages never carry VAT.

**F2. She asks the app to do the payslip.** `untested (scenario wishes)`
- Noticed: an honest «kann ich nicht», and what it can do.
- By hand: none.
- By wish: refused.
- Learns: nothing.

**F3. Names replaced by «Mitarbeiter».** `fails (quarter-close-10), retest (0170d83)`
- Noticed: she cannot tell Marco's from hers.
- By hand: edit the text.
- By wish: none.
- Learns: the bank's counterparty is kept.

**Automation target.** Code: wage accounts. Person: nothing.

**Test.** `huber-q3`: the salary payments of the persona statement.

**Status.** fails (quarter-close-10)

### OW-36 A customer payment without an uploaded invoice

**Goal.** «Familie Keller hat bezahlt, die Rechnung habe ich in Word geschrieben.»

**Happy path.** A VAT-registered firm's customer payment without an invoice is flagged
«Rechnung fehlt» and booked at the standard rate with a note, or waits; MWST names it; the
payment offers «Rechnung hochladen» and «keine MWST darauf».

**What goes wrong.**

**F1. Booked at 0 % as an export.** `fails (quarter-close-6, sidebar-wishes-14, high)`
- Noticed: since 598c1ef, MWST and the payment name it (regression-8 passes).
- By hand: bearbeiten › MWST V81 (quarter-close-9 passes after).
- By wish: «das ist eine Arbeit hier in Wil, mit MWST».
- Learns: a domestic customer's payments are V81 by default (overnight decision 2, waits).

**F2. «Neu klassifizieren» books V0 again.** `fails (quarter-close-7)`
- Noticed: the same V0.
- By hand: redo.
- By wish: redo.
- Learns: see OW-30.

**F3. She uploads the invoice PDF later.** `untested`
- Noticed: the payment is booked again with its VAT.
- By hand: drop the PDF.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: domestic sale default. Person: an exempt sale.

**Test.** `huber-q3`: RB-2026-0001 and RB-2026-0018 (Keller and Meier).

**Status.** fails (quarter-close-6, quarter-close-7)

### OW-37 A job abroad

**Goal.** «Die Arbeit für Bauer war in Konstanz, in Deutschland.»

**Happy path.** Her invoice says «Leistungsort Deutschland»; booked V0-E (Ziffer 221, Leistungen
im Ausland), not V0 (Ziffer 220, Exporte).

**What goes wrong.**

**F1. Booked V0, Ziffer 220.** `fails (misreads-12, misreads-26)`
- Noticed: MWST shows it under Exporte.
- By hand: V0-E, if she knows the code (OW-31 F2).
- By wish: works (misreads-19), but see OW-30.
- Learns: Leistungsort abroad on the invoice means V0-E.

**F2. A German customer needs a German VAT registration (work on a building).** `untested`
- Noticed: the AI should mention it, not book anything.
- By hand: none in the books.
- By wish: «muss ich in Deutschland etwas machen?».
- Learns: nothing.

**Automation target.** Code: the place of supply from the invoice. Person: nothing.

**Test.** `huber-q3`: `Rechnung_2026-031_Konstanz.pdf` with the October camt.

**Status.** fails (misreads-12, misreads-26)

### OW-38 A change in a filed quarter is refused

**Goal.** «Die Rechnung vom Juni gehört ins zweite Quartal.»

**Happy path.** On cash basis the booking stays on the payment date; a change in a filed
quarter is refused with the reason and the way to correct it in the open quarter.

**What goes wrong.**

**F1. The AI moved the booking to June.** `passes (regression-1, fixed d87d8f5)`
- Noticed: refused in plain words.
- By hand: the date field refuses too.
- By wish: refused.
- Learns: nothing.

**F2. A hand edit of a sealed entry.** `untested`
- Noticed: the field is read-only, with «Korrektur in Q4 erfassen →».
- By hand: the correction.
- By wish: «korrigier das im vierten Quartal».
- Learns: nothing.

**Automation target.** Code: the lock. Person: nothing.

**Test.** `huber-q3` sealed through Q3; try to edit a Q3 booking by hand and by a wish.

**Status.** partly (regression-1)

## Invoices

### OW-39 Set up invoicing

**Goal.** «Ich will unsere Rechnungen mit der App schreiben, mit Einzahlungsschein.»

**Happy path.** A first-run «Rechnungen einrichten» asks the address, the pay-to account (the
CHF account she has is preselected), the payment terms, the logo; the QR-bill follows.

**What goes wrong.**

**F1. No setup step; the hint names a config key.** `fails (invoices-2, invoices-5)`
- Noticed: «ein Konto für diese Währung (invoicing.payTo)».
- By hand: Firma › Rechnungslayout › Rechnungen einrichten.
- By wish: «richte die Rechnungen ein mit unserem Raiffeisen-Konto».
- Learns: the only CHF account is the pay-to account.

**F2. Empty address parts leave commas.** `fails (invoices-4, low)`
- Noticed: «Malerei Huber GmbH · ,».
- By hand: fill the address.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: defaults from setup. Person: the logo, the terms.

**Test.** `huber-q3`: Rechnungen, first invoice.

**Status.** fails (invoices-2, invoices-4, invoices-5)

### OW-40 Write an invoice

**Goal.** «Rechnung an Familie Keller: Stube streichen, Stunden und Material.»

**Happy path.** «+ Rechnung», «Neuer Kunde», positions edited on the sheet, totals live, 8.1 %
MWST, «Ausstellen», «Senden»; the QR-bill on the PDF.

**What goes wrong.**

**F1. The selects save nothing.** `fails (invoices-6, high)`
- Noticed: after a reload the unit and the VAT rate are the old ones.
- By hand: none works.
- By wish: «Material pauschal, nicht in Stunden».
- Learns: nothing; a bug (selects in the sheet's HTML).

**F2. «Ausstellen» does nothing while something is missing.** `fails (invoices-3)`
- Noticed: no message.
- By hand: guess.
- By wish: «warum geht Ausstellen nicht?».
- Learns: nothing.

**F3. Typing into a price appends.** `fails (invoices-7, low)`
- Noticed: «0.85» for 85.
- By hand: select all first.
- By wish: none.
- Learns: nothing.

**F4. The wrong customer.** `untested`
- Noticed: before issuing: change it; after: OW-41.
- By hand: the customer field.
- By wish: «die Rechnung ist für Meier, nicht Keller».
- Learns: nothing.

**Automation target.** Code: totals, VAT, QR. AI: positions from a description. Person: what
was done, at what price.

**Test.** `huber-q3` (scenario invoices).

**Status.** fails (invoices-3, invoices-6, invoices-7)

### OW-41 Fix an issued invoice

**Goal.** «Der Betrag auf der Rechnung war falsch, die ist schon beim Kunden.»

**Happy path.** «Stornieren» keeps the number and the PDF, makes a Storno-Mitteilung; a new
invoice with the right amount. Or «Gutschrift ausstellen» for a part: a credit note referring to
the invoice, with its own number; when the customer pays the reduced amount, both settle.

**What goes wrong.**

**F1. She edits the issued invoice in place.** `untested`
- Noticed: an issued invoice is read-only, with «Stornieren» and «Gutschrift».
- By hand: Storno and a new one.
- By wish: «die Rechnung 2026-029 war zu hoch, mach das richtig».
- Learns: nothing.

**F2. The customer pays the old amount after a Gutschrift.** `untested`
- Noticed: an overpayment on the invoice.
- By hand: refund, or keep as credit.
- By wish: «Keller hat zu viel bezahlt».
- Learns: nothing.

**F3. The payment of a cancelled invoice arrives.** `untested`
- Noticed: «Rückfrage» (invoices.cancelHint promises it).
- By hand: link it to the new invoice.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: numbers, links, VAT reversal (-V81). Person: what is wrong.

**Test.** `huber-q3`: issue an invoice, Storno, Gutschrift; a made-up payment of each amount.

**Status.** untested

### OW-42 The customer pays the invoice

**Goal.** «Hat Keller schon bezahlt?»

**Happy path.** The payment with the QR reference matches the invoice by code; booked V81 to
3400; the invoice shows «bezahlt».

**What goes wrong.**

**F1. Paid without the QR reference (e-banking typed by hand).** `untested`
- Noticed: amount and customer name match; code proposes, she confirms.
- By hand: link the payment.
- By wish: «Keller hat die Rechnung bezahlt».
- Learns: nothing.

**F2. Paid in part.** `untested`
- Noticed: «teilweise bezahlt, offen …».
- By hand: link; a reminder for the rest.
- By wish: none.
- Learns: VAT on what was received.

**F3. The customer deducts Skonto unasked.** `untested`
- Noticed: paid less.
- By hand: accept as Skonto (sales reduction, Ziffer 235) or remind.
- By wish: «das Skonto lassen wir gelten».
- Learns: nothing.

**F4. Paid twice.** `untested`
- Noticed: two payments for one invoice.
- By hand: refund booking.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: QR reference, amount. Person: accept a deduction.

**Test.** `huber-q3`: issue an invoice, then a made-up camt with its payment (full, part, less).

**Status.** untested

### OW-43 A reminder

**Goal.** «Meier hat nach 30 Tagen nicht bezahlt.»

**Happy path.** The invoice is overdue; «1. Mahnung» as a draft with a new due date; «Senden».

**What goes wrong.**

**F1. A reminder for an invoice paid yesterday.** `untested`
- Noticed: the app checks the latest statement first, or warns its last import date.
- By hand: delete the draft.
- By wish: none.
- Learns: nothing.

**F2. A reminder fee.** `untested`
- Noticed: a reminder fee is not a supply, so it carries no VAT; the app books it without a
  VAT code.
- By hand: a line without VAT.
- By wish: «mit 20 Franken Mahngebühr».
- Learns: nothing.

**Automation target.** Code: overdue list. Person: whether to remind.

**Test.** `huber-q3`, an issued invoice with a due date in the past.

**Status.** untested

## The quarter

### OW-44 Check the VAT return

**Goal.** «Stimmt die MWST fürs dritte Quartal?» (She does not know what a Ziffer is.)

**Happy path.** MWST Q3 shows turnover, output tax, input tax and what to pay, each figure with
the bookings behind it, in plain words; warnings for sales without VAT and input tax without a
receipt.

**What goes wrong.**

**F1. Domestic sales under Exporte.** `fails (quarter-close-6)`
- Noticed: a banner names them (regression-8).
- By hand: V81.
- By wish: works.
- Learns: OW-36.

**F2. After the fixes, the figures match.** `passes (quarter-close-9)`
- Noticed: the return matches the persona files.
- By hand: none.
- By wish: none.
- Learns: nothing.

**F3. Input tax claimed without a receipt.** `fails (misreads-21, mistakes-16 earlier)`
- Noticed: should be a warning on the return.
- By hand: remove the code.
- By wish: «welche Vorsteuer hat keinen Beleg?».
- Learns: nothing.

**Automation target.** Code: the whole return. Person: trust it.

**Test.** `huber-q3`: MWST Q3, compute the figures from `persona-files.mjs`.

**Status.** fails (quarter-close-6, misreads-21)

### OW-45 Create and file the return

**Goal.** «Wie kommt das jetzt zur ESTV?»

**Happy path.** «Abrechnung erstellen» shows the figures to check, «Freigegeben» writes the
eCH-0217 XML and says where it is, with a download and the steps on the ESTV portal.

**What goes wrong.**

**F1. Raw JSON and no file location.** `fails (quarter-close-19), retest (0170d83)`
- Noticed: «Lauf wartet auf dich» leads to JSON.
- By hand: find data/filing/.
- By wish: «wo ist die Datei für die ESTV?».
- Learns: nothing.

**F2. The portal shows other figures than the app.** `untested`
- Noticed: she compares.
- By hand: none in the app; do not submit.
- By wish: «die ESTV zeigt eine andere Zahl».
- Learns: nothing.

**F3. She filed, but did not tell the app.** `untested`
- Noticed: Abschluss says the quarter is still open.
- By hand: «eingereicht» with the date.
- By wish: «ich habe das Q3 eingereicht».
- Learns: nothing.

**Automation target.** Code: the XML. Person: submit and pay.

**Test.** `huber-q3`, after the VAT fixes.

**Status.** fails (quarter-close-19)

### OW-46 Bilanz and Erfolgsrechnung

**Goal.** «Wie steht die Firma?»

**Happy path.** Bilanz and ER net of VAT, the VAT debt on 2201, the bank at the statement's
balance, a warning when an opening balance is missing.

**What goes wrong.**

**F1. VAT gross, no VAT account in the Bilanz within the year.** `fails (quarter-close-11, high)`
- Noticed: the ER shows gross figures; Abschluss shows a VAT debt the Bilanz lacks.
- By hand: none.
- By wish: «warum ist die MWST nicht in der Bilanz?».
- Learns: nothing; waits for Ken (overnight decision 3).

**F2. Bank negative without the opening.** `fails (quarter-close-12)`
- Noticed: no warning «Anfangsbestand fehlt».
- By hand: OW-05.
- By wish: works (quarter-close-13).
- Learns: nothing.

**F3. A big number is cut off.** `fails (quarter-close-21, low)`
- Noticed: the bank's balance is cut off in the account panel.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: all. Person: reads.

**Test.** `huber-q3`, Bilanz & ER Q3.

**Status.** fails (quarter-close-11, quarter-close-12)

### OW-47 Close the quarter

**Goal.** «Das dritte Quartal ist fertig.»

**Happy path.** Abschluss lists what is open; when nothing is, «abschliessen» seals the quarter;
from then on nothing dated in it changes.

**What goes wrong.**

**F1. It asks to file quarters before the books began.** `fails (quarter-close-20), retest (0170d83)`
- Noticed: «2026-Q1 ist noch offen».
- By hand: none.
- By wish: none.
- Learns: nothing.

**F2. She closes before filing.** `untested`
- Noticed: refused: «erst einreichen».
- By hand: file.
- By wish: none.
- Learns: nothing.

**F3. She closes Q4 before the year-end entries.** `untested`
- Noticed: refused: Q4 closes with the year.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the checklist and the seal. Person: the decision to close.

**Test.** `huber-q3` after filing.

**Status.** fails (quarter-close-20)

### OW-48 The package for the Treuhänder

**Goal.** «Die Treuhand will die MWST und die Buchhaltung.»

**Happy path.** Abschluss › «Übergabe an Treuhand» › «Treuhänder-Paket»: reports, Banana import,
CSVs, every receipt and every statement of the quarter, checksums; «gespeichert» after Save.

**What goes wrong.**

**F1. The statement and a receipt are missing.** `fails (quarter-close-17), retest (0170d83, 380df9b)`
- Noticed: «Kontoauszüge: nichts im Zeitraum».
- By hand: add them to the mail.
- By wish: «schick dem Treuhänder das Paket».
- Learns: the package follows the quarter of the booking.

**F2. «gespeichert» before Save.** `fails (quarter-close-18), retest (0170d83)`
- Noticed: the toast.
- By hand: none.
- By wish: none.
- Learns: nothing.

**F3. The package holds reports from before her last fix.** `untested`
- Noticed: the Bilanz in the zip differs from the screen.
- By hand: export again.
- By wish: none.
- Learns: the package is built at the time of export.

**Automation target.** Code: all. Person: send it.

**Test.** `huber-q3`, export, unzip, compare to the books.

**Status.** fails (quarter-close-17, quarter-close-18)

### OW-49 A mistake in a filed quarter

**Goal.** «Die Treuhand sagt, im zweiten Quartal ist eine Rechnung falsch.»

**Happy path.** The filed booking stays. «Korrektur in Q4 erfassen →» books a correction entry in
the open quarter that names the original and its quarter; MWST shows the Korrekturabrechnung
(0535) for Q2 with the difference.

**What goes wrong.**

**F1. She tries to edit the filed booking.** `untested`
- Noticed: refused, with the correction link.
- By hand: the correction.
- By wish: «korrigier die Rechnung vom Mai».
- Learns: nothing.

**F2. The correction lands in the open quarter's return.** `untested`
- Noticed: the open return grows.
- By hand: mark it «korrigiert Q2».
- By wish: none.
- Learns: corrections go on 0535.

**F3. The books were right, the filed return was wrong (a typo on the portal).** `untested`
- Noticed: MWST shows filed versus now.
- By hand: book nothing; file 0535.
- By wish: «ich habe beim Einreichen eine falsche Zahl getippt».
- Learns: nothing.

**Automation target.** Code: the correction entry and 0535. Person: whether to correct.

**Test.** `huber-q3` sealed through Q3, then correct a Q3 booking in Q4.

**Status.** untested

## Mistakes and safety

### OW-50 Quit during a run

**Goal.** (She closes the laptop while it reads.)

**Happy path.** The runs go on at the next start; nothing lost, nothing doubled; the app says so.

**What goes wrong.**

**F1. Runs interrupted.** `passes (mistakes-18)`
- Noticed: finished after reopening.
- By hand: nothing.
- By wish: none.
- Learns: nothing.

**F2. No word on quitting, no word on resuming; a child process keeps running.** `fails (mistakes-19, low)`
- Noticed: none.
- By hand: none.
- By wish: none.
- Learns: «2 Läufe sind noch im Gang …».

**Automation target.** Code: all.

**Test.** `huber-setup`: drop two files, quit within 5 s.

**Status.** fails (mistakes-19)

### OW-51 Everyday slips

**Goal.** (Wrong language, zoom, dark mode, Swiss typing.)

**Happy path.** Every slip is visible and undone by the same control.

**What goes wrong.**

**F1. Français by mistake.** `passes (mistakes-21)`
- Noticed: at once; the same menu brings German back.
- By hand: works.
- By wish: none.
- Learns: nothing.

**F2. Zoom to 160 % clips the bars.** `fails (mistakes-22), retest (849d012)`
- Noticed: the toolbar is cut.
- By hand: «−».
- By wish: none.
- Learns: nothing.

**F3. Back from zoom ends at 90 %.** `fails (mistakes-23, low)`
- Noticed: no «100 %».
- By hand: click the percentage.
- By wish: none.
- Learns: nothing.

**F4. The period presets need «Anwenden».** `fails (mistakes-11, low)`
- Noticed: nothing changes on the click.
- By hand: «Anwenden».
- By wish: none.
- Learns: nothing.

**Automation target.** Code: all.

**Test.** `huber-setup`, the mistakes scenario.

**Status.** fails (mistakes-11, mistakes-22, mistakes-23)

### OW-52 The AI sidebar: refusals, questions, undo

**Goal.** «Mach alles richtig.» / «Buch das auf Konto 9999.» / «Doch nicht.»

**Happy path.** A vague wish gets a question back with what it would do; a wrong one is refused
with the reason; every change is a card with «Rückgängig»; nothing changes she did not name.

**What goes wrong.**

**F1. A vague wish.** `passes (regression-4)`
- Noticed: a question back.
- By hand: none.
- By wish: answer it.
- Learns: nothing.

**F2. A wrong account.** `passes (sidebar-wishes-17); fails (sidebar-wishes-18), retest (d87d8f5)`
- Noticed: refused; then a wrong account proposed.
- By hand: none.
- By wish: none.
- Learns: proposals from her chart only.

**F3. The AI undoes its own change without saying so.** `fails (sidebar-wishes-16), retest (d87d8f5)`
- Noticed: the booking flips back.
- By hand: Rückgängig.
- By wish: none.
- Learns: nothing.

**F4. «Sie» instead of «du».** `fails (regression-2, low)`
- Noticed: one slip.
- By hand: none.
- By wish: none.
- Learns: nothing.

**F5. A wish beyond the app (payroll, pay an invoice, the tax return).** `untested (scenario wishes)`
- Noticed: an honest «kann ich nicht», with what the app can do.
- By hand: none.
- By wish: refused.
- Learns: nothing.

**Automation target.** AI: understand and refuse. Code: check every change. Person: keep or undo.

**Test.** `huber-q3`, scenarios sidebar-wishes and wishes.

**Status.** fails (sidebar-wishes-18, sidebar-wishes-16, regression-2)

## Extending the automation

Wishes Sandra makes to hand more work to the app. For each: the AI shows the rule, workflow step
or setting plainly before she keeps it; the next matching case follows it; she finds and undoes
it later (Änderungen, or Firma). Test on `huber-q3` (scenario wishes): keep the rule, drop a
matching receipt or statement, check the booking, then take the rule back and check again.

| id | Sandra says | Becomes | The next case must | Status |
|---|---|---|---|---|
| OW-X01 | «Swisscom immer auf Telefon 6510» | a supplier rule | the next Swisscom bill booked 6510 I81 without the AI | `untested` |
| OW-X02 | «Tankstellen sind Fahrzeugaufwand» | a rule by kind of supplier | a fuel till photo booked 6200 | `untested` |
| OW-X03 | «Rechnungen von Farbmix sind Material, nicht Aufwand» | a supplier rule (4400, M81) | the next Farbmix invoice on 4400 M81 | `untested` |
| OW-X04 | «frag mich bei Barbezügen über 500 Franken» | a workflow step: a task before booking | a large withdrawal waits in Braucht dich with the question | `untested` |
| OW-X05 | «das Natel ist immer zur Hälfte privat» | a private-share rule | each Swisscom bill split, the half on 2451 | `untested` |
| OW-X06 | «lies jeden Montag das Postfach» | a schedule on «Belege und Daten holen» | Monday's run in Automatisierung | `untested` |
| OW-X07 | «Arbeiten in Deutschland immer ohne Schweizer MWST, Ziffer 221» | a customer or invoice rule | the next invoice with a German site address carries V0-E | `untested` |
| OW-X08 | «schreib in der Rechnung ‹Grüezi› statt ‹Sehr geehrte›» | an invoice text | the next draft greets with «Grüezi» | `untested` |
| OW-X09 | «häng jeder Rechnung den Arbeitsrapport als PDF an» | an invoice workflow step | «Senden» asks for the report or attaches it | `untested` |
| OW-X10 | «zahlbar in 10 Tagen statt 30» | a setting | the next invoice's due date and QR text | `untested` |
| OW-X11 | «mach eine Rechnung für Familie Keller über 12 Stunden à 95» | a draft invoice | the draft with the right positions and VAT | `untested` |
| OW-X12 | «was hat das Gerüst dieses Jahr gekostet?» | an answer, no change | the figure with the bookings behind it | `untested` |
| OW-X13 | «zeig mir alle Belege ohne Zahlung» | a filter | Belege filtered | `untested` |
| OW-X14 | «schick dem Treuhänder jedes Quartal das Paket» | a workflow after filing | the package made after «eingereicht» | `untested` |
| OW-X15 | «Skonto von Farbmix immer so buchen» | a rule from her correction | the next Skonto booked as she corrected it | `untested` |
| OW-X16 | «mach die Lohnabrechnung für Marco» | an honest refusal | nothing changed, what the app can do instead | `untested` |

What every wish case checks too: the rule was shown before it counted; it changed nothing else;
taking it back restores the old behaviour; a rule that changes figures waits for her to switch it
on (workflows.md, «Changing a workflow»).
