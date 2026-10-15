# IT consultant with clients abroad: Eva, IT-Beraterin GmbH

Eva Steiner is the only employee of her consulting GmbH. Most of her clients are in Germany and
Austria; she invoices them in EUR for work she does from Switzerland, which is a service abroad
without Swiss VAT. Some clients are Swiss and pay 8.1 %. She has a CHF account and a Wise EUR
account, pays her own salary, buys software subscriptions from the USA and travels to clients.
Registered for VAT, effective method, cash basis, quarterly. Technical, impatient with jargon,
fast.

Surfaces: the sandbox on `demo-consulting/` (Muster Consulting GmbH: Raiffeisen CHF, Wise EUR, a
manual Kontokorrent), and a fresh VM with setup preset «Consulting» (scenario other-firms). No
case here has run in a persona test yet; the related owner cases are named.

Format and status: [README.md](README.md).

## Invoices abroad

### IT-01 Invoice a German client in EUR

**Goal.** «Rechnung an die Firma in München, 32 Stunden, in Euro.»

**Happy path.** Rechnungen › «+ Rechnung», the client's country is DE, currency EUR; the invoice
carries no Swiss VAT and the note that the service is taxable at the recipient (reverse charge);
the QR-bill in EUR to the Wise or CHF account; the booking will be V0-E (Ziffer 221).

**What goes wrong.**

**F1. Swiss VAT on the invoice.** `untested`
- Noticed: the sheet shows 8.1 % for a foreign business client.
- By hand: the VAT select (but see invoices-6: the selects did not save).
- By wish: «Kunden in Deutschland ohne Schweizer MWST».
- Learns: the client's country sets the default.

**F2. The client is a private person abroad.** `untested`
- Noticed: the AI or the form asks «Firma oder Privatperson?»: for many services the place of
  supply then stays in Switzerland.
- By hand: 8.1 %.
- By wish: none.
- Learns: the client record says business or private.

**F3. No EUR account for the QR-bill.** `untested (cf. invoices-2)`
- Noticed: «ein Konto für diese Währung fehlt».
- By hand: Firma › Rechnungslayout › pay-to EUR.
- By wish: «Euro-Rechnungen aufs Wise-Konto».
- Learns: nothing.

**Automation target.** Code: VAT by client country and kind; reverse-charge text. Person: the
hours and the price.

**Test.** Sandbox on `demo-consulting/`, a client in Germany.

**Status.** untested

### IT-02 The client pays the EUR invoice into the Wise EUR account

**Goal.** «München hat bezahlt.»

**Happy path.** The EUR credit matches the invoice by reference or amount; booked V0-E on 3400
at the CHF value of the payment day; the invoice «bezahlt».

**What goes wrong.**

**F1. Booked V0 (Ziffer 220 Exporte).** `untested (cf. misreads-12)`
- Noticed: MWST shows it under Exporte.
- By hand: V0-E.
- By wish: «das ist eine Dienstleistung, kein Export».
- Learns: services abroad are V0-E.

**F2. The client's bank deducted fees: a little less arrived.** `untested`
- Noticed: «bezahlt bis auf …».
- By hand: write off the rest as bank fees.
- By wish: «die Differenz sind Bankspesen».
- Learns: small differences from this client are fees.

**F3. The CHF value differs from the invoice's CHF estimate.** `untested`
- Noticed: none needed; the payment's day rate counts.
- By hand: nothing.
- By wish: «warum ist der Frankenbetrag anders?».
- Learns: nothing.

**Automation target.** Code: match, rate, code. Person: accept a short payment.

**Test.** Sandbox on `demo-consulting/`, a made-up Wise EUR credit.

**Status.** untested

### IT-03 The client pays the EUR invoice into the CHF account

**Goal.** «Die haben in Euro auf mein Franken-Konto überwiesen.»

**Happy path.** The bank converts; the CHF credit is matched to the EUR invoice by reference;
booked at the CHF amount received.

**What goes wrong.**

**F1. No match because the amounts differ.** `untested`
- Noticed: «Zahlung ohne Rechnung».
- By hand: link; the app accepts the currency difference.
- By wish: «das ist die Zahlung der Rechnung 2026-014».
- Learns: nothing.

**F2. The difference booked as a loss with VAT.** `untested`
- Noticed: an odd entry.
- By hand: exchange difference (6960), no VAT.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: reference match across currencies. Person: nothing.

