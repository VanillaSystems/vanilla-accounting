# Owner of a small webshop: Nadia, Kleiner Webshop GmbH

Nadia Brun runs a webshop GmbH alone: she sells online through a shop system with a payment
provider (Shopify Payments, Stripe, PayPal), buys goods abroad, has them shipped by a courier
who also clears customs, and pays suppliers from a Wise account in EUR and USD. Registered for
VAT, effective method, cash basis, quarterly. She is quicker with software than Sandra, but
has no accounting training. Sales arrive as payouts: one bank credit for many orders, minus the
provider's fees and refunds.

Surfaces: a fresh VM with setup preset «Webshop» (scenario other-firms), and the sandbox on
`demo/` (Muster Kaffee GmbH: Raiffeisen CHF, Wise EUR, a manual Kontokorrent). Payout reports,
customs invoices and Wise exports are made up and added to the persona files when a test needs
them. No case here has run in a persona test yet.

Format and status: [README.md](README.md).

## Setup

### WS-01 Set up a webshop's books

**Goal.** «Ich verkaufe online, mit Shopify, und habe ein Wise-Konto in Euro.»

**Happy path.** Setup with the Webshop preset: CHF bank, Wise EUR (and USD), the payout clearing
account (1093, «Durchlaufkonto») for the payment provider, revenue accounts for goods, an
inventory account.

**What goes wrong.**

**F1. The Wise account in two currencies is one IBAN.** `untested`
- Noticed: setup must take one bank account per currency.
- By hand: add the second currency in Firma › Bankkonten.
- By wish: «ich habe bei Wise auch Dollar».
- Learns: nothing.

**F2. She does not know what the clearing account is.** `untested (usability#11 names the jargon)`
- Noticed: «Durchlaufkonto (1093)» frightens.
- By hand: accept the default.
- By wish: «was ist das Durchlaufkonto?».
- Learns: explained in words: «hier liegen deine Verkäufe, bis Shopify sie auszahlt».

**Automation target.** Code: the preset. Person: which providers and currencies she uses.

**Test.** VM `vanilla-clean`, setup «Webshop».

**Status.** untested

## Sales

### WS-02 A payout: many orders, fees and refunds in one credit

**Goal.** «Shopify hat ausbezahlt. Was davon ist Umsatz?»

**Happy path.** The provider's payout report lists the orders, refunds and fees. Each order is
booked as sale on the clearing account (1093) with V81 at the order date; the fees as expense
without Swiss VAT (or with acquisition tax when the provider is abroad); the bank credit clears
1093. The clearing account is zero after each payout.

**What goes wrong.**

**F1. The payout is booked as one sale of the net amount.** `untested`
- Noticed: turnover too low by the fees; 1093 not used.
- By hand: split into gross sales and fees.
- By wish: «das ist eine Auszahlung, nicht ein Verkauf».
- Learns: payments from this provider are payouts.

**F2. The payout report is missing.** `untested`
- Noticed: «Auszahlung ohne Bericht» in Braucht dich.
- By hand: download the report and drop it.
- By wish: «hol den Auszahlungsbericht» (a browser source, not built yet).
- Learns: nothing.

**F3. The payout includes a refund of an earlier quarter's order.** `untested`
- Noticed: a negative line.
- By hand: book -V81 at the refund date.
- By wish: none.
- Learns: refunds reduce turnover in the quarter they are paid.

**F4. 1093 does not reach zero.** `untested`
- Noticed: the clearing account shows a balance after the payout.
- By hand: find the order not in the report.
- By wish: «warum ist das Durchlaufkonto nicht null?».
- Learns: nothing.

**Automation target.** Code: parse the payout report, book each line. Person: nothing.

**Test.** Sandbox on `demo/` plus a made-up payout report and bank credit.

**Status.** untested

### WS-03 Orders that span the quarter's end

**Goal.** «Die Bestellung war am 30. September, die Auszahlung am 2. Oktober.»

**Happy path.** On cash basis the VAT falls in the quarter of the payment received. The order is
booked on 1093 with its order date (as classify does), and the return counts the sale where the
money came in, consistently every quarter.

**What goes wrong.**

