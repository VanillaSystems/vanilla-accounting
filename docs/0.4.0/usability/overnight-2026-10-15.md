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
28. Merged firmtypes2 and wishsafety; tests 974 pass, real-books golden master 18/18.
    - firmtypes2: one root cause behind four round-5 findings. The start screen's list read every recent workspace with `workspaceAt`, which also set the VAT engines, so the engines ended on the last workspace listed, not the open one; the name now comes from the manifest alone. A failing year-close check answers 500 instead of hanging. A replay's seal step says skipped. Codes the form does not take are refused at the write door. A firm not registered closes its year without a return and prints no VAT on invoices. Owner account by legal form; period words per filing length.
    - wishsafety: an answer that rebooks several payments on different accounts, deletes more than one booking or sets a rate code without a VAT receipt is held on one card (before → after, «Übernehmen» / «Verwerfen»); the rule card judges the bookings as they were before the AI. The AI is recorded as author (`by: assistant`). «Rückgängig» reopens the question a change answered. The open-work note lists contradictions, duplicates and bookings unsettled at filing; Aufgaben flags the latter.
    - Open for Ken: whether the 0535 covers net-rate corrections (named «Korrekturabrechnung» without a number); the legal wording of the threshold text (liability from 1 January, MWSTG Art. 14 Abs. 3, the agent's reading); a mid-year `since` is not modelled. Still open: r5f-9 (task when the threshold is passed), r5f-26 (typing in a focused MWST field opens «Neue Buchung»), r5h-34 (duplicates on Aufgaben, only in the AI's note so far).
29. Merged intake2; tests 991 pass, real-books golden master 18/18.
    - A mailbox is connected in Firma › Quellen («Postfach verbinden», password in the secret store, «Verbindung prüfen» reads nothing). The Mac app does not yet fetch mail by itself (sources unit 2b); imapflow and mailparser are now packed but unverified in a built app.
    - Non-receipts were never judged in the packed app because a fresh Mac has no `pdftotext`; first pages now come from pdf.js. Quarantine listed on Belege with reasons, «Ist ein Beleg» takes a file back.
    - A reminder is a supporting document tied to its invoice by number. An invoice and its forwarded copy no longer hold each other back from matching (Swisscom).
    - The opening balance can be entered after a quarter is filed (seals cover entries, payments and links, not `openingBalances`); refused only once the year is closed through 31.12.
    - r4c-34 «Automatisch buchen» now writes its outcome beside the button; the packed-app silence was not reproduced, cause unknown. Run counts, the invoice select race, the hand-form VAT prefill and duplicates on Aufgaben fixed.
    - Rebase: Aufgaben keeps both new sections (filed bookings that contradict their receipts, possible duplicate receipts).
    - Started fix/leftovers: r5f-9 threshold warning and task, r5f-26 typing in the MWST field, r4c-21 SumUp payout without report.
