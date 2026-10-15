# A firm not registered for VAT: Bella, Coiffeur Salon Bella

**Not supported yet.** Setup says so today: «Eine Buchhaltung ohne MWST kann die App noch nicht
führen: heute trägt jede Buchung einen MWST-Code und jedes Quartal wird abgerechnet.» This page
says what such a firm needs, as test cases for the day it is built.

Bella runs a hair salon as a sole proprietorship (Einzelfirma), below the turnover threshold, so
she is not in the VAT register. Customers pay cash, by card terminal and by TWINT. She buys
products from a Swiss wholesaler. Her books serve her income tax return and her AHV as a
self-employed person. A Treuhänder does the tax return.

Surface: a fresh VM, setup with «nein» on «Im MWST-Register eingetragen?» (scenario
other-firms).

Format and status: [README.md](README.md).

### NV-01 Setup says honestly what works

**Goal.** «Ich bin nicht mehrwertsteuerpflichtig.»

**Happy path.** Today: the setup answer says the app is not for her yet, before she has typed
everything. Later: books without VAT codes, no VAT area, a yearly close.

**What goes wrong.**

**F1. She learns it only at the end of setup.** `untested`
- Noticed: the refusal shows on the answer, at once (desktop.newIntro promises it).
- By hand: none.
- By wish: none.
- Learns: nothing.

**F2. She says «ja» to get in.** `untested`
- Noticed: a UID with MWST is asked; she has none.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the setup answer. Person: her status.

**Test.** VM `vanilla-clean`, setup «nein».

**Status.** not supported yet

### NV-02 Book without VAT

**Goal.** «Ich will einfach Einnahmen und Ausgaben.»

**Happy path.** Every entry without a VAT code; the receipt's VAT is part of the cost; no input
tax; reports without VAT.

**What goes wrong.**

**F1. A receipt with Swiss VAT booked with input tax.** `not supported yet`
- Noticed: the firm has no input tax at all.
- By hand: no code.
- By wish: none.
- Learns: no codes in this firm.

**F2. The VAT area and the VAT checklist still show.** `not supported yet`
- Noticed: she is asked to file.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: no codes. Person: nothing.

**Test.** When built.

**Status.** not supported yet

### NV-03 Watch the threshold

**Goal.** «Sag mir, wenn ich mich anmelden muss.»

**Happy path.** The turnover of the last twelve months against the registration threshold; a
warning ahead of it; what to do.

**What goes wrong.**

**F1. Tips and non-taxable income counted.** `not supported yet`
- Noticed: the turnover too high.
- By hand: mark them.
- By wish: none.
- Learns: nothing.

**F2. She crosses it mid-year.** `not supported yet`
- Noticed: NV-08.
- By hand: register.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the sum. Person: register.

**Test.** When built.

**Status.** not supported yet

### NV-04 The owner's money in an Einzelfirma

**Goal.** «Ich nehme jeden Monat Geld für mich raus.»

**Happy path.** Withdrawals to the Privatkonto (not a Kontokorrent, no salary for the owner);
private use booked there.

**What goes wrong.**

**F1. Withdrawals booked as salary.** `not supported yet`
- Noticed: a salary in an Einzelfirma.
- By hand: Privatkonto.
- By wish: «das ist mein Privatbezug».
- Learns: transfers to her are withdrawals.

**F2. Private shares with a K-code.** `not supported yet`
- Noticed: no VAT, so no K-code.
- By hand: no code.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the legal form's accounts. Person: nothing.

**Test.** When built.

**Status.** not supported yet

### NV-05 Daily cash takings

**Goal.** «Am Abend zähle ich die Kasse.»

**Happy path.** A cash book: daily takings per day, cash deposited at the bank as a transfer,
the cash count checked.

**What goes wrong.**

**F1. The deposit booked as income again.** `not supported yet`
- Noticed: income twice.
- By hand: a transfer.
- By wish: none.
- Learns: deposits are transfers.

**F2. The cash count differs.** `not supported yet`
- Noticed: the difference shown.
- By hand: book the difference.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the cash book. Person: the count.

**Test.** When built.

**Status.** not supported yet

### NV-06 Card terminal and TWINT payouts

**Goal.** «Das Kartengerät zahlt alle paar Tage aus, minus Gebühr.»

**Happy path.** Like a webshop payout (WS-02), without VAT: gross takings, fees as a cost.

**What goes wrong.**

**F1. The net payout booked as takings.** `not supported yet`
- Noticed: fees missing.
- By hand: gross up.
- By wish: none.
- Learns: the terminal's payouts.

**F2. Card takings counted in the cash book too.** `not supported yet`
- Noticed: income twice.
- By hand: remove.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: payout parse. Person: nothing.

**Test.** When built.

**Status.** not supported yet

### NV-07 Year-end of an Einzelfirma

**Goal.** «Was braucht mein Treuhänder für die Steuererklärung?»

**Happy path.** Bilanz and ER, the private account, the AHV base; depreciation; the result to
the owner's equity.

**What goes wrong.**

**F1. The profit allocation of a GmbH offered.** `not supported yet`
- Noticed: dividends in an Einzelfirma.
- By hand: none.
- By wish: none.
- Learns: the legal form's year-end.

**F2. Her own AHV contributions booked as cost.** `not supported yet`
- Noticed: they are private in an Einzelfirma.
- By hand: Privatkonto.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the year-end per legal form. Person: nothing.

**Test.** When built.

**Status.** not supported yet

### NV-08 She registers for VAT mid-year

**Goal.** «Ab 1. Juli bin ich im Register.»

**Happy path.** From that date the books carry VAT codes and quarters are filed; before it, not.

**What goes wrong.**

**F1. VAT codes on the first half.** `not supported yet`
- Noticed: a return for a period before registration.
- By hand: none.
- By wish: none.
- Learns: the registration date.

**F2. Stock bought before the registration (Einlageentsteuerung).** `not supported yet`
- Noticed: input tax on goods in stock can be claimed afterwards.
- By hand: the Treuhänder.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the date. Person: the date.

**Test.** When built.

**Status.** not supported yet

## Extending the automation

| id | Bella says | Becomes | The next case must | Status |
|---|---|---|---|---|
| NV-X01 | «TWINT-Auszahlungen immer aufteilen in Einnahmen und Gebühren» | a payout rule | the next payout split | `not supported yet` |
| NV-X02 | «sag mir jeden Monat, wo ich beim Umsatz stehe» | a report on a schedule | the figure on the first of each month | `not supported yet` |
| NV-X03 | «Produkte vom Grossisten sind Materialaufwand» | a supplier rule | the next invoice on the right account | `not supported yet` |
