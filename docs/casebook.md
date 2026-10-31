# Casebook

The casebook shows how standard Swiss booking cases are booked: one invented case per booking
pattern, on account numbers of the Swiss KMU chart (`modules/ch/accounts.yaml`). Each case in
`examples/cases/` says when it applies and shows a receipt, the bank transaction, the journal
lines, the VAT code, the Ziffern of the VAT return it moves, the rule in `processes/*.guide.yaml`
and the law that decide it, and the usual mistakes.

The cases are ordered by how often a small services company meets them, then the cases of a
company that sells goods through a webshop.

## How the casebook stays right

- `npm run check-processes` validates every case: its rule ids exist, its accounts are in the
  chart, its VAT codes are ones the engine knows, a foreign amount carries the ESTV daily sell
  rate of its date, the lines match the bank transaction, a single-leg row has a `-2` code, a
  correction is dated after the quarter it corrects, and the declared Ziffern are what the
  engine computes. Every error message names the fix, including the Ziffern to write.
- `tests/casebook.test.ts` books every case into a copy of each shipped demo workspace and checks that
  the VAT return of its quarter moves by exactly the declared Ziffern.

## How the classifier uses it

A company with little history of its own (fewer than 100 rows of journal entries and prior-year
sample entries, `OWN_HISTORY_THRESHOLD` in `src/knowledge/cases.ts`) gets casebook examples in its
classify prompt. For each transaction, `selectCases` picks the four most similar cases without a
model: keywords in the bank text and receipts, the kind of counterparty the transaction implies,
the receipt's Swiss MWST, the direction and foreign currency. A case whose receipt contradicts the
transaction's receipts on Swiss MWST is never picked. One call carries at most eight cases, about
300 tokens each. Past the threshold, the company's own entries are the better examples.

## Adding a case

1. Run `npm run mine-cases` on a workspace to list its booking patterns, most frequent first. It
   prints no names, amounts or references.
2. Write `examples/cases/<id>.yaml` like the cases below, with invented names and amounts. Give it
   a `rank` of its own.
3. Run `npm run check-processes` and copy the Ziffern it reports into `ziffern` and `payable`.
4. Add the case to the index below. `npm test` fails while a case is missing here.

## Services company

| # | Case | Codes | Ziffern |
|---:|---|---|---|
| 1 | [Monthly salary of the owner-employee](../examples/cases/salary-payment.yaml) | none | none |
| 2 | [AHV/IV/EO/ALV quarterly advance to the Ausgleichskasse](../examples/cases/ahv-akonto.yaml) | none | none |
| 3 | [Pension fund (BVG) premium](../examples/cases/bvg-premium.yaml) | I0, none | none |
| 4 | [Accident (UVG) and sick-pay insurance premium](../examples/cases/accident-sickness-insurance.yaml) | I0 | none |
| 5 | [Consulting fee paid by a Swiss client (8.1%)](../examples/cases/consulting-revenue-ch.yaml) | V81 | 200, 303 |
| 6 | [Consulting fee paid by a client abroad (Ziffer 221)](../examples/cases/consulting-revenue-abroad.yaml) | V0-E | 200, 221 |
| 7 | [Business expense with a receipt that shows 8.1% MWST](../examples/cases/expense-swiss-vat.yaml) | I81 | 405 |
| 8 | [Business expense without a receipt](../examples/cases/expense-without-receipt.yaml) | I0 | none |
| 9 | [Expense the owner paid privately (Auslagen)](../examples/cases/owner-paid-expense.yaml) | I81 | 405 |
| 10 | [Software subscription from abroad without Swiss VAT (Bezugsteuer)](../examples/cases/bezugsteuer-foreign-service.yaml) | B81-1 | 383, 405 |
| 11 | [Supplier abroad that charges Swiss MWST](../examples/cases/foreign-supplier-swiss-vat.yaml) | I81 | 405 |
| 12 | [Private share of a mixed-use expense (Vorsteuerkorrektur)](../examples/cases/private-share.yaml) | K81-B | 415 |
| 13 | [Bank account and card fees](../examples/cases/bank-fees.yaml) | I0 | none |
| 14 | [Refund of a purchase](../examples/cases/purchase-refund.yaml) | -I81 | 405 |
| 15 | [Purchase paid in euros, converted at the ESTV rate](../examples/cases/fx-purchase-estv-rate.yaml) | I81 | 405 |
| 16 | [Correction of a filed quarter (Stornobuchung with corrects)](../examples/cases/correction-private-purchase.yaml) | -I81 | 405 of the corrected quarter (form 0535) |
| 17 | [Input tax recovered for a filed quarter (single-leg -2 entry)](../examples/cases/vorsteuer-recovered-filed-quarter.yaml) | I81-2 | 405 of the corrected quarter (form 0535) |
| 18 | [One bank payment for several invoices (Sammelzahlung)](../examples/cases/sammelzahlung.yaml) | I81, I0 | 405 |
| 19 | [Paying the quarterly VAT to the ESTV](../examples/cases/vat-payment.yaml) | none | none |
| 20 | [Owner pays money into the company](../examples/cases/owner-loan.yaml) | none | none |
| 21 | [Office rent](../examples/cases/office-rent.yaml) | I0 | none |
| 22 | [Laptop or other equipment worth keeping (asset)](../examples/cases/asset-purchase.yaml) | I81 | 405 |
| 23 | [Fuel and other costs of a company car](../examples/cases/vehicle-fuel.yaml) | I81 | 405 |
| 24 | [Income and capital tax of the company](../examples/cases/direct-tax-payment.yaml) | none | none |
| 25 | [One receipt with two VAT rates (8.1% and 2.6%)](../examples/cases/mixed-rate-receipt.yaml) | I26, I81 | 405 |

## Goods and webshop

| # | Case | Codes | Ziffern |
|---:|---|---|---|
| 26 | [Webshop order to a Swiss customer, paid out by the payment provider](../examples/cases/webshop-payout-swiss.yaml) | V81, I0, none | 200, 303 |
| 27 | [Webshop order shipped abroad (export, Ziffer 220)](../examples/cases/webshop-export.yaml) | V0, I0, none | 200, 220 |
| 28 | [Monthly input tax on webshop fees (single-leg M81-2)](../examples/cases/webshop-fees-vat.yaml) | M81-2 | 400 |
| 29 | [Courier customs bill with import VAT (eVV)](../examples/cases/import-vat-evv.yaml) | M0, none, M81, M81-2 | 400 |
| 30 | [One card charge for several marketplace invoices](../examples/cases/grouped-vendor-invoices.yaml) | M81, I81 | 400, 405 |
| 31 | [Refund to a Swiss webshop customer](../examples/cases/webshop-refund.yaml) | -V81 | 200, 303 |
| 32 | [Goods for resale at the reduced rate (2.6%)](../examples/cases/reduced-rate-goods.yaml) | M26 | 400 |
