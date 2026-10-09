# Transactions and receipt linking

The Transaktionen tab lists bank transactions (camt053, Wise) and manual ones. Selecting a transaction opens a detail panel. There the user can edit the description or note, search for a receipt and link it (`Zuordnen`), or unlink it (`Zuordnung entfernen`). A link is stored as a mapping `{receiptId, transactionRef}`.

## Sub-features

- `tx-list` filters with `alle`, `zugeordnet`, and `nicht zugeordnet`, and searches with `Ref, Beschreibung suchen…`. `nicht zugeordnet` also hides Wise fees and transactions marked `noReceiptNeeded`. The status column reads `zugeordnet`, `Gebühr`, `kein Beleg nötig` or `fehlend`.
- `tx-describe` uses `Beschreibung bearbeiten`, then `Speichern`, to write `transactions[ref].description`.
- `tx-remarks` uses `Notiz bearbeiten`, then `Speichern`, to write `transactions[ref].remarks`.
- `tx-link` links a receipt: type in `Beleg suchen (Dateiname, Beschreibung)…` and choose a `Zuordnen` result. This adds a mapping.
- `tx-unlink` uses `Zuordnung entfernen` to remove a mapping.
- `tx-closed` refuses every change to a transaction dated on or before `closedThrough`: link, unlink, description, note, `noReceiptNeeded` and delete. The API answers 403 `Periode geschlossen bis $CT. …` and nothing is written.
- `tx-no-receipt` is the ShieldCheck button `title="Als „kein Beleg nötig" bestätigen"`. It writes `noReceiptNeeded: true` and shows the banner `Bestätigt: kein Beleg nötig`; clicking `Bestätigt: kein Beleg nötig (klicken zum Zurücksetzen)` removes the field.
- `tx-delete` is `title="Transaktion löschen"` with a native `confirm()`. It removes a manual transaction and its mappings. A bank transaction is refused with a 400 alert `Nur manuelle Transaktionen können gelöscht werden. …`; a closed-period manual one with a 403 alert.
- `tx-manual` creates a manual transaction (Auslage). The suggest step is LLM-backed and skipped. A date on or before `closedThrough` is refused with 403.

## How to get to it (user POV)

- Choose the `Transaktionen` tab, or open `/<period>/transactions`.
- Deep link to one transaction: `/<period>/transactions?tx=<ref>`.
- From Buchungen, select a row. The side panel shows the same transaction's receipts.

## Driving it with browse + sandbox.sh

Preconditions:

- The doctor passes.
- Pick an open-period transaction that already has a receipt, and that receipt: `jq -r --arg ct "$CT" '[.transactions[]|select(.date>$ct)|.ref] as $t | [.mappings[]|select(.transactionRef as $r|$t|index($r))][0]|"\(.transactionRef) \(.receiptId)"' $SB/books.json`. When every open transaction is settled there is none to link from scratch: prove unlink first, then relink the same receipt.

- **Open the detail.** Run `$B newtab "$UI/$OPEN_Q/transactions?tx=$REF"` and `$B wait --networkidle`. The detail panel shows the transaction amount and the `Beleg suchen…` box.
- **Unlink.** Click `button[title='Zuordnung entfernen']`. `$S diff` shows exactly `- mappings {"transactionRef":"<REF>","receiptId":"<RID>"}`.
- **Link.** Run `$B fill "input[placeholder^='Beleg suchen']" "<first 24 chars of the receipt filename>"`, wait for `button[title='Zuordnen']`, and click the result. The receipt moves back into the linked list and `$S diff` is empty again (the mapping is restored).
- **No receipt needed.** Click `button[title^='Als „kein Beleg']`. The banner `Bestätigt: kein Beleg nötig` appears and `$S diff` shows `~ transactions <REF> .noReceiptNeeded: undefined -> true`. Click `button[title^='Bestätigt: kein Beleg']` to reset; the diff line disappears.
- **Closed-period refusal.** Repeat Link on a `$CLOSED_Q` transaction, and Unlink on a `$CLOSED_Q` transaction that already has a mapping. Each time, `$B dialog` shows `Periode geschlossen bis $CT. Zuordnungen zu Transaktionen in geschlossenen Perioden können nicht geändert werden.`, and `$S diff` shows no change.
- **Describe.** Click `Beschreibung bearbeiten`, run `$B fill "input[placeholder='Beschreibung…']" "<text>"`, then click `Speichern`. `$S diff` shows `~ transactions <REF> .description`. On a `$CLOSED_Q` transaction the same steps show the red inline error `Error: Periode geschlossen bis $CT. Transaktionen in geschlossenen Perioden können nicht geändert werden.` and `$S diff` stays empty.
- **Delete refusal.** On a `$CLOSED_Q` bank transaction click `button[title='Transaktion löschen']` (the `confirm()` is auto-accepted): `$B dialog` shows the 400 `Nur manuelle Transaktionen …` alert. On a `$CLOSED_Q` manual one (`M<year>-<n>`) it shows `… können nicht gelöscht werden.` `$S diff` stays empty.
- **Proof.** Save before and after screenshots and `index-diff.txt` under `$EVIDENCE/transactions/`.

## Gotchas

- Mappings have no id, so `$S diff` prints them as their full JSON. That's expected.
- `/api/mapping/add` and `/api/mapping/remove` return 403 for closed-period transactions. Prove a positive link on an open-period transaction.
- The receipt-centric assign panel on the Belege tab (`Transaktion zuordnen`) uses the same endpoints and the same alert.
- A receipt linked to several transactions shows `Mehrfach zugeordnet – nicht genehmigt` until someone approves it.
- Errors differ by surface: link, unlink, no-receipt and delete errors are `alert()`s (read with `$B dialog`); description and note errors render inline in red, with no dialog.
- The period lock is `assertOpen` in `src/server/books.ts`, called by every writing route under `withBooks` (whose `mutateJournal` catches anything a route misses), proven endpoint by endpoint in `tests/period-lock.test.ts` (`npm test`).
- Driven on 2026-10-08: unlink, relink, no-receipt toggle and reset, closed-period refusal, closed description edit (inline error), delete refusal on a closed-quarter bank and manual transaction, note on an open-quarter transaction. Driven on 2026-10-07: link, unlink, both refusals. `Beschreibung bearbeiten`, `tx-delete` and `tx-manual` not driven.
