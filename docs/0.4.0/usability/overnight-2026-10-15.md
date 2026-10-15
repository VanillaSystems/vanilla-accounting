# Overnight run 2026-10-15/16: decisions and status

Ken asked (before sleeping) to continue without him: create personas, write exhaustive use cases
with their corner cases, test them, improve the app, iterate. MISSION.md is the yardstick. This
file records every decision a person might have made differently, newest last.

## Setup of the run

- A coordinator (the main session) sorts findings, hands batches to fix agents in their own git
  worktrees (a sibling folder per fix, branch `fix/<name>`), merges into 0.4.0-drop after
  `npm test`, the real-books golden master (18 tests, read-only on the real books) and a look at
  the evidence.
- Test agents run the packed app in Tart VMs from snapshots (`huber-setup`, `huber-q3`; macOS runs
  two VMs at most) or the web sandbox (no model: the accountant without AI).

## Decisions

1. Android app: postponed until the iOS app is stable (Ken's lean). Receipt sync from the phone is
   tested by simulating the iOS app's upload (scenario phone-sync).
2. Customer payments without an invoice (VAT-registered firm): today booked at the zero code, which
   declares a domestic job as an export (Ziffer 220). Built as visible warnings (merged). A default
   of the standard rate with a note goes on a branch and is merged only if the real-books golden
   master stays unchanged; otherwise it waits for Ken.
3. Bilanz/ER net within the year (VAT legs to 2201): changes figures in every report and the
   golden master pins them; waits for Ken, with a plan.
4. VAT corrected by hand: the payment is booked again by the next run (needs Claude). Follow-up:
   without a model, the correction must adjust the booking's VAT code itself (mission: possible
   without the AI).
5. Restore after delete: merged (race fixed, per-deletion trash, unknown-IBAN question with the bank name).
6. «Neu klassifizieren» respects corrections: merged. A booking set by hand or by a wish is kept
   unless the person confirms; the classifier never books an empty account or entries that do not
   add up to the payment; every automatic booking says why. Only origin manual counts as «hers»:
   invoice bookings and older entries without origin are still re-booked without asking.
7. Noted for Ken: the Bilanz counts a single-leg VAT-amount entry (the Shopify Vorsteuer pattern
   M81-2 / I81-2) as a missing counter-account and shows a difference. This belongs with the
   «Bilanz/ER net, VAT legs to 2201» decision (3).
8. Duplicates and receipt detection: measured on the real books (read-only, numbers not in git):
   30 of 32 labelled duplicates found (0 before), no real receipt quarantined. Merging after the
   agent rebases onto the latest branch. «ist dasselbe» at the drop does not take the file at all
   (rather than taking it as kind duplicate): it adds nothing the books lack.
9. Linking merged: a link or unlink (by hand, sidebar, undo) rebooks the payment; matching ranks
   open payments by invoice number, amount, vendor and date. One shared function decides what a
   change rebooks: a corrected VAT rebooks every automatic entry (older ones included); a hand
   link only those that recorded their receipts, because an older entry without that record may
   have been shaped by a person and, without a model, would be left unbooked.
10. Duplicates and receipt detection merged (content duplicates, receipt-or-not at the drop, in the run and in mail collection, skip-sender offer).
11. Wishes test (25 wishes): 9 right, 5 partly, 5 refused honestly, 5 wrong, 1 pretended. Two
    batches for the mission: the sidebar knows and uses the whole app (invoices, settings,
    exports, accounts, receipt kinds; VAT family follows the account); rules that act («frag
    mich» becomes a task), a rules page, one click to keep a rule from its card. Settings changes
    from the sidebar apply at once with undo instead of the draft detour (owner wants one click).
12. Treuhänderin without AI: booking a payment by hand is a blocker (fix running); questions to
    the owner and accountant tools (opening balance form, accrual reversal, Gegenbuchung, journal
    filter/PDF) follow once the by-hand fix is merged (same areas).
13. Phone sync: the packed Mac app does not accept phone uploads at all (loopback only, host
    guard, no pairing). Fix: the phone paths only, on the local network, switched on by the person,
    with a pairing token in a QR code; the rest of the API stays loopback-only. The iOS app learns
    to pair. The desktop app also starts processing arriving files by itself.
