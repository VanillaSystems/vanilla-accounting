# Booking patterns (Banana Accounting)

Non-obvious journal-entry shapes. For VAT *code* rules see `AGENTS.md`; this file is about
*entry structure* — which accounts go where.

## Amount-type-2 VAT codes (`-2` = "MwSt/USt-Betrag") — single-leg VAT corrections

Some Banana VAT codes end in `-2` (e.g. `M81-2`, `I81-2`, `B81-2`). The `-2` means **the amount
you enter IS the VAT amount** — not gross, not net. These are booked **single-legged**: you fill
**exactly one** account (Soll *or* Haben), and the VAT code carries the other leg to the VAT
account automatically. Filling *both* legs double-books the VAT — do not do it.

The `-1` variant = net (VAT excluded), plain code (no suffix) = gross (VAT included). See
`reference/MWST-codes.txt` for the full table.

## Shopify — monthly Vorsteuer on transaction fees

**Problem:** the per-order Stripe/Shopify payout receipts do NOT show the 8.1% Swiss MWST on
Shopify's fees. The proof is Shopify's **monthly billing statement** ("Payments Invoice", from
Settings → Billing → Bills). We book that hidden Vorsteuer once per month as a correction.

**Correct entry** (the shape Banana uses for a monthly Vorsteuer correction):

| Field         | Value                                                       |
|---------------|-------------------------------------------------------------|
| accountDebit  | *(empty)* — the code supplies this leg → `2201 Abrechnungskonto MWST` |
| accountCredit | `6580` Webshopaufwand                                       |
| amount        | the VAT amount only = gross fees × 8.1 / 108.1              |
| vatCode       | `M81-2`                                                     |
| description   | `Shopify, Vorsteuer Transaktionsgebühren <Mon JJJJ>`        |

Effect: reduces the Webshopaufwand expense by the reclaimable VAT and books the Vorsteuer to the
MWST settlement account. **No cash moves** — the fee was already paid when the payout was booked,
so do **not** touch the owner's Kontokorrent (`2451`).

- Example: gross fees EUR 1'081 → VAT = 1'081 × 8.1/108.1 = **EUR 81**.
- Code choice: use **`M81-2`** (Material-/Dienstleistungsaufwand, VAT-form Ziffer 400).
  `I81-2` (Ziffer 405) reclaims the same francs but declares it on a different
  form line — avoid unless deliberately reclassifying.

Filling both legs of a `-2` code double-books the VAT and, with `2451` as the other leg, moves the
owner's Kontokorrent.

### Tooling
- `src/accounting/validate.ts` allows one blank leg **only** for `-2` codes (`isVatAmountCode`),
  and skips the M/I/V account-class warnings for them (a single-leg correction pairs the code with
  the account being corrected, not the code family's "expected" account class).
- `src/llm/prompts.ts` rule **9b** teaches the classifier this pattern.

## Payment providers — payout over the clearing account (#203)

A payment provider's payout (Shopify Payments, a card terminal) is a settlement, not a sale. With
`provider.clearing` and the cut-over day `provider.since` in the company's file of the provider
(processes/README.md «A payment provider»), code books, for what is dated on or after `since`:

| Entry            | Soll       | Haben       | Code                                   | From                     |
|------------------|------------|-------------|----------------------------------------|--------------------------|
| each order       | clearing   | revenue     | V81 delivered in CH/LI, V0 abroad      | the provider's sales CSV |
| each refund      | revenue    | clearing    | the sale's code with the minus (-V81)  | the provider's sales CSV |
| each fee         | fee account| clearing    | `provider.fees.vat` (I0 without a bill)| the provider's fee CSV   |
| the payout       | bank       | clearing    | none                                   | the bank statement       |

The clearing account comes back to what the provider holds unpaid; the quarter's review shows it.
What is dated before `since` stays as it was booked; nothing is booked again.
The monthly Vorsteuer correction above stays as it is.