**F1. The order counts in Q3 and the payout in Q4 again.** `untested`
- Noticed: turnover counted twice across quarters.
- By hand: none; a bug.
- By wish: «warum ist der Umsatz doppelt?».
- Learns: nothing.

**F2. The AI moves the bank credit to the order date.** `untested`
- Noticed: refused (cash-basis rule, d87d8f5).
- By hand: none.
- By wish: refused.
- Learns: nothing.

**Automation target.** Code: dates. Person: nothing.

**Test.** A made-up payout across the quarter's end.

**Status.** untested

### WS-04 A customer returns goods

**Goal.** «Die Kundin hat die Ware zurückgeschickt, ich habe ihr das Geld zurückgegeben.»

**Happy path.** The refund (in the next payout or as its own debit) books -V81 on revenue, the
VAT reduced in the quarter of the refund; the goods back into stock.

**What goes wrong.**

**F1. The refund is booked as an expense with input tax.** `untested`
- Noticed: Ziffer 400 grows.
- By hand: revenue account, -V81.
- By wish: «das ist eine Rückerstattung an eine Kundin».
- Learns: refunds of the provider are sales reductions.

**F2. A partial refund (one item of three).** `untested`
- Noticed: the amount differs from the order.
- By hand: amount by hand.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: refund lines in the report. Person: nothing.

**Test.** A payout report with a refund line.

**Status.** untested

### WS-05 A chargeback

**Goal.** «Eine Kundin hat bei der Kreditkarte reklamiert.»

**Happy path.** The provider deducts the amount and a dispute fee; the sale is reduced; if the
dispute is won, the money comes back in a later payout.

**What goes wrong.**

**F1. The dispute fee booked with VAT.** `untested`
- Noticed: input tax on a foreign fee.
- By hand: no code.
- By wish: none.
- Learns: nothing.

**F2. Won later, booked as new sale.** `untested`
- Noticed: turnover too high.
- By hand: reverse the reduction instead.
- By wish: «den Fall habe ich gewonnen».
- Learns: nothing.

**Automation target.** Code: report lines. Person: nothing.

**Test.** A payout report with a dispute.

**Status.** untested

### WS-06 Sales to customers abroad

**Goal.** «Ich schicke auch nach Deutschland.»

**Happy path.** Goods shipped abroad are exports (V0, Ziffer 220) with the export proof (the
courier's or post's export declaration); domestic orders stay V81.

**What goes wrong.**

**F1. A foreign order without export proof booked V0.** `untested`
- Noticed: «Export ohne Ausfuhrnachweis» warning.
- By hand: add the proof, or book V81.
- By wish: none.
- Learns: nothing.

**F2. A foreign customer's order shipped to a Swiss address.** `untested`
- Noticed: the address decides, not the customer.
- By hand: V81.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the shipping country from the report. Person: the proof.

**Test.** A payout report with a shipping country column.

**Status.** untested

### WS-07 Gift cards

**Goal.** «Ich verkaufe Gutscheine.»

**Happy path.** A gift card sold is not yet a sale: it is a liability (2030 or a gift-card
account) without VAT; the VAT falls when it is redeemed for goods.

**What goes wrong.**

**F1. The gift card booked as sale with VAT.** `untested`
- Noticed: the report line says «Gift card».
- By hand: move to the liability.
- By wish: «das war ein Gutschein».
- Learns: gift-card lines are liabilities.

**F2. A gift card never redeemed.** `untested`
- Noticed: an old balance at year-end.
- By hand: the Treuhänder decides.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: report line kinds. Person: expiry policy.

**Test.** A payout report with a gift-card line.

**Status.** untested

## Buying abroad

### WS-08 A supplier invoice in USD or EUR without Swiss VAT

**Goal.** «Die Ware kommt aus China, bezahlt in Dollar über Wise.»

**Happy path.** Booked M0 at the CHF value of the payment day (the ESTV daily rate); the import
VAT comes on the customs invoice (WS-09).

**What goes wrong.**

**F1. The rate is the flat old rate.** `untested`
- Noticed: «Kurs» on the booking names its source.
- By hand: fetch the rates; the booking follows.
- By wish: «nimm den ESTV-Kurs vom Zahltag».
- Learns: nothing.