30. Merged leftovers (after rc.290, so not in round 6's build); tests 998 pass, real-books golden master 18/18.
    - r5f-9: a firm not registered is warned from 90 % of the threshold, reached or projected at the year's pace (after 91 days); Aufgaben carries a task once it is passed.
    - r4c-21/r5h-12: a SumUp payout without its report is held as a question («Bericht verknüpfen, oder die ganze Auszahlung als Umsatz buchen?»), not booked V81 on the net; a report linked later closes it. Reason: VAT is owed on the gross, and a provisional entry filed as it stands would need a 0535 for every late report.
    - r5f-26 did not reproduce in the sandbox; likely round 5's driver clicked «+ Buchung». The round-6 firms tester checks it in the packed app.
    - Open for Ken: should the threshold task count in the dock badge? Is holding a reportless payout right, or should the AI book it from the bank text?
31. Round 6 other firms (rc.290, .verify/findings/r6-firms.md): of 21 round-5 rows not good, 10 fixed, 7 partly, 3 failing (r5f-4, r5f-9 fixed after the build, r5f-14); the 6 good rows still good. r5f-26 does not reproduce in the packed app (round 5 typed into the add form). Five switches between the two firms always showed the right engines. Filed H1 byte-identical through the replay.
    - New highs: r6f-33 the 2. Semester return can be approved and exported on 16.10.; r6f-22 setup never asks for the ESTV activity code, the first net-rate filing sticks with an English message naming a field.
    - Partly: the sidebar's advice on a 1 October registration is wrong; Perioden und Siegel lists quarter due dates for a firm without returns; H1 shows the corrected figure as filed.
    - Fix round firmtypes3 started (also every English or internal message that reaches the person, as a class).
    - Ken (16.10.): he tests by hand on his real books; automated tests never use them. Build rc.295-g49de54d handed to him.
32. Round 6 Huber (rc.290, .verify/findings/r6-huber.md): of 19 round-5 rows not fixed, 16 fixed, 2 partly, 1 failing (r5h-22 invoice select race, 3 of 8 runs). x02 held until «Übernehmen», AI recorded as author, undo reopens the question, mailbox connect, quarantine, reminder, Swisscom, opening after filing, late-receipt I81 all fixed. Wishes: 5 right, 1 refused honestly, 0 wrong.
    - New high r6h-24: a rule kept by answering the app's sale question is not switched on; «Automatisch buchen» answers with a hash.
    - Medium: drop-held duplicates vanish (r6h-23); «Löschen» deletes at once and not in Änderungen (r6h-28); mailbox connect not atomic (r6h-25); drop dialog cut off with the sidebar open (r6h-30).
    - The tester's GUI launcher passed the Claude token in `open --env` argv and `open` echoed it once into a tool output (no evidence file has it). Ken told to rotate it. The harness fix is in fix/huber6.
    - Fix round huber6 started.
33. Merged firmtypes3; tests 1009 pass, real-books golden master 18/18.
    - A return for a period still running is refused (`periodRunning`), and the MWST page shows «läuft noch bis …». The year's last period (Q4/H2) can now be filed: its XML is archived beside the seals, and the year close seals it and sets closedThrough. Before, that run always got stuck. This affects the real books' Q4 2026 filing, so check it at the year end.
    - Activity code asked in setup; a missing one withholds «Freigegeben» with a task. The portal-by-hand promise was dropped: it would leave no as-filed record for the 0535 and the year close.
    - One typed `Refused {code, params}` for every run, step and command refusal, rendered in four languages; a test forbids internal names in those texts.
    - AI prompt: a registration dated inside the year rules from that date. The threshold texts are hedged («in der Regel ab 1.1.; die Verfügung der ESTV nennt das Datum»).
    - Perioden und Siegel shows one card for the year of a firm without returns; H1 leads with the filed figure, today's figure beside it.
    - Open for Ken: the 0535 for net rate; the threshold wording; no portal-by-hand path; a net-rate firm still sees the receipt's Swiss-VAT fields.
34. Icons (Ken, 16.10.): the receipt icon kept coming back because `0.4.0` and `main` still carry it (the wave was only on the 0.4.0-ui line), the phone app's set was still the receipt, and the Dock caches old icons. Commit d80051b pins every icon by hash (desktop/brand-icons.json, tools/brand/icons.mjs); a test and desktop:build refuse any non-brand or retired icon. `0.4.0`/`main` get it when 0.4.0-drop is merged (Ken's call).
35. Merged huber6; tests 1018 pass, real-books golden master 18/18.
    - r6h-24: one `keepSwitchedOn` seam. A rule kept by answering, correcting or undoing is switched on; a waiting workflow refuses in words with a link; Regeln marks waiting rules.
    - r5h-22: the real race was a GET served before the PATCH applied and arriving after it settled. local-edits now keeps the page's copy when a save settled after the read began. 50 of 50 runs pass.
    - r6h-28: «Löschen» leaves a placeholder with «Rückgängig» in place, and Änderungen lists deletions. No confirm dialog (reversible over asked).
    - r6h-23: closing the drop dialog takes a held duplicate in, so Aufgaben asks; unclear files go to quarantine.
    - r6h-25: mailbox connect stores the password first, writes nothing on failure, and updates an existing source for the same address.
    - r5h-36: the AI may delete what a person may; several deletions go through the held card.
    - Harness: `vm.sh app` starts the app in the VM's GUI session through a LaunchAgent, so the keychain works; the token is on no command line.
    - Started fix/composer (KI sidebar toggle, history button, VS Code-style composer with «+» context picker), as Ken asked.
    - Open for Ken: mailbox connect updates vs refuses a second time; partial deletions by the AI; r6h-33 credit note without PDF (M0 vs -M81); refresh the huber-q3 snapshot (it has rc.174); the token is still readable with `ps -E` by the same user.
36. Merged composer (KI sidebar: arrow toggle, «Verlauf» button with «Vergangene Gespräche» list, one-field composer with «+» picker for this page, Beleg, Buchung, Zahlung, Ablauf/Lauf, and a round send arrow). No file from disk: the API takes references only. Tests 1021 pass, golden master 18/18. Building rc for round 7.