**Test.** Sandbox, a CHF credit with the invoice reference.

**Status.** untested

### IT-04 One payment for two invoices

**Goal.** «Die haben zwei Rechnungen auf einmal bezahlt.»

**Happy path.** Both invoices settled by one credit; the booking splits per invoice.

**What goes wrong.**

**F1. Only one invoice marked paid.** `untested`
- Noticed: one invoice overdue although paid.
- By hand: link the second.
- By wish: «die Zahlung ist für beide Rechnungen».
- Learns: nothing.

**F2. A reminder sent for the paid one.** `untested`
- Noticed: the overdue list.
- By hand: cancel the reminder.
- By wish: none.
- Learns: check open payments before reminding.

**Automation target.** Code: sums of open invoices. Person: nothing.

**Test.** Sandbox, two invoices, one credit.

**Status.** untested

### IT-05 A client in Liechtenstein

**Goal.** «Neuer Kunde in Vaduz.»

**Happy path.** Liechtenstein is in the Swiss VAT territory: the invoice carries 8.1 % and the
booking V81, not a service abroad.

**What goes wrong.**

**F1. The app treats it as abroad (V0-E).** `untested`
- Noticed: no Swiss VAT on the invoice.
- By hand: 8.1 %.
- By wish: «Liechtenstein ist doch wie Schweiz».
- Learns: country LI is domestic for VAT.

**F2. The AI agrees with a wrong wish «ohne MWST, ist ja Ausland».** `untested`
- Noticed: it should push back.
- By hand: none.
- By wish: refused with the reason.
- Learns: nothing.

**Automation target.** Code: LI is domestic (module ch). Person: nothing.

**Test.** Sandbox, a client with country LI.

**Status.** untested

### IT-06 A client in the USA

**Goal.** «Ein Kunde in New York, in Dollar.»

**Happy path.** USD invoice, no Swiss VAT, V0-E; paid to a USD account or converted.

**What goes wrong.**

**F1. No USD account, the QR-bill cannot be made.** `untested`
- Noticed: «kein Konto für USD».
- By hand: invoice without QR, bank details only.
- By wish: none.
- Learns: nothing.

**F2. The rate of the payment day missing (US holiday).** `untested`
- Noticed: «Kurs fehlt».
- By hand: the ESTV rate of the last day.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: rate. Person: nothing.

**Test.** Sandbox, a USD invoice.

**Status.** untested

### IT-07 A Swiss client with 8.1 %

**Goal.** «Rechnung an die Bank in Zürich.»

**Happy path.** 8.1 %, QR-bill in CHF, booked V81 when paid.

**What goes wrong.**

**F1. Paid without an issued invoice in the app (written elsewhere).** `fails (quarter-close-6 pattern)`
- Noticed: booked V0; MWST names the payment (regression-8).
- By hand: V81.
- By wish: «das ist ein Schweizer Kunde».
- Learns: domestic client, V81 (OW-36).

**F2. The client pays the net amount without VAT.** `untested`
- Noticed: short by the VAT.
- By hand: remind for the rest; VAT on what was received.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: domestic default. Person: nothing.

**Test.** Sandbox, a CHF credit without invoice.

**Status.** fails (quarter-close-6)

### IT-08 An advance payment before the work

**Goal.** «Der Kunde zahlt die Hälfte im Voraus.»

**Happy path.** On cash basis, VAT is due when the money comes; the advance books as sale (or
2030 with the VAT), the final invoice deducts it.

**What goes wrong.**

**F1. The advance booked without VAT on 2030.** `untested`
- Noticed: the return misses it.
- By hand: the code.
- By wish: «das ist eine Anzahlung».
- Learns: nothing.

**F2. The final invoice charges the whole amount again.** `untested`
- Noticed: the invoice lacks «abzüglich Anzahlung».
- By hand: a line with the advance.
- By wish: «zieh die Anzahlung ab».
- Learns: nothing.

**Automation target.** Code: the link from advance to invoice. Person: the amount.

**Test.** Sandbox, an advance invoice and the final one.

**Status.** untested

### IT-09 A credit note to a client

**Goal.** «Ich gebe dem Kunden zehn Stunden gut.»

**Happy path.** «Gutschrift ausstellen» on the invoice, in its currency, with its VAT treatment;
booked as a sales reduction when paid out or offset.

**What goes wrong.**

**F1. The credit note in CHF for an EUR invoice.** `untested`
- Noticed: the currency differs.
- By hand: the invoice's currency.
- By wish: none.
- Learns: credit notes follow their invoice.