**F2. The rate of that day is not published yet.** `untested`
- Noticed: «Kurs fehlt» on the booking.
- By hand: wait, or type the rate.
- By wish: none.
- Learns: booked again when the rate comes.

**F3. One order paid partly from EUR and partly from CHF on Wise.** `untested`
- Noticed: two payments, one receipt.
- By hand: link both.
- By wish: «das ist eine Zahlung über zwei Währungen».
- Learns: Wise splits stay grouped.

**Automation target.** Code: rate per day, grouping. Person: nothing.

**Test.** Sandbox on `demo/`: a Wise EUR debit and a made-up USD invoice.

**Status.** untested

### WS-09 The customs invoice

**Goal.** «Der Kurier will Zoll und MWST für die Sendung.»

**Happy path.** The courier's customs invoice splits into duty (4020, no VAT), import VAT (4030
or straight as input tax, Ziffer 405, with the customs receipt) and the advance fee (with Swiss
VAT, I81); one payment, three bookings.

**What goes wrong.**

**F1. All of it as one expense with I81.** `untested`
- Noticed: input tax on duty.
- By hand: split.
- By wish: «das ist eine Zollrechnung».
- Learns: this courier's customs invoices split this way.

**F2. The import VAT claimed without the customs assessment.** `untested`
- Noticed: the courier's invoice alone is not proof.
- By hand: drop the customs assessment and link it.
- By wish: none.
- Learns: nothing.

**F3. Freight and customs on one payment, two invoices.** `untested`
- Noticed: OW-24 pattern.
- By hand: link both.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: lines of a known courier. AI: an unknown one. Person: nothing.

**Test.** A made-up customs invoice and its payment.

**Status.** untested

### WS-10 One courier invoice for several shipments

**Goal.** «Die Frachtrechnung hat fünf Sendungen drauf.»

**Happy path.** One receipt, one payment, booked as freight; the shipments listed in the
description.

**What goes wrong.**

**F1. Matched to the wrong payment of the same courier.** `untested`
- Noticed: amounts differ.
- By hand: relink.
- By wish: none.
- Learns: nothing.

**F2. The courier bills in CHF, she pays in EUR from Wise.** `untested`
- Noticed: the amounts differ by the rate.
- By hand: link; the CHF amount is the receipt's.
- By wish: none.
- Learns: Wise's statement shows the original amount.

**Automation target.** Code: cross-currency matching. Person: nothing.

**Test.** A made-up freight invoice in CHF and a Wise EUR debit.

**Status.** untested

### WS-11 Software and services from abroad

**Goal.** «Die Shop-Apps und die Werbung zahle ich in Dollar.»

**Happy path.** Services bought from abroad are subject to acquisition tax (Bezugsteuer):
declared in Ziffer 383 and, for a firm with full input tax deduction, claimed back in Ziffer
405 in the same quarter.

**What goes wrong.**

**F1. Booked I0, no acquisition tax.** `untested`
- Noticed: the return should warn «Leistungen aus dem Ausland ohne Bezugsteuer».
- By hand: the acquisition-tax code.
- By wish: «das ist eine Dienstleistung aus dem Ausland».
- Learns: this supplier is a foreign service provider.

**F2. A foreign supplier that charges Swiss VAT (registered in Switzerland).** `untested`
- Noticed: the invoice shows a CHE number.
- By hand: I81, no acquisition tax.
- By wish: none.
- Learns: the receipt decides.

**Automation target.** Code: the code by supplier country and VAT number. Person: nothing.

**Test.** A made-up USD invoice of an ad platform.

**Status.** untested

## Money accounts

### WS-12 Import the Wise statements

**Goal.** «Bei Wise gibt es pro Währung einen Auszug.»

**Happy path.** Each currency's export is read; card payments that Wise split across currencies
stay one purchase; transfers between her own accounts are transfers, not expenses.

**What goes wrong.**

**F1. A transfer CHF to EUR booked as expense and income.** `untested`
- Noticed: turnover and costs both grow.
- By hand: book as transfer (1020/1021).
- By wish: «das ist ein Wechsel zwischen meinen Konten».
- Learns: own IBANs are transfers.