37. Round 7 Huber on rc.329-gf9aa4fe (`.verify/findings/r7-huber.md`): of 13 round-6 rows, 9 fixed, 3 partly, 1 still failing (r6h-33). The new KI sidebar (arrow toggle, «Verlauf», composer, «+» picker) and the wave icon pass. New highs: r7h-21 (a SumUp question overwrites the split booking), r7h-22 (AI books a supplier credit with M81), r7h-23 («Privat bezahlt» on a receipt the bank paid books it twice), r7h-24 (a quarter changes between «Freigegeben» and «Eingereicht»). Fix round huber7 and the round-7 firms tester started.

38. Round 7 other firms on rc.329-gf9aa4fe (`.verify/findings/r7-firms.md`): of 15 round-6 rows, 8 fixed (both round-6 highs r6f-33 and r6f-22), 6 partly, none still failing; r6f-9 regressed. New highs: r7f-28 (net-rate firm: answering «kein Umsatz» leaves the payment on 3000 F1) and r7f-29 (r7h-24 again for a half-year). The sidebar and the icon pass in both firms; the no-Claude path holds. r7f-29 and r7f-31 went to huber7, the rest to the new fix round firms4. Disk: three superseded VMs and 20 merged worktrees removed, 14 GB free.

39. Merged huber7: a period is held from «Freigegeben» until «Eingereicht» or «Zurück» (`config.approvedReturn`, refusal `periodClosed` with `approved`), the XML step recomputes and sends a changed return back to review, and the seal refuses `figuresChanged` (r7h-24, r7f-29). «Privat bezahlt» on a paid receipt refused `receiptPaid`, one-step undo (r7h-23). A booked payout closes its question, and a stale answer never replaces a rule's booking (r7h-21). VAT code sign checked on every person and KI booking, `codeSign` (r7h-22). Deleted run bookings recorded and restorable from Änderungen; bare Backspace no longer deletes (r7h-31, r7f-31). Keyboard Enter on buttons, one item per SumUp payout, lows. Suite 1040/0, golden 18/18. Open for Ken: credit note without PDF inheriting the invoice rate (r7h-14).

40. Merged firms4: «kein Umsatz» moves the payment's revenue entries to the owner's account without a code, undoable, and the rule follows (r7f-28). Activity-code and other VAT-setup refusals typed and worded in four languages (r7f-30). A rule with a code the firm cannot use is refused `codeNotTaken` before the account check; the KI is told which codes the firm takes (r7f-32, r7f-37). Run digests count bookings (r7f-34), Änderungen shows why a sealed run cannot be undone (r7f-36), outcomes and periods in words, net-rate correction boxes, half-year chips, no VAT field for unregistered firms. Suite 1045/0, golden 18/18. Open for Ken: the parking account for «kein Umsatz» (owner account now), typed refusals for the other Firma forms, linking a late receipt of a sealed period (r6f-34).

41. Built rc.351-gf8467d2. Round 8 runs four testers at once: two VMs (Huber from huber-q3, the other firms from vanilla-clean) and two browser sandboxes without a model (demo-consulting: invoices, reports, export, VAT, close; demo-coiffeur: receipts, bank, hand bookings, rules, tasks, undo).

42. Round 8 results. Huber (r8-huber.md): 16 of 21 round-7 rows fixed, all four round-7 highs; new highs r8h-20 (model-read SumUp fees as negative revenue), -21 (stray key links a wrong payment, «Lösen» splits), -22 (one click undoes a deliberate -M81), -23 (restoring a deletion over a rebooked payment), -24 (an answer during the hold is dropped and Q3 filed without it). Consulting sandbox (r8-consult.md): saving needs the AI (r8c-3), EUR invoice account not settable (r8c-1), Bilanz/ER gross without a word (r8c-2), Enter regression (r8c-7). Coiffeur sandbox (r8-coif.md): blockers r8k-1 (overlapping statement duplicates booked payments) and r8k-2 (undo of it deletes the earlier statement). Firms VM stopped at 2.7 GB disk (two VMs do not fit); the hold works on every write path. Fix rounds consult8, bank8, huber8 running; firms rerun r8firms2 alone in a VM.

43. Merged consult8: saving works without the AI (one save per file, plain message, r8c-3); foreign-currency pay-to accounts in Firma › Rechnungslayout › Zahlungskonten (r8c-1); Bilanz/ER and their PDF/CSV state the VAT still in the figures with owed, input and net (r8c-2, figures unchanged, decision 3 open); Enter on list rows again (r8c-7); phone layout below 600 px (r8c-8, not yet seen at 390 px); foreign open invoices (r8c-9); year-close links (r8c-10); cancelled-invoice payments (r8c-5); hand corrections write correction cases (r8c-6); lows. Suite 1056/0, golden 18/18.
