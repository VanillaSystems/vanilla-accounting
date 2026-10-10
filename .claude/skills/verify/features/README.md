# Vanilla Accounting verification map

This directory is the maintained source for verifying the user-facing behavior of Vanilla Accounting. Read this index first, then use the matching feature file as the recipe. `S`, `B`, `UI`, `API`, `SB`, and `EVIDENCE` are defined in [../SKILL.md](../SKILL.md).

## Baseline preconditions

- Start a fresh sandbox with `$S up <run>`, then `source $TMPDIR/belege-verify/<run>/env`.
- `$S doctor <run>` passes on every line, including "real repo index untouched since up".
- The recipes read the period lock from the env that `up` writes: `CT` is the clone's `config.closedThrough`, `CLOSED_Q` and `CLOSED_FROM` are the last filed quarter and its first day, `OPEN_Q` and `OPEN_FROM` the open quarter after it. Entries dated on or before `$CT` are locked; later ones are open. An expected text that shows `$CT` carries its value. The worked examples are the demo's: `CT=2026-03-31`, closed `2026-Q1`, open `2026-Q2`.
- The browser actions run in your own `browse` tab: `$B newtab "$UI/..."`.
- No model calls in the sandbox: the API's `claude` is a shim that exits 1. Any button that calls an LLM fails with an alert. That is expected, so don't count it as a regression.

## Driving conventions

- Navigate by URL (the paths of docs/urls.md, e.g. `/journal/<id>?period=$OPEN_Q`; old `/<lang>/<period>/<tab>?receipt=&tx=` links redirect there) to reach a state, then act through the UI.
- Prefer `data-rowid`, ARIA roles and names from `$B snapshot -i`, `title=` attributes, and placeholders over positions.
- Choose fixture records from the sandbox index with `jq` at run time. IDs change when data is reclassified, so never hard-code one from an old run.
- One mutation per proof. Run `$S diff` right after it, so the diff shows only that mutation.

## Proof and skip reporting

- UI proof is a before and after screenshot plus a DOM readback (`$B js` or `$B text`) of the changed element.
- Mutation proof is the `$S diff` output, saved as `index-diff.txt`. It must list exactly the intended change.
- Refusal proof is the `$B dialog` text plus a `$S diff` that shows no change for that record.
- CLI proof is the command, its stdout, and its exit code, run with `cd "$SB"`.
- Report an LLM-backed or camera-backed path as skipped, with the reason. Do not report it as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with browse + sandbox.sh`, and `Gotchas`.

## Features

- [Journal entries (Buchungen)](./journal-entries.md) covers inline edit and the Periodensperre refusals (edit, delete, reclassify). **Driven end to end on 2026-10-08.**
- [Transactions and receipt linking](./transactions.md) covers the transaction detail, description and note edits, the "kein Beleg nötig" toggle, and linking or unlinking a receipt. **Unlink, relink, toggle and closed-period refusal driven on 2026-10-08.**
- [Receipts (Belege)](./receipts.md) covers the list, the non-receipt filter, search, preview, metadata edit and delete. **Driven end to end on 2026-10-08.**
- [MWST report](./vat-report.md) covers the Ziffern per period, the Ziffer detail, the Korrekturabrechnung (0535) with its correction cases, and the `vat-report` / `vat-xml` CLIs. **Driven on 2026-10-08.**
- [Static audit export](./audit-export.md) covers `npm run build:audit` served by a plain static server: every tab, search, PDFs, the snapshot line, no `/api/*` request. **Driven on 2026-10-09.**

## Not mapped yet

- Scan PWA (`/scan`), which needs a camera. Its upload endpoint is `POST /api/upload` (`Content-Type: application/pdf`) and writes to `$SB/beleg-import/`. The iOS app (`ios/`) uses the same endpoint.
- The reports `Saldobilanz`, `Bilanz`, `Erfolgsrechnung`, `Kontoauszug`, `Kontenabgleich`, and `Kontoauszüge` are read-only views.
- `Kontoauszug` (`/<lang>/<period>/account-ledger?account=<nr>&je=<id>&receipt=<id>`): the account is picked in the combobox `[data-testid=account-combobox]` (type a number prefix or part of the name, Enter): the `Belege` column counts the receipts mapped to each entry's `transactionRef`; clicking a row (`tr[data-rowid="<entry id>"]`) opens the right pane with the receipt list (or `Keine Belege`) and the first PDF in an `iframe`. Headless screenshots show the iframe blank; prove the PDF with `curl -sI $API/api/receipts/<id>` (`application/pdf`).