**F2. The same currency's export twice with overlapping days.** `untested`
- Noticed: «schon da».
- By hand: nothing.
- By wish: none.
- Learns: nothing.

**F3. A Wise card fee in EUR.** `untested`
- Noticed: a small debit without receipt.
- By hand: «braucht keinen», bank fees.
- By wish: none.
- Learns: Wise fees need no receipt.

**Automation target.** Code: all. Person: nothing.

**Test.** Sandbox on `demo/`.

**Status.** untested

### WS-13 The exchange difference

**Goal.** «Warum stimmt das Euro-Konto in Franken nicht?»

**Happy path.** Within the year, each EUR payment is booked at its day's rate; at year-end
`year:close` books the exchange difference (6960) from the year-end rate.

**What goes wrong.**

**F1. The year-end rate is not published yet.** `untested`
- Noticed: the year-end checklist says so.
- By hand: fetch later.
- By wish: none.
- Learns: nothing.

**F2. She books the difference by hand during the year.** `untested`
- Noticed: year:close would book it again.
- By hand: delete hers.
- By wish: none.
- Learns: year:close replaces its own entry, never adds a second.

**Automation target.** Code: all.

**Test.** Sandbox on `demo/`, year-end dry run.

**Status.** untested

### WS-14 A PayPal balance

**Goal.** «Ein paar Kunden zahlen mit PayPal, das Geld bleibt dort.»

**Happy path.** PayPal is a money account of its own; its export is read; transfers to the bank
are transfers.

**What goes wrong.**

**F1. PayPal not set up; payouts from PayPal look like sales.** `untested`
- Noticed: sales without orders.
- By hand: add PayPal as an account.
- By wish: «ich habe auch PayPal».
- Learns: nothing.

**F2. A purchase paid from the PayPal balance.** `untested`
- Noticed: a receipt without a bank payment.
- By hand: link to the PayPal payment.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the account. Person: say she has one.

**Test.** A made-up PayPal export.

**Status.** untested

## Goods and stock

### WS-15 Goods bought for resale

**Goal.** «Das ist Ware für den Verkauf, nicht Büromaterial.»

**Happy path.** Goods for resale book to 4200 (Warenaufwand) with M81 or M0; inventory change at
year-end.

**What goes wrong.**

**F1. Booked on office costs.** `untested`
- Noticed: the margin looks wrong.
- By hand: account 4200.
- By wish: «Ware für den Shop immer auf Warenaufwand».
- Learns: this supplier sells goods for resale.

**F2. Samples taken from stock for her own use.** `untested`
- Noticed: she says so.
- By hand: private withdrawal at cost, K81-B on the input tax.
- By wish: «ich habe zwei Packungen privat genommen».
- Learns: nothing.

**Automation target.** AI: which account. Person: private use.

**Test.** A made-up supplier invoice for goods.

**Status.** untested

### WS-16 The stock at year-end

**Goal.** «Am 31.12. habe ich noch Ware im Lager.»

**Happy path.** Abschluss › inventory change: she enters the stock value; the entry 1200 / 4200
(or the reverse) is booked on 31.12.

**What goes wrong.**

**F1. She enters the selling price, not the cost.** `untested`
- Noticed: a hint «zum Einstandspreis».
- By hand: correct.
- By wish: none.
- Learns: nothing.

**F2. Last year's stock not reversed.** `untested`
- Noticed: the change is the difference of two year-ends.
- By hand: the app computes the difference.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the entry. Person: the count.

**Test.** Sandbox on `demo/`, year-end.

**Status.** untested

## Receipts

### WS-17 Many small digital receipts by mail

**Goal.** «Die Rechnungen kommen alle per Mail.»

**Happy path.** The mailbox source collects attachments daily; each is read and matched.

**What goes wrong.**

**F1. The mail login expired.** `untested`
- Noticed: a task days before it fails (workflows.md, «Before it breaks»).
- By hand: sign in again.
- By wish: none.
- Learns: nothing.

