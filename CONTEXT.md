# Belege — Domain Glossary

## Receipt
A PDF file that serves as supporting evidence for one or more bank transactions. Receipts may be computer-generated (Shopify, Wise invoices) or scanned/photographed. Each Receipt has a `location`: `staged` (in `beleg-import/`, awaiting processing) or `archived` (in `receipts/`, processed).

## BankTransaction
A single entry from a camt053 XML bank statement (any bank the workspace lists; Raiffeisen and Wise exports are tested). Has a unique `ref` (AcctSvcrRef), date, description, amount, currency, direction (CRDT/DBIT), and bank. The `ref` for Raiffeisen is a numeric string; for Wise it starts with W (e.g. `WEUR000042`).

## Mapping
A confirmed link between a Receipt and a BankTransaction. Many-to-many: one Receipt can support multiple BankTransactions (e.g. Wise multi-currency splits where one purchase debits multiple accounts), and one BankTransaction can have multiple supporting Receipts (e.g. FedEx freight invoice + customs invoice).

## Beleg-Import
The staging folder `beleg-import/` where new receipts arrive — either manually on the laptop (downloaded PDFs) or uploaded from the iOS app via `POST /api/upload`. Files here are unprocessed. After `extract` + `match`, they are renamed and moved to `receipts/`.

## Workspace
The directory holding one company's data: `belege.workspace.yaml` (who the company is, which ledger account each bank books on), `books.json`, `receipts/`, `beleg-import/`, `bank-statements/`, `filings/`, `accounts.json`, `history/` (prior-year books) and `data/` (gitignored). The layout is fixed (`src/workspace/workspace.ts`). Every CLI and the API open it with `openWorkspace()`: `BELEGE_WORKSPACE`, else the first directory from the cwd upward that holds a manifest. The app's own files (`processes/`, `reference/`) are found from the code, never from the cwd.

## Index
The single shared data file `books.json` at the workspace root (see **Workspace**). Written by CLI scripts, read by the React app and mutated by the local API server.

## Local API Server
A minimal Express server (`src/server/api.ts`) that runs alongside Vite during `npm run dev:full`. Provides write access to the Index and the filesystem. Not present in production static builds.

## Collection
An interactive Claude Code session that gathers Receipts from email (IMAP) and vendor webshops (headed browser). Receipts are normalized to PDF and dropped into Beleg-Import. Collection does not replace the existing extract/match pipeline — it feeds into it.

## Payment Date
The day the money actually moved — the `date` of the underlying BankTransaction. Because the business is taxed on a **cash basis**, this is the tax point: the date that governs both when an amount is recognised and which exchange rate converts it to CHF. It is distinct from a receipt's invoice/order date, and from a JournalEntry's own `date` (which is sometimes shifted to the order date for Shopify revenue/fee entries).

## ESTV Daily Sell Rate
The official Swiss foreign-exchange **sell** rate (Devisenkurs *Verkauf*) published by BAZG/ESTV, one value per currency per business day. It is the rate Swiss VAT law (MWSTG Art. 24) accepts for converting foreign amounts to CHF, and the method this project uses — applied at each entry's Payment Date. On days with no published rate (weekends, holidays), the most recently recorded rate applies. Not to be confused with a bank's or Wise's own applied rate, which is **not** an accepted VAT conversion basis. See `docs/adr/0001-foreign-currency-conversion.md`.

## Exchange Difference (Kursdifferenz)
The unrealized foreign-exchange gain or loss on a foreign-currency bank account, arising because its transactions are booked at varying daily rates while its native balance is fixed. Surfaced only at year-end by revaluing the account's CHF book value against the 31.12 rate; booked to a Kursgewinn/-verlust account. Independent of native-currency bank reconciliation, which compares balances in the account's own currency.
