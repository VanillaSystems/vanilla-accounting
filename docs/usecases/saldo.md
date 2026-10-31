# A firm on the Saldosteuersatz: Schreinerei Ammann GmbH

**Not supported yet.** Setup says so today: «The Saldosteuersatz method is not supported yet:
the return the app writes is the effective one (input tax per receipt).» The usability test
found that most small trades firms settle this way (usability#10), so this is the largest group
the app turns away. This page says what they need, as test cases for the day it is built.

Peter Ammann runs a joinery GmbH with three people. The firm settles VAT with the ESTV's flat
rates (Saldosteuersätze): a rate on the gross turnover per activity, no input tax per receipt,
half-yearly returns. The VAT codes for it exist in the module (family «F», Ziffern 322 to 333,
the tax credits of Ziffer 470/471); the return and setup do not.

Surface: a fresh VM, setup with «Saldosteuersatz» (scenario other-firms).

Format and status: [README.md](README.md).

### SS-01 Setup says honestly what works

**Goal.** «Wir rechnen mit Saldosteuersatz ab.»

**Happy path.** Today: the answer says the app is not for the firm yet. Later: the method, the
approved rates per activity, half-yearly periods.

**What goes wrong.**

**F1. The note tells her to set up the books again after switching method.** `fails (usability#10)`
- Noticed: «rerun npm run init», a command she cannot run.
- By hand: none.
- By wish: none.
- Learns: plain words and no commands.

**F2. She picks «effektiv» to get in.** `untested`
- Noticed: the app files effective returns the ESTV will not accept from her.
- By hand: none.
- By wish: none.
- Learns: setup warns that the method must match the ESTV's register.

**Automation target.** Code: the setup answer. Person: the method.

**Test.** VM `vanilla-clean`, setup «Saldosteuersatz».

**Status.** fails (usability#10)

### SS-02 Book sales at the flat rate

**Goal.** «Die Küche für Familie Brunner, mit 8.1 % auf der Rechnung.»

**Happy path.** The invoice shows 8.1 % to the customer; the books hold the gross sale with the
firm's flat-rate code; the return applies the approved rate to the gross turnover.

**What goes wrong.**

**F1. The sale booked with the effective code V81.** `not supported yet`
- Noticed: the return would compute 8.1 % net.
- By hand: the F-code.
- By wish: none.
- Learns: all sales carry the firm's flat rate.

**F2. Two activities with two rates (joinery and trading).** `not supported yet`
- Noticed: one rate for all.
- By hand: the code per line.
- By wish: «der Möbelhandel hat den anderen Satz».
- Learns: the activity per customer or item.

**Automation target.** Code: the rate per activity. Person: which activity.

**Test.** When built.

**Status.** not supported yet

### SS-03 Purchases without input tax

**Goal.** «Holz eingekauft, mit MWST drauf.»

**Happy path.** The receipt's VAT is part of the cost; no input-tax code; the receipt is still
kept and matched.

**What goes wrong.**

**F1. Input tax claimed.** `not supported yet`
- Noticed: Ziffer 400 in a flat-rate firm.
- By hand: no code.
- By wish: none.
- Learns: no input tax in this firm.

**F2. An asset bought: no input tax either.** `not supported yet`
- Noticed: same.
- By hand: same.
- By wish: none.
- Learns: same.

**Automation target.** Code: no input tax. Person: nothing.

**Test.** When built.

**Status.** not supported yet

### SS-04 The half-yearly return

**Goal.** «Die Abrechnung fürs erste Halbjahr.»

**Happy path.** Form for the flat-rate method: turnover per rate (Ziffern 322 to 333), the tax
per rate, credits (470/471), what to pay; the XML for the portal.

**What goes wrong.**

**F1. Quarterly periods.** `not supported yet`
- Noticed: the periods module asks four returns.
- By hand: none.
- By wish: none.
- Learns: half-yearly periods.

**F2. Turnover counted net.** `not supported yet`
- Noticed: the flat rate applies to gross turnover.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the return. Person: file.

**Test.** When built.

**Status.** not supported yet

### SS-05 Services bought from abroad

**Goal.** «Die Software für die Maschine kommt aus Deutschland.»

**Happy path.** Acquisition tax is declared at the normal rate also by a flat-rate firm, without
deduction.

**What goes wrong.**

**F1. Not declared.** `not supported yet`
- Noticed: no acquisition tax in the return.
- By hand: the code.
- By wish: none.
- Learns: supplier abroad.

**F2. Deducted as if effective.** `not supported yet`
- Noticed: no deduction under flat rates.
- By hand: none.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the code.

**Test.** When built.

**Status.** not supported yet

### SS-06 Exports under flat rates

**Goal.** «Ein Schrank für einen Kunden in Österreich.»

**Happy path.** Exports declared, with the export proof; the tax credit for them handled as the
flat-rate rules say (Ziffer 470/471 for the forms 1050/1055).

**What goes wrong.**

**F1. Flat rate applied to the export.** `not supported yet`
- Noticed: tax on a sale abroad.
- By hand: none.
- By wish: none.
- Learns: nothing.

**F2. No export proof.** `not supported yet`
- Noticed: WS-06.
- By hand: drop it.
- By wish: none.
- Learns: nothing.

**Automation target.** Code: the credit. Person: the proof.

**Test.** When built.

**Status.** not supported yet

### SS-07 Switching method

**Goal.** «Ab nächstem Jahr rechnen wir effektiv ab.»

**Happy path.** At the start of a year the method changes; the books keep both histories; the
input tax on goods in stock and assets is claimed once (Einlageentsteuerung), with the
Treuhänder.

**What goes wrong.**

**F1. The app asks to set up new books.** `fails (usability#10)`
- Noticed: the note says so.
- By hand: none.
- By wish: none.
- Learns: a method has a start date.

**F2. The past returns recomputed with the new method.** `not supported yet`
- Noticed: filed quarters change.
- By hand: none.
- By wish: none.
- Learns: a filed period never changes.

**Automation target.** Code: methods per period. Person: the date.

**Test.** When built.

**Status.** fails (usability#10)

### SS-08 A private share under flat rates

**Goal.** «Der Lieferwagen ist auch privat.»

**Happy path.** No K81-B (no input tax was claimed); the private share books without VAT, or as
the flat-rate rules require.

**What goes wrong.**

**F1. K81-B booked.** `not supported yet`
- Noticed: a K-code in a flat-rate firm.
- By hand: none.
- By wish: none.
- Learns: no K-codes.

**F2. The year-end checklist lists K81-B.** `not supported yet`
- Noticed: the item.
- By hand: «Nicht nötig».
- By wish: none.
- Learns: the checklist per method.

**Automation target.** Code: per method. Person: nothing.

**Test.** When built.

**Status.** not supported yet

## Extending the automation

| id | Peter says | Becomes | The next case must | Status |
|---|---|---|---|---|
| SS-X01 | «Möbelhandel immer mit dem zweiten Saldosteuersatz» | a rule per activity | the next trading sale at that rate | `not supported yet` |
| SS-X02 | «erinnere mich im Juli und im Januar an die Abrechnung» | a schedule | tasks on those dates | `not supported yet` |
| SS-X03 | «zeig mir, ob die effektive Methode günstiger wäre» | a comparison report | both figures for the last year | `not supported yet` |
