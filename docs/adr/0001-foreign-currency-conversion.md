# 1. Foreign-currency conversion uses the ESTV daily sell rate at the payment date

Date: 2026-07-03
Status: Accepted

## Context

Many journal entries are foreign-currency (Wise EUR/USD accounts).
The books are kept in CHF, so every foreign entry must be converted. There is no "bank actual
CHF" shortcut for the Wise EUR/USD accounts — the money that moved was EUR/USD, and the bank
never provides a CHF figure for it, so conversion is the norm, not an edge case.

Until now conversion used a flat annual rate (EUR 0.91 / USD 0.78 in `context/wechselkurse.txt`, now `reference/wechselkurse.txt`),
carried over from the earlier practice of picking one number per year. That is **not compliant**
with Swiss VAT law (MWSTG Art. 24; MWST-Info 03), which requires converting foreign amounts with
one of two published ESTV methods, applied consistently across a tax period:

1. the **ESTV monthly average rate** (Monatsmittelkurs), or
2. the **ESTV daily sell rate** (Devisenkurs *Verkauf*).

A payment provider's own rate (e.g. the rate Wise actually applied) is **not** an accepted method
for the VAT conversion. Because the business uses **cash-basis** taxation, the tax point — and thus
the conversion date — is the day the money moved: the **payment date**.

## Decision

Convert every foreign-currency entry with the **ESTV daily sell rate valid on its payment date**.

- **Rate source**: BAZG/ESTV `https://www.backend-rates.bazg.admin.ch/api/xmldaily?d=YYYYMMDD`.
  The single published `<kurs>` is the sell rate ESTV mandates. Rates are cached, checked in, and
  auditor-verifiable in `reference/estv-daily-rates-2026.json`, keyed by the calendar date each rate
  is valid for (the API's `gueltigkeit` list, so Friday's rate rolls over the weekend).
- **Payment date**, not entry date: the rate keys off the underlying `BankTransaction.date`. Some
  entries (Shopify revenue/fee) carry a shifted `entry.date` (the order date); those still convert
  at the transaction's payment date. Manual corrections with no bank transaction (Eigenverbrauch
  `M2026-xxx`) fall back to `entry.date`.
- **Weekend/holiday fallback**: per ESTV ("apply the most recently recorded daily rate"), a payment
  on a day with no published rate uses the latest validity date on or before it.
- **Storage**: the resolved rate stays denormalized on each `JournalEntry.exchangeRate`, frozen at
  the value used — so a restatement is visible in the data, not recomputed silently.
- **Scope**: EUR and USD (the booked currencies). GBP appears only in `match.ts` receipt↔transaction
  proximity ranking, never in booking, and is deliberately left on its flat rate.

Tooling: `npm run fetch-rates` (fetch + cache) then `npm run restamp-fx` (`--dry-run` to preview).

## Consequences

- **Compliant** with MWSTG Art. 24, and consistent within the 2026 tax period. (The rule binds
  within a period, not across years, so upgrading 2026 from the old flat rate is allowed.)
- The trial balance **still balances**: each entry applies its one rate to both legs, so every
  two-legged entry nets to zero in CHF. Restamping every foreign entry did not introduce any imbalance.
- The EUR/USD bank accounts now accumulate CHF at varying rates, so their CHF book value carries a
  real unrealized FX position. A **year-end exchange-difference (Kursgewinn/-verlust) revaluation**
  against the 31.12 rate becomes a required closing step. Native-currency reconciliation
  (`npm run reconcile-balances`) is unaffected, as it compares native balances.
- Switching methods mid-period (e.g. back to flat, or to monthly average) would break the
  consistency requirement — this decision is effectively locked for the tax period.

## Alternatives considered

- **ESTV monthly average rate** — also compliant and simpler (one rate per currency-month). Rejected
  because daily is barely more effort given the automatable BAZG API, and it removes any
  "which month bucket" ambiguity for cash-basis payment dates.
- **Wise's actually-applied rate** — arguably the truest cash rate, but not an ESTV-accepted method
  for VAT conversion, so it cannot be the ledger-wide standard.
- **Keep the flat annual rate** — non-compliant and an unexplained method vs. the varying rates an
  auditor sees elsewhere. Rejected.