**F2. The credit note offset on the next invoice.** `untested`
- Noticed: the next payment is short.
- By hand: link both.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: all. Person: how much.

**Test.** Sandbox, invoice, credit note, payment.

**Status.** untested

### IT-10 Hours to an invoice

**Goal.** «Mach mir die Rechnung aus meiner Stundenliste.»

**Happy path.** She attaches the timesheet (CSV or PDF) in the sidebar; the AI drafts the
invoice positions; she checks and issues.

**What goes wrong.**

**F1. Hours summed wrong.** `untested`
- Noticed: the draft total differs from her sheet.
- By hand: edit positions.
- By wish: «das sind 31 Stunden, nicht 32».
- Learns: nothing.

**F2. Hours of two clients in one sheet.** `untested`
- Noticed: the AI should ask which.
- By hand: none.
- By wish: answer.
- Learns: nothing.

**Automation target.** AI: read the sheet. Person: check.

**Test.** VM with Claude, a made-up timesheet.

**Status.** untested

## Costs

### IT-11 Software subscriptions from the USA

**Goal.** «Die Abos für Cloud und Software zahle ich in Dollar.»

**Happy path.** Acquisition tax (Bezugsteuer): Ziffer 383 and its deduction in 405 (WS-11).

**What goes wrong.**

**F1. Booked I0 without acquisition tax.** `untested`
- Noticed: the return should warn.
- By hand: the code.
- By wish: «das ist ein Abo aus den USA».
- Learns: the supplier is abroad.

**F2. A US supplier with a Swiss VAT number.** `untested`
- Noticed: the invoice shows CHE and Swiss VAT.
- By hand: I81.
- By wish: none.
- Learns: the receipt decides.

**Automation target.** Code: supplier country and VAT number. Person: nothing.

**Test.** Sandbox, a made-up USD subscription invoice.

**Status.** untested

### IT-12 Travel to a client abroad

**Goal.** «Hotel und Zug in Deutschland für den Kunden.»

**Happy path.** Foreign VAT is not Swiss input tax: I0; the cost on 6500 or a travel account;
re-invoiced to the client if agreed.

**What goes wrong.**

**F1. German VAT claimed as input tax.** `untested (cf. misreads-17 pushback passes)`
- Noticed: «keine CH-MWST».
- By hand: I0.
- By wish: refused.
- Learns: nothing.

**F2. The trip is re-invoiced: a cost and a sale.** `untested`
- Noticed: the invoice line «Spesen».
- By hand: the line on the invoice.
- By wish: «verrechne dem Kunden das Hotel».
- Learns: nothing.

**Automation target.** Code: the VAT. Person: whether to re-invoice.

**Test.** Sandbox, a made-up hotel invoice in EUR.

**Status.** untested

### IT-13 A laptop

**Goal.** «Neuer Laptop für die Arbeit.»

**Happy path.** Above the threshold: asset (1520) with I81; depreciation at year-end (TH-10).

**What goes wrong.**

**F1. Booked as expense.** `untested`
- Noticed: the asset list misses it.
- By hand: 1520.
- By wish: «das ist eine Anschaffung».
- Learns: the threshold.

**F2. Partly private use.** `untested`
- Noticed: she says so.
- By hand: K81-B for the private share (year-end).
- By wish: «ich brauche ihn auch privat».
- Learns: nothing.

**Automation target.** AI: asset or not. Person: private share.

**Test.** Sandbox, a made-up laptop invoice.

**Status.** untested

### IT-14 Expenses she paid privately

**Goal.** «Ich habe Spesen privat bezahlt, die Firma soll sie mir zurückzahlen.»

**Happy path.** The receipts book against 2451 with their input tax; the reimbursement from the
firm's account clears 2451.

**What goes wrong.**

**F1. The reimbursement booked as salary.** `untested`
- Noticed: AHV-relevant; wrong.
- By hand: 2451.
- By wish: «das ist die Spesen-Rückzahlung».
- Learns: nothing.

**F2. A flat expense allowance without receipts.** `untested`
- Noticed: an allowance needs an approved expense regulation.
- By hand: book as allowance.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: 2451 for her receipts. Person: the allowance.

**Test.** Sandbox, receipts without firm payment, a transfer to her.

**Status.** untested

### IT-15 Her salary

**Goal.** «Mein Lohn jeden Monat.»

