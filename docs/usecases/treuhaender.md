# Treuhänderin without an AI subscription: Monika, Treuhand Frei

Monika Frei keeps the books of about forty small firms. She knows Swiss accounting and VAT
thoroughly and works fast with the keyboard in her own software. The Hubers want her to do
everything, not only review. She has no Claude subscription and will not get one: every step
must work by hand, and the app must feel like bookkeeping, not like software. Each visit is
short and starts with «was hat sich seit dem letzten Mal geändert?».

Surface: the web sandbox (`sandbox.sh up`), which makes no model calls at all, on the Huber books
copied out of the VM (`.verify/huber-books/`), scenario `treuhaender`. Findings:
`.verify/findings/treuhaender.md`. The owner's decisions (filing, sealing, closing the year,
the profit) stay with the owner; Monika prepares them.

Format and status: [README.md](README.md).

## Getting in

### TH-01 Open a client's books with nothing installed

**Goal.** «Schicken Sie mir einen Link.»

**Happy path.** The owner opens a review instance («Prüfung öffnen»); Monika gets a link and an
e-mail code, works in the browser, the owner closes the instance afterwards. Every save is a
commit with her name.

**What goes wrong.**

**F1. There is no review instance yet.** `not supported yet (ADR 0003)`
- Noticed: the owner has to send a folder or an export.
- By hand: the books folder plus the web app (the sandbox is today's stand-in).
- By wish: none.
- Learns: nothing.

**F2. A folder path with spaces breaks the tooling.** `fails (treuhaender-1, tooling)`
- Noticed: the sandbox's env file splits the path.
- By hand: quote it.
- By wish: none.
- Learns: nothing; a tooling fix.

**Automation target.** Code: the instance, the login. Person: the owner grants and ends access.

**Test.** Sandbox on the Huber folder (path with spaces).

**Status.** fails (treuhaender-1)

### TH-02 What changed since my last visit

**Goal.** «Was hat die Firma seit dem letzten Mal gemacht?»

**Happy path.** Änderungen groups what changed since her last visit: new statements, receipts,
bookings by the AI, hand edits, wishes, rules, each with who and when, and a way to undo.

**What goes wrong.**

**F1. Änderungen lists runs only.** `fails (misreads-24)`
- Noticed: hand edits, wishes and reclassifications are missing.
- By hand: compare the journal with her last export.
- By wish: none (no AI).
- Learns: every change in one history.

**F2. «Since your last visit» is not per person.** `untested`
- Noticed: the list has no «seit» marker.
- By hand: a date filter.
- By wish: none.
- Learns: the app remembers her last visit.

**Automation target.** Code: the history. Person: reads.

**Test.** Sandbox, after a session in the VM on the same books.

**Status.** fails (misreads-24)

### TH-03 Every AI button has a manual twin

**Goal.** «Ich habe keine KI. Was davon geht ohne?»

**Happy path.** Without a model, the app says once that reading photos and proposing bookings
need the AI, and shows the manual way at each place: type the receipt, book by hand. No error
alerts.

**What goes wrong.**

**F1. AI buttons answer with an error.** `untested`
- Noticed: «claude exited 1» in an alert (SKILL.md says the sandbox shows it).
- By hand: none.
- By wish: none.
- Learns: AI buttons hide or say «braucht KI» when there is none.

**F2. Runs wait for a model forever.** `fails (treuhaender-3)`
- Noticed: photos «in Arbeit», the bar at 67 %.
- By hand: open each receipt.
- By wish: none.
- Learns: a run without a model ends in «braucht dich».

**Automation target.** Code: everything a rule decides. Person: the rest, by hand.

**Test.** Sandbox; click every button that calls a model.

**Status.** fails (treuhaender-3)

## Receipts and payments by hand

### TH-04 Receipts read by code

**Goal.** «Die PDFs hat sie schon gelesen?»

**Happy path.** Text PDFs give date, total and Swiss VAT by code when the figures add up; each
row says what it still lacks.

**What goes wrong.**

**F1. A PDF whose figures do not add up at a Swiss rate.** `passes (treuhaender-2)`
- Noticed: «wartet auf dich», «fehlt: Betrag».
- By hand: Angaben.
- By wish: none.
- Learns: nothing.

**F2. A photo of an invoice already in the books.** `fails (treuhaender-4, low); delete passes (treuhaender-19)`
- Noticed: one more open receipt; nothing says it is the same invoice.
- By hand: ⌫ deletes it, 30 days in the trash; a «Duplikat von …» action would help.
- By wish: none.
- Learns: nothing.

**F3. The Swiss VAT of a text PDF.** `passes (treuhaender-13)`
- Noticed: rate, net, VAT and the VAT number read by code.
- By hand: Angaben › Schweizer MWST «ja» confirms.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: text facts. Person: photos.

**Test.** Sandbox, drop the October files.

**Status.** fails (treuhaender-4)

### TH-05 Type a receipt in by hand

**Goal.** «Datum, Betrag, MWST, ich tippe das ab.»

**Happy path.** Belege › `E` (Angaben bearbeiten): date, currency, amount, Swiss VAT yes or no,
rate, VAT amount, VAT number, description, all by keyboard; marked «von Hand».

**What goes wrong.**

**F1. The VAT radios break the Tab order.** `fails (treuhaender-6)`
- Noticed: «keine» not set, the description lost.
- By hand: the mouse.
- By wish: none.
- Learns: radios as one Tab stop.

**F2. A photo needs typing and the app does not say so.** `fails (treuhaender-3); typing it passes (treuhaender-16)`
- Noticed: «in Arbeit».
- By hand: the preview is large enough to read; `E`, date, amount, «ja»; the VAT line fills,
  the payment is suggested, Enter links and moves to the next receipt.
- By wish: none.
- Learns: OW-04 F3.

**F4. After typing, the receipt still looks unread.** `fails (treuhaender-17, treuhaender-18, low)`
- Noticed: `needsVisionReview` stays; the receipt keeps the dropped file name and stays staged,
  while AI-read receipts are archived under date and supplier.
- By hand: none.
- By wish: none.
- Learns: facts typed by a person count like facts read, for the flag and the name.

**F3. A receipt with two rates.** `untested`
- Noticed: the VAT fields take more than one rate.
- By hand: add a rate.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: checks (VAT fits amount). Person: the figures.

**Test.** Sandbox, `IMG_4733.jpg` and `Malerbedarf_Konstanz_RE-4471.pdf` by keyboard only.

**Status.** fails (treuhaender-3, treuhaender-6, treuhaender-17, treuhaender-18)

### TH-06 Book a bank payment by hand

**Goal.** «Soll Material, Haben Bank, M81. Fertig.»

**Happy path.** On a payment (and on its linked receipt) «Von Hand buchen» opens a form prefilled
with date, amount, the bank account on the credit side and the receipt; she sets Soll and MWST;
the booking carries the payment's reference, so the payment reads «gebucht».

**What goes wrong.**

**F1. No booking form on a payment.** `fails (treuhaender-8, blocker)`
- Noticed: «Buchen» starts a run whose task leads back to the same page.
- By hand: Buchungen › N books «Ohne Bankzahlung»; the payment stays «nicht gebucht».
- By wish: none.
- Learns: nothing; the form is missing.

**F2. «Gebucht» on the task removes it with nothing booked.** `fails (treuhaender-9, high)`
- Noticed: «Nichts wartet auf dich», the payment still has no entry.
- By hand: none.
- By wish: none.
- Learns: «Gebucht» only when an entry with that reference exists.

**F3. Statement lines without a booking are not listed as work.** `fails (treuhaender-5)`
- Noticed: nothing says «4 Zahlungen ohne Buchung».
- By hand: Kontoauszüge, line by line.
- By wish: none.
- Learns: a queue of payments without a booking.

**Automation target.** Code: supplier rules book what they know without a model. Person: the
rest, in one form.

**Test.** Sandbox, the four October payments.

**Status.** fails (treuhaender-5, treuhaender-8, treuhaender-9)

### TH-07 Link a receipt to a payment

**Goal.** «Der Beleg gehört zu dieser Zahlung.»

**Happy path.** `L` on the receipt, «Passt am besten» on top, Enter links it.

**What goes wrong.**

**F1. A receipt in EUR, a payment in CHF.** `passes (treuhaender-7)`
- Noticed: «≈ CHF … · ESTV 02.10.2026» beside the bank amount.
- By hand: works.
- By wish: none.
- Learns: nothing.

**F2. The wrong payment of another amount.** `fails (misreads-22)`
- Noticed: no warning.
- By hand: Lösen.
- By wish: none.
- Learns: OW-23.

**Automation target.** Code: suggestions. Person: confirm.

**Test.** Sandbox, `L` on each October receipt.

**Status.** fails (misreads-22)

### TH-08 Split a payment over several accounts

**Goal.** «Die Rechnung ist halb Material, halb Werkzeug.»

**Happy path.** One payment, several lines (Soll per line, one Haben bank), each with its VAT
code; the lines add up to the payment, the form shows the rest.

**What goes wrong.**

**F1. The lines do not add up.** `untested`
- Noticed: «Rest …» before saving.
- By hand: fix a line.
- By wish: none.
- Learns: nothing.

**F2. Splitting a booking made by the AI.** `untested`
- Noticed: the AI's entry becomes manual.
- By hand: works.
- By wish: none.
- Learns: OW-30: manual stays.

**Automation target.** Code: the check. Person: the split.

**Test.** Sandbox, split `IMG_4502.jpg`'s payment.

**Status.** untested

### TH-09 A payment that needs no receipt

**Goal.** «Bankspesen, Zinsen, die Steuerrechnung: braucht keinen Beleg.»

**Happy path.** «braucht keinen» on the payment; booked without input tax.

**What goes wrong.**

**F1. A supplier payment marked by mistake.** `untested`
- Noticed: the owner's review.
- By hand: «zurücksetzen».
- By wish: none.
- Learns: nothing.

**F2. A tax payment booked as expense.** `untested`
- Noticed: VAT payment on 2201, not 6xxx.
- By hand: 2201 for the ESTV.
- By wish: none.
- Learns: payments to the ESTV clear 2201.

**Automation target.** Code: payee rules. Person: confirm.

**Test.** Sandbox, the statement's fee lines.

**Status.** untested

### TH-10 The chart of accounts fits the firm

**Goal.** «Wo ist der Materialaufwand?»

**Happy path.** A painting firm has the trades chart (4000 Material, 4900 Skonti, 1500 Maschinen,
6800 Abschreibungen); account search by number or name in every field.

**What goes wrong.**

**F1. The consultant chart on a trades firm.** `fails (treuhaender-11), retest (48fdaa3 trades preset)`
- Noticed: no 4000, no 4900.
- By hand: add accounts (Firma › Kontenplan).
- By wish: none.
- Learns: the preset's chart.

**F2. She adds an account.** `passes (treuhaender-12); reports untested`
- Noticed: Firma › Kontenplan › «Konto hinzufügen» saves at once, usable in the fields; but
  the new account carries no type or report line.
- By hand: works; whether Bilanz and ER place it is to check.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the chart per preset. Person: her own accounts.

**Test.** Sandbox, search «Material»; add 4000.

**Status.** fails (treuhaender-11)

### TH-11 Book by hand what has no payment

**Goal.** «Eine Umbuchung, Soll 1530, Haben 6200.»

**Happy path.** Buchungen › N: «Neue Buchung von Hand» (date, Soll, Haben, MWST, Betrag, Text),
keyboard only, Tab saves, the next entry at once.

**What goes wrong.**

**F1. A date in a filed quarter.** `untested`
- Noticed: «Bis … ist eingereicht: eine neue Buchung liegt danach.»
- By hand: the open period, or a correction.
- By wish: none.
- Learns: nothing.

**F2. A VAT code on a transfer between balance accounts.** `untested`
- Noticed: should warn: no VAT between balance accounts.
- By hand: remove.
- By wish: none.
- Learns: nothing.

**F3. She types the opening balance as an entry.** `fails (quarter-close-14)`
- Noticed: the Bilanz does not balance.
- By hand: Firma › Eröffnung (TH-24).
- By wish: none.
- Learns: OW-05.

**Automation target.** Code: checks. Person: the entry.

**Test.** Sandbox, five entries by keyboard; count the keystrokes.

**Status.** fails (quarter-close-14)

### TH-12 Reverse an entry

**Goal.** «Die Buchung stornieren, nicht löschen.»

**Happy path.** In the open period: delete, or a reversal entry (Soll and Haben swapped) with a
reference to the original; in a filed period: «Korrektur in … erfassen →» prefilled as a
reversal.

**What goes wrong.**

**F1. No reversal in the open period, only delete.** `untested`
- Noticed: she wants the trail.
- By hand: a new entry with swapped accounts.
- By wish: none.
- Learns: a «Stornieren» on any entry.

**F2. Reversing a payment's booking leaves the payment unbooked.** `untested`
- Noticed: the payment reads «nicht gebucht».
- By hand: book it again.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the reversal. Person: why.

**Test.** Sandbox, reverse a Q3 entry.

**Status.** untested

### TH-13 Classify a quarter without the AI

**Goal.** «Die Lieferanten sind jedes Quartal die gleichen.»

**Happy path.** Supplier knowledge (Swisscom on 6510 I81) books by code, without a model; she adds
a rule from a booking («als Regel für Swisscom»), by hand.

**What goes wrong.**

**F1. «Neu klassifizieren» needs the model.** `untested`
- Noticed: an error.
- By hand: book each payment.
- By wish: none.
- Learns: rules decide first, the model only the rest.

**F2. No way to make a rule by hand.** `untested`
- Noticed: knowledge files only (YAML).
- By hand: none in the app.
- By wish: none.
- Learns: «als Regel speichern» on a booking.

**Automation target.** Code: rules. Person: the rule.

**Test.** Sandbox: a Swisscom bill of October; is it booked without a model?

**Status.** untested

### TH-39 Skonto by hand

**Goal.** «Bezahlt mit 2 % Skonto: Aufwand, Bank, Skontoertrag, MWST-Korrektur.»

**Happy path.** Linking a receipt to a payment that is less names the difference («Skonto … ,
MWST-Korrektur …») and proposes the split; or the hand entry takes several lines with one bank
side.

**What goes wrong.**

**F1. The difference is not named, the entry has one amount.** `fails (treuhaender-14)`
- Noticed: linked as best fit, nothing about the difference.
- By hand: two entries she works out herself.
- By wish: none.
- Learns: a Skonto proposal from the difference, by code.

**F2. On cash basis the input tax follows the paid amount.** `untested`
- Noticed: the VAT of the invoice is claimed whole.
- By hand: book the input tax on the paid amount, or the correction on 4900.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the split. Person: confirm.

**Test.** Sandbox, `Farbmix_Rechnung_FM-79010.pdf` with the October payment.

**Status.** fails (treuhaender-14)

## Year-end entries

### TH-14 Depreciation

**Goal.** «Abschreibung auf dem Lieferwagen.»

**Happy path.** Abschluss › Abschreibungen › «Erfassen»: a prefilled entry 6800 / 1530 on 31.12.,
no VAT; marked done.

**What goes wrong.**

**F1. Dated in a closed Q4.** `untested`
- Noticed: refused: Q4 closes with the year.
- By hand: book before closing.
- By wish: none.
- Learns: nothing.

**F2. A VAT code on the depreciation.** `untested`
- Noticed: should be refused.
- By hand: remove.
- By wish: none.
- Learns: nothing.

**F3. Indirect method (via 1539 Wertberichtigung).** `untested`
- Noticed: she chooses the account.
- By hand: Haben 1539.
- By wish: none.
- Learns: her method, for next year.

**Automation target.** Code: the template, the date. Person: the amount.

**Test.** Sandbox, year-end on the Huber books (a van on 1530).

**Status.** untested

### TH-15 Prepaid expenses (transitorische Aktiven)

**Goal.** «Die Versicherung für nächstes Jahr ist schon bezahlt.»

**Happy path.** 1300 / 6300 on 31.12. for the part of next year; reversed on 1.1. by itself.

**What goes wrong.**

**F1. Not reversed in the new year.** `untested`
- Noticed: the cost missing next year.
- By hand: reverse on 1.1.
- By wish: none.
- Learns: accruals reverse automatically.

**F2. The premium carries no VAT; she adds one.** `untested`
- Noticed: no VAT on an accrual.
- By hand: remove.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: reversal. Person: the part.

**Test.** Sandbox, the Mobiliar premium.

**Status.** untested

### TH-16 Accrued expenses (transitorische Passiven)

**Goal.** «Die Dezember-Rechnung kommt erst im Januar; der Dezemberlohn ist noch offen.»

**Happy path.** 6xxx / 2300 on 31.12.; reversed on 1.1.; the January payment books normally.

**What goes wrong.**

**F1. The January payment books the cost again without the reversal.** `untested`
- Noticed: the cost twice.
- By hand: reverse.
- By wish: none.
- Learns: same as TH-15.

**F2. Input tax claimed on the accrual.** `untested`
- Noticed: cash basis: input tax on payment.
- By hand: no code.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: reversal. Person: the amount.

**Test.** Sandbox, year-end.

**Status.** untested

### TH-17 Accrued and deferred income

**Goal.** «Dezember gearbeitet, im Januar verrechnet» / «Im Dezember bezahlt, Arbeit im Januar».

**Happy path.** 1301 / 3400 and 3400 / 2301 on 31.12., no VAT code (VAT on payment, cash basis);
reversed on 1.1.

**What goes wrong.**

**F1. VAT code on the accrual.** `untested`
- Noticed: the return of Q4 grows.
- By hand: remove.
- By wish: none.
- Learns: nothing.

**F2. Open receivables proposed twice (1100 and 1301).** `untested`
- Noticed: the same work twice.
- By hand: mark one «Nicht nötig».
- By wish: none.
- Learns: nothing.

**Automation target.** Code: proposals from open invoices. Person: unbilled work.

**Test.** Sandbox, year-end with an open invoice.

**Status.** untested

### TH-18 Provisions

**Goal.** «Rückstellung für unser Honorar und die Steuern.»

**Happy path.** 6xxx / 2330 for the fee; 8900 / 2208 for profit and capital tax; no VAT.

**What goes wrong.**

**F1. Tax provision before the result is known.** `untested`
- Noticed: the result changes after other entries.
- By hand: book it last.
- By wish: none.
- Learns: the checklist orders it last.

**F2. Last year's provision not dissolved.** `untested`
- Noticed: 2330 grows each year.
- By hand: dissolve the old one.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: templates. Person: amounts.

**Test.** Sandbox, year-end.

**Status.** untested

### TH-19 Private shares at year-end

**Goal.** «Privatanteil Auto und Natel.»

**Happy path.** 2451 / 6xxx with K81-B (Ziffer 415) for the private share of costs whose input
tax was claimed; booked before Q4 is filed.

**What goes wrong.**

**F1. Booked after Q4 was filed.** `untested`
- Noticed: the K-code changes a filed quarter's tax.
- By hand: correction on 0535.
- By wish: none.
- Learns: the checklist puts it before filing Q4 (year-end.md).

**F2. Already split per bill during the year.** `untested`
- Noticed: OW-33 rule plus year-end share.
- By hand: one of the two.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: flat rates. Person: the share.

**Test.** Sandbox, year-end.

**Status.** untested

### TH-20 Social insurance final statements

**Goal.** «Die Schlussabrechnung der Ausgleichskasse.»

**Happy path.** The difference between advances and the final statement: 5700 / 2270 on 31.12.

**What goes wrong.**

**F1. The final statement arrives in March.** `untested`
- Noticed: accrue an estimate.
- By hand: an estimate, corrected next year.
- By wish: none.
- Learns: nothing.

**F2. Advances booked on 5700 and on 2270 mixed.** `untested`
- Noticed: 2270 balance odd.
- By hand: transfer.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: template. Person: amount.

**Test.** Sandbox, year-end.

**Status.** untested

### TH-21 Work in progress and doubtful debts

**Goal.** «Die Fassade ist halb gemacht» / «Der Kunde zahlt wohl nicht.»

**Happy path.** Inventory change for work in progress (1280 / 3xxx or as the firm books it);
3805 / 1109 for a doubtful debt; no VAT on either (the VAT on a lost receivable is corrected only
when it is final, Ziffer 235).

**What goes wrong.**

**F1. The doubtful debt reduces VAT at once.** `untested`
- Noticed: only a final loss reduces the VAT.
- By hand: no code.
- By wish: none.
- Learns: nothing.

**F2. Work in progress left for a job already invoiced.** `untested`
- Noticed: counted twice.
- By hand: remove.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: templates. Person: the values.

**Test.** Sandbox, year-end.

**Status.** untested

### TH-22 The year-end checklist

**Goal.** «Was fehlt noch für den Abschluss?»

**Happy path.** Abschluss lists every item computed from the books; «Erfassen» or «Nicht nötig»
per item; the exchange difference booked by `year:close`; the balance sheet balances.

**What goes wrong.**

**F1. An item marked «Nicht nötig» by mistake.** `untested`
- Noticed: the list.
- By hand: undo the mark.
- By wish: none.
- Learns: nothing.

**F2. The balance sheet does not balance.** `untested`
- Noticed: the check names the cause (entries with one account, an unknown account, an opening
  that did not balance).
- By hand: fix the cause; never book the difference away.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the checklist. Person: what applies.

**Test.** Sandbox, `year:close -- 2026 --dry-run` and Abschluss.

**Status.** untested

## Corrections

### TH-23 Correct a wrong booking in the open period

**Goal.** «Falsches Konto, falscher Code.»

**Happy path.** bearbeiten, Tab saves; the change carries her name; the owner sees «geändert von
Treuhand».

**What goes wrong.**

**F1. The next run overwrites her correction.** `fails (misreads-10, misreads-11)`
- Noticed: nothing.
- By hand: redo.
- By wish: none.
- Learns: OW-30.

**F2. The code typed by its label word.** `fails (misreads-13); the catalogue passes (treuhaender-15)`
- Noticed: refused.
- By hand: MWST-Codes, search «Ausland»: V0 and V0-E with «Wann / Nicht wenn / Ziffern»; then
  the code.
- By wish: none.
- Learns: OW-31.

**Automation target.** Code: keep manual. Person: the fix.

**Test.** Sandbox, change three bookings, reload, check origin and author.

**Status.** fails (misreads-10, misreads-11, misreads-13)

### TH-24 The opening balance

**Goal.** «Die Bank stimmt nicht, die Eröffnungsbilanz fehlt.»

**Happy path.** The app names the missing opening («Eröffnungssaldo 1020 fehlt, Bank am 30.06.:
…») and offers to take it from the statement; Firma › Eröffnung takes all balances of the last
closing by hand.

**What goes wrong.**

**F1. The statement page shows a difference, nothing offers the opening.** `fails (treuhaender-10)`
- Noticed: «weicht … vom Endsaldo der Bank ab».
- By hand: Firma › Eröffnung has no field (quarter-close-5).
- By wish: none.
- Learns: offer it where the difference shows (regression-10 shows it in Automatisierung only).

**F2. The opening from her last year's closing in Banana.** `untested`
- Noticed: `import-opening` exists only on the command line.
- By hand: none in the app.
- By wish: none.
- Learns: an import in Firma › Eröffnung.

**Automation target.** Code: take and check. Person: which closing counts.

**Test.** Sandbox on the Huber books.

**Status.** fails (treuhaender-10, quarter-close-5)

### TH-25 Correct a filed quarter

**Goal.** «Im Q2 ist eine Vorsteuer zu viel abgezogen.»

**Happy path.** On the filed entry, «Korrektur in Q3 erfassen →» opens «Korrekturbuchung»
prefilled as a reversal; booked in the open quarter, «korrigiert Q2»; MWST shows the
Korrekturabrechnung (0535) for Q2 with the difference.

**What goes wrong.**

**F1. The correction is counted in the open quarter's return.** `untested`
- Noticed: the open return changes.
- By hand: none.
- By wish: none.
- Learns: corrections go on 0535.

**F2. A correction of a correction.** `untested`
- Noticed: two corrections on one entry.
- By hand: the second names the first.
- By wish: none.
- Learns: nothing.

**F3. The filed return was wrong, the books right.** `untested`
- Noticed: MWST shows filed versus now.
- By hand: book nothing; 0535.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the form 0535. Person: whether.

**Test.** Sandbox with `closedThrough` set (`$CLOSED_Q` of the demo).

**Status.** untested

### TH-26 A mistake in a closed year

**Goal.** «Im Abschluss 2026 war ein Fehler.»

**Happy path.** Corrected in 2027 with a reference; 2026 never changes; the VAT part on 0535 for
the 2026 quarter.

**What goes wrong.**

**F1. She tries to reopen 2026.** `untested`
- Noticed: refused, sealed.
- By hand: the correction in 2027.
- By wish: none.
- Learns: nothing.

**F2. The opening of 2027 is already derived.** `untested`
- Noticed: the correction changes equity in 2027, not the opening.
- By hand: book on 2970 (prior-period).
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the lock. Person: the correction.

**Test.** Sandbox after `year:close` and `year:open`.

**Status.** untested

### TH-27 A payment booked twice

**Goal.** «Die Swisscom ist zweimal drin.»

**Happy path.** The balance check shows a difference; the duplicate check lists two entries for
one payment; she deletes one.

**What goes wrong.**

**F1. Two entries on one payment reference.** `untested`
- Noticed: «Zahlung zweimal gebucht» in Braucht dich.
- By hand: delete one.
- By wish: none.
- Learns: nothing.

**F2. The same payment in two statements, imported twice.** `untested`
- Noticed: OW-08.
- By hand: delete the transaction.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the check. Person: which one.

**Test.** Sandbox, add a second entry on a payment by hand.

**Status.** untested

## Questions to the owner

### TH-28 Ask the owner about an item

**Goal.** «Frau Huber, wofür ist dieser Beleg?»

**Happy path.** On a receipt or a booking, «Frage an Inhaber»; the owner sees it in Braucht dich,
answers there; the answer stays on the item; the AI (the owner's) may book from the answer.

**What goes wrong.**

**F1. There is no question on an item.** `not supported yet`
- Noticed: she writes an e-mail.
- By hand: the receipt's Notiz.
- By wish: none.
- Learns: nothing yet.

**F2. The owner answers late.** `not supported yet`
- Noticed: open questions per quarter.
- By hand: book provisionally on a suspense account.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the thread. AI: books from the answer. Person: answers.

**Test.** When built: sandbox (Monika) and VM (Sandra) on the same books.

**Status.** not supported yet

### TH-29 The owner and she change the same books

**Goal.** «Frau Huber hat gestern auch etwas geändert.»

**Happy path.** Both work on their branch; git merges record by record; a real conflict shows
side by side.

**What goes wrong.**

**F1. Both edit the same booking.** `untested`
- Noticed: a conflict.
- By hand: choose.
- By wish: none.
- Learns: nothing.

**F2. The owner's AI reclassifies what she corrected.** `untested`
- Noticed: OW-30.
- By hand: redo.
- By wish: none.
- Learns: manual never overwritten.

**Automation target.** Code: merge. Person: the conflict.

**Test.** Two sandboxes on clones of the same books, merged.

**Status.** untested

## VAT and hand-over

### TH-30 Prepare the VAT return

**Goal.** «Ich prüfe die Abrechnung, Frau Huber reicht ein.»

**Happy path.** MWST: each Ziffer with its entries; input tax only with a receipt with Swiss VAT;
the eCH-0217 XML for the owner; the owner files.

**What goes wrong.**

**F1. Input tax without a receipt.** `fails (misreads-21)`
- Noticed: no list.
- By hand: filter «ohne Beleg» in Buchungen.
- By wish: none.
- Learns: a warning on the return.

**F2. Domestic sales as exports.** `fails (quarter-close-6)`
- Noticed: banner (regression-8).
- By hand: V81.
- By wish: none.
- Learns: OW-36.

**F3. She cannot file: filing is the owner's.** `untested`
- Noticed: the XML is ready, the owner gets a task.
- By hand: owner.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the return. Person: owner files.

**Test.** Sandbox on the Huber books, MWST Q3.

**Status.** fails (misreads-21, quarter-close-6)

### TH-31 The VAT account against the returns

**Goal.** «Stimmt 2201 mit den eingereichten Abrechnungen?»

**Happy path.** The year-end VAT check posts each code's tax to 2201 and compares with the filed
returns and payments; what is owed on 31.12. is Q4.

**What goes wrong.**

**F1. A payment to the ESTV missing.** `untested`
- Noticed: the check names the difference.
- By hand: find the payment.
- By wish: none.
- Learns: nothing.

**F2. Bilanz within the year shows no 2201.** `fails (quarter-close-11)`
- Noticed: OW-46.
- By hand: Abschluss's closing balance sheet.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the check.

**Test.** Sandbox, year-end dry run.

**Status.** fails (quarter-close-11)

### TH-32 Mark a quarter as reviewed

**Goal.** «Q3 ist geprüft.»

**Happy path.** A review status per quarter, visible to the owner; changes after the review are
shown as such.

**What goes wrong.**

**F1. Only runs can be marked «geprüft».** `not supported yet`
- Noticed: «Als geprüft markieren» exists on runs, not quarters.
- By hand: tell the owner.
- By wish: none.
- Learns: nothing yet.

**F2. A change after her review.** `not supported yet`
- Noticed: should flag «nach Prüfung geändert».
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the status. Person: the review.

**Test.** When built.

**Status.** not supported yet

### TH-33 Export to her own software

**Goal.** «Ich brauche das als Banana-Import.»

**Happy path.** Export › Banana TSV of the period; imports in Banana with the same figures.

**What goes wrong.**

**F1. An account not in her Banana chart.** `untested`
- Noticed: Banana refuses.
- By hand: map.
- By wish: none.
- Learns: nothing.

**F2. VAT codes differ.** `untested`
- Noticed: codes are Banana's own (vat-codes.md).
- By hand: none needed.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the export.

**Test.** Sandbox, export Q3; compare totals.

**Status.** untested

### TH-34 Journal and account ledger as PDF

**Goal.** «Ein Journal und die Kontoblätter zum Ablegen.»

**Happy path.** Export › reports: journal, ledger per account, Bilanz, ER, Saldobilanz as PDF and
CSV.

**What goes wrong.**

**F1. No journal print.** `untested`
- Noticed: she looks for it.
- By hand: CSV.
- By wish: none.
- Learns: nothing.

**F2. The reports gross of VAT.** `fails (quarter-close-11)`
- Noticed: OW-46.
- By hand: Abschluss's balance sheet.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the reports.

**Test.** Sandbox, export.

**Status.** fails (quarter-close-11)

### TH-35 Close the year and open the next

**Goal.** «Abschluss fertig, Frau Huber schliesst.»

**Happy path.** She prepares; the owner clicks «Jahr abschliessen» and «Neues Jahr eröffnen»; the
opening balances follow; the result to 2970.

**What goes wrong.**

**F1. She clicks «Jahr abschliessen».** `untested`
- Noticed: only the owner may.
- By hand: owner.
- By wish: none.
- Learns: nothing.

**F2. The new year opened before a late entry.** `untested`
- Noticed: «Neues Jahr eröffnen» again updates the openings and lists what changed.
- By hand: run it again.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: close and open. Person: owner.

**Test.** Sandbox, after year-end entries.

**Status.** untested

### TH-36 Profit allocation

**Goal.** «Die GV hat eine Dividende beschlossen.»

**Happy path.** «Gewinnverwendung buchen» on the day of the decision: reserve (2950), dividend,
35 % withholding tax (2206), the shareholder credited 65 % (2451).

**What goes wrong.**

**F1. Dividend larger than the free equity.** `untested`
- Noticed: refused.
- By hand: less.
- By wish: none.
- Learns: nothing.

**F2. Withholding tax not paid within 30 days.** `untested`
- Noticed: a task with the due date.
- By hand: pay.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the entries. Person: the decision.

**Test.** Sandbox after year:open.

**Status.** untested

### TH-37 Many clients, short visits

**Goal.** «Der nächste Kunde.»

**Happy path.** Switch between client books in a few clicks; each opens on «seit dem letzten
Mal».

**What goes wrong.**

**F1. One window per client, no list.** `untested`
- Noticed: she keeps a list herself.
- By hand: open folder.
- By wish: none.
- Learns: recent books on the start screen.

**F2. She books into the wrong client's books.** `untested`
- Noticed: the company name in the top bar.
- By hand: undo.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the list. Person: picks.

**Test.** Two sandboxes; switch.

**Status.** untested

### TH-38 Expert speed

**Goal.** «Ich will mit der Tastatur buchen wie in Banana.»

**Happy path.** Every field reachable by Tab; account search by number and name; Enter saves
and opens the next; a copy of the last entry; shortcuts listed.

**What goes wrong.**

**F1. Radios and selects break the flow.** `fails (treuhaender-6)`
- Noticed: values lost.
- By hand: the mouse.
- By wish: none.
- Learns: nothing.

**F2. Account search works.** `passes (treuhaender-11: search by name and number in the form)`
- Noticed: works.
- By hand: works.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the form.

**Test.** Sandbox, ten entries by keyboard, time them.

**Status.** fails (treuhaender-6)

## Extending the automation

Monika has no AI. She extends the automation by hand, and checks what the owner's AI made.

| id | Monika does | Becomes | The next case must | Status |
|---|---|---|---|---|
| TH-X01 | «als Regel speichern» on a booking (Swisscom 6510 I81) | a supplier rule, made by hand | the next Swisscom bill booked without a model | `not supported yet` |
| TH-X02 | a recurring entry: monthly rent accrual | a schedule, made by hand | the entry on the first of each month | `not supported yet` |
| TH-X03 | a template for her year-end set (the same items every year) | a year-end preset | next year's checklist preselected | `untested` |
| TH-X04 | reads the rules the owner's AI made (Änderungen) and takes one back | a review of rules | the rule gone, the old behaviour back | `untested` |
| TH-X05 | edits the text of a guide rule in place (workflows.md, «Directly, without AI») | a changed rule | the next run follows it | `untested` |
| TH-X06 | a report she needs each quarter (open items list) | a saved filter or report | one click next quarter | `untested` |