**F2. The invoice is a link, not an attachment.** `untested`
- Noticed: «Mail ohne Anhang von …».
- By hand: download and drop.
- By wish: «hol die Rechnung von dem Link».
- Learns: this sender sends links (browser sources, not built yet).

**F3. An order summary instead of an invoice.** `untested`
- Noticed: no VAT number, «Bestellbestätigung».
- By hand: get the invoice.
- By wish: none.
- Learns: an order summary does not prove input tax.

**Automation target.** Code: collect, deduplicate. AI: kind. Person: sign in.

**Test.** VM with a made-up IMAP mailbox (mail-setup.md).

**Status.** untested

### WS-18 Invoices only in a portal

**Goal.** «Die Rechnung gibt es nur im Kundenkonto auf der Website.»

**Happy path.** A browser source fetches it with her signed-in session; or she downloads it.

**What goes wrong.**

**F1. The source does not exist yet.** `not supported yet`
- Noticed: the receipt stays missing.
- By hand: download and drop.
- By wish: «hol jeden Monat die Rechnung von …»: an honest «noch nicht».
- Learns: nothing yet.

**F2. The session expired.** `not supported yet`
- Noticed: a task to sign in.
- By hand: sign in.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the recorded script. Person: sign in.

**Test.** When the browser sources are built.

**Status.** not supported yet

## The quarter

### WS-19 Check the VAT return

**Goal.** «Stimmt die MWST? Der Shop sagt einen anderen Umsatz.»

**Happy path.** Ziffer 200 matches the shop's sales of the quarter (paid), minus refunds; 220 the
exports; 383 the acquisition tax; 405 its deduction.

**What goes wrong.**

**F1. The shop's report counts orders, the return counts payments.** `untested`
- Noticed: a difference of the orders not yet paid out.
- By hand: none; explained.
- By wish: «warum ist der Umsatz anders als im Shop?».
- Learns: nothing.

**F2. Acquisition tax missing.** `untested`
- Noticed: WS-11.
- By hand: the code.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the return. Person: trust it.

**Test.** Sandbox on `demo/`.

**Status.** untested

### WS-20 Private purchases with the firm's card

**Goal.** «Ich habe aus Versehen mit der Firmenkarte privat eingekauft.»

**Happy path.** The payment goes to 2451 without a VAT code.

**What goes wrong.**

**F1. The AI books it as an expense.** `untested`
- Noticed: she sees it.
- By hand: 2451.
- By wish: «das war privat».
- Learns: nothing.

**F2. She pays it back to the firm.** `untested`
- Noticed: a credit on the bank from her.
- By hand: 2451.
- By wish: none.
- Learns: her own name on a credit means Kontokorrent.

**Automation target.** AI: suggests. Person: decides.

**Test.** Sandbox, a made-up card payment.

**Status.** untested

## More corner cases

### WS-21 Shipping charged to the customer

**Goal.** «Der Kunde zahlt den Versand mit.»

**Happy path.** Shipping charged on an order is part of the sale and carries the sale's VAT
(V81 for a domestic order, V0 with the export); the courier's bill is a cost.

**What goes wrong.**

**F1. Shipping booked without VAT as a pass-through.** `untested`
- Noticed: the payout report's shipping column; turnover too low.
- By hand: include it in the sale.
- By wish: «Versand ist Teil vom Verkauf».
- Learns: shipping lines are sales.

**F2. Free-shipping orders with a negative shipping line.** `untested`
- Noticed: a discount line.
- By hand: a sales reduction.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: report columns. Person: nothing.

**Test.** A payout report with shipping lines.

**Status.** untested

### WS-22 Discount codes

**Goal.** «Ich hatte eine Aktion mit 20 % Rabatt.»

**Happy path.** The sale is booked at the price paid; the discount is not a cost.

**What goes wrong.**

**F1. Gross price booked as sale and the discount as marketing cost.** `untested`
- Noticed: turnover and VAT too high.
- By hand: book the net of discount.
- By wish: «Rabatt ist kein Aufwand».
- Learns: discount lines reduce the sale.