**Happy path.** Salary on 5000, social insurance on 5700 and 2270; no VAT; payroll itself is
outside the app.

**What goes wrong.**

**F1. Salary to 2451.** `untested`
- Noticed: no salary in the ER.
- By hand: 5000.
- By wish: «das ist mein Lohn».
- Learns: monthly transfer to her with «Lohn» is salary.

**F2. She asks for a payslip.** `untested`
- Noticed: an honest refusal.
- By hand: none.
- By wish: refused.
- Learns: nothing.

**Automation target.** Code: recurring salary. Person: the amount.

**Test.** Sandbox.

**Status.** untested

## The quarter and the year

### IT-16 Check the VAT return

**Goal.** «Stimmen die Auslandumsätze?»

**Happy path.** Ziffer 200 all sales; 221 services abroad; 303 the domestic ones at 8.1 %; 383
and 405 the acquisition tax.

**What goes wrong.**

**F1. Services abroad under 220.** `untested (cf. misreads-26)`
- Noticed: MWST.
- By hand: V0-E.
- By wish: works.
- Learns: OW-30.

**F2. An EUR sale counted at the invoice rate, not the payment rate.** `untested`
- Noticed: the figure differs from the bank.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: all.

**Test.** Sandbox on `demo-consulting/`.

**Status.** untested

### IT-17 Year-end: open invoices and work not yet invoiced

**Goal.** «Im Dezember gearbeitet, im Januar verrechnet.»

**Happy path.** Abschluss proposes receivables (1100) for invoices open on 31.12., accrued income
(1301) for December work invoiced in January, the EUR ones at the year-end rate; all reversed in
the new year.

**What goes wrong.**

**F1. The receivable in EUR at the invoice rate.** `untested`
- Noticed: the year-end rate should be used.
- By hand: change the amount.
- By wish: none.
- Learns: nothing.

**F2. Not reversed in January.** `untested`
- Noticed: the sale counted twice.
- By hand: reverse.
- By wish: none.
- Learns: year-end accruals reverse by themselves.

**Automation target.** Code: proposals, reversal. Person: the work not yet invoiced.

**Test.** Sandbox, year-end dry run.

**Status.** untested

## More corner cases

### IT-18 Cancel an issued invoice

**Goal.** «Die Rechnung ging an die falsche Firma.»

**Happy path.** «Stornieren»: the number stays taken, a Storno-Mitteilung as PDF; a new invoice
to the right client.

**What goes wrong.**

**F1. The cancelled invoice is paid anyway.** `untested`
- Noticed: «Rückfrage» on the payment (invoices.cancelHint).
- By hand: link to the new invoice, or refund.
- By wish: none.
- Learns: nothing.

**F2. She deletes the invoice instead.** `untested`
- Noticed: an issued invoice cannot be deleted; the number sequence keeps no gap.
- By hand: Storno.
- By wish: «lösch die Rechnung» answers with Storno.
- Learns: nothing.

**Automation target.** Code: numbers. Person: why.

**Test.** Sandbox, issue and cancel.

**Status.** untested

### IT-19 A reminder in English

**Goal.** «Der Kunde in Wien zahlt nicht.»

**Happy path.** «1. Mahnung» in the invoice's language, with the original currency and the new
due date.

**What goes wrong.**

**F1. The reminder in German for an English invoice.** `untested`
- Noticed: the draft's language.
- By hand: switch the language.
- By wish: «auf Englisch».
- Learns: the client's language.

**F2. The client paid in the meantime to the CHF account.** `untested`
- Noticed: IT-03; the app checks open payments first.
- By hand: cancel the reminder.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: overdue list and language. Person: whether to remind.

**Test.** Sandbox, an overdue EUR invoice.

**Status.** untested

### IT-20 The office in her flat

**Goal.** «Ich arbeite von zu Hause, die Firma zahlt mir Miete.»

**Happy path.** A rent agreement with the owner: the monthly rent to her books on 6000 against the
bank, no VAT; she declares it privately.

**What goes wrong.**

**F1. Booked as salary.** `untested`
- Noticed: AHV-relevant.
- By hand: 6000.
- By wish: «das ist die Miete fürs Büro».
- Learns: monthly «Miete» to her is rent.

**F2. Booked to 2451.** `untested`
- Noticed: no rent cost.
- By hand: 6000.
- By wish: none.
- Learns: same.

**Automation target.** Code: recurring rule. Person: the agreement.

