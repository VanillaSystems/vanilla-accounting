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
14. Booking a payment by hand without AI: merged (form in Kontoauszüge, the task and the receipt; lines must add up; «Gebucht» only with a booking). Open: «N» entries are still not tied to a payment (treuhaender-22).
15. Flaky tests: three races in the test code (the inbox watcher's run, teardown before exit,
    kept-alive connections) fixed; 20 runs under load all green. Found: tests wrote their runs
    into the real app folder ~/Library/Application Support/Vanilla Accounting/runs (about 1'100
    test folders) and left about as many -approvals folders in the temp dir. Tests now keep their
    own folders. The existing leftovers are NOT deleted: they sit in Ken's real app folder next
    to his own runs; to sort out together.
16. Invoices merged: sheet selects save; a payment naming an invoice number, or a refund naming a
    credit note, is matched and booked from the invoice (V81 / -V81) in code; «Ausstellen» says
    what is missing with links; service period; open invoices of earlier quarters stay listed.
17. The sidebar knows the whole app (merged): a map of every area generated from the app's own
    lists; it creates invoice drafts, sets payment terms and texts, adds accounts, sets a receipt
    aside as duplicate, packs the Treuhänder-Paket, starts the booking; the VAT family follows the
    account; it refuses to silently take back an earlier change.
18. Phone path merged: Firma › Handy switches on a listener on the local network for the phone's
    paths only, with a pairing token in a QR code (constant-time compare, stable port, a new code
    locks out old phones); the books API stays on 127.0.0.1. The Mac app processes arriving files
    by itself. The iOS app pairs by QR (built for the simulator, unsigned; not installed on a
    device). Residual risk, documented: plain HTTP on the LAN, so a sniffed token lets someone
    upload into the inbox, never read the books.
19. Found by the rules batch: the classifier did not carry out rules at all before; «Swisscom →
    6510» only worked because the model guessed. Rules with a structured «then» are now applied in
    code before any model call (also without Claude); free-text rules (all 88 of the real books)
    stay notes for the model, so the real books' bookings do not change.
20. Accountant tools merged: opening balances typed in Firma › Eröffnung (2970 the plug; the Bilanz
    names the real cause of a difference); a manual entry books its payment, and an entry typed
    without one can be attached to it; accruals reverse on 1.1. with the entry; Gegenbuchung and
    Kopieren on every entry; the Abschluss checklist ticks entries booked in Buchungen; a journal
    filter by origin; the journal as PDF in the Treuhänder-Paket.
21. Question channel (accountant ↔ owner): merged after an answered «privat» becomes a
    precedent only on a specific key (VAT number, vendor), never a generic bank text like «Karte
    … Einkauf», which would book every card purchase as private.
    For Ken: books set up before this version need one line in the books repository's
    .gitattributes so two clones merge questions without a conflict:
    `vanilla-accounting/transactional-data/*/questions.jsonl merge=union` (not added to the real
    books repository; that is Ken's to do).
22. Decision memos written (private books repo, docs/company/decisions-2026-10-16.md, with the
    real figures). Decision 2 taken overnight: a customer payment without an invoice is asked once
    with a proposal (standard rate for CHF from a Swiss account, zero for foreign money), the
    answer kept as a rule for that customer; it changes no entry of the real books (measured: none
    qualifies today). Decision 3 (Bilanz/ER net: derive the VAT legs at read time) stays Ken's:
    the statement golden files would move and need his review.
23. Decision 2 built and merged: a customer payment without an invoice becomes one question with a proposal (CHF from a Swiss/LI IBAN: standard rate; foreign: export), the answer rebooks and becomes a rule for that payer (by IBAN, else the payer name; generic texts never). The bank import now keeps the payer IBAN for open periods.
24. Round 3 corner cases (findings in .verify/findings/corner.md): 46 findings, 1 blocker. After the first filing no receipt could be added at all, because intake rewrote sealed transactions. Triaged into three batches, each in its own worktree: sealed (the blocker; later receipts on hand-made bookings; unlink and relink without AI; exact undo), salesvat (customer money without an invoice booked V0, SumUp sales, Liechtenstein, abroad), corrections (a storno that moved the bank, same-account corrections, unbooked payments on Aufgaben, the hand form, credit-note sign, missing opening balance, the phone LAN listener). Net Bilanz/ER (corner-24) waits for decision 3.
25. Merged five rounds: honesty, rulequality, salesvat, corrections, sealed. Tests 885 pass, real-books golden master 18/18.
    - Cause of the blocker: every inbox run merged the bank statements again and stripped reference, counterparty and parts from closed rows. The rows were sealed with those fields, so the first filing made every later run fail. Ken's real books would have hit it at their next filing: their open rows carry references. Closed rows are now kept verbatim.
    - Found at the merge: the new by-hand questions (asked without a model) were being closed by any rules change. Fixed, so only a question a rule asked closes.
    - Open: who wrote a reason (rule or code shown as Claude); a SumUp rule that splits sales from fees; the invoice address refusal still technical; Kontoauszüge pay bar overflow; corner-11 run counts (a runs-table redesign); corner-5.
26. Round 4 (build rc.229).
    - Corner cases: 20 of 27 fixed, the blocker gone, phone pairing works end to end.
    - Wishes: 16 of 24 right, 7 of 8 new ones right, 0 pretended.
    - Monika without AI: all her round-2 use cases pass.
    - Merged: polish (who decided a booking, a payout rule with fees, plain refusals) and firmtypes (firms not VAT-registered, and firms on the net tax rate with half-yearly returns: one typed VatSetup, demo-coiffeur, demo-schreinerei). Tests 914 pass, golden master 18/18.
    - New rounds running: honesty2, safety, filedsale.
    - Open for Ken:
      - decision 3 (net Bilanz/ER), raised again by the Treuhänderin;
      - check the net-rate form's box numbers 323/333 against the real ESTV form 0553 before a net-rate firm files (taken from Banana's code list, because the PDF was not reachable);
      - whether the filing period stays a free choice per method;
      - whether to hide the MWST entry for a firm not registered (kept for now, with the threshold watch).
27. Merged honesty2, safety, filedsale and seams; build rc.262 is in round 5 (other firms, Huber). Disk is tight, about 12 GB free: one VM per tester, each stops below 5 GB.
    Queued for the next fix round:
    - the private account by legal form (2850 for an Einzelfirma, not 2451);
    - the privateUse setup question names K81-B for every kind of firm;
    - the server routes do not check typed codes (only the forms do);
    - «im eingereichten Quartal» wording for half years;
    - whether the 0535 is also the correction form on the net tax rate method (Ken or the ESTV).