**F2. A 100 % code (a gift to an influencer).** `untested`
- Noticed: an order with zero price.
- By hand: private use or advertising gift (K81-B if above the gift limit).
- By wish: «das war ein Geschenk für Werbung».
- Learns: nothing.

**Automation target.** Code: report lines. Person: what a free order was.

**Test.** A payout report with discount lines.

**Status.** untested

### WS-23 Sales on a marketplace

**Goal.** «Ich verkaufe auch über einen Marktplatz, der zieht Provision ab.»

**Happy path.** Like a payout (WS-02): gross sales, commission as a cost (with Swiss VAT if the
marketplace is Swiss and shows it), the net credit clears the clearing account.

**What goes wrong.**

**F1. The commission netted away.** `untested`
- Noticed: turnover too low.
- By hand: gross up.
- By wish: «der Marktplatz zieht Provision ab».
- Learns: this payer is a marketplace.

**F2. The marketplace's monthly statement and the payouts do not match in time.** `untested`
- Noticed: the clearing account carries a balance at the quarter's end.
- By hand: explained by the timing.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: statement parse. Person: nothing.

**Test.** A made-up marketplace statement.

**Status.** untested

### WS-24 Goods damaged or written off

**Goal.** «Eine Lieferung kam kaputt an, die kann ich nicht verkaufen.»

**Happy path.** The loss is booked at cost; the input tax stays (the goods were for the
business); an insurance or supplier refund reduces the loss.

**What goes wrong.**

**F1. The AI reverses the input tax.** `untested`
- Noticed: a K-code on a business loss.
- By hand: remove.
- By wish: none.
- Learns: nothing.

**F2. The supplier refunds and the refund is booked as a sale.** `untested`
- Noticed: Ziffer 200 grows.
- By hand: -M81 on goods.
- By wish: «das ist die Rückerstattung vom Lieferanten».
- Learns: OW-27.

**Automation target.** AI: suggest. Person: what happened.

**Test.** Sandbox, a refund from a supplier.

**Status.** untested

### WS-25 The shop's order PDFs land among the receipts

**Goal.** «Der Shop schickt mir jede Bestellung als PDF.»

**Happy path.** Order confirmations from her own shop are her sales documents, not purchase
receipts: kept apart, linked to the payout, never a second sale.

**What goes wrong.**

**F1. Each order PDF waits as an unmatched receipt.** `untested`
- Noticed: dozens of «noch keine Zahlung».
- By hand: mark them as sales documents.
- By wish: «das sind meine eigenen Bestellungen».
- Learns: mail from her own shop is sales.

**F2. An order PDF is booked as an expense.** `untested`
- Noticed: input tax on her own sale.
- By hand: delete the booking.
- By wish: none.
- Learns: her own UID on a receipt means her own document.

**Automation target.** Code: her own UID and shop sender. Person: nothing.

**Test.** Made-up order PDFs with her own UID.

**Status.** untested

## Extending the automation

| id | Nadia says | Becomes | The next case must | Status |
|---|---|---|---|---|
| WS-X01 | «teil jede Shopify-Auszahlung in Verkäufe und Gebühren auf» | a payout rule (the provider is known) | the next payout booked through 1093 | `untested` |
| WS-X02 | «Gebühren von Stripe immer auf 6840» | a supplier rule | the next fees on 6840 | `untested` |
| WS-X03 | «frag mich bei Rückerstattungen über 200 Franken» | a task step | a big refund waits with the question | `untested` |
| WS-X04 | «die Zollrechnungen vom Kurier immer aufteilen» | a supplier rule | the next customs invoice split in three | `untested` |
| WS-X05 | «Werbung aus dem Ausland immer mit Bezugsteuer» | a rule by supplier country | 383 and 405 on the next ad bill | `untested` |
| WS-X06 | «zeig mir den Umsatz pro Land fürs Quartal» | a report | the figures with the orders behind them | `untested` |
| WS-X07 | «hol jeden Montag die Auszahlungsberichte» | a schedule (a browser source) | `not supported yet` until the sources are built | `not supported yet` |
| WS-X08 | «Wechsel zwischen meinen Wise-Konten nie als Aufwand» | a transfer rule | the next CHF to EUR as a transfer | `untested` |