**Test.** Sandbox, a monthly transfer to the owner with «Miete».

**Status.** untested

### IT-21 A subcontractor abroad

**Goal.** «Ein Freelancer in Polen hat mir einen Teil gemacht.»

**Happy path.** The service from abroad is subject to acquisition tax (383) and deducted (405);
the cost in EUR at the payment day's rate.

**What goes wrong.**

**F1. No acquisition tax.** `untested`
- Noticed: the return warns (WS-11).
- By hand: the code.
- By wish: «das ist ein Freelancer im Ausland».
- Learns: the supplier is abroad.

**F2. His invoice shows Polish VAT by mistake.** `untested`
- Noticed: foreign VAT is never Swiss input tax.
- By hand: ask him for a corrected invoice.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the code. Person: nothing.

**Test.** Sandbox, a made-up EUR invoice from abroad.

**Status.** untested

### IT-22 The client wants a changed invoice

**Goal.** «Der Kunde braucht seine Bestellnummer auf der Rechnung.»

**Happy path.** A text change after issue that changes no figure: a corrected copy with the same
number and amount, logged; a figure change needs a Storno (IT-18).

**What goes wrong.**

**F1. She changes the amount the same way.** `untested`
- Noticed: refused: figures change only by Storno or Gutschrift.
- By hand: Storno.
- By wish: none.
- Learns: nothing.

**F2. The QR reference changes on the copy.** `untested`
- Noticed: the payment would not match.
- By hand: none; the reference stays.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: what may change after issue. Person: the text.

**Test.** Sandbox, an issued invoice, add a reference text.

**Status.** untested

### IT-23 The Wise EUR account at year-end

**Goal.** «Wieviel ist mein Euro-Konto am 31.12. wert?»

**Happy path.** `year:close` books the exchange difference of the EUR account on 31.12. (6960),
the EUR balance times the ESTV year-end rate (WS-13).

**What goes wrong.**

**F1. The December Wise statement is missing.** `untested`
- Noticed: the year-end checklist: the balance cannot be checked.
- By hand: download it.
- By wish: none.
- Learns: nothing.

**F2. A card payment of 31.12. settles on 2.1.** `untested`
- Noticed: the bank's date counts.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: all.

**Test.** Sandbox on `demo-consulting/`, year-end dry run.

**Status.** untested

### IT-24 A business car, partly private

**Goal.** «Das Auto der Firma brauche ich auch privat.»

**Happy path.** At year-end the private share (0.9 % of the price per month, the ESTV flat rate)
books to 2451 with K81-B (Ziffer 415).

**What goes wrong.**

**F1. No private share booked.** `untested`
- Noticed: the year-end checklist lists «Privatanteil».
- By hand: Abschluss › Erfassen.
- By wish: «rechne den Privatanteil fürs Auto».
- Learns: the car and its price, kept for next year.

**F2. Every fuel receipt split instead.** `untested`
- Noticed: double reduction with the flat rate.
- By hand: undo the splits.
- By wish: none.
- Learns: flat rate or split, never both.

**Automation target.** Code: the flat rate. Person: the price, the choice.

**Test.** Sandbox, year-end with a car on 1530.

**Status.** untested

## Extending the automation

| id | Eva says | Becomes | The next case must | Status |
|---|---|---|---|---|
| IT-X01 | «Rechnungen an Firmen in Deutschland immer in Euro, ohne MWST, mit Reverse-Charge-Hinweis» | an invoice rule by client country | the next draft for a German client | `untested` |
| IT-X02 | «schreib Rechnungen an ausländische Kunden auf Englisch» | an invoice language rule | the next draft in English | `untested` |
| IT-X03 | «Bankspesen unter 20 Euro bei Kundenzahlungen einfach ausbuchen» | a rule for short payments | the next short payment settled with a fee booking | `untested` |
| IT-X04 | «die Cloud-Abos immer mit Bezugsteuer» | a supplier rule | 383 and 405 on the next bill | `untested` |
| IT-X05 | «zeig mir die offenen Rechnungen pro Kunde» | a report | the list with amounts in their currency | `untested` |
| IT-X06 | «erinnere mich, wenn eine Rechnung 10 Tage überfällig ist» | a schedule with a task | a task on day 10 | `untested` |
| IT-X07 | «der Monatslohn ist immer Lohn, auch ohne Text» | a recurring rule | the next monthly transfer on 5000 | `untested` |
